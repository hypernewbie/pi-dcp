import { describe, expect, it } from "vitest";
import {
  formatCompactionNotification,
  formatMinimalNotification,
  renderCompactionBar,
  createCompactionPreview,
} from "../src/compaction-bar.ts";
import type { CompactionPreview } from "../src/types.ts";

const previewDcpCommand: CompactionPreview = {
  summarized: 80,
  splitPrefix: 10,
  kept: 110,
  tokensBefore: 420_000,
  reason: "manual",
  initiator: "dcp-command",
};

const previewPiNative: CompactionPreview = {
  summarized: 80,
  splitPrefix: 10,
  kept: 110,
  tokensBefore: 420_000,
  reason: "threshold",
  initiator: "pi-native",
};

describe("compaction bar", () => {
  it("renders the three context parts in order", () => {
    const bar = renderCompactionBar(previewDcpCommand, 20);
    expect(bar).toMatch(/^│.*│$/);
    expect(bar).toContain("░");
    expect(bar).toContain("⣿");
    expect(bar).toContain("█");
    expect(bar).toHaveLength(22);
    expect(bar.indexOf("░")).toBeLessThan(bar.indexOf("⣿"));
    expect(bar.indexOf("⣿")).toBeLessThan(bar.indexOf("█"));
  });

  it("renders DCP command notification with truthful labels", () => {
    const message = formatCompactionNotification(previewDcpCommand, {
      type: "session_compact",
      compactionEntry: { tokensBefore: 420_000 } as never,
      fromExtension: true,
      reason: "manual",
      willRetry: false,
    });
    expect(message).toContain("DCP COMPRESS");
    expect(message).toContain("command");
    expect(message).toContain("DCP summary");
    expect(message).toContain("summarized: 80");
    expect(message).toContain("kept: 110");
  });

  it("renders Pi native notification with correct labels", () => {
    const message = formatCompactionNotification(previewPiNative, {
      type: "session_compact",
      compactionEntry: { tokensBefore: 420_000 } as never,
      fromExtension: false,
      reason: "threshold",
      willRetry: false,
    });
    expect(message).toContain("PI COMPACT");
    expect(message).toContain("threshold");
    expect(message).toContain("Pi default summary");
  });

  it("renders minimal notification", () => {
    const minimal = formatMinimalNotification("dcp-dual-threshold", "manual", true, 450_000);
    expect(minimal).toContain("DCP COMPRESS");
    expect(minimal).toContain("dual-threshold");
    expect(minimal).toContain("DCP summary");
  });

  it("always includes receipt when counts are zero", () => {
    const message = formatCompactionNotification(previewDcpCommand, {
      type: "session_compact",
      compactionEntry: { tokensBefore: 420_000 } as never,
      fromExtension: true,
      reason: "manual",
      willRetry: false,
    });
    expect(message).toContain("receipt: 0 file refs · 0 protected · 0 subagent artifacts");
  });

  it("includes receipt when provided", () => {
    const message = formatCompactionNotification(
      previewDcpCommand,
      {
        type: "session_compact",
        compactionEntry: { tokensBefore: 420_000 } as never,
        fromExtension: true,
        reason: "manual",
        willRetry: false,
      },
      { fileRefs: 6, protectedBlocks: 2, subagentArtifacts: 1 },
    );
    expect(message).toContain("receipt:");
    expect(message).toContain("6 file refs");
    expect(message).toContain("2 protected");
    expect(message).toContain("1 subagent artifact");
  });

  it("labels Pi default receipts as unavailable", () => {
    const message = formatCompactionNotification(previewPiNative, {
      type: "session_compact",
      compactionEntry: { tokensBefore: 420_000 } as never,
      fromExtension: false,
      reason: "threshold",
      willRetry: false,
    });
    expect(message).toContain("receipt: Pi default summary — DCP carry-forward details unavailable");
  });
});
