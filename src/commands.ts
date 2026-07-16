import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveEffectiveThreshold } from "./config.ts";
import { triggerCompaction, resetTriggerState } from "./triggers.ts";
import { notify, setCompactingWorking } from "./ui.ts";
import { statsToDisplay } from "./stats.ts";
import type { RuntimeState } from "./types.ts";
import { appendVirtualBlock, appendVirtualBlockReceipt, createVirtualBlock, rebuildVirtualBlocks } from "./virtual-blocks.ts";

export function registerCommands(pi: ExtensionAPI, state: RuntimeState): void {
  pi.registerCommand("dcp", {
    description: "pi-dcp: dynamic context pruning commands",
    handler: async (args, ctx) => {
      if (!state.config.commands.enabled) return;
      const trimmed = args.trim();
      const [subcommand, ...rest] = trimmed.split(/\s+/);
      const restArgs = rest.join(" ").trim();
      const lc = subcommand.toLowerCase();

      switch (lc) {
        case "compact":
          return handleVirtualCompact(pi, ctx, state, restArgs, false);
        case "compact_continue":
          return handleVirtualCompact(pi, ctx, state, restArgs, true);
        case "compress":
          return handleCompact(pi, ctx, state, restArgs, false);
        case "compress_continue":
          return handleCompact(pi, ctx, state, restArgs, true);
        case "threshold":
          return handleThreshold(ctx, state, restArgs);
        case "enable":
          return handleEnable(ctx, state);
        case "disable":
          return handleDisable(ctx, state);
        case "config":
          return handleConfig(ctx, state);
        case "status":
          return showStatus(ctx, state);
        case "stats":
          return showStats(ctx, state);
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

async function handleVirtualCompact(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: RuntimeState,
  args: string,
  continueRequested: boolean,
): Promise<void> {
  if (!state.config.enabled) {
    notify(ctx, state.config, "pi-dcp is disabled", "warning");
    return;
  }
  if (!state.config.contextRelief.enabled) {
    notify(ctx, state.config, "Compact is disabled in configuration", "warning");
    return;
  }
  if (continueRequested) {
    notify(ctx, state.config, "Compact does not interrupt a running task; continuing is automatic.", "info");
  }
  if (state.triggerState.isCompacting) return;
  state.triggerState.isCompacting = true;
  setCompactingWorking(ctx, true);
  try {
    state.virtualBlocks = rebuildVirtualBlocks(ctx.sessionManager.getBranch());
    const block = await createVirtualBlock(
      pi,
      ctx,
      state.config,
      state.protection,
      state.virtualBlocks,
      args.trim() || undefined,
      pi.getThinkingLevel(),
    );
    if (!block) {
      notify(ctx, state.config, "No completed work was available to compact.", "info");
      return;
    }
    appendVirtualBlock(pi, block);
    if (state.config.notification !== "off") {
      appendVirtualBlockReceipt(pi, block, {
        number: state.virtualBlocks.length + 1,
        activeWorkingSetTokens: state.config.contextRelief.activeWorkingSetTokens,
      });
    }
    state.virtualBlocks.push(block);
    state.triggerState.turnsSinceCompaction = 0;
    state.triggerState.tokensAtLastCompaction = ctx.getContextUsage()?.tokens ?? null;
    notify(ctx, state.config, `Compacted completed work (~${block.estimatedRawTokens.toLocaleString()} tokens).`, "info");
  } finally {
    setCompactingWorking(ctx, false);
    state.triggerState.isCompacting = false;
  }
}

async function handleCompact(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: RuntimeState,
  args: string,
  forceContinue: boolean,
): Promise<void> {
  if (!state.config.enabled) {
    notify(ctx, state.config, "pi-dcp is disabled", "warning");
    return;
  }
  const focus = args.trim() || undefined;
  triggerCompaction(pi, ctx, state.config, state.triggerState, focus, "dcp-command", { forceContinue });
}

async function handleThreshold(ctx: ExtensionCommandContext, state: RuntimeState, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 2) {
    notify(
      ctx,
      state.config,
      "Usage: /dcp threshold <percent|null> <absolute|null> (this session only, not saved to config)",
      "warning",
    );
    return;
  }

  const [percentArg, absoluteArg] = parts;
  const percent = parseThresholdValue(percentArg);
  const absolute = parseThresholdValue(absoluteArg);

  if (percent === undefined || (percent !== null && (percent < 0 || percent > 100))) {
    notify(ctx, state.config, `Invalid percent "${percentArg}": must be 0-100 or "null"`, "warning");
    return;
  }
  if (absolute === undefined || (absolute !== null && (!Number.isInteger(absolute) || absolute < 0))) {
    notify(ctx, state.config, `Invalid absolute "${absoluteArg}": must be a non-negative integer or "null"`, "warning");
    return;
  }

  state.config.triggers.endOfTurn.tokenThresholdPercent = percent;
  state.config.contextRelief.triggerPercent = percent;
  state.config.triggers.endOfTurn.tokenThresholdAbsolute = absolute;

  const usage = ctx.getContextUsage();
  const effective = resolveEffectiveThreshold(percent, absolute, usage?.contextWindow ?? 0);
  notify(
    ctx,
    state.config,
    `pi-dcp thresholds set for this session: ${percent !== null ? `${percent}%` : "—"} / ${absolute !== null ? absolute.toLocaleString() : "—"} → effective ${effective !== null ? effective.toLocaleString() : "none (defer to Pi)"}`,
    "info",
  );
}

function parseThresholdValue(raw: string): number | null | undefined {
  const lc = raw.toLowerCase();
  if (lc === "null" || lc === "off" || lc === "none" || lc === "-") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return n;
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
    "  /dcp stats           Show compaction/pruning stats (current branch)",
    "  /dcp compact [focus] Fold older completed work into a summary without interrupting the task",
    "  /dcp compress [focus] Run full one-shot context compaction with a detailed summary",
    "  /dcp compact_continue [focus] Same as compact; the task continues automatically",
    "  /dcp compress_continue [focus] Compress now, then resume the interrupted task afterward",
    "  /dcp threshold <percent|null> <absolute|null> Set dual-threshold for this session only (not saved)",
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

async function showStats(ctx: ExtensionCommandContext, state: RuntimeState): Promise<void> {
  const lines = state.stats
    ? statsToDisplay(state.stats, state.triggerState.lastCompaction)
    : ["No stats available (session not started)"];
  display(ctx, lines.join("\n"));
}

function statusLines(ctx: ExtensionCommandContext, state: RuntimeState): string[] {
  const usage = ctx.getContextUsage();
  const win = usage?.contextWindow ?? 0;
  const effective = resolveEffectiveThreshold(
    state.config.contextRelief.triggerPercent ?? state.config.triggers.endOfTurn.tokenThresholdPercent,
    state.config.triggers.endOfTurn.tokenThresholdAbsolute,
    win,
  );
  const pct = state.config.contextRelief.triggerPercent ?? state.config.triggers.endOfTurn.tokenThresholdPercent;
  const abs = state.config.triggers.endOfTurn.tokenThresholdAbsolute;

  const lines = [
    `pi-dcp: ${state.config.enabled ? "enabled" : "disabled"}`,
    `context: ${usage?.tokens?.toLocaleString() ?? "unknown"} / ${usage?.contextWindow.toLocaleString() ?? "unknown"} tokens`,
    `thresholds: ${pct !== null ? `${pct}%` : "—"} / ${abs !== null ? abs.toLocaleString() : "—"} → effective ${effective !== null ? effective.toLocaleString() : "none (defer to Pi)"}`,
    `compaction cooldown: ${state.config.triggers.endOfTurn.cooldownTurns} turn(s)`,
    `custom summary: ${state.config.compaction.customSummary ? "on" : "off"}`,
    `notification: ${state.config.notification}`,
    `context pruning: ${state.config.pruning.enabled ? "on (experimental)" : "off"}`,
    `protected tokens budget: ${state.config.compaction.maxProtectedTokens.toLocaleString()}`,
    `preserve subagent results: ${state.config.compaction.preserveSubagentResults ? "on" : "off"}`,
  ];

  const last = state.triggerState.lastCompaction;
  if (last) {
    const initiatorLabel =
      last.initiator === "dcp-command"
        ? "DCP command"
        : last.initiator === "dcp-dual-threshold"
          ? "DCP dual-threshold"
          : "Pi native";
    const provider = last.summaryProvider === "dcp" ? "DCP summary" : "Pi default summary";
    lines.push(
      `last compaction: ${initiatorLabel} · ${last.reason} · ${provider} · ${last.tokensBefore.toLocaleString()} tokens before`,
    );
    if (last.runNumber !== undefined && last.cumulativeRemovedTokens !== undefined) {
      lines.push(
        `  compression #${last.runNumber}: -~${formatK(last.removedTokensThisRun)} removed, +~${formatK(last.summaryTokensThisRun)} summary (cumulative removed: ~${formatK(last.cumulativeRemovedTokens)})`,
      );
    } else if (last.removedTokensThisRun !== undefined) {
      lines.push(
        `  removed: ~${formatK(last.removedTokensThisRun)}, summary: ~${formatK(last.summaryTokensThisRun)}`,
      );
    }
    if (last.messagesCompressed !== undefined && last.toolsCompressed !== undefined) {
      lines.push(`  items: ${last.messagesCompressed} messages, ${last.toolsCompressed} tool calls`);
    }
    if (last.fileRefs || last.protectedBlocks || last.subagentArtifacts) {
      const parts: string[] = [];
      if (last.fileRefs) parts.push(`${last.fileRefs} file refs`);
      if (last.protectedBlocks) parts.push(`${last.protectedBlocks} protected`);
      if (last.subagentArtifacts) parts.push(`${last.subagentArtifacts} subagent artifacts`);
      if (parts.length > 0) lines.push(`  carried forward: ${parts.join(" · ")}`);
    }
  }

  if (state.stats) {
    lines.push(
      `stats: ${state.stats.compactions} compactions (DCP ${state.stats.dcpInitiated}, Pi ${state.stats.piInitiated}), ${state.stats.deduplicated} deduped, ${state.stats.errorsPurged} purged`,
    );
  }

  return lines;
}

function formatK(tokens: number | undefined): string {
  if (tokens === undefined) return "?";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${tokens}`;
}

function display(ctx: ExtensionCommandContext, text: string): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, "info");
  } else {
    console.log(text);
  }
}
