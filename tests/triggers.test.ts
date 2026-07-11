import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { createTriggerState } from "../src/state.ts";
import { shouldTriggerCompaction } from "../src/triggers.ts";

describe("shouldTriggerCompaction", () => {
  it("returns true when above threshold with cooldown satisfied", () => {
    const config = DEFAULT_CONFIG;
    const state = createTriggerState();
    state.turnsSinceCompaction = 2;
    expect(shouldTriggerCompaction(config, state, 300_000, 1_000_000)).toBe(true);
  });

  it("returns false when below threshold", () => {
    const config = DEFAULT_CONFIG;
    const state = createTriggerState();
    state.turnsSinceCompaction = 2;
    expect(shouldTriggerCompaction(config, state, 100_000, 1_000_000)).toBe(false);
  });

  it("returns false during cooldown", () => {
    const config = DEFAULT_CONFIG;
    const state = createTriggerState();
    state.turnsSinceCompaction = 1;
    expect(shouldTriggerCompaction(config, state, 300_000, 1_000_000)).toBe(false);
  });

  it("returns false when context has not grown enough since last compaction", () => {
    const config = DEFAULT_CONFIG;
    const state = createTriggerState();
    state.turnsSinceCompaction = 2;
    state.tokensAtLastCompaction = 260_000;
    expect(shouldTriggerCompaction(config, state, 262_000, 1_000_000)).toBe(false);
  });
});
