import { describe, it, expect, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { createTriggerState } from "../src/state.ts";
import { shouldTriggerCompaction, triggerCompaction } from "../src/triggers.ts";

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

  it("can use the context-relief threshold independently", () => {
    const config = {
      ...DEFAULT_CONFIG,
      contextRelief: { ...DEFAULT_CONFIG.contextRelief, triggerPercent: 50 },
      triggers: { endOfTurn: { ...DEFAULT_CONFIG.triggers.endOfTurn, tokenThresholdPercent: 90, tokenThresholdAbsolute: null } },
    };
    const state = createTriggerState();
    state.turnsSinceCompaction = 2;
    expect(shouldTriggerCompaction(config, state, 500_001, 1_000_000, true)).toBe(true);
    expect(shouldTriggerCompaction(config, state, 400_001, 1_000_000, true)).toBe(false);
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

// ctx.compact() always aborts whatever the agent is currently doing before it
// compacts (Pi has no safe mid-loop compact-and-continue primitive). The only
// way to re-prompt after a ctx.compact() abort is the explicit /dcp _continue
// variants, which set forceContinue=true. Plain manual compress never resumes.
describe("triggerCompaction forceContinue", () => {
  function makeFakes(opts: { isIdle: boolean; hasPendingMessages: boolean }) {
    let onComplete: (() => void) | undefined;
    const pi = { sendUserMessage: vi.fn() } as any;
    const ctx = {
      isIdle: () => opts.isIdle,
      hasPendingMessages: () => opts.hasPendingMessages,
      compact: vi.fn((options: any) => {
        onComplete = options.onComplete;
      }),
      hasUI: false,
    } as any;
    return { pi, ctx, complete: () => onComplete?.() };
  }

  it("a plain manual /dcp compress never resumes, even if it interrupted an active run", () => {
    // The user asked for exactly one thing (compact) and gets exactly that.
    // Only the explicit _continue variant sets forceContinue.
    const { pi, ctx, complete } = makeFakes({ isIdle: false, hasPendingMessages: false });
    const state = createTriggerState();
    triggerCompaction(pi, ctx, DEFAULT_CONFIG, state, undefined, "dcp-command");
    complete();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not resume when the agent was already idle and forceContinue is false", () => {
    const { pi, ctx, complete } = makeFakes({ isIdle: true, hasPendingMessages: false });
    const state = createTriggerState();
    triggerCompaction(pi, ctx, DEFAULT_CONFIG, state, undefined, "dcp-command");
    complete();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("forceContinue always resumes, even if nothing was interrupted", () => {
    const { pi, ctx, complete } = makeFakes({ isIdle: true, hasPendingMessages: false });
    const state = createTriggerState();
    triggerCompaction(pi, ctx, DEFAULT_CONFIG, state, undefined, "dcp-command", { forceContinue: true });
    complete();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("forceContinue resumes even when the run was active", () => {
    const { pi, ctx, complete } = makeFakes({ isIdle: false, hasPendingMessages: false });
    const state = createTriggerState();
    triggerCompaction(pi, ctx, DEFAULT_CONFIG, state, undefined, "dcp-command", { forceContinue: true });
    complete();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("forceContinue is still blocked by an already-pending message", () => {
    const { pi, ctx, complete } = makeFakes({ isIdle: true, hasPendingMessages: true });
    const state = createTriggerState();
    triggerCompaction(pi, ctx, DEFAULT_CONFIG, state, undefined, "dcp-command", { forceContinue: true });
    complete();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});
