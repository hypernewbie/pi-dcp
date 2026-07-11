import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveThreshold } from "./utils.ts";
import { triggerCompaction, resetTriggerState } from "./triggers.ts";
import { notify, debug } from "./ui.ts";
import type { RuntimeState } from "./types.ts";

export function registerCommands(pi: ExtensionAPI, state: RuntimeState): void {
  pi.registerCommand("dcp", {
    description: "pi-dcp: dynamic context pruning commands",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [subcommand, ...rest] = trimmed.split(/\s+/);
      const restArgs = rest.join(" ").trim();

      switch (subcommand.toLowerCase()) {
        case "compact":
          return handleCompact(ctx, state, restArgs);
        case "enable":
          return handleEnable(ctx, state);
        case "disable":
          return handleDisable(ctx, state);
        case "config":
          return handleConfig(ctx, state);
        case "status":
        case "":
          return showStatus(ctx, state);
        default:
          notify(ctx, state.config, `Unknown /dcp subcommand: ${subcommand}`, "warning");
          return showStatus(ctx, state);
      }
    },
  });
}

async function handleCompact(ctx: ExtensionCommandContext, state: RuntimeState, args: string): Promise<void> {
  if (!state.config.enabled) {
    notify(ctx, state.config, "pi-dcp is disabled", "warning");
    return;
  }
  const focus = args.trim() || undefined;
  triggerCompaction(ctx, state.config, state.triggerState, focus);
}

async function handleEnable(ctx: ExtensionCommandContext, state: RuntimeState): Promise<void> {
  state.config.enabled = true;
  notify(ctx, state.config, "pi-dcp enabled", "info");
}

async function handleDisable(ctx: ExtensionCommandContext, state: RuntimeState): Promise<void> {
  state.config.enabled = false;
  resetTriggerState(state.triggerState);
  notify(ctx, state.config, "pi-dcp disabled", "info");
}

async function handleConfig(ctx: ExtensionCommandContext, state: RuntimeState): Promise<void> {
  const lines = [
    "pi-dcp config paths:",
    `  global: ${state.loaded.globalPath ?? "(not created)"}`,
    `  project: ${state.loaded.projectPath ?? "(not loaded / not created)"}`,
  ];
  if (state.loaded.warnings.length > 0) {
    lines.push("warnings:");
    for (const warning of state.loaded.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  const text = lines.join("\n");
  if (ctx.hasUI) {
    ctx.ui.notify(text, "info");
  } else {
    console.log(text);
  }

  if (ctx.hasUI) {
    try {
      const edited = await ctx.ui.editor("pi-dcp config", text);
      debug(ctx, state.config, `editor returned: ${edited === undefined ? "undefined" : "text"}`);
    } catch {
      // ignore editor cancellation
    }
  }
}

async function showStatus(ctx: ExtensionCommandContext, state: RuntimeState): Promise<void> {
  const usage = ctx.getContextUsage();
  const endOfTurnThreshold = usage
    ? resolveThreshold(state.config.triggers.endOfTurn.tokenThreshold, usage.contextWindow)
    : null;
  const nudgeThreshold = usage
    ? resolveThreshold(state.config.triggers.nudge.tokenThreshold, usage.contextWindow)
    : null;

  const lines = [
    `pi-dcp: ${state.config.enabled ? "enabled" : "disabled"}`,
    `context: ${usage?.tokens?.toLocaleString() ?? "unknown"} / ${usage?.contextWindow.toLocaleString() ?? "unknown"} tokens`,
    `end-of-turn threshold: ${endOfTurnThreshold?.toLocaleString() ?? "unknown"}`,
    `nudge threshold: ${nudgeThreshold?.toLocaleString() ?? "unknown"}`,
    `compaction cooldown: ${state.config.triggers.endOfTurn.cooldownTurns} turn(s)`,
    `custom summary: ${state.config.compaction.customSummary ? "on" : "off"}`,
    `context pruning: ${state.config.pruning.enabled ? "on (experimental)" : "off"}`,
  ];

  const text = lines.join("\n");
  if (ctx.hasUI) {
    ctx.ui.notify(text, "info");
  } else {
    console.log(text);
  }
}
