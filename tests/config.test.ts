import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG, mergeConfig, resolveThreshold, validateThreshold } from "../src/config.ts";

describe("mergeConfig", () => {
  it("keeps defaults when no overrides", () => {
    const merged = mergeConfig(DEFAULT_CONFIG);
    expect(merged.triggers.endOfTurn.tokenThreshold).toBe(250_000);
    expect(merged.pruning.enabled).toBe(false);
  });

  it("overrides scalars", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { enabled: false });
    expect(merged.enabled).toBe(false);
    expect(merged.debug).toBe(DEFAULT_CONFIG.debug);
  });

  it("unions protected tool arrays", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      protectedTools: ["my-tool"],
    });
    expect(merged.protectedTools).toContain("my-tool");
    expect(merged.protectedTools).toContain("write");
  });

  it("deep-merges nested objects", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      triggers: {
        endOfTurn: {
          tokenThreshold: "50%",
        },
      },
    });
    expect(merged.triggers.endOfTurn.tokenThreshold).toBe("50%");
    expect(merged.triggers.endOfTurn.cooldownTurns).toBe(DEFAULT_CONFIG.triggers.endOfTurn.cooldownTurns);
  });
});

describe("resolveThreshold", () => {
  it("returns absolute numbers as-is", () => {
    expect(resolveThreshold(100_000, 1_000_000)).toBe(100_000);
  });

  it("resolves percentages", () => {
    expect(resolveThreshold("30%", 1_000_000)).toBe(300_000);
  });
});

describe("validateThreshold", () => {
  it("warns when threshold is above Pi auto-compaction trigger", () => {
    const warnings = validateThreshold(990_000, 1_000_000, { reserveTokens: 16_384 }, 8_192);
    expect(warnings.some((w) => w.includes("auto-compaction trigger"))).toBe(true);
  });

  it("warns when threshold is below post-compaction floor", () => {
    const warnings = validateThreshold(10_000, 1_000_000, { keepRecentTokens: 20_000 }, 8_192);
    expect(warnings.some((w) => w.includes("post-compaction floor"))).toBe(true);
  });
});
