import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveEffectiveThreshold } from "./config.ts";
import { triggerCompaction, resetTriggerState } from "./triggers.ts";
import { notify } from "./ui.ts";
import type { RuntimeState } from "./types.ts";

export function registerCommands(pi: ExtensionAPI, state: RuntimeState): void {
  pi.registerCommand("dcp", {
    description: "pi-dcp: dynamic context pruning commands",
    handler: async (args, ctx) => {
      if (!state.config.commands.enabled) return;
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
          return showStatus(ctx, state);
        case "help":
        case "":
          return showHelp(ctx, state);
        default:
          notify(ctx, state.config, `Unknown /dcp subcommand: ${subcommand}`, "warning");
          return showHelp(ctx, state);
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
}

async function showHelp(ctx: ExtensionCommandContext, state: RuntimeState): Promise<void> {
  const text = [
    "pi-dcp commands:",
    "  /dcp                 Show this help and current status",
    "  /dcp status          Show current context/threshold status",
    "  /dcp compact [focus] Compact now; optional focus guides the summary",
    "  /dcp enable          Enable pi-dcp for this session",
    "  /dcp disable         Disable pi-dcp for this session",
    "  /dcp config          Show config paths and load warnings",
    "",
    ...statusLines(ctx, state),
  ].join("\n");
  display(ctx, text);
}

async function showStatus(ctx: ExtensionCommandContext, state: RuntimeState): Promise<void> {
  display(ctx, statusLines(ctx, state).join("\n"));
}

function statusLines(ctx: ExtensionCommandContext, state: RuntimeState): string[] {
  const usage = ctx.getContextUsage();
  const window = usage?.contextWindow ?? 0;
  const effective = resolveEffectiveThreshold(
    state.config.triggers.endOfTurn.tokenThresholdPercent,
    state.config.triggers.endOfTurn.tokenThresholdAbsolute,
    window,
  );
  const pct = state.config.triggers.endOfTurn.tokenThresholdPercent;
  const abs = state.config.triggers.endOfTurn.tokenThresholdAbsolute;

  const lines = [
    `pi-dcp: ${state.config.enabled ? "enabled" : "disabled"}`,
    `context: ${usage?.tokens?.toLocaleString() ?? "unknown"} / ${usage?.contextWindow.toLocaleString() ?? "unknown"} tokens`,
    `thresholds: ${pct !== null ? `${pct}%` : "—"} / ${abs !== null ? abs.toLocaleString() : "—"} → effective ${effective !== null ? effective.toLocaleString() : "none (defer to Pi)"}`,
    `compaction cooldown: ${state.config.triggers.endOfTurn.cooldownTurns} turn(s)`,
    `custom summary: ${state.config.compaction.customSummary ? "on" : "off"}`,
    `context pruning: ${state.config.pruning.enabled ? "on (experimental)" : "off"}`,
  ];

  return lines;
}

function display(ctx: ExtensionCommandContext, text: string): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, "info");
  } else {
    console.log(text);
  }
}
