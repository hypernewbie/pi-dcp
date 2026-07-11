import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { createTriggerState } from "./state.ts";
import { buildNudge } from "./nudges.ts";
import {
  shouldTriggerCompaction,
  triggerCompaction,
  recordCompactionCompleted,
  resetTriggerState,
} from "./triggers.ts";
import { registerCommands } from "./commands.ts";
import { handleSessionBeforeCompact } from "./compaction/custom-summary.ts";
import { resolveProtection } from "./protection.ts";
import { pruneContext } from "./context-pruner.ts";
import { updateStatus } from "./ascii-bar.ts";
import { createCompactionPreview, notifyCompaction } from "./compaction-bar.ts";
import { notify, debug } from "./ui.ts";
import type { DcpConfig, LoadedConfig, ResolvedProtection, RuntimeState, TriggerState } from "./types.ts";

export default function dcpExtension(pi: ExtensionAPI): void {
  const initial = loadConfig(process.cwd(), true);
  const state: RuntimeState = {
    config: initial.config,
    loaded: initial,
    triggerState: createTriggerState(),
    protection: resolveProtection(
      initial.config.pruning,
      initial.config.compaction,
      initial.config.protectedTools,
      initial.config.protectedFilePatterns,
    ),
  };

  registerCommands(pi, state);

  pi.on("session_start", (_event, ctx) => {
    const fresh = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    Object.assign(state.config, fresh.config);
    state.loaded.globalPath = fresh.globalPath;
    state.loaded.projectPath = fresh.projectPath;
    state.loaded.warnings = fresh.warnings;
    state.protection = resolveProtection(
      state.config.pruning,
      state.config.compaction,
      state.config.protectedTools,
      state.config.protectedFilePatterns,
    );
    resetTriggerState(state.triggerState);
    state.compactionPreview = undefined;
    updateStatus(ctx, state.config);

    for (const warning of fresh.warnings) {
      notify(ctx, state.config, warning, "warning");
    }
  });

  pi.on("turn_end", (_event, ctx) => {
    if (!state.config.enabled || !state.config.triggers.endOfTurn.enabled) return;

    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null) return;

    state.triggerState.turnsSinceCompaction++;

    if (shouldTriggerCompaction(state.config, state.triggerState, usage.tokens, usage.contextWindow)) {
      triggerCompaction(ctx, state.config, state.triggerState);
    }
    updateStatus(ctx, state.config);
  });

  pi.on("session_compact", (event, ctx) => {
    const usage = ctx.getContextUsage();
    recordCompactionCompleted(state.triggerState, usage?.tokens ?? null);
    notifyCompaction(ctx, state.compactionPreview, event, state.config.notification === "detailed");
    state.compactionPreview = undefined;
    updateStatus(ctx, state.config);
  });

  pi.on("before_agent_start", (event, ctx) => {
    return buildNudge(event, ctx, state.config, state.triggerState);
  });

  // Context-event pruning is experimental and disabled by default.
  pi.on("context", (event, ctx) => {
    if (!state.config.enabled || !state.config.pruning.enabled) return undefined;

    const result = pruneContext(event.messages, state.config.pruning, state.protection);
    const total =
      result.stats.deduplicated +
      result.stats.errorsPurged +
      result.stats.droppedByMaxMessages +
      result.stats.droppedByMaxUserTurns;

    if (total > 0) {
      debug(
        ctx,
        state.config,
        `context pruning: ${result.stats.deduplicated} dedup, ${result.stats.errorsPurged} errors, ${result.stats.droppedByMaxMessages} maxMessages, ${result.stats.droppedByMaxUserTurns} maxUserTurns`,
      );
    }

    return { messages: result.messages };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    state.compactionPreview = createCompactionPreview(event);
    return handleSessionBeforeCompact(event, ctx, state.config, state.protection);
  });
}
