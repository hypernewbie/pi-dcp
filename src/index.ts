import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { loadConfig, loadPiCompactionSettings, validateThreshold } from "./config.ts";
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
import { appendVirtualBlock, appendVirtualBlockReceipt, createVirtualBlock, rebuildVirtualBlocks, retireVirtualBlock } from "./virtual-blocks.ts";
import { projectVirtualBlocksWithInfo } from "./context-projector.ts";
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

  registerCommands(pi, state);
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

    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null) return;

    state.triggerState.turnsSinceCompaction++;
    if (!shouldTriggerCompaction(state.config, state.triggerState, usage.tokens, usage.contextWindow, true)) return;
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
        undefined,
        pi.getThinkingLevel(),
      );
      if (!block) return;
      appendVirtualBlock(pi, block);
      if (state.config.notification !== "off") {
        appendVirtualBlockReceipt(pi, block, {
          number: state.virtualBlocks.length + 1,
          activeWorkingSetTokens: state.config.contextRelief.activeWorkingSetTokens,
        });
      }
      state.virtualBlocks.push(block);
      state.triggerState.turnsSinceCompaction = 0;
      state.triggerState.tokensAtLastCompaction = usage.tokens;
      debug(ctx, state.config, `Compacted completed work (~${block.estimatedRawTokens.toLocaleString()} tokens)`);
    } finally {
      setCompactingWorking(ctx, false);
      state.triggerState.isCompacting = false;
    }
  });

  pi.on("session_compact", (event, ctx) => {
    const usage = ctx.getContextUsage();
    recordCompactionCompleted(state.triggerState, usage?.tokens ?? null);

    // Determine initiator: prefer preview, else pending, else pi-native
    const initiator: CompactionInitiator = state.compactionPreview?.initiator ?? state.triggerState.pendingInitiator ?? "pi-native";
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
  });

  // Project durable summaries first, then apply optional request-only pruning.
  pi.on("context", (event, ctx) => {
    if (!state.config.enabled) return undefined;

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
        skippedBlocks: projection.skippedBlocks,
        timestamp: Date.now(),
      };
      if (projection.skippedBlocks > 0) {
        notify(ctx, state.config, `${projection.skippedBlocks} stored context summar${projection.skippedBlocks === 1 ? "y" : "ies"} could not be applied to this request.`, "warning");
      }
    } catch (error) {
      state.lastProjection = undefined;
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
    const preview = createCompactionPreview(event, initiator, focusIsUserSupplied);
    state.compactionPreview = preview;

    // Only substitute DCP's own custom summary when pi-dcp explicitly asked for
    // the one-shot /dcp compress path. A plain native /compact, or Pi's own
    // threshold/overflow auto-compaction, gets Pi's own
    // default summary untouched - pi-dcp still reports it honestly (as
    // "PI COMPACT", never a fake DCP run identity) without hijacking what the
    // user or Pi itself asked for.
    if (initiator === "pi-native") return undefined;

    return handleSessionBeforeCompact(event, ctx, state.config, state.protection, preview, pi.getThinkingLevel());
  });
}
