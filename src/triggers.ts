import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionInitiator, DcpConfig, TriggerState } from "./types.ts";
import { resolveEffectiveThreshold } from "./config.ts";
import { notify, debug } from "./ui.ts";

// Pi-only addition (not in upstream OpenCode DCP): ctx.compact() always aborts
// whatever the agent is currently doing before it compacts. If the dual-threshold
// trigger fires while a multi-step tool-call run is still active, this nudge is
// re-sent after compaction completes so the interrupted task keeps going instead
// of stopping cold. Gated by triggers.endOfTurn.autoContinue (default true).
const AUTO_CONTINUE_PROMPT = "Resuming from context compression, continue current task";

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
  pi: ExtensionAPI,
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

  // Snapshot now: ctx.compact() is about to abort whatever is running. If the
  // agent was actively mid-run, remember it so we can resume it afterward.
  const wasActive = !ctx.isIdle();

  debug(ctx, config, `Triggering compaction (initiator: ${initiator}, focus: ${focus.slice(0, 60)}...)`);

  ctx.compact({
    customInstructions: focus,
    onComplete: () => {
      // session_compact emits the detailed completion notification and bar.
      state.isCompacting = false;
      state.turnsSinceCompaction = 0;
      state.pendingInitiator = null;

      if (config.triggers.endOfTurn.autoContinue && wasActive && !ctx.hasPendingMessages()) {
        pi.sendUserMessage(AUTO_CONTINUE_PROMPT);
      }
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
