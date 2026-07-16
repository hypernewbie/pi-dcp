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
  const rawWorkingSet = Math.max(0, block.retainedRawTokens || details.activeWorkingSetTokens);
  const bar = renderRangeBar(block.estimatedRawTokens, rawWorkingSet);
  const mode = block.rangeKind === "active-prefix" ? "active-prefix" : "completed phase";
  pi.appendEntry<{ text: string }>("dcp-receipt", {
    text: [
      `▣ DCP COMPACT #${details.number} · ${mode}`,
      "",
      bar,
      `░ summarized completed work · █ raw working set retained`,
      `→ Range: ${block.startEntryId}..${block.endEntryId}`,
      `→ Raw replaced: ~${block.estimatedRawTokens.toLocaleString()} tokens; summary: ~${block.estimatedBlockTokens.toLocaleString()} tokens`,
      `→ Items: ${block.messagesCompressed} messages and ${block.toolsCompressed} tool calls`,
      `→ User prompts preserved: ${block.preservedUserMessages.length}; exact evidence: ~${estimateTextTokens(block.exactEvidence).toLocaleString()} tokens`,
      `→ Raw working set retained: ~${rawWorkingSet.toLocaleString()} tokens`,
    ].join("\n"),
  });
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

export async function createVirtualBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: DcpConfig,
  protection: ResolvedProtection,
  blocks: VirtualCompressionBlock[],
  focus: string | undefined,
  thinkingLevel: ThinkingLevel,
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
  );
  if (!range) return undefined;

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
    // A summary that is not smaller cannot provide context relief. Leave the
    // raw range intact and let later growth produce a better candidate.
    if (estimatedBlockTokens >= range.estimatedRawTokens) return undefined;
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

