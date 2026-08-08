import type { ExtensionCommandContext, ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveEffectiveThreshold } from "./config.ts";
import { triggerCompaction, resetTriggerState } from "./triggers.ts";
import { notify, setCompactingWorking } from "./ui.ts";
import { statsToDisplay } from "./stats.ts";
import type { RuntimeState } from "./types.ts";
import { rebuildVirtualBlocks, relieveContextPressure, retireVirtualBlock } from "./virtual-blocks.ts";
import { measureProjectedTokens, refreshProjectedContext } from "./context-projector.ts";
import { isVirtualContextUsageInstalled } from "./context-magic.ts";
import type { VirtualUsageRef } from "./context-magic.ts";

export function registerCommands(pi: ExtensionAPI, state: RuntimeState, projectionRef: VirtualUsageRef): void {
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
          return handleVirtualCompact(pi, ctx, state, projectionRef, restArgs, false);
        case "compact_continue":
          return handleVirtualCompact(pi, ctx, state, projectionRef, restArgs, true);
        case "compress":
          return handleCompact(pi, ctx, state, projectionRef, restArgs, false);
        case "compress_continue":
          return handleCompact(pi, ctx, state, projectionRef, restArgs, true);
        case "threshold":
          return handleThreshold(ctx, state, restArgs);
        case "enable":
          return handleEnable(ctx, state);
        case "disable":
          return handleDisable(ctx, state);
        case "config":
          return handleConfig(ctx, state);
        case "status":
        case "context":
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
  projectionRef: VirtualUsageRef,
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
    notify(ctx, state.config, "Compact does not interrupt a running task; the _continue variant is a no-op here.", "info");
  }
  if (state.triggerState.isCompacting) return;
  // Defer mid-run rather than race the live turn. Running inline would mean
  // the relief's summarizer calls share the run's abort signal (ESC kills the
  // user's compact with a misleading "no work available" message) and the next
  // contiguous tool/result boundary may not be safe to cut across until the
  // turn actually ends.
  if (!ctx.isIdle()) {
    state.triggerState.pendingManualCompact = { focus: args.trim() || undefined, compressAfter: false };
    notify(ctx, state.config, "Agent is busy; compact will run at the end of the current step.", "info");
    return;
  }
  state.triggerState.isCompacting = true;
  setCompactingWorking(ctx, true);
  try {
    state.virtualBlocks = rebuildVirtualBlocks(ctx.sessionManager.getBranch());
    const usage = ctx.getContextUsage();
    const threshold = resolveEffectiveThreshold(
      state.config.contextRelief.triggerPercent ?? state.config.triggers.endOfTurn.tokenThresholdPercent,
      state.config.triggers.endOfTurn.tokenThresholdAbsolute,
      usage?.contextWindow ?? 0,
    );
    const freeTarget = usage?.tokens != null && threshold !== null
      ? Math.max(0, usage.tokens - threshold) + state.config.contextRelief.targetHeadroomTokens
      : state.config.contextRelief.targetHeadroomTokens;
    const relief = await relieveContextPressure(
      pi,
      ctx,
      state.config,
      state.protection,
      state.virtualBlocks,
      args.trim() || undefined,
      pi.getThinkingLevel(),
      freeTarget,
      state.config.notification !== "off",
    );
    if (relief.created.length === 0) {
      // Deep diagnostic for 240k bug — trace selector decisions.
      let diag = "";
      try {
        const branch: any[] = ctx.sessionManager.getBranch() as any[];
        const { sessionEntryToContextMessages } = await import("@earendil-works/pi-coding-agent");
        const { estimateTextTokens } = await import("./utils.ts");
        const est = (m:any)=> estimateTextTokens(JSON.stringify(m));
        const userStarts: number[] = [];
        for (let i=0;i<branch.length;i++) if (branch[i].type==='message' && branch[i].message?.role==='user') userStarts.push(i);
        const covered = new Set<string>();
        for (const b of state.virtualBlocks as any[]) {
          const s = branch.findIndex((e:any)=>e.id===b.startEntryId);
          const ei = branch.findIndex((e:any)=>e.id===b.endEntryId);
          if (s>=0 && ei>=s) for(let i=s;i<=ei;i++) covered.add(branch[i].id);
        }
        let totalTurns=userStarts.length>1?userStarts.length-1:0;
        let unavailable=0, empty=0, tooLarge=0, tooSmall=0, notClosed=0, candidates=0, largest=0;
        let activeInfo="";
        for(let i=0;i<userStarts.length-1;i++){
          const s=userStarts[i], e=userStarts[i+1]-1;
          const cand=branch.slice(s,e+1);
          const unavail = cand.some((en:any)=>covered.has(en.id)) || cand.some((en:any)=>en.type==='compaction'||en.type==='branch_summary');
          if(unavail){ unavailable++; continue; }
          const msgs=cand.flatMap((en:any)=> sessionEntryToContextMessages(en));
          if(msgs.length===0){ empty++; continue; }
          const t=msgs.reduce((sum:number,m:any)=>sum+est(m),0);
          if(t>60000){ tooLarge++; if(t>largest) largest=t; continue; }
          if(t<1000){ tooSmall++; continue; }
          // closed check
          const calls=new Set<string>(), results=new Set<string>();
          for(const en of cand) for(const m of sessionEntryToContextMessages(en)){
            if(m.role==='assistant') for(const p of (m.content as any)) if(p.type==='toolCall') calls.add(p.id);
            if(m.role==='toolResult') results.add((m as any).toolCallId);
          }
          let closed=true;
          for(const id of calls) if(!results.has(id)) {closed=false; break;}
          if(closed) for(const id of results) if(!calls.has(id)) {closed=false; break;}
          if(!closed){ notClosed++; continue; }
          candidates++; if(t>largest) largest=t;
        }
        // active prefix trace
        if(userStarts.length){
          const fs=userStarts[userStarts.length-1];
          const finalEntries=branch.slice(fs);
          const curReq=sessionEntryToContextMessages(finalEntries[0]);
          const activeEntries=finalEntries.slice(1);
          let activeTokens=0;
          for(const en of activeEntries) for(const m of sessionEntryToContextMessages(en)) activeTokens+=est(m);
          let running=0; const open=new Set<string>(); let prefixEnd=-1, prefixTokens=0;
          for(let i=0;i<activeEntries.length;i++){
            const en=activeEntries[i];
            const msgs=sessionEntryToContextMessages(en);
            running+=msgs.reduce((s:number,m:any)=>s+est(m),0);
            for(const m of msgs){
              if(m.role==='assistant') for(const p of (m.content as any)) if(p.type==='toolCall') open.add(p.id);
              if(m.role==='toolResult') open.delete((m as any).toolCallId);
            }
            if(en.type!=='message'||en.message.role!=='toolResult') continue;
            if(open.size>0) continue;
            const suffix=activeTokens-running;
            if(suffix>=35000 && running<=60000){ prefixEnd=i; prefixTokens=running; }
          }
          activeInfo=` activeLen=${activeEntries.length} activeTokens~${Math.round(activeTokens)} prefixEnd=${prefixEnd} prefixTokens~${Math.round(prefixTokens)}`;
        }
        diag=` branch=${branch.length} userStarts=${userStarts.length} totalTurns=${totalTurns} compEntries=${branch.filter((e:any)=>e.type==='compaction').length} covered=${covered.size} candidates=${candidates} largest~${Math.round(largest)} unavailable=${unavailable} empty=${empty} tooLarge=${tooLarge} tooSmall=${tooSmall} notClosed=${notClosed}${activeInfo}`;
      } catch (e:any) { diag=` diagError=${String(e?.message||e).slice(0,120)}`; }
      notify(ctx, state.config, `No completed work was available to compact. (diag:${diag})`, "info");
      return;
    }
    state.triggerState.turnsSinceCompaction = 0;
    // Record the projected (post-relief) token count, not the pre-relief
    // reading. The growth-throttle re-trigger guard compares against this
    // number; recording the pre-relief number opens a dead band where Pi's
    // own aborting compaction can fire instead of DCP. Also refresh the
    // projection state so the patched getContextUsage() and /dcp status
    // reflect the post-relief request immediately.
    const refresh = refreshProjectedContext(ctx.sessionManager.getBranch(), state.virtualBlocks, usage?.contextWindow ?? 0);
    // Always set state.lastProjection after compact, even if the projection
    // failed (appliedBlocks === 0). The vctx line in /dcp status depends on
    // this being set; without it, the two status outputs are identical and the
    // user has no way to know the compact did anything. If the projection
    // failed, fall back to the raw usage tokens so the display still changes.
    const projectedTokens = refresh.projectedTokens > 0 ? refresh.projectedTokens : (usage?.tokens ?? 0);
    state.lastProjection = {
      projectedTokens,
      contextWindow: usage?.contextWindow ?? 0,
      appliedBlocks: refresh.appliedBlocks,
      timestamp: Date.now(),
    };
    projectionRef.current = state.lastProjection;
    state.triggerState.tokensAtLastCompaction = projectedTokens;
    // SAFETY: if the projection failed for ALL created blocks (appliedBlocks
    // === 0), the blocks are persisted but useless - the raw history will go
    // out anyway and the model context will overflow. Retire the blocks
    // immediately so the user is not exposed to a silent failure.
    if (relief.created.length > 0 && refresh.appliedBlocks === 0) {
      for (const block of relief.created) {
        retireVirtualBlock(pi, block.id);
      }
      state.virtualBlocks = state.virtualBlocks.filter((b) => !relief.created.some((c) => c.id === b.id));
      notify(
        ctx,
        state.config,
        `Compact created ${relief.created.length} ${relief.created.length === 1 ? "summary" : "summaries"} but the projection could not apply them (parallel tool calls or message drift). Retired. The raw history went out.`,
        "warning",
      );
    }
    notify(ctx, state.config, `Compacted ${relief.created.length} range${relief.created.length === 1 ? "" : "s"} of completed work (~${relief.freedTokens.toLocaleString()} tokens freed).`, "info");
  } finally {
    setCompactingWorking(ctx, false);
    state.triggerState.isCompacting = false;
  }
}

async function handleCompact(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: RuntimeState,
  projectionRef: VirtualUsageRef,
  args: string,
  forceContinue: boolean,
): Promise<void> {
  if (!state.config.enabled) {
    notify(ctx, state.config, "pi-dcp is disabled", "warning");
    return;
  }
  // Honest warning: compress creates virtual blocks then aborts the run. Pi's
  // compaction then summarizes the raw history, which can retire existing blocks
  // whose entry ranges are no longer in the active context. Tell the user.
  if (state.virtualBlocks.length > 0) {
    const count = state.virtualBlocks.length;
    notify(
      ctx,
      state.config,
      `${count} existing ${count === 1 ? "summary" : "summaries"} may be retired by this compress.`,
      "warning",
    );
  }
  // /dcp compress must NOT race the live run. If the agent is mid-run, defer
  // to the next turn_end (it will create virtual blocks then abort cleanly).
  if (!ctx.isIdle()) {
    state.triggerState.pendingManualCompact = { focus: args.trim() || undefined, compressAfter: true };
    notify(ctx, state.config, "Agent is busy; compress will run at the end of the current step.", "info");
    return;
  }
  await runCompressWithVirtualBlocks(pi, ctx, state, projectionRef, args.trim() || undefined, forceContinue);
}

/**
 * Create virtual blocks from the current history, then call ctx.compact()
 * (which aborts the live run). The virtual blocks are persisted as custom
 * session entries BEFORE the abort, so they survive the compaction and are
 * still projected in via the context hook for the next request - the surgical
 * part of OpenCode DCP. The abort is Pi's one-shot compaction with DCP's
 * structured custom summary. forceContinue controls whether the interrupted
 * run is resumed after the compaction completes.
 */
export async function runCompressWithVirtualBlocks(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: RuntimeState,
  projectionRef: VirtualUsageRef,
  focus: string | undefined,
  forceContinue: boolean,
): Promise<void> {
  if (state.triggerState.isCompacting) return;
  state.triggerState.isCompacting = true;
  setCompactingWorking(ctx, true);
  try {
    state.virtualBlocks = rebuildVirtualBlocks(ctx.sessionManager.getBranch());
    const usage = ctx.getContextUsage();
    const threshold = resolveEffectiveThreshold(
      state.config.contextRelief.triggerPercent ?? state.config.triggers.endOfTurn.tokenThresholdPercent,
      state.config.triggers.endOfTurn.tokenThresholdAbsolute,
      usage?.contextWindow ?? 0,
    );
    const freeTarget = usage?.tokens != null && threshold !== null
      ? Math.max(0, usage.tokens - threshold) + state.config.contextRelief.targetHeadroomTokens
      : state.config.contextRelief.targetHeadroomTokens;
    const relief = await relieveContextPressure(
      pi,
      ctx,
      state.config,
      state.protection,
      state.virtualBlocks,
      focus,
      pi.getThinkingLevel(),
      freeTarget,
      state.config.notification !== "off",
    );
    if (relief.created.length > 0) {
      const refresh = refreshProjectedContext(ctx.sessionManager.getBranch(), state.virtualBlocks, usage?.contextWindow ?? 0);
      if (refresh.projectedTokens > 0) {
        state.lastProjection = {
          projectedTokens: refresh.projectedTokens,
          contextWindow: usage?.contextWindow ?? 0,
          appliedBlocks: refresh.appliedBlocks,
          timestamp: Date.now(),
        };
        projectionRef.current = state.lastProjection;
        state.triggerState.tokensAtLastCompaction = refresh.projectedTokens;
      }
      notify(ctx, state.config, `Compacted ${relief.created.length} range${relief.created.length === 1 ? "" : "s"} of completed work (~${relief.freedTokens.toLocaleString()} tokens freed).`, "info");
    }
  } finally {
    setCompactingWorking(ctx, false);
    state.triggerState.isCompacting = false;
  }
  // Now abort the run. The virtual blocks are already persisted and survive
  // the compaction; the context hook projects them in for the next request.
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
    "  /dcp status | context  Show current context/threshold status (with projected vctx after /dcp compact)",
    "  /dcp stats           Show compaction/pruning stats (current branch)",
    "  /dcp compact [focus] Fold older completed work into a summary without interrupting the task",
    "  /dcp compress [focus] Run full one-shot context compaction with a detailed summary",
    "  /dcp compact_continue [focus] Alias of /dcp compact; the task is never interrupted",
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

  const projection = state.lastProjection;
  // The vctx line MUST show after /dcp compact - that is the invariant. It
  // shows whenever blocks exist, not only when state.lastProjection is set,
  // because the context hook can clear that state on projection failure. The
  // blocks themselves are the source of truth: their estimatedBlockTokens
  // sum IS the projected request size.
  const blockCount = state.virtualBlocks.length;
  const blockSummaryTokens = state.virtualBlocks.reduce((sum, b) => sum + b.estimatedBlockTokens, 0);
  const blockRawTokens = state.virtualBlocks.reduce((sum, b) => sum + b.estimatedRawTokens, 0);
  const vctxLine = projection
    ? projection.appliedBlocks > 0
      ? `vctx (actual sent): ~${projection.projectedTokens.toLocaleString()} tokens${projection.contextWindow > 0 ? ` (${Math.round((projection.projectedTokens / projection.contextWindow) * 100)}%)` : ""} · ${projection.appliedBlocks} summar${projection.appliedBlocks === 1 ? "y" : "ies"} applied`
      : `vctx (post-compact): ~${projection.projectedTokens.toLocaleString()} tokens${projection.contextWindow > 0 ? ` (${Math.round((projection.projectedTokens / projection.contextWindow) * 100)}%)` : ""} · projection failed (0 blocks applied)`
    : blockCount > 0
      ? `vctx (post-compact): ~${blockSummaryTokens.toLocaleString()} tokens${win > 0 ? ` (${Math.round((blockSummaryTokens / win) * 100)}%)` : ""} · ${blockCount} summar${blockCount === 1 ? "y" : "ies"} persisted (replaced ~${(blockRawTokens - blockSummaryTokens).toLocaleString()} raw tokens)`
      : undefined;

  const lines = [
    `pi-dcp: ${state.config.enabled ? "enabled" : "disabled"}`,
    `context: ${usage?.tokens?.toLocaleString() ?? "unknown"} / ${usage?.contextWindow.toLocaleString() ?? "unknown"} tokens`,
    ...(vctxLine ? [vctxLine] : []),
    // Diagnostic for the unsupported footer-number override (see context-magic.ts
    // maintenance contract). "raw" after a Pi update means the override no longer
    // took hold and the footer shows unprojected numbers again.
    `context display: ${isVirtualContextUsageInstalled() ? "projected when summaries apply" : "raw (override inactive; see context-magic.ts)"}`,
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
