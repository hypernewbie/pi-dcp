import { describe, expect, it } from "vitest";
import { formatCompactionNotification, renderCompactionBar } from "../src/compaction-bar.ts";
import type { CompactionPreview } from "../src/types.ts";

const preview: CompactionPreview = {
  summarized: 80,
  splitPrefix: 10,
  kept: 110,
  tokensBefore: 420_000,
  reason: "threshold",
};

describe("compaction bar", () => {
  it("renders the three context parts in order", () => {
    const bar = renderCompactionBar(preview, 20);
    expect(bar).toMatch(/^│.*│$/);
    expect(bar).toContain("░");
    expect(bar).toContain("⣿");
    expect(bar).toContain("█");
    expect(bar).toHaveLength(22);
    expect(bar.indexOf("░")).toBeLessThan(bar.indexOf("⣿"));
    expect(bar.indexOf("⣿")).toBeLessThan(bar.indexOf("█"));
  });

  it("renders a useful completion notification", () => {
    const message = formatCompactionNotification(preview, {
      type: "session_compact",
      compactionEntry: {} as never,
      fromExtension: true,
      reason: "threshold",
      willRetry: false,
    });
    expect(message).toContain("▣ DCP | Compacted ~420k");
    expect(message).toContain("summarized: 80");
    expect(message).toContain("kept: 110");
    expect(message).toContain("Reason: threshold");
  });
});
