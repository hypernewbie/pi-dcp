import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { createTriggerState } from "../src/state.ts";
import { shouldTriggerCompaction } from "../src/triggers.ts";

describe("shouldTriggerCompaction", () => {
  it("fires at the absolute cap on a huge window (cost protection)", () => {
    // 1M window: 73% = 730k, absolute 450k → effective 450k
    const state = createTriggerState();
    state.turnsSinceCompaction = 2;
    expect(shouldTriggerCompaction(DEFAULT_CONFIG, state, 450_001, 1_000_000)).toBe(true);
    expect(shouldTriggerCompaction(DEFAULT_CONFIG, state, 449_999, 1_000_000)).toBe(false);
  });

  it("fires at the percent on a small window (capacity protection)", () => {
    // 200k window: 73% = 146k, absolute 450k → effective 146k
    const state = createTriggerState();
    state.turnsSinceCompaction = 2;
    expect(shouldTriggerCompaction(DEFAULT_CONFIG, state, 146_001, 200_000)).toBe(true);
    expect(shouldTriggerCompaction(DEFAULT_CONFIG, state, 145_999, 200_000)).toBe(false);
  });

  it("returns false during cooldown", () => {
    const state = createTriggerState();
    state.turnsSinceCompaction = 1;
    expect(shouldTriggerCompaction(DEFAULT_CONFIG, state, 800_000, 1_000_000)).toBe(false);
  });

  it("returns false when context has not grown enough since last compaction", () => {
    const state = createTriggerState();
    state.turnsSinceCompaction = 2;
    state.tokensAtLastCompaction = 449_000;
    expect(shouldTriggerCompaction(DEFAULT_CONFIG, state, 450_500, 1_000_000)).toBe(false);
  });

  it("does not fire when both thresholds are null", () => {
    const config = {
      ...DEFAULT_CONFIG,
      triggers: {
        endOfTurn: {
          ...DEFAULT_CONFIG.triggers.endOfTurn,
          tokenThresholdPercent: null,
          tokenThresholdAbsolute: null,
        },
      },
    };
    const state = createTriggerState();
    state.turnsSinceCompaction = 2;
    expect(shouldTriggerCompaction(config, state, 900_000, 1_000_000)).toBe(false);
  });
});
