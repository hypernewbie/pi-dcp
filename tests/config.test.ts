import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONFIG,
  mergeConfig,
  resolveEffectiveThreshold,
  validateThreshold,
} from "../src/config.ts";

describe("mergeConfig", () => {
  it("keeps defaults when no overrides", () => {
    const merged = mergeConfig(DEFAULT_CONFIG);
    expect(merged.triggers.endOfTurn.tokenThresholdPercent).toBe(73);
    expect(merged.triggers.endOfTurn.tokenThresholdAbsolute).toBe(450_000);
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

  it("deep-merges context relief settings without losing defaults", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { contextRelief: { maxChunkInputTokens: 12_000 } });
    expect(merged.contextRelief.maxChunkInputTokens).toBe(12_000);
    expect(merged.contextRelief.activeWorkingSetTokens).toBe(DEFAULT_CONFIG.contextRelief.activeWorkingSetTokens);
    expect(merged.compaction.maxSummaryTokens).toBe(20_000);
  });

  it("deep-merges nested objects", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      triggers: {
        endOfTurn: {
          tokenThresholdPercent: 60,
        },
      },
    });
    expect(merged.triggers.endOfTurn.tokenThresholdPercent).toBe(60);
    expect(merged.triggers.endOfTurn.cooldownTurns).toBe(DEFAULT_CONFIG.triggers.endOfTurn.cooldownTurns);
  });
});

describe("resolveEffectiveThreshold", () => {
  it("returns the percent when it is lower than the absolute (small windows)", () => {
    // 73% of 200k = 146k < 450k
    expect(resolveEffectiveThreshold(73, 450_000, 200_000)).toBe(146_000);
  });

  it("returns the absolute when it is lower than the percent (huge windows)", () => {
    // 73% of 1M = 730k > 450k
    expect(resolveEffectiveThreshold(73, 450_000, 1_000_000)).toBe(450_000);
  });

  it("ignores null thresholds", () => {
    expect(resolveEffectiveThreshold(null, 450_000, 1_000_000)).toBe(450_000);
    expect(resolveEffectiveThreshold(73, null, 1_000_000)).toBe(730_000);
  });

  it("returns null when both thresholds are disabled", () => {
    expect(resolveEffectiveThreshold(null, null, 1_000_000)).toBe(null);
  });
});

describe("validateThreshold", () => {
  it("warns when effective threshold is above Pi auto-compaction trigger", () => {
    const warnings = validateThreshold(99, null, 1_000_000, { reserveTokens: 16_384 }, 8_192);
    expect(warnings.some((w) => w.includes("auto-compaction trigger"))).toBe(true);
  });

  it("warns when effective threshold is below post-compaction floor", () => {
    const warnings = validateThreshold(null, 10_000, 1_000_000, { keepRecentTokens: 20_000 }, 8_192);
    expect(warnings.some((w) => w.includes("post-compaction floor"))).toBe(true);
  });

  it("warns when both thresholds are null", () => {
    const warnings = validateThreshold(null, null, 1_000_000, {}, 8_192);
    expect(warnings.some((w) => w.includes("will not auto-compact"))).toBe(true);
  });
});
