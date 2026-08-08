import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { loadConfig, loadPiCompactionSettings, resolveEffectiveThreshold, validateThreshold } from "./config.ts";
import { createTriggerState } from "./state.ts";
import {
  shouldTriggerCompaction,
  recordCompactionCompleted,
  resetTriggerState,
} from "./triggers.ts";
import { registerCommands } from "./commands.ts";
import { registerSessionReaderTool } from "./session-reader-tool.ts";
import { handleSessionBeforeCompact } from "./compaction/custom-summary.ts";
import { resolveProtection } from "./protection.ts";
import { pruneContext } from "./context-pruner.ts";
import { createCompactionPreview, buildCompactionReceiptText } from "./compaction-bar.ts";
import type { DcpRunInfo } from "./compaction-bar.ts";
import { notify, debug, setCompactingWorking } from "./ui.ts";
import { createEmptyStats, rebuildStatsFromEntries, recordCompactionStat, recordPruningStat, getCustomType } from "./stats.ts";
import { rebuildVirtualBlocks, relieveContextPressure, retireVirtualBlock } from "./virtual-blocks.ts";
import { installVirtualContextUsage, type VirtualUsageRef } from "./context-magic.ts";
import { projectVirtualBlocksWithInfo, measureProjectedTokens, refreshProjectedContext } from "./context-projector.ts";
import type { DcpConfig, LoadedConfig, ResolvedProtection, RuntimeState } from "./types.ts";
import type { CompactionInitiator } from "./types.ts";

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
    stats: createEmptyStats(),
    virtualBlocks: [],
  };
  // Shared with the live getContextUsage patch so Pi's own footer percentage
  // reflects the projected request instead of the raw session estimate.
  const projectionRef: VirtualUsageRef = {};
  // Consecutive projection failures per block. A block that cannot be applied
  // twice in a row is structurally dead (its range was rewritten or split), so
  // it is retired instead of being retried on every request forever.
  const blockFailureCounts = new Map<string, number>();
  const RETIRE_AFTER_CONSECUTIVE_FAILURES = 2;
  installVirtualContextUsage(projectionRef);

  registerCommands(pi, state, projectionRef);
  registerSessionReaderTool(pi);

  // Compaction receipts are rendered as durable custom session entries, not via
  // ctx.ui.notify: compaction always truncates/rewrites the visible transcript
  // from persisted branch entries right after this hook runs, which wipes any
  // transient status line before a user can see it. A custom entry is part of
  // that persisted branch and survives the rebuild.
  pi.registerEntryRenderer<{ text: string }>("dcp-receipt", (entry, _options, theme) => {
    const text = entry.data?.text;
    if (!text) return undefined;
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(theme.fg("customMessageText", text), 0, 0));
    return box;
  });

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
    state.lastProjection = undefined;
    projectionRef.current = undefined;
    blockFailureCounts.clear();

    // Rebuild stats from current branch custom entries
    try {
      const branch = ctx.sessionManager.getBranch();
      state.stats = rebuildStatsFromEntries(
        branch as Array<{ type: string; customType?: string; data?: unknown }>,
      );
    } catch {
      state.stats = createEmptyStats();
    }

    try {
      state.virtualBlocks = rebuildVirtualBlocks(ctx.sessionManager.getBranch());
    } catch {
      state.virtualBlocks = [];
    }

    for (const warning of fresh.warnings) {
      notify(ctx, state.config, warning, "warning");
    }

    const contextWindow = ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow ?? 0;
    const piCompaction = loadPiCompactionSettings(ctx.cwd, ctx.isProjectTrusted());
    for (const warning of validateThreshold(
      state.config.contextRelief.triggerPercent ?? state.config.triggers.endOfTurn.tokenThresholdPercent,
      state.config.triggers.endOfTurn.tokenThresholdAbsolute,
      contextWindow,
      piCompaction,
      state.config.compaction.maxSummaryTokens,
    )) {
      notify(ctx, state.config, warning, "warning");
    }
  });

  // Checked after each assistant/tool step. Automatic pressure relief creates a
  // bounded summary block and never starts Pi's aborting compaction primitive.
  pi.on("turn_end", async (_event, ctx) => {
    if (!state.config.enabled || !state.config.triggers.endOfTurn.enabled || !state.config.contextRelief.enabled) return;

    // A /dcp compact requested while the agent was mid-run is deferred to
    // here so it runs after the active turn completes, not concurrently with
    // it. Consume it before the auto-trigger: this turn does the user's work
    // first, and the auto-trigger resumes on the next turn_end after cooldown.
    const pendingManual = state.triggerState.pendingManualCompact;
    if (pendingManual) {
      state.triggerState.pendingManualCompact = undefined;
      // /dcp compress (deferred mid-run): create virtual blocks then abort the
      // run via ctx.compact(). The blocks are persisted before the abort, so
      // they survive the compaction and are projected in via the context hook
      // for the next request. The variant (compress vs compress_continue)
      // controls whether the interrupted run resumes after the abort.
      if (pendingManual.compressAfter) {
        const { runCompressWithVirtualBlocks } = await import("./commands.ts");
        await runCompressWithVirtualBlocks(
          pi,
          ctx,
          state,
          projectionRef,
          pendingManual.focus,
          false,
        );
        return;
      }
      if (state.triggerState.isCompacting) return;
      const usage = ctx.getContextUsage();
      if (usage && usage.tokens !== null) {
        state.triggerState.isCompacting = true;
        setCompactingWorking(ctx, true);
        try {
          state.virtualBlocks = rebuildVirtualBlocks(ctx.sessionManager.getBranch());
          const threshold = resolveEffectiveThreshold(
            state.config.contextRelief.triggerPercent ?? state.config.triggers.endOfTurn.tokenThresholdPercent,
            state.config.triggers.endOfTurn.tokenThresholdAbsolute,
            usage.contextWindow,
          );
          const freeTarget = usage.tokens != null && threshold !== null
            ? Math.max(0, usage.tokens - threshold) + state.config.contextRelief.targetHeadroomTokens
            : state.config.contextRelief.targetHeadroomTokens;
          const relief = await relieveContextPressure(
            pi,
            ctx,
            state.config,
            state.protection,
            state.virtualBlocks,
            pendingManual.focus,
            pi.getThinkingLevel(),
            freeTarget,
            state.config.notification !== "off",
          );
          if (relief.created.length === 0) {
            state.triggerState.tokensAtLastCompaction = usage.tokens;
            notify(ctx, state.config, "No completed work was available to compact.", "info");
          } else {
            state.triggerState.turnsSinceCompaction = 0;
            // Measure the ACTIVE context (compactions applied), not the raw
            // branch: the provider only receives post-compaction messages.
            const refresh = refreshProjectedContext(ctx.sessionManager.buildContextEntries(), state.virtualBlocks, usage.contextWindow);
            const projectedAfter = refresh.projectedTokens > 0 ? refresh.projectedTokens : usage.tokens;
            state.lastProjection = {
              projectedTokens: projectedAfter,
              contextWindow: usage.contextWindow,
              appliedBlocks: refresh.appliedBlocks,
              timestamp: Date.now(),
            };
            projectionRef.current = state.lastProjection;
            state.triggerState.tokensAtLastCompaction = projectedAfter;
            notify(
              ctx,
              state.config,
              `Compacted ${relief.created.length} range${relief.created.length === 1 ? "" : "s"} of completed work (~${relief.freedTokens.toLocaleString()} tokens freed).`,
              "info",
            );
          }
        } finally {
          setCompactingWorking(ctx, false);
          state.triggerState.isCompacting = false;
        }
      }
      return;
    }

    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null) return;

    state.triggerState.turnsSinceCompaction++;
    if (!shouldTriggerCompaction(state.config, state.triggerState, usage.tokens, usage.contextWindow, true)) return;
    if (state.triggerState.isCompacting) return;

    state.triggerState.isCompacting = true;
    setCompactingWorking(ctx, true);
    try {
      state.virtualBlocks = rebuildVirtualBlocks(ctx.sessionManager.getBranch());
      // Free enough to get back under the trigger plus the configured headroom,
      // not just one range: real pressure usually needs several bounded folds.
      const threshold = resolveEffectiveThreshold(
        state.config.contextRelief.triggerPercent ?? state.config.triggers.endOfTurn.tokenThresholdPercent,
        state.config.triggers.endOfTurn.tokenThresholdAbsolute,
        usage.contextWindow,
      );
      const freeTarget = Math.max(0, usage.tokens - (threshold ?? usage.tokens)) + state.config.contextRelief.targetHeadroomTokens;
      const relief = await relieveContextPressure(
        pi,
        ctx,
        state.config,
        state.protection,
        state.virtualBlocks,
        undefined,
        pi.getThinkingLevel(),
        freeTarget,
        state.config.notification !== "off",
      );
      if (relief.created.length === 0) {
        // Throttle futile retries until context grows materially again.
        state.triggerState.tokensAtLastCompaction = usage.tokens;
        return;
      }
      state.triggerState.turnsSinceCompaction = 0;
      // Record the projected (post-relief) token count, not the pre-relief
      // usage reading. The growth-throttle re-trigger guard compares against
      // this number; if we stored the pre-relief number, the next pass would
      // be blocked until usage grew past pre-relief + 5%*threshold, opening a
      // dead band where Pi's own aborting compaction can fire instead of DCP.
      const projectedAfter = measureProjectedTokens(ctx.sessionManager.buildContextEntries(), state.virtualBlocks);
      state.triggerState.tokensAtLastCompaction = projectedAfter > 0 ? projectedAfter : usage.tokens;
      debug(ctx, state.config, `Compacted ${relief.created.length} range(s), ~${relief.freedTokens.toLocaleString()} tokens freed`);
    } finally {
      setCompactingWorking(ctx, false);
      state.triggerState.isCompacting = false;
    }
  });

  pi.on("session_compact", (event, ctx) => {
    const usage = ctx.getContextUsage();
    recordCompactionCompleted(state.triggerState, usage?.tokens ?? null);

    // The preview was created from pendingInitiator BEFORE we knew whether
    // handleSessionBeforeCompact would actually run. If Pi did not use an
    // extension-provided summary (event.fromExtension is false), the real
    // initiator for this run was Pi itself, regardless of what we asked for.
    // The receipts and stats must reflect that honestly.
    const previewInitiator = state.compactionPreview?.initiator;
    const initiator: CompactionInitiator = event.fromExtension
      ? (previewInitiator ?? state.triggerState.pendingInitiator ?? "pi-native")
      : "pi-native";
    if (previewInitiator && previewInitiator !== "pi-native" && !event.fromExtension) {
      notify(ctx, state.config, `DCP custom summary did not run; Pi's default summary was used instead.`, "warning");
    }
    const hostReason = event.reason;
    const summaryProvider = event.fromExtension ? ("dcp" as const) : ("pi" as const);
    const tokensBefore = state.compactionPreview?.tokensBefore ?? event.compactionEntry?.tokensBefore ?? 0;

    const details = event.compactionEntry?.details as
      | {
          readFiles?: unknown;
          modifiedFiles?: unknown;
          artifacts?: unknown;
          protectedBlocks?: unknown;
          fileRefs?: unknown;
          subagentArtifacts?: unknown;
          fromDcp?: unknown;
          runNumber?: unknown;
          cumulativeRemovedTokens?: unknown;
          removedTokensThisRun?: unknown;
          summaryTokensThisRun?: unknown;
          messagesCompressed?: unknown;
          toolsCompressed?: unknown;
        }
      | undefined;

    const fileRefsCount = Array.isArray(details?.fileRefs)
      ? (details?.fileRefs as unknown[]).length
      : Array.isArray(details?.readFiles) || Array.isArray(details?.modifiedFiles)
        ? ((details?.readFiles as unknown[] | undefined)?.length ?? 0) +
          ((details?.modifiedFiles as unknown[] | undefined)?.length ?? 0)
        : undefined;

    const protectedBlocks = typeof details?.protectedBlocks === "number" ? details.protectedBlocks : undefined;
    const subagentArtifacts =
      typeof details?.subagentArtifacts === "number"
        ? details.subagentArtifacts
        : Array.isArray(details?.artifacts)
          ? (details?.artifacts as unknown[]).length
          : undefined;

    // A genuine DCP compression run only exists when Pi actually committed the
    // extension-provided summary AND that summary carried DCP's run counters.
    const dcpRun: DcpRunInfo | undefined =
      event.fromExtension && details?.fromDcp === true && typeof details.runNumber === "number" && typeof details.cumulativeRemovedTokens === "number"
        ? { runNumber: details.runNumber, cumulativeRemovedTokens: details.cumulativeRemovedTokens }
        : undefined;

    // Record last compaction for /dcp status
    const reasonLabel = initiator === "dcp-command" ? "command" : initiator === "dcp-dual-threshold" ? "dual-threshold" : hostReason;
    state.triggerState.lastCompaction = {
      initiator,
      reason: reasonLabel as any,
      hostReason,
      summaryProvider,
      tokensBefore,
      timestamp: Date.now(),
      hadBar: !!state.compactionPreview,
      fileRefs: fileRefsCount,
      protectedBlocks,
      subagentArtifacts,
      removedTokensThisRun: state.compactionPreview?.removedTokensThisRun,
      summaryTokensThisRun: typeof details?.summaryTokensThisRun === "number" ? details.summaryTokensThisRun : undefined,
      messagesCompressed: state.compactionPreview?.messagesCompressed,
      toolsCompressed: state.compactionPreview?.toolsCompressed,
      splitPrefixMessages: state.compactionPreview?.splitPrefix,
      runNumber: dcpRun?.runNumber,
      cumulativeRemovedTokens: dcpRun?.cumulativeRemovedTokens,
    };

    // Stats persistence
    if (state.stats) {
      const opId = `compact-${event.compactionEntry.id ?? Date.now()}-${tokensBefore}`;
      const op = recordCompactionStat(state.stats, {
        operationId: opId,
        timestamp: Date.now(),
        initiator,
        source:
          initiator === "dcp-command"
            ? "dcp-command"
            : initiator === "dcp-dual-threshold"
              ? "dcp-dual-threshold"
              : "pi-native",
        hostReason,
        summaryProvider,
        tokensBefore,
        summarized: state.compactionPreview?.summarized ?? 0,
        splitPrefix: state.compactionPreview?.splitPrefix ?? 0,
        kept: state.compactionPreview?.kept ?? 0,
      });
      try {
        pi.appendEntry(getCustomType(), op);
      } catch {
        // best effort
      }
    }

    const receiptText = buildCompactionReceiptText(state.compactionPreview, event, state.config, dcpRun);
    if (receiptText) {
      try {
        pi.appendEntry<{ text: string }>("dcp-receipt", { text: receiptText });
      } catch {
        // best effort - a rendering failure must never break compaction itself
      }
    }

    state.compactionPreview = undefined;
    state.triggerState.pendingInitiator = null;

    // A native compaction may remove the raw range referenced by a block. Such
    // blocks can no longer be projected and are retired from the active index.
    try {
      const activeIds = new Set(ctx.sessionManager.buildContextEntries().map((entry) => entry.id));
      const stillActive = [];
      for (const block of state.virtualBlocks) {
        if (activeIds.has(block.startEntryId) && activeIds.has(block.endEntryId)) {
          stillActive.push(block);
        } else {
          retireVirtualBlock(pi, block.id);
        }
      }
      state.virtualBlocks = stillActive;
    } catch {
      // Keep state unchanged if the host is in the middle of rebuilding its branch.
    }

    // Raw history changed shape; the previous projection no longer describes it.
    state.lastProjection = undefined;
    projectionRef.current = undefined;
  });

  // Project durable summaries first, then apply optional request-only pruning.
  pi.on("context", (event, ctx) => {
    if (!state.config.enabled) {
      projectionRef.current = undefined;
      state.lastProjection = undefined;
      return undefined;
    }

    let messages = event.messages;
    try {
      const branch = ctx.sessionManager.getBranch();
      state.virtualBlocks = rebuildVirtualBlocks(branch);
      const contextEntries = ctx.sessionManager.buildContextEntries();
      const projection = projectVirtualBlocksWithInfo(event.messages, contextEntries, state.virtualBlocks);
      messages = projection.messages;
      const projectedTokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
      state.lastProjection = {
        projectedTokens,
        contextWindow: ctx.model?.contextWindow ?? 0,
        appliedBlocks: projection.appliedBlocks,
        timestamp: Date.now(),
      };
      projectionRef.current = state.lastProjection;
      // A superseded overlap is normal (a newer summary replaced an older one)
      // and is never reported. A genuine failure is only interesting if it
      // persists: transient branch states can fail one projection harmlessly.
      const failed = new Set(projection.failedBlockIds);
      for (const id of [...blockFailureCounts.keys()]) {
        if (!failed.has(id)) blockFailureCounts.delete(id);
      }
      const retiredNow: string[] = [];
      for (const id of failed) {
        const count = (blockFailureCounts.get(id) ?? 0) + 1;
        blockFailureCounts.set(id, count);
        if (count < RETIRE_AFTER_CONSECUTIVE_FAILURES) continue;
        try {
          retireVirtualBlock(pi, id);
          retiredNow.push(id);
        } catch {
          // Retirement is best effort; failing to persist it must not break the request.
        }
      }
      if (retiredNow.length > 0) {
        for (const id of retiredNow) blockFailureCounts.delete(id);
        state.virtualBlocks = state.virtualBlocks.filter((block) => !retiredNow.includes(block.id));
        notify(
          ctx,
          state.config,
          `Discarded ${retiredNow.length} summar${retiredNow.length === 1 ? "y" : "ies"} that no longer fit this session's history. Nothing was lost: the original messages are intact and were sent in full.`,
          "info",
        );
      }
    } catch (error) {
      // Fail-open: the next request still uses the raw messages. But the vctx
      // display line in /dcp status depends on state.lastProjection, and
      // wiping it on every failed projection would hide the compact's effect
      // from the user. Keep the last known projection for display; only
      // projectionRef.current (which gates the patched getContextUsage) is
      // cleared so the next request sees the raw value.
      projectionRef.current = undefined;
      debug(ctx, state.config, `Context summary projection failed open: ${error instanceof Error ? error.message : String(error)}`);
      // Projection is fail-open: request-only pruning may still run below.
    }
    const result = state.config.pruning.enabled
      ? pruneContext(messages, state.config.pruning, state.protection)
      : { messages, stats: { deduplicated: 0, errorsPurged: 0, deduplicatedIds: [], purgedIds: [] } };
    messages = result.messages;
    const total = result.stats.deduplicated + result.stats.errorsPurged;

    if (total > 0) {
      debug(
        ctx,
        state.config,
        `context pruning: ${result.stats.deduplicated} dedup, ${result.stats.errorsPurged} errors`,
      );

      // Record stats with idempotency
      if (state.stats) {
        let appended = false;
        if (result.stats.deduplicatedIds.length > 0) {
          const op = recordPruningStat(state.stats, "deduplication", result.stats.deduplicatedIds);
          if (op) {
            try {
              pi.appendEntry(getCustomType(), op);
              appended = true;
            } catch {}
          }
        }
        if (result.stats.purgedIds.length > 0) {
          const op = recordPruningStat(state.stats, "purge-errors", result.stats.purgedIds);
          if (op) {
            try {
              pi.appendEntry(getCustomType(), op);
              appended = true;
            } catch {}
          }
        }
        void appended;
      }
    }

    if (messages !== event.messages || total > 0) return { messages };
    return undefined;
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const initiator = state.triggerState.pendingInitiator ?? "pi-native";
    const focusIsUserSupplied = state.triggerState.pendingFocusIsExplicit;

    // Only substitute DCP's own custom summary when pi-dcp explicitly asked for
    // the one-shot /dcp compress path. A plain native /compact, or Pi's own
    // threshold/overflow auto-compaction, gets Pi's own
    // default summary untouched - pi-dcp still reports it honestly (as
    // "PI COMPACT", never a fake DCP run identity) without hijacking what the
    // user or Pi itself asked for.
    if (initiator === "pi-native") {
      state.compactionPreview = undefined;
      return undefined;
    }

    const preview = createCompactionPreview(event, initiator, focusIsUserSupplied);
    state.compactionPreview = preview;

    return handleSessionBeforeCompact(event, ctx, state.config, state.protection, preview, pi.getThinkingLevel());
  });
}
