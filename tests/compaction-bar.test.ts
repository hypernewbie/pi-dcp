import { describe, expect, it } from "vitest";
import {
  formatCompactionNotification,
  formatMinimalNotification,
  renderCompactionBar,
} from "../src/compaction-bar.ts";
import type { CompactionPreview } from "../src/types.ts";

const previewDcpCommand: CompactionPreview = {
  summarized: 80,
  splitPrefix: 10,
  kept: 110,
  tokensBefore: 420_000,
  reason: "manual",
  initiator: "dcp-command",
  removedTokensThisRun: 62_000,
  messagesCompressed: 38,
  toolsCompressed: 9,
  focus: "preserve the auth migration decision",
  focusIsUserSupplied: true,
};

const previewDualThreshold: CompactionPreview = {
  ...previewDcpCommand,
  initiator: "dcp-dual-threshold",
  focus: "Preserve architecture decisions, file changes, and current task.",
  focusIsUserSupplied: false,
  splitPrefix: 0,
};

const previewPiNative: CompactionPreview = {
  summarized: 80,
  splitPrefix: 0,
  kept: 110,
  tokensBefore: 420_000,
  reason: "threshold",
  initiator: "pi-native",
  removedTokensThisRun: 62_000,
  messagesCompressed: 38,
  toolsCompressed: 9,
  focusIsUserSupplied: false,
};

function makeEvent(overrides: Partial<{ fromExtension: boolean; reason: "manual" | "threshold" | "overflow"; summary: string }> = {}) {
  return {
    type: "session_compact" as const,
    compactionEntry: { summary: overrides.summary ?? "x".repeat(400) } as never,
    fromExtension: overrides.fromExtension ?? true,
    reason: overrides.reason ?? "manual",
    willRetry: false,
  };
}

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

  it("renders an OpenCode-shaped DCP compression receipt for a genuine DCP run", () => {
    const message = formatCompactionNotification(
      previewDcpCommand,
      makeEvent({ fromExtension: true }),
      { runNumber: 4, cumulativeRemovedTokens: 248_000 },
      false,
    );
    expect(message).toContain("▣ DCP | -~248K removed, +~100 summary");
    expect(message).toContain("▣ Compression #4 -~62K removed, +~100 summary");
    expect(message).toContain("→ Items: 38 messages and 9 tool calls compressed");
    expect(message).toContain('→ Origin: command, focus: "preserve the auth migration decision"');
  });

  it("does not surface the default dual-threshold focus as a user-supplied topic", () => {
    const message = formatCompactionNotification(
      previewDualThreshold,
      makeEvent({ fromExtension: true }),
      { runNumber: 1, cumulativeRemovedTokens: 62_000 },
      false,
    );
    expect(message).toContain("→ Origin: dual-threshold");
    expect(message).not.toContain("focus:");
  });

  it("shows split-turn prefix as a distinct Pi-only line when present", () => {
    const message = formatCompactionNotification(
      previewDcpCommand,
      makeEvent({ fromExtension: true }),
      { runNumber: 1, cumulativeRemovedTokens: 62_000 },
      false,
    );
    expect(message).toContain("→ Split-turn prefix: 10 messages, summarized separately");
  });

  it("includes the actual summary text only when showCompression is enabled", () => {
    const withoutShow = formatCompactionNotification(
      previewDcpCommand,
      makeEvent({ fromExtension: true, summary: "SPECIFIC_SUMMARY_TEXT" }),
      { runNumber: 1, cumulativeRemovedTokens: 62_000 },
      false,
    );
    expect(withoutShow).not.toContain("SPECIFIC_SUMMARY_TEXT");

    const withShow = formatCompactionNotification(
      previewDcpCommand,
      makeEvent({ fromExtension: true, summary: "SPECIFIC_SUMMARY_TEXT" }),
      { runNumber: 1, cumulativeRemovedTokens: 62_000 },
      true,
    );
    expect(withShow).toContain("SPECIFIC_SUMMARY_TEXT");
  });

  it("does not claim a DCP run identity for Pi-native compaction", () => {
    const message = formatCompactionNotification(previewPiNative, makeEvent({ fromExtension: false, reason: "threshold" }), undefined, false);
    expect(message).toContain("▣ PI COMPACT · threshold · Pi default summary");
    expect(message).not.toContain("Compression #");
    expect(message).not.toContain("▣ DCP |");
    expect(message).toContain("→ Removed:");
    expect(message).toContain("compacted");
  });

  it("does not claim a DCP run identity when DCP-initiated but Pi's default summary won", () => {
    // DCP asked for it, but the summarizer failed and Pi's own default summary was used.
    const message = formatCompactionNotification(previewDcpCommand, makeEvent({ fromExtension: false }), undefined, false);
    expect(message).toContain("▣ DCP COMPRESS · command · Pi default summary");
    expect(message).not.toContain("Compression #");
  });

  it("renders the OpenCode-shaped minimal notification for a DCP run", () => {
    const minimal = formatMinimalNotification(
      previewDcpCommand,
      makeEvent({ fromExtension: true }),
      { runNumber: 4, cumulativeRemovedTokens: 248_000 },
    );
    expect(minimal).toBe("▣ DCP | -~248K removed, +~100 summary — Compression #4");
  });

  it("renders a provenance-only minimal notification for Pi-native compaction", () => {
    const minimal = formatMinimalNotification(previewPiNative, makeEvent({ fromExtension: false, reason: "overflow" }), undefined);
    expect(minimal).toBe("▣ PI COMPACT · overflow · Pi default summary");
  });
});
