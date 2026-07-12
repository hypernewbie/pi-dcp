import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { CompactionInitiator, CompactionPreview, DcpConfig } from "./types.ts";

const PRUNED = "░";
const SPLIT_PREFIX = "⣿";
const KEPT = "█";

/** Capture the logical shape of the context immediately before compaction. */
export function createCompactionPreview(
  event: SessionBeforeCompactEvent,
  initiator: CompactionInitiator,
): CompactionPreview {
  const { preparation, branchEntries } = event;
  const firstKeptIndex = branchEntries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);

  const summarized = preparation.messagesToSummarize.length;
  const splitPrefix = preparation.turnPrefixMessages.length;
  const kept = firstKeptIndex >= 0 ? countContextEntries(branchEntries.slice(firstKeptIndex)) : 0;

  return {
    summarized,
    splitPrefix,
    kept,
    tokensBefore: preparation.tokensBefore,
    reason: event.reason,
    initiator,
  };
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
 * ░ = summarized history, ⣿ = split-turn prefix summarized separately,
 * █ = retained recent context.
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

export interface CompactionReceipt {
  fileRefs?: number;
  protectedBlocks?: number;
  subagentArtifacts?: number;
}

export function formatCompactionNotification(
  preview: CompactionPreview,
  event: SessionCompactEvent,
  receipt?: CompactionReceipt,
): string {
  const bar = renderCompactionBar(preview);
  const initiatorLabel = getInitiatorLabel(preview.initiator);
  const reasonLabel = getReasonLabel(preview.initiator, event.reason);
  const providerLabel = getSummaryProviderLabel(event.fromExtension);
  const tokens = `~${formatTokens(preview.tokensBefore)}`;

  const lines = [
    `▣ ${initiatorLabel} · ${reasonLabel} · ${providerLabel} (${tokens})`,
    ``,
    `${bar}`,
    `${PRUNED} summarized: ${preview.summarized}  ${SPLIT_PREFIX} split prefix: ${preview.splitPrefix}  ${KEPT} kept: ${preview.kept}`,
  ];

  lines.push("", formatReceipt(receipt, event.fromExtension));

  return lines.join("\n");
}

export function formatMinimalNotification(
  initiator: CompactionInitiator,
  hostReason: "manual" | "threshold" | "overflow",
  fromExtension: boolean,
  tokensBefore?: number,
): string {
  const initiatorLabel = getInitiatorLabel(initiator);
  const reasonLabel = getReasonLabel(initiator, hostReason);
  const providerLabel = getSummaryProviderLabel(fromExtension);
  const tokens = tokensBefore != null ? ` (~${formatTokens(tokensBefore)})` : "";
  return `▣ ${initiatorLabel} · ${reasonLabel} · ${providerLabel}${tokens}`;
}

function formatReceipt(receipt: CompactionReceipt | undefined, fromExtension: boolean): string {
  if (!fromExtension) {
    return "receipt: Pi default summary — DCP carry-forward details unavailable";
  }

  const fileRefs = receipt?.fileRefs ?? 0;
  const protectedBlocks = receipt?.protectedBlocks ?? 0;
  const subagentArtifacts = receipt?.subagentArtifacts ?? 0;
  return `receipt: ${fileRefs} file refs · ${protectedBlocks} protected · ${subagentArtifacts} subagent artifact${subagentArtifacts === 1 ? "" : "s"}`;
}

export function notifyCompaction(
  ctx: ExtensionContext,
  preview: CompactionPreview | undefined,
  event: SessionCompactEvent,
  config: DcpConfig,
  receipt?: CompactionReceipt,
): void {
  if (config.notification === "off") return;
  if (!ctx.hasUI) return;

  const tokensBefore = preview?.tokensBefore ?? event.compactionEntry?.tokensBefore;

  if (!preview) {
    // Fallback: still emit a truthful one-line result.
    const fallbackInitiator: CompactionInitiator = "pi-native";
    const minimal = formatMinimalNotification(
      fallbackInitiator,
      event.reason,
      event.fromExtension,
      tokensBefore,
    );
    ctx.ui.notify(minimal, "info");
    return;
  }

  if (config.notification === "minimal") {
    const minimal = formatMinimalNotification(
      preview.initiator,
      event.reason,
      event.fromExtension,
      preview.tokensBefore,
    );
    ctx.ui.notify(minimal, "info");
    return;
  }

  // detailed
  ctx.ui.notify(formatCompactionNotification(preview, event, receipt), "info");
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
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return `${tokens}`;
}
