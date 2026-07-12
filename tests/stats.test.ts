import { describe, it, expect } from "vitest";
import { createEmptyStats, rebuildStatsFromEntries, recordCompactionStat, recordPruningStat } from "../src/stats.ts";

describe("stats", () => {
  it("rebuilds from entries and is branch-local", () => {
    const op1 = {
      version: 1,
      operationId: "compact-1",
      kind: "compaction",
      timestamp: Date.now(),
      source: "dcp-command",
      hostReason: "manual",
      summaryProvider: "dcp",
      tokensBefore: 1000,
    };
    const entries = [
      { type: "custom", customType: "pi-dcp.stats.v1", data: op1 },
      { type: "message", customType: undefined, data: {} },
    ];
    const stats = rebuildStatsFromEntries(entries as any);
    expect(stats.compactions).toBe(1);
    expect(stats.dcpInitiated).toBe(1);
  });

  it("idempotent pruning via seen ids", () => {
    const stats = createEmptyStats();
    const op = recordPruningStat(stats, "deduplication", ["tc1", "tc2"]);
    expect(op).toBeDefined();
    expect(stats.deduplicated).toBe(2);

    const op2 = recordPruningStat(stats, "deduplication", ["tc1", "tc2"]);
    expect(op2).toBeUndefined(); // already seen
    expect(stats.deduplicated).toBe(2);
  });

  it("records compaction with initiator tracking", () => {
    const stats = createEmptyStats();
    recordCompactionStat(stats, {
      operationId: "compact-x",
      timestamp: Date.now(),
      initiator: "dcp-command",
      source: "dcp-command",
      hostReason: "manual",
      summaryProvider: "dcp",
      tokensBefore: 50000,
      summarized: 10,
      splitPrefix: 0,
      kept: 5,
    });
    expect(stats.compactions).toBe(1);
    expect(stats.dcpSummaries).toBe(1);
  });
});
