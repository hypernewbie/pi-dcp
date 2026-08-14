import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONFIG,
  computeReliefFreeTarget,
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

  it("defaults to an aggressive 25K context-relief profile", () => {
    expect(DEFAULT_CONFIG.contextRelief.targetFloorTokens).toBe(25_000);
    expect(DEFAULT_CONFIG.contextRelief.maxChunkInputTokens).toBe(100_000);
    expect(DEFAULT_CONFIG.contextRelief.maxChunkSummaryTokens).toBe(10_000);
    expect(DEFAULT_CONFIG.contextRelief.exactEvidenceTokens).toBe(4_000);
    // Untouched knobs: headroom, active working set, quality gate inputs.
    expect(DEFAULT_CONFIG.contextRelief.targetHeadroomTokens).toBe(60_000);
    expect(DEFAULT_CONFIG.contextRelief.activeWorkingSetTokens).toBe(35_000);
    expect(DEFAULT_CONFIG.contextRelief.preservedUserMessageTokens).toBe(2_000);
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

describe("computeReliefFreeTarget", () => {
  it("targets the 25K floor for a 250K session: freeTarget is 225K", () => {
    // 73% of 250K = 182.5K is a valid effective threshold. With the default
    // 60K headroom the un-floored ceiling would be 242.5K, but the 25K floor
    // dominates: min(threshold + headroom, floor) = 25K, so the pass must
    // free 250K - 25K = 225K. This is the honest, aggressive default contract.
    const threshold = 182_500;
    const ceiling = Math.min(
      threshold + DEFAULT_CONFIG.contextRelief.targetHeadroomTokens,
      DEFAULT_CONFIG.contextRelief.targetFloorTokens,
    );
    expect(ceiling).toBe(25_000);
    expect(computeReliefFreeTarget(250_000, threshold, DEFAULT_CONFIG.contextRelief)).toBe(225_000);
  });

  it("falls back to bare headroom when threshold or usage is unavailable", () => {
    const relief = DEFAULT_CONFIG.contextRelief;
    expect(computeReliefFreeTarget(null, 182_500, relief)).toBe(60_000);
    expect(computeReliefFreeTarget(250_000, null, relief)).toBe(60_000);
    expect(computeReliefFreeTarget(undefined, 182_500, relief)).toBe(60_000);
  });

  it("clamps to zero when usage is already below the floor target", () => {
    expect(computeReliefFreeTarget(10_000, 182_500, DEFAULT_CONFIG.contextRelief)).toBe(0);
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
