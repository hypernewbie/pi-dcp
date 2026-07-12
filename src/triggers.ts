import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionInitiator, DcpConfig, TriggerState } from "./types.ts";
import { resolveEffectiveThreshold } from "./config.ts";
import { notify, debug } from "./ui.ts";

export function shouldTriggerCompaction(
  config: DcpConfig,
  state: TriggerState,
  tokens: number,
  contextWindow: number,
): boolean {
  if (!config.enabled || !config.triggers.endOfTurn.enabled) return false;

  const threshold = resolveEffectiveThreshold(
    config.triggers.endOfTurn.tokenThresholdPercent,
    config.triggers.endOfTurn.tokenThresholdAbsolute,
    contextWindow,
  );
  if (threshold === null) return false;
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
  initiator: CompactionInitiator = "dcp-command",
): void {
  if (state.isCompacting) return;

  const focusIsUserSupplied = typeof customInstructions === "string" && customInstructions.trim().length > 0;
  const focus = customInstructions ?? config.triggers.endOfTurn.focus;
  state.isCompacting = true;
  state.pendingInitiator = initiator;
  state.pendingFocusIsExplicit = focusIsUserSupplied;

  debug(ctx, config, `Triggering compaction (initiator: ${initiator}, focus: ${focus.slice(0, 60)}...)`);

  ctx.compact({
    customInstructions: focus,
    onComplete: () => {
      // session_compact emits the detailed completion notification and bar.
      state.isCompacting = false;
      state.turnsSinceCompaction = 0;
      state.pendingInitiator = null;
    },
    onError: (error) => {
      state.isCompacting = false;
      state.pendingInitiator = null;
      notify(ctx, config, `Compaction failed: ${error.message}`, "error");
    },
  });
}

export function recordCompactionCompleted(state: TriggerState, tokens: number | null): void {
  state.isCompacting = false;
  state.turnsSinceCompaction = 0;
  state.tokensAtLastCompaction = tokens ?? null;
  state.pendingInitiator = null;
}

export function resetTriggerState(state: TriggerState): void {
  state.isCompacting = false;
  state.turnsSinceCompaction = 0;
  state.tokensAtLastCompaction = null;
  state.pendingInitiator = null;
  state.pendingFocusIsExplicit = false;
  state.lastCompaction = undefined;
}

export function consumePendingInitiator(state: TriggerState): CompactionInitiator {
  const pending = state.pendingInitiator ?? "pi-native";
  state.pendingInitiator = null;
  return pending;
}
