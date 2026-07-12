import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionInitiator, CompactionPreview, DcpConfig } from "./types.ts";
import { estimateTextTokens } from "./utils.ts";

const PRUNED = "░";
const SPLIT_PREFIX = "⣿";
const KEPT = "█";

/**
 * Capture the logical shape of the context immediately before compaction, plus
 * OpenCode-DCP-faithful compression facts (removed tokens, message/tool counts).
 * These facts are computed from `event.preparation` alone, so they are available
 * for ANY compaction (DCP-triggered or Pi-native) — they describe what Pi is
 * about to discard, independent of who ultimately writes the summary.
 */
export function createCompactionPreview(
  event: SessionBeforeCompactEvent,
  initiator: CompactionInitiator,
  focusIsUserSupplied: boolean,
): CompactionPreview {
  const { preparation, branchEntries, customInstructions } = event;
  const firstKeptIndex = branchEntries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);

  const summarized = preparation.messagesToSummarize.length;
  const splitPrefix = preparation.turnPrefixMessages.length;
  const kept = firstKeptIndex >= 0 ? countContextEntries(branchEntries.slice(firstKeptIndex)) : 0;

  const removedMessages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
  const removedTokensThisRun = removedMessages.reduce((sum, m) => sum + estimateTokens(m), 0);
  const { messagesCompressed, toolsCompressed } = countMessagesAndTools(removedMessages);

  return {
    summarized,
    splitPrefix,
    kept,
    tokensBefore: preparation.tokensBefore,
    reason: event.reason,
    initiator,
    removedTokensThisRun,
    messagesCompressed,
    toolsCompressed,
    focus: customInstructions,
    focusIsUserSupplied,
  };
}

/** Count conversational turns (user/assistant) vs. tool calls within them. */
function countMessagesAndTools(messages: AgentMessage[]): { messagesCompressed: number; toolsCompressed: number } {
  let messagesCompressed = 0;
  let toolsCompressed = 0;
  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant") {
      messagesCompressed++;
    }
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") toolsCompressed++;
      }
    }
  }
  return { messagesCompressed, toolsCompressed };
}

function getInitiatorLabel(initiator: CompactionInitiator): string {
  return initiator === "pi-native" ? "PI COMPACT" : "DCP COMPRESS";
}

function getReasonLabel(initiator: CompactionInitiator, hostReason: "manual" | "threshold" | "overflow"): string {
  if (initiator === "dcp-command") return "command";
  if (initiator === "dcp-dual-threshold") return "dual-threshold";
  return hostReason;
}

function getSummaryProviderLabel(fromExtension: boolean): string {
  return fromExtension ? "DCP summary" : "Pi default summary";
}

/**
 * Render a DCP-style part bar:
 *
 *   │░░░░░░░░⣿⣿████████████████████████│
 *
 * ░ = compressed this run (main history), ⣿ = split-turn prefix compressed
 * this run (a genuine Pi concept: the compaction landed mid-turn, so the
 * unfinished turn's prefix is summarized separately from the rest), █ = kept.
 */
export function renderCompactionBar(preview: CompactionPreview, width = 50): string {
  const parts = [
    { count: preview.summarized, glyph: PRUNED },
    { count: preview.splitPrefix, glyph: SPLIT_PREFIX },
    { count: preview.kept, glyph: KEPT },
  ];
  const total = parts.reduce((sum, part) => sum + part.count, 0);

  if (total <= 0) return `│${PRUNED.repeat(width)}│`;

  const lengths = allocateWidths(
    parts.map((part) => part.count),
    width,
    total,
  );
  let bar = "";
  for (let i = 0; i < parts.length; i++) {
    bar += parts[i].glyph.repeat(lengths[i]);
  }
  return `│${bar}│`;
}

export interface DcpRunInfo {
  runNumber: number;
  cumulativeRemovedTokens: number;
}

export function formatCompactionNotification(
  preview: CompactionPreview,
  event: SessionCompactEvent,
  dcpRun: DcpRunInfo | undefined,
  showCompression: boolean,
): string {
  const bar = renderCompactionBar(preview);
  const initiatorLabel = getInitiatorLabel(preview.initiator);
  const reasonLabel = getReasonLabel(preview.initiator, event.reason);
  const providerLabel = getSummaryProviderLabel(event.fromExtension);

  const summaryTokensThisRun = estimateTextTokens(event.compactionEntry.summary);
  const removedStr = formatTokens(preview.removedTokensThisRun);
  const summaryStr = formatTokens(summaryTokensThisRun);

  const lines: string[] = [];

  if (dcpRun) {
    // Genuine DCP compression run: OpenCode-faithful cumulative header + per-run line.
    const cumulativeRemovedStr = formatTokens(dcpRun.cumulativeRemovedTokens);
    lines.push(`▣ DCP | -~${cumulativeRemovedStr} removed, +~${summaryStr} summary`);
    lines.push("");
    lines.push(bar);
    lines.push(`▣ Compression #${dcpRun.runNumber} -~${removedStr} removed, +~${summaryStr} summary`);
    lines.push(
      `→ Items: ${preview.messagesCompressed} message${preview.messagesCompressed === 1 ? "" : "s"} and ${preview.toolsCompressed} tool call${preview.toolsCompressed === 1 ? "" : "s"} compressed`,
    );
    const originLabel = preview.initiator === "dcp-command" ? "command" : "dual-threshold";
    let originLine = `→ Origin: ${originLabel}`;
    if (preview.focusIsUserSupplied && preview.focus) {
      originLine += `, focus: "${truncateInline(preview.focus, 80)}"`;
    }
    lines.push(originLine);
    if (preview.splitPrefix > 0) {
      lines.push(`→ Split-turn prefix: ${preview.splitPrefix} message${preview.splitPrefix === 1 ? "" : "s"}, summarized separately`);
    }
    if (showCompression) {
      lines.push(`→ Compression (~${summaryStr}): ${event.compactionEntry.summary}`);
    }
  } else {
    // Not a genuine DCP compression run (Pi-native, or DCP requested but Pi's
    // default summary was used after a fallback). Show the same universal
    // facts, but do not claim a DCP-run identity or cumulative totals DCP
    // never tracked.
    lines.push(`▣ ${initiatorLabel} · ${reasonLabel} · ${providerLabel}`);
    lines.push("");
    lines.push(bar);
    lines.push(`→ Removed: ~${removedStr}, Summary: ~${summaryStr}`);
    lines.push(
      `→ Items: ${preview.messagesCompressed} message${preview.messagesCompressed === 1 ? "" : "s"} and ${preview.toolsCompressed} tool call${preview.toolsCompressed === 1 ? "" : "s"} compacted`,
    );
    if (preview.splitPrefix > 0) {
      lines.push(`→ Split-turn prefix: ${preview.splitPrefix} message${preview.splitPrefix === 1 ? "" : "s"}, summarized separately`);
    }
  }

  return lines.join("\n");
}

export function formatMinimalNotification(
  preview: CompactionPreview,
  event: SessionCompactEvent,
  dcpRun: DcpRunInfo | undefined,
): string {
  const initiatorLabel = getInitiatorLabel(preview.initiator);
  const reasonLabel = getReasonLabel(preview.initiator, event.reason);
  const providerLabel = getSummaryProviderLabel(event.fromExtension);

  if (dcpRun) {
    const summaryTokensThisRun = estimateTextTokens(event.compactionEntry.summary);
    const cumulativeRemovedStr = formatTokens(dcpRun.cumulativeRemovedTokens);
    const summaryStr = formatTokens(summaryTokensThisRun);
    return `▣ DCP | -~${cumulativeRemovedStr} removed, +~${summaryStr} summary — Compression #${dcpRun.runNumber}`;
  }

  return `▣ ${initiatorLabel} · ${reasonLabel} · ${providerLabel}`;
}

export function notifyCompaction(
  ctx: ExtensionContext,
  preview: CompactionPreview | undefined,
  event: SessionCompactEvent,
  config: DcpConfig,
  dcpRun: DcpRunInfo | undefined,
): void {
  if (config.notification === "off") return;
  if (!ctx.hasUI) return;

  if (!preview) {
    // Fallback: no captured preview (should not normally happen), emit a
    // truthful minimal line using only what SessionCompactEvent guarantees.
    const label = event.fromExtension ? "DCP summary" : "Pi default summary";
    ctx.ui.notify(`▣ PI COMPACT · ${event.reason} · ${label}`, "info");
    return;
  }

  if (config.notification === "minimal") {
    ctx.ui.notify(formatMinimalNotification(preview, event, dcpRun), "info");
    return;
  }

  ctx.ui.notify(formatCompactionNotification(preview, event, dcpRun, config.compaction.showCompression), "info");
}

function countContextEntries(entries: Array<{ type: string }>): number {
  return entries.reduce((count, entry) => {
    if (entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary") {
      return count + 1;
    }
    return count;
  }, 0);
}

function allocateWidths(counts: number[], width: number, total: number): number[] {
  const raw = counts.map((count) => (count / total) * width);
  const widths = raw.map(Math.floor);
  let remaining = width - widths.reduce((sum, value) => sum + value, 0);

  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (const item of order) {
    if (remaining <= 0) break;
    widths[item.index]++;
    remaining--;
  }

  return widths;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${tokens}`;
}

function truncateInline(s: string, maxLen: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 1) + "…";
}
