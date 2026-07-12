import { completeSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DcpConfig, ResolvedProtection } from "../types.ts";
import { notify } from "../ui.ts";
import { renderSummaryPrompt } from "./prompt.ts";
import { buildProtectedAppendix } from "./protected-appendix.ts";

export async function handleSessionBeforeCompact(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  config: DcpConfig,
  protection: ResolvedProtection,
): Promise<{ compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown } } | undefined> {
  if (!config.enabled || !config.compaction.customSummary) return undefined;

  const { preparation, signal, customInstructions } = event;
  const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

  const allMessages = [...messagesToSummarize, ...turnPrefixMessages];

  let model = ctx.model;
  if (config.compaction.summaryModel) {
    const resolved = resolveModelBySpec(ctx, config.compaction.summaryModel);
    if (resolved) model = resolved;
    else {
      notify(ctx, config, `Could not resolve summary model "${config.compaction.summaryModel}", using current model`, "warning");
    }
  }

  if (!model) {
    notify(ctx, config, "No model available for DCP summary, falling back to default compaction", "warning");
    return undefined;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    notify(ctx, config, `DCP summary auth failed: ${auth.error}`, "warning");
    return undefined;
  }

  const conversationText = serializeConversation(convertToLlm(allMessages));
  const protectedResult = buildProtectedAppendix(allMessages, config.compaction, protection);

  const cumulativeFileOps = collectCumulativeFileOps(event);
  const readFiles = [...cumulativeFileOps.read]
    .filter((f) => !cumulativeFileOps.modified.has(f))
    .sort();
  const modifiedFiles = [...cumulativeFileOps.modified].sort();

  // Merge file refs from protected collection (e.g., write/edit paths that were protected)
  const allFileRefs = [...new Set([...readFiles, ...modifiedFiles, ...protectedResult.collection.fileReferences])].sort();
  // For prompt we separate read vs modified, but we have full sets already.
  // Use the cumulative sets for read/modified, and protected artifacts for artifacts section.
  const artifacts = [...new Set([...protectedResult.collection.subagentArtifacts])].sort();

  const { systemPrompt, userPrompt } = renderSummaryPrompt({
    conversationText,
    previousSummary,
    customInstructions,
    protectedAppendix: protectedResult.text,
    readFiles,
    modifiedFiles,
    subagentArtifacts: artifacts,
  });

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
        maxTokens: config.compaction.maxSummaryTokens,
        signal,
      },
    );

    const summary = (response.content as Array<{ type: string; text?: string }>)
      .filter((c): c is { type: string; text: string } => typeof (c as any).text === "string" && (c as any).type === "text")
      .map((c) => c.text)
      .join("\n");

    if (!summary.trim()) {
      notify(ctx, config, "DCP compaction summary was empty, falling back to default", "warning");
      return undefined;
    }

    return {
      compaction: {
        summary,
        firstKeptEntryId,
        tokensBefore,
        details: {
          readFiles,
          modifiedFiles,
          artifacts,
          protectedBlocks: protectedResult.collection.items.length,
          fileRefs: allFileRefs.length,
          subagentArtifacts: artifacts.length,
          truncatedProtected: protectedResult.collection.truncatedCount,
          skippedProtected: protectedResult.collection.skippedCount,
          fromDcp: true,
        },
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notify(ctx, config, `DCP compaction summary failed: ${message}`, "error");
    return undefined;
  }
}

function resolveModelBySpec(ctx: ExtensionContext, spec: string) {
  const slash = spec.indexOf("/");
  if (slash > 0) {
    const provider = spec.slice(0, slash);
    const id = spec.slice(slash + 1);
    const found = ctx.modelRegistry.find(provider, id);
    if (found) return found;
  }
  return undefined;
}

interface CumulativeFileOps {
  read: Set<string>;
  modified: Set<string>;
}

function collectCumulativeFileOps(event: SessionBeforeCompactEvent): CumulativeFileOps {
  const read = new Set<string>(event.preparation.fileOps.read);
  const modified = new Set<string>([
    ...event.preparation.fileOps.edited,
    ...event.preparation.fileOps.written,
  ]);

  for (const entry of event.branchEntries) {
    if (entry.type !== "compaction" && entry.type !== "branch_summary") continue;
    const details = entry.details;
    if (!details || typeof details !== "object") continue;
    const value = details as { readFiles?: unknown; modifiedFiles?: unknown; artifacts?: unknown };
    addStrings(read, value.readFiles);
    addStrings(modified, value.modifiedFiles);
    // artifacts are handled separately but we include file paths if present
  }

  for (const message of [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages]) {
    extractFileOpsFromMessage(message, read, modified);
  }

  return { read, modified };
}

function addStrings(target: Set<string>, value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) target.add(item);
  }
}

function extractFileOpsFromMessage(
  message: { role?: string; content?: unknown },
  read: Set<string>,
  modified: Set<string>,
): void {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return;

  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    const toolCall = block as { type?: string; name?: string; arguments?: unknown };
    if (toolCall.type !== "toolCall" || typeof toolCall.name !== "string") continue;
    const args = toolCall.arguments && typeof toolCall.arguments === "object"
      ? toolCall.arguments as Record<string, unknown>
      : {};

    const directPath = typeof args.path === "string"
      ? args.path
      : typeof args.filePath === "string"
        ? args.filePath
        : undefined;

    if (toolCall.name === "read" && directPath) read.add(directPath);
    if ((toolCall.name === "write" || toolCall.name === "edit") && directPath) modified.add(directPath);
  }
}
