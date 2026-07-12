import type { CompactionInitiator, StatsOperation, StatsState, LastCompactionInfo } from "./types.ts";

const CUSTOM_TYPE = "pi-dcp.stats.v1";

export function createEmptyStats(): StatsState {
  return {
    compactions: 0,
    dcpInitiated: 0,
    piInitiated: 0,
    dcpSummaries: 0,
    piSummaries: 0,
    deduplicated: 0,
    errorsPurged: 0,
    operations: [],
    seenToolCallIds: new Set<string>(),
  };
}

export function rebuildStatsFromEntries(entries: Array<{ type: string; customType?: string; data?: unknown }>): StatsState {
  const stats = createEmptyStats();
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType !== CUSTOM_TYPE) continue;
    const data = entry.data as StatsOperation | undefined;
    if (!data || typeof data !== "object" || data.version !== 1) continue;
    applyOperation(stats, data, false);
  }
  return stats;
}

function applyOperation(stats: StatsState, op: StatsOperation, trackSeen: boolean): void {
  // Idempotency for pruning ops based on affectedToolCallIds
  if ((op.kind === "deduplication" || op.kind === "purge-errors") && op.affectedToolCallIds) {
    const newIds = op.affectedToolCallIds.filter((id) => !stats.seenToolCallIds.has(id));
    if (trackSeen) {
      for (const id of op.affectedToolCallIds) stats.seenToolCallIds.add(id);
    } else {
      // During rebuild we still need to populate seen set
      for (const id of op.affectedToolCallIds) stats.seenToolCallIds.add(id);
      // Count only new ones during rebuild? Actually rebuild should count logically.
      // Since operations are append-only per unique toolCallId, counting rebuild identically works.
    }
    if (newIds.length === 0 && stats.operations.some((o) => o.operationId === op.operationId)) {
      return; // duplicate op
    }
    // For dedup/purge, the count is number of affected ids
    if (op.kind === "deduplication") stats.deduplicated += newIds.length || op.affectedToolCallIds.length;
    if (op.kind === "purge-errors") stats.errorsPurged += newIds.length || op.affectedToolCallIds.length;
  } else {
    if (stats.operations.some((o) => o.operationId === op.operationId)) return;

    if (op.kind === "compaction") {
      stats.compactions++;
      if (op.source === "dcp-command" || op.source === "dcp-dual-threshold") stats.dcpInitiated++;
      else stats.piInitiated++;
      if (op.summaryProvider === "dcp") stats.dcpSummaries++;
      else if (op.summaryProvider === "pi") stats.piSummaries++;
      stats.lastCompactionTimestamp = op.timestamp;
    }
  }

  stats.operations.push(op);
}

export function recordCompactionStat(
  stats: StatsState,
  info: {
    operationId: string;
    timestamp: number;
    initiator: CompactionInitiator;
    source: "dcp-command" | "dcp-dual-threshold" | "pi-native";
    hostReason: "manual" | "threshold" | "overflow";
    summaryProvider: "dcp" | "pi";
    tokensBefore: number;
    summarized: number;
    splitPrefix: number;
    kept: number;
  },
): StatsOperation {
  const op: StatsOperation = {
    version: 1,
    operationId: info.operationId,
    kind: "compaction",
    timestamp: info.timestamp,
    source: info.source,
    hostReason: info.hostReason,
    summaryProvider: info.summaryProvider,
    tokensBefore: info.tokensBefore,
    summarizedMessages: info.summarized,
    splitPrefixMessages: info.splitPrefix,
    keptMessages: info.kept,
  };
  applyOperation(stats, op, true);
  return op;
}

export function recordPruningStat(
  stats: StatsState,
  kind: "deduplication" | "purge-errors",
  toolCallIds: string[],
): StatsOperation | undefined {
  const newIds = toolCallIds.filter((id) => !stats.seenToolCallIds.has(id));
  if (newIds.length === 0) return undefined;

  const op: StatsOperation = {
    version: 1,
    operationId: `prune-${kind}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    kind,
    timestamp: Date.now(),
    affectedToolCallIds: newIds,
  };

  for (const id of newIds) stats.seenToolCallIds.add(id);
  applyOperation(stats, op, false);
  return op;
}

export function getCustomType(): string {
  return CUSTOM_TYPE;
}

export function statsToDisplay(stats: StatsState, lastCompaction?: LastCompactionInfo): string[] {
  const lines: string[] = [];
  lines.push(`pi-dcp stats (current branch)`);
  lines.push(`compactions: ${stats.compactions} (DCP initiated: ${stats.dcpInitiated}, Pi initiated: ${stats.piInitiated})`);
  lines.push(`summary providers: DCP ${stats.dcpSummaries} / Pi ${stats.piSummaries}`);
  lines.push(`outputs deduplicated: ${stats.deduplicated}`);
  lines.push(`failed-call inputs purged: ${stats.errorsPurged}`);
  if (lastCompaction) {
    lines.push(
      `last compaction: ${formatInitiator(lastCompaction.initiator)} ${lastCompaction.reason} · ${lastCompaction.summaryProvider} summary · ${lastCompaction.tokensBefore.toLocaleString()} tokens before`,
    );
  } else if (stats.lastCompactionTimestamp) {
    lines.push(`last compaction: ${new Date(stats.lastCompactionTimestamp).toISOString()}`);
  }
  return lines;
}

function formatInitiator(initiator: CompactionInitiator): string {
  if (initiator === "dcp-command") return "DCP command";
  if (initiator === "dcp-dual-threshold") return "DCP dual-threshold";
  return "Pi native";
}
