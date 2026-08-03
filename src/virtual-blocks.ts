import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  convertToLlm,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { selectCompressibleRange, type VirtualRange } from "./range-selector.ts";
import { entryRangeCanBeReplaced } from "./context-projector.ts";
import type {
  DcpBlockEntryData,
  DcpConfig,
  ResolvedProtection,
  VirtualCompressionBlock,
} from "./types.ts";
import { estimateTextTokens } from "./utils.ts";
import { buildProtectedAppendix } from "./compaction/protected-appendix.ts";
import { appendPreservedUserMessages, collectRealUserMessages } from "./compaction/user-prompts.ts";
import { renderRangeSummaryPrompt } from "./compaction/range-prompt.ts";

export const DCP_BLOCK_CUSTOM_TYPE = "dcp-context-range.v1";
export const DCP_BLOCK_RETIRED_TYPE = "dcp-context-range-retired.v1";

export function rebuildVirtualBlocks(entries: readonly SessionEntry[]): VirtualCompressionBlock[] {
  const blocks = new Map<string, VirtualCompressionBlock>();
  const retired = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === DCP_BLOCK_RETIRED_TYPE) {
      const id = readBlockId(entry.data);
      if (id) retired.add(id);
      continue;
    }
    if (entry.customType !== DCP_BLOCK_CUSTOM_TYPE) continue;
    const data = entry.data as Partial<DcpBlockEntryData> | undefined;
    const block = data?.block;
    if (!block || data?.version !== 1 || typeof block.id !== "string") continue;
    if (block.active === false) {
      blocks.delete(block.id);
      continue;
    }
    blocks.set(block.id, block as VirtualCompressionBlock);
  }

  for (const id of retired) blocks.delete(id);
  return [...blocks.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function appendVirtualBlock(pi: ExtensionAPI, block: VirtualCompressionBlock): void {
  pi.appendEntry<DcpBlockEntryData>(DCP_BLOCK_CUSTOM_TYPE, { version: 1, block });
}

export function appendVirtualBlockReceipt(
  pi: ExtensionAPI,
  block: VirtualCompressionBlock,
  details: { number: number; activeWorkingSetTokens: number },
): void {
  appendReliefReceipt(pi, [block], {
    firstNumber: details.number,
    activeWorkingSetTokens: details.activeWorkingSetTokens,
  });
}

/** Emit one transcript card for the whole relief pass, never one card per range. */
export function appendReliefReceipt(
  pi: ExtensionAPI,
  blocks: readonly VirtualCompressionBlock[],
  details: { firstNumber: number; activeWorkingSetTokens: number },
): void {
  if (blocks.length === 0) return;
  const totalRawTokens = blocks.reduce((sum, block) => sum + block.estimatedRawTokens, 0);
  const totalBlockTokens = blocks.reduce((sum, block) => sum + block.estimatedBlockTokens, 0);
  const totalMessages = blocks.reduce((sum, block) => sum + block.messagesCompressed, 0);
  const totalTools = blocks.reduce((sum, block) => sum + block.toolsCompressed, 0);
  const totalPrompts = blocks.reduce((sum, block) => sum + block.preservedUserMessages.length, 0);
  const totalEvidenceTokens = blocks.reduce((sum, block) => sum + estimateTextTokens(block.exactEvidence), 0);
  const finalBlock = blocks[blocks.length - 1];
  const rawContextAfter = Math.max(0, finalBlock.retainedRawTokens || details.activeWorkingSetTokens);
  const bar = renderRangeBar(totalRawTokens, rawContextAfter);
  const firstNumber = details.firstNumber;
  const lastNumber = firstNumber + blocks.length - 1;
  const summaryLabel = blocks.length === 1 ? "summary" : "summaries";
  const compressionLabel = blocks.length === 1
    ? `▣ Compression #${firstNumber} -~${formatTokenCount(totalRawTokens)} removed, +~${formatTokenCount(totalBlockTokens)} ${summaryLabel}`
    : `▣ Compression #${firstNumber}–#${lastNumber} · ${blocks.length} ranges`;
  const rangeLabel = blocks.length === 1
    ? `→ Range: ${finalBlock.startEntryId}..${finalBlock.endEntryId} · ${finalBlock.rangeKind === "active-prefix" ? "earlier active work" : "completed phase"}`
    : `→ Ranges: ${blocks.length} completed phases`;
  const contextLabel = blocks.length === 1 ? "range" : "pass";

  pi.appendEntry<{ text: string }>("dcp-receipt", {
    text: [
      `▣ DCP | -~${formatTokenCount(totalRawTokens)} removed, +~${formatTokenCount(totalBlockTokens)} ${summaryLabel}`,
      "",
      bar,
      compressionLabel,
      rangeLabel,
      `→ Items: ${totalMessages} messages and ${totalTools} tool calls compressed`,
      `→ User prompts preserved: ${totalPrompts}; exact evidence: ~${formatTokenCount(totalEvidenceTokens)}`,
      `→ Raw context after this ${contextLabel}: ~${formatTokenCount(rawContextAfter)}`,
      `░ summarized completed work · █ raw context retained`,
    ].join("\n"),
  });
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${tokens}`;
}

function renderRangeBar(summarizedTokens: number, retainedTokens: number, width = 42): string {
  const total = summarizedTokens + retainedTokens;
  if (total <= 0) return `│${"░".repeat(width)}│`;
  const summarizedWidth = Math.max(1, Math.min(width - 1, Math.round((summarizedTokens / total) * width)));
  return `│${"░".repeat(summarizedWidth)}${"█".repeat(width - summarizedWidth)}│`;
}

export function retireVirtualBlock(pi: ExtensionAPI, blockId: string): void {
  pi.appendEntry(DCP_BLOCK_RETIRED_TYPE, { version: 1, blockId });
}

const MAX_BLOCKS_PER_RELIEF = 6;
const MIN_NET_RELIEF_TOKENS = 1_000;
const MIN_NET_RELIEF_RATIO = 0.25;

/**
 * Create as many bounded summaries as needed to free approximately
 * `freeTargetTokens`, one range at a time. A single range is capped by
 * maxChunkInputTokens, so real pressure (e.g. 300K over threshold) requires
 * several blocks in one pass rather than one under-sized fold.
 */
export async function relieveContextPressure(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: DcpConfig,
  protection: ResolvedProtection,
  blocks: VirtualCompressionBlock[],
  focus: string | undefined,
  thinkingLevel: ThinkingLevel,
  freeTargetTokens: number,
  showReceipts: boolean,
): Promise<{ created: VirtualCompressionBlock[]; freedTokens: number }> {
  const created: VirtualCompressionBlock[] = [];
  const firstNumber = blocks.length + 1;
  let freedTokens = 0;
  for (let i = 0; i < MAX_BLOCKS_PER_RELIEF; i++) {
    if (created.length > 0 && freedTokens >= freeTargetTokens) break;
    // Active-prefix relief is the last resort for a single uninterrupted run,
    // never an escalation after completed history was already folded this pass.
    const block = await createVirtualBlock(pi, ctx, config, protection, blocks, focus, thinkingLevel, created.length === 0);
    if (!block) break;
    appendVirtualBlock(pi, block);
    blocks.push(block);
    created.push(block);
    freedTokens += Math.max(0, block.estimatedRawTokens - block.estimatedBlockTokens);
  }
  if (showReceipts && created.length > 0) {
    appendReliefReceipt(pi, created, {
      firstNumber,
      activeWorkingSetTokens: config.contextRelief.activeWorkingSetTokens,
    });
  }
  return { created, freedTokens };
}

export async function createVirtualBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: DcpConfig,
  protection: ResolvedProtection,
  blocks: VirtualCompressionBlock[],
  focus: string | undefined,
  thinkingLevel: ThinkingLevel,
  allowActivePrefix = true,
): Promise<VirtualCompressionBlock | undefined> {
  if (typeof ctx.sessionManager.buildContextEntries !== "function") return undefined;

  let model = ctx.model;
  if (config.compaction.summaryModel) {
    const resolved = resolveModelBySpec(ctx, config.compaction.summaryModel);
    if (resolved) model = resolved;
  }
  if (!model) return undefined;

  const outputLimit = typeof model.maxTokens === "number" && model.maxTokens > 0
    ? Math.min(config.contextRelief.maxChunkSummaryTokens, model.maxTokens)
    : config.contextRelief.maxChunkSummaryTokens;
  // Never build a standalone summary request larger than its target model can
  // accept after reserving the requested completion space.
  const modelInputLimit = typeof model.contextWindow === "number" && model.contextWindow > 0
    ? Math.max(1, model.contextWindow - outputLimit)
    : config.contextRelief.maxChunkInputTokens;
  const branch = ctx.sessionManager.buildContextEntries();
  const range = selectCompressibleRange(
    branch,
    blocks,
    Math.min(config.contextRelief.maxChunkInputTokens, modelInputLimit),
    Math.min(config.contextRelief.targetHeadroomTokens, modelInputLimit),
    config.contextRelief.activeWorkingSetTokens,
    allowActivePrefix,
  );
  if (!range) return undefined;

  // Refuse before spending a summary call: if the projector could not replace
  // this exact range, the block would be created, persisted, and then rejected
  // on every future request forever.
  if (!entryRangeCanBeReplaced(branch, range.startEntryId, range.endEntryId)) return undefined;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return undefined;

  const conversationText = serializeConversation(convertToLlm(range.messages));
  const protectedResult = buildProtectedAppendix(range.messages, {
    ...config.compaction,
    protectUserMessages: false,
    maxProtectedTokens: config.contextRelief.exactEvidenceTokens,
  }, protection);
  const evidence = selectExactEvidence(range.messages, protectedResult.text, config.contextRelief.exactEvidenceTokens);
  const { systemPrompt, userPrompt } = renderRangeSummaryPrompt({
    kind: range.kind,
    conversationText,
    retainedContext: range.kind === "active-prefix"
      ? serializeConversation(convertToLlm(range.retainedMessages))
      : undefined,
    exactEvidence: evidence || undefined,
    focus,
  });
  const reasoning = model.reasoning && thinkingLevel !== "off" ? thinkingLevel : undefined;
  if (typeof model.contextWindow === "number" && model.contextWindow > 0 &&
      estimateTextTokens(userPrompt) + outputLimit > model.contextWindow) return undefined;

  try {
    const response = await completeSimple(
      model,
      {
        systemPrompt,
        messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        maxTokens: outputLimit,
        reasoning,
        signal: ctx.signal,
      },
    );
    if (response.stopReason === "error") return undefined;
    const summary = response.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n").trim();
    if (!summary || /<\/?think(?:ing)?>/i.test(summary)) return undefined;

    const preserved = collectRealUserMessages(range.messages);
    const composed = appendPreservedUserMessages(summary, range.messages, undefined, config.contextRelief.preservedUserMessageTokens);
    const full = evidence ? `${composed}\n\n## Exact evidence\n\n${evidence}` : composed;
    const estimatedBlockTokens = estimateTextTokens(full);
    const netReliefTokens = range.estimatedRawTokens - estimatedBlockTokens;
    // Tiny wins do not justify a durable summary or a full model call. Require
    // both meaningful absolute relief and a meaningful fraction of the range.
    if (netReliefTokens < MIN_NET_RELIEF_TOKENS ||
        netReliefTokens < range.estimatedRawTokens * MIN_NET_RELIEF_RATIO) return undefined;
    const items = countRangeItems(range.messages);
    return {
      version: 1,
      id: `dcp-block-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      startEntryId: range.startEntryId,
      endEntryId: range.endEntryId,
      anchorEntryId: range.startEntryId,
      rangeKind: range.kind,
      messagesCompressed: items.messages,
      toolsCompressed: items.tools,
      summary: full,
      exactEvidence: evidence,
      preservedUserMessages: preserved,
      estimatedRawTokens: range.estimatedRawTokens,
      retainedRawTokens: range.retainedRawTokens,
      estimatedBlockTokens,
      active: true,
      createdAt: Date.now(),
    };
  } catch {
    return undefined;
  }
}

export function selectExactEvidence(messages: AgentMessage[], protectedText: string, maxTokens: number): string {
  const errors: string[] = [];

  // Newest failures first: they are the most likely unresolved prerequisite.
  for (const message of [...messages].reverse()) {
    if (message.role !== "toolResult") continue;
    const text = extractMessageText(message.content);
    if (!/(error|failed|failure|test|exception|blocked)/i.test(text)) continue;
    const tail = text.length > 4_000 ? `[... earlier output omitted ...]\n${text.slice(-4_000)}` : text;
    errors.push(`### Error or test evidence\n${tail}`);
  }

  const maxChars = Math.max(1_000, maxTokens * 4);
  return [...errors, ...(protectedText ? [protectedText] : [])].join("\n\n").slice(0, maxChars);
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text")
    .map((part) => String((part as { text?: unknown }).text ?? ""))
    .join("\n");
}

function countRangeItems(messages: AgentMessage[]): { messages: number; tools: number } {
  let messagesCompressed = 0;
  let toolsCompressed = 0;
  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant") messagesCompressed++;
    if (message.role === "assistant") {
      for (const part of message.content) if (part.type === "toolCall") toolsCompressed++;
    }
  }
  return { messages: messagesCompressed, tools: toolsCompressed };
}

function resolveModelBySpec(ctx: ExtensionContext, spec: string) {
  const slash = spec.indexOf("/");
  if (slash <= 0) return undefined;
  return ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
}

function readBlockId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const id = (data as { blockId?: unknown }).blockId;
  return typeof id === "string" ? id : undefined;
}

