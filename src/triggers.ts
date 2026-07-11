import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DcpConfig, TriggerState } from "./types.ts";
import { resolveThreshold } from "./utils.ts";
import { notify, debug } from "./ui.ts";

export function shouldTriggerCompaction(
  config: DcpConfig,
  state: TriggerState,
  tokens: number,
  contextWindow: number,
): boolean {
  if (!config.enabled || !config.triggers.endOfTurn.enabled) return false;

  const threshold = resolveThreshold(config.triggers.endOfTurn.tokenThreshold, contextWindow);
  if (tokens <= threshold) return false;

  if (state.isCompacting) return false;
  if (state.turnsSinceCompaction < config.triggers.endOfTurn.cooldownTurns) return false;

  // Avoid futile re-compaction: only retry if context has grown meaningfully
  // since the last compaction, or if we have no prior measurement.
  const minGrowth = Math.max(1, Math.floor(threshold * 0.05));
  if (
    state.tokensAtLastCompaction !== null &&
    tokens < state.tokensAtLastCompaction + minGrowth
  ) {
    return false;
  }

  return true;
}

export function triggerCompaction(
  ctx: ExtensionContext,
  config: DcpConfig,
  state: TriggerState,
  customInstructions?: string,
): void {
  if (state.isCompacting) return;

  const focus = customInstructions ?? config.triggers.endOfTurn.focus;
  state.isCompacting = true;

  debug(ctx, config, `Triggering compaction (focus: ${focus.slice(0, 60)}...)`);

  ctx.compact({
    customInstructions: focus,
    onComplete: () => {
      state.isCompacting = false;
      state.turnsSinceCompaction = 0;
      notify(ctx, config, "Compacted context", "info");
    },
    onError: (error) => {
      state.isCompacting = false;
      notify(ctx, config, `Compaction failed: ${error.message}`, "error");
    },
  });
}

export function recordCompactionCompleted(state: TriggerState, tokens: number | null): void {
  state.isCompacting = false;
  state.turnsSinceCompaction = 0;
  state.tokensAtLastCompaction = tokens ?? null;
}

export function resetTriggerState(state: TriggerState): void {
  state.isCompacting = false;
  state.turnsSinceCompaction = 0;
  state.tokensAtLastCompaction = null;
}
