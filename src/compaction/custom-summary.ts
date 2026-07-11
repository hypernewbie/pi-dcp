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
  const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary, fileOps } = preparation;

  const allMessages = [...messagesToSummarize, ...turnPrefixMessages];

  // Resolve summarization model: configured name, or current conversation model.
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
  const protectedAppendix = buildProtectedAppendix(allMessages, config.compaction, protection);

  const readFiles = [...fileOps.read].filter((f) => !fileOps.edited.has(f) && !fileOps.written.has(f)).sort();
  const modifiedFiles = [...new Set([...fileOps.edited, ...fileOps.written])].sort();

  const { systemPrompt, userPrompt } = renderSummaryPrompt({
    conversationText,
    previousSummary,
    customInstructions,
    protectedAppendix,
    readFiles,
    modifiedFiles,
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

    const summary = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
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
  // Try "provider/id" split, which is the supported lookup API.
  const slash = spec.indexOf("/");
  if (slash > 0) {
    const provider = spec.slice(0, slash);
    const id = spec.slice(slash + 1);
    const found = ctx.modelRegistry.find(provider, id);
    if (found) return found;
  }
  return undefined;
}
