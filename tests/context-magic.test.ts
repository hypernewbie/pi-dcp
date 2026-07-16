import { describe, expect, it } from "vitest";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { installVirtualContextUsage, isVirtualContextUsageInstalled, wrapGetContextUsage, type VirtualUsageRef } from "../src/context-magic.ts";

// CANARY for the maintenance contract in src/context-magic.ts. If a Pi update
// renames/removes getContextUsage or stops exporting AgentSession, these fail
// in CI before a user ever sees the footer silently over-reporting again.
describe("Pi internals the footer override depends on", () => {
  it("AgentSession is still exported with a prototype getContextUsage()", () => {
    expect(typeof AgentSession).toBe("function");
    expect(typeof (AgentSession as any).prototype?.getContextUsage).toBe("function");
  });

  it("install succeeds against the real prototype and reports itself", () => {
    expect(installVirtualContextUsage({})).toBe(true);
    expect(isVirtualContextUsageInstalled()).toBe(true);
  });
});

describe("virtual context usage patch", () => {
  const raw = { tokens: 360_000, contextWindow: 372_000, percent: (360_000 / 372_000) * 100 };

  it("reports the projected size when summaries were applied", () => {
    const ref: VirtualUsageRef = {
      current: { projectedTokens: 46_000, contextWindow: 372_000, appliedBlocks: 3, timestamp: Date.now() },
    };
    const patched = wrapGetContextUsage(() => ({ ...raw }), ref);
    const usage = patched.call(undefined)!;
    expect(usage.tokens).toBe(46_000);
    expect(usage.percent).toBeCloseTo((46_000 / 372_000) * 100, 3);
    expect(usage.contextWindow).toBe(372_000);
  });

  it("passes raw usage through when no summaries applied", () => {
    const ref: VirtualUsageRef = {
      current: { projectedTokens: 46_000, contextWindow: 372_000, appliedBlocks: 0, timestamp: Date.now() },
    };
    const patched = wrapGetContextUsage(() => ({ ...raw }), ref);
    expect(patched.call(undefined)!.tokens).toBe(360_000);
  });

  it("passes through when there is no projection at all", () => {
    const patched = wrapGetContextUsage(() => ({ ...raw }), {});
    expect(patched.call(undefined)!.tokens).toBe(360_000);
  });

  it("never reports more than the raw figure", () => {
    const ref: VirtualUsageRef = {
      current: { projectedTokens: 500_000, contextWindow: 372_000, appliedBlocks: 1, timestamp: Date.now() },
    };
    const patched = wrapGetContextUsage(() => ({ ...raw }), ref);
    expect(patched.call(undefined)!.tokens).toBe(360_000);
  });

  it("keeps Pi's post-compaction unknown state intact", () => {
    const patched = wrapGetContextUsage(() => ({ tokens: null, contextWindow: 372_000, percent: null }), {});
    expect(patched.call(undefined)!.tokens).toBeNull();
  });

  it("fails open when the original returns undefined", () => {
    const patched = wrapGetContextUsage(() => undefined, { current: { projectedTokens: 1, contextWindow: 1, appliedBlocks: 1, timestamp: 0 } });
    expect(patched.call(undefined)).toBeUndefined();
  });
});
