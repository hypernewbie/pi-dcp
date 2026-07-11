import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { CompactionPreview } from "./types.ts";

const PRUNED = "░";
const SPLIT_PREFIX = "⣿";
const KEPT = "█";

/** Capture the logical shape of the context immediately before compaction. */
export function createCompactionPreview(event: SessionBeforeCompactEvent): CompactionPreview {
  const { preparation, branchEntries } = event;
  const firstKeptIndex = branchEntries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);

  const summarized = preparation.messagesToSummarize.length;
  const splitPrefix = preparation.turnPrefixMessages.length;
  const kept = firstKeptIndex >= 0
    ? countContextEntries(branchEntries.slice(firstKeptIndex))
    : 0;

  return {
    summarized,
    splitPrefix,
    kept,
    tokensBefore: preparation.tokensBefore,
    reason: event.reason,
  };
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

  const lengths = allocateWidths(parts.map((part) => part.count), width, total);
  let bar = "";
  for (let i = 0; i < parts.length; i++) {
    bar += parts[i].glyph.repeat(lengths[i]);
  }
  return `│${bar}│`;
}

export function formatCompactionNotification(
  preview: CompactionPreview,
  event: SessionCompactEvent,
): string {
  const bar = renderCompactionBar(preview);
  const reason = event.reason === "threshold" ? "threshold" : event.reason;
  const parts = [
    `▣ DCP | Compacted ~${formatTokens(preview.tokensBefore)}`,
    `\n\n${bar}`,
    `\n░ summarized: ${preview.summarized}`,
    `  ⣿ split prefix: ${preview.splitPrefix}`,
    `  █ kept: ${preview.kept}`,
    `\n→ Reason: ${reason}`,
  ];
  return parts.join("");
}

export function notifyCompaction(
  ctx: ExtensionContext,
  preview: CompactionPreview | undefined,
  event: SessionCompactEvent,
  detailed: boolean,
): void {
  if (!preview || !detailed || !ctx.hasUI) return;
  ctx.ui.notify(formatCompactionNotification(preview, event), "info");
}

function countContextEntries(entries: Array<{ type: string }>): number {
  return entries.reduce((count, entry) => {
    // Session headers and compaction metadata are not individual context parts.
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

  // Give leftover cells to the largest fractional parts, preserving the
  // visible ordering of the three sections.
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
