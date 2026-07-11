import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DcpConfig } from "./types.ts";
import { resolveThreshold } from "./utils.ts";

export interface BarMetrics {
  tokens: number | null;
  contextWindow: number;
  threshold: number;
  nudgeThreshold: number;
}

export function getMetrics(ctx: ExtensionContext, config: DcpConfig): BarMetrics | undefined {
  const usage = ctx.getContextUsage();
  if (!usage) return undefined;

  return {
    tokens: usage.tokens,
    contextWindow: usage.contextWindow,
    threshold: resolveThreshold(config.triggers.endOfTurn.tokenThreshold, usage.contextWindow),
    nudgeThreshold: resolveThreshold(config.triggers.nudge.tokenThreshold, usage.contextWindow),
  };
}

/**
 * Render an ASCII progress bar for context usage.
 *
 *   [██████░░░░░░░░░░░░░░] 312k / 1.0M (31%)  │ threshold: 250k
 */
export function renderAsciiBar(metrics: BarMetrics): string {
  const { tokens, contextWindow, threshold } = metrics;
  const width = 24;

  const current = tokens ?? 0;
  const pct = Math.min(100, Math.max(0, Math.round((current / contextWindow) * 100)));
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;

  const bar = "█".repeat(filled) + "░".repeat(empty);
  const currentStr = formatTokens(current);
  const windowStr = formatTokens(contextWindow);
  const thresholdStr = formatTokens(threshold);

  if (tokens === null) {
    return `[${bar}] ? / ${windowStr}  │ threshold: ${thresholdStr}`;
  }

  return `[${bar}] ${currentStr} / ${windowStr} (${pct}%)  │ threshold: ${thresholdStr}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

export function renderStatusLine(ctx: ExtensionContext, config: DcpConfig): string | undefined {
  const metrics = getMetrics(ctx, config);
  if (!metrics) return undefined;

  const bar = renderAsciiBar(metrics);
  const parts: string[] = [bar];

  if (config.compaction.customSummary) parts.push("custom-summary");
  if (config.pruning.enabled) parts.push("pruning");

  return `dcp: ${parts.join("  ·  ")}`;
}

export function updateStatus(ctx: ExtensionContext, config: DcpConfig): void {
  const line = renderStatusLine(ctx, config);
  if (line) {
    ctx.ui.setStatus("dcp", line);
  }
}
