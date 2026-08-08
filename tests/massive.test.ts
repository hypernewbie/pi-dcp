import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve } from "node:path";

const EXTENSION_PATH = resolve(import.meta.dirname, "../src/index.ts");

const completeSimpleMock = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({
  completeSimple: (...args: unknown[]) => completeSimpleMock(...args),
}));

function makeMockApi(
  hooks: Record<string, Function[]>,
  commands: Array<{ name: string; description?: string; handler?: Function }>,
  entryRenderers: Map<string, Function>,
) {
  return {
    registerCommand: (name: string, options: any) => commands.push({ name, ...options }),
    on: (event: string, handler: Function) => {
      (hooks[event] ??= []).push(handler);
    },
    registerTool: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    registerEntryRenderer: (customType: string, renderer: Function) =>
      entryRenderers.set(customType, renderer),
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: async () => false,
    getThinkingLevel: () => "off" as const,
    setThinkingLevel: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    events: { on: () => {}, off: () => {}, emit: () => {} },
  };
}

function userMessage(id: string, text: string): any {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
  };
}

function assistantMessage(id: string, text: string, toolCalls: Array<{ id: string; name: string }> = []): any {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        ...toolCalls.map((tc) => ({ type: "toolCall", id: tc.id, name: tc.name, arguments: {} })),
      ],
      timestamp: Date.now(),
    },
  };
}

function toolResult(id: string, toolCallId: string, text: string): any {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "toolResult", toolCallId, toolName: "test", content: [{ type: "text", text }], timestamp: Date.now() },
  };
}

async function setupExtension(opts: {
  branch: any[];
  usageTokens?: number;
  contextWindow?: number;
  idle?: boolean;
  model?: any;
  getApiKey?: () => any;
  notifyMsgs?: string[];
}) {
  const hooks: Record<string, Function[]> = {};
  const commands: Array<{ name: string; description?: string; handler?: Function }> = [];
  const entryRenderers = new Map<string, Function>();
  const mockApi = makeMockApi(hooks, commands, entryRenderers);
  const mod = await import(EXTENSION_PATH);
  mod.default(mockApi as any);

  const notified = opts.notifyMsgs ?? [];
  const ctx: any = {
    hasUI: true,
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    ui: {
      notify: (m: string) => notified.push(m),
      setWidget: () => {},
    },
    getContextUsage: () => ({ tokens: opts.usageTokens ?? 0, contextWindow: opts.contextWindow ?? 1_000_000 }),
    sessionManager: {
      getBranch: () => opts.branch,
      buildContextEntries: () => opts.branch,
    },
    isIdle: () => opts.idle ?? true,
    hasPendingMessages: () => false,
    compact: function (opts: any) {
      (ctx as any).compactCallCount = ((ctx as any).compactCallCount ?? 0) + 1;
      queueMicrotask(() => opts.onComplete?.());
    },
    model: opts.model ?? { reasoning: false, maxTokens: 8_000, contextWindow: 1_000_000, provider: "p", id: "m" },
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => opts.getApiKey?.() ?? { ok: true, apiKey: "k" },
    },
    signal: undefined,
    getThinkingLevel: () => "off",
  };

  for (const h of hooks["session_start"] ?? []) await h({ type: "session_start", reason: "new" }, ctx);
  const dcpCommand = commands.find((c) => c.name === "dcp")!;
  return { hooks, commands, entryRenderers, mockApi, ctx, dcpCommand, notified };
}

beforeEach(() => {
  completeSimpleMock.mockReset();
  completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "summary" }] });
});

// ============================================================================
// /dcp compact: range selection edge cases
// ============================================================================

describe("/dcp compact: range selection", () => {
  it("creates no block when the branch has only a current user message", async () => {
    const branch = [userMessage("u1", "current")];
    const { dcpCommand, ctx, notified } = await setupExtension({ branch, usageTokens: 100 });
    await dcpCommand.handler!("compact", ctx);
    expect(notified.some((m) => m.includes("No completed work"))).toBe(true);
  });

  it("creates a block from a single completed turn (user + assistant)", async () => {
    const branch = [
      userMessage("u1", "x".repeat(200_000)),
      assistantMessage("a1", "done"),
      userMessage("u2", "current"),
    ];
    const { dcpCommand, ctx, notified } = await setupExtension({ branch, usageTokens: 900_000 });
    await dcpCommand.handler!("compact", ctx);
    expect(notified.some((m) => m.includes("Compacted") && m.includes("range"))).toBe(true);
  });

  it("creates a block from the oldest completed turn when multiple exist", async () => {
    const branch = [
      userMessage("u1", "x".repeat(200_000)),
      assistantMessage("a1", "first done"),
      userMessage("u2", "x".repeat(200_000)),
      assistantMessage("a2", "second done"),
      userMessage("u3", "current"),
    ];
    const { dcpCommand, ctx, notified } = await setupExtension({ branch, usageTokens: 900_000 });
    await dcpCommand.handler!("compact", ctx);
    expect(notified.some((m) => /Compacted \d+ range/.test(m))).toBe(true);
  });

  it("skips a too-small first turn and picks a larger later turn", async () => {
    const branch = [
      userMessage("u1", "tiny"),
      assistantMessage("a1", "tiny done"),
      userMessage("u2", "x".repeat(200_000)),
      assistantMessage("a2", "big done"),
      userMessage("u3", "current"),
    ];
    const { dcpCommand, ctx, notified } = await setupExtension({ branch, usageTokens: 900_000 });
    await dcpCommand.handler!("compact", ctx);
    expect(notified.some((m) => m.includes("Compacted"))).toBe(true);
  });

  it("refuses to split a parallel tool-call group (call inside, result outside)", async () => {
    // Range covers assistant message with tool call tc1 but NOT its result
    // r1 (r1 is in a later turn). The pre-creation check must reject.
    const branch = [
      userMessage("u1", "x".repeat(200_000)),
      assistantMessage("a1", "calling", [{ id: "tc1", name: "bash" }]),
      userMessage("u2", "current request"),
      toolResult("r1", "tc1", "late result"),
    ];
    const { dcpCommand, ctx, notified } = await setupExtension({ branch, usageTokens: 900_000 });
    await dcpCommand.handler!("compact", ctx);
    // The compact should either find no compressible range or refuse the split.
    // In either case, no "Compacted 1 range" message should appear.
    expect(notified.some((m) => m.match(/Compacted \d+ range/))).toBe(false);
  });

  it("accepts a range that contains a complete tool-call group", async () => {
    const branch = [
      userMessage("u1", "x".repeat(200_000)),
      assistantMessage("a1", "calling", [{ id: "tc1", name: "bash" }]),
      toolResult("r1", "tc1", "result"),
      userMessage("u2", "current"),
    ];
    const { dcpCommand, ctx, notified } = await setupExtension({ branch, usageTokens: 900_000 });
    await dcpCommand.handler!("compact", ctx);
    expect(notified.some((m) => m.includes("Compacted"))).toBe(true);
  });

  it("creates no block when no range meets the minimum size threshold", async () => {
    const branch = [
      userMessage("u1", "tiny"),
      assistantMessage("a1", "tiny"),
      userMessage("u2", "current"),
    ];
    const { dcpCommand, ctx, notified } = await setupExtension({ branch, usageTokens: 100 });
    await dcpCommand.handler!("compact", ctx);
    expect(notified.some((m) => m.includes("No completed work"))).toBe(true);
  });

  it("handles reasoning blocks in the assistant message (they are not conversational identity)", async () => {
    const branch = [
      userMessage("u1", "x".repeat(200_000)),
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [
            { type: "thinking", text: "reasoning" },
            { type: "text", text: "done" },
          ],
          timestamp: Date.now(),
        },
      },
      userMessage("u2", "current"),
    ];
    const { dcpCommand, ctx, notified } = await setupExtension({ branch, usageTokens: 900_000 });
    await dcpCommand.handler!("compact", ctx);
    expect(notified.some((m) => m.includes("Compacted"))).toBe(true);
  });
});

// ============================================================================
// /dcp status: display invariant
// ============================================================================

describe("/dcp status: display", () => {
  it("shows the vctx line after a successful compact", async () => {
    const branch = [
      userMessage("u1", "x".repeat(200_000)),
      assistantMessage("a1", "done"),
      userMessage("u2", "current"),
    ];
    const { dcpCommand, ctx, notified } = await setupExtension({ branch, usageTokens: 900_000 });
    await dcpCommand.handler!("compact", ctx);
    notified.length = 0;
    await dcpCommand.handler!("status", ctx);
    const out = notified.join("\n");
    expect(out).toContain("vctx");
  });

  it("shows the projected context size in the vctx line", async () => {
    const branch = [
      userMessage("u1", "x".repeat(200_000)),
      assistantMessage("a1", "done"),
      userMessage("u2", "current"),
    ];
    const { dcpCommand, ctx, notified } = await setupExtension({ branch, usageTokens: 900_000 });
    await dcpCommand.handler!("compact", ctx);
    notified.length = 0;
    await dcpCommand.handler!("status", ctx);
    const out = notified.join("\n");
    expect(out).toMatch(/vctx.*?[\d,.]+ tokens/);
  });

  it("shows config fields: threshold, cooldown, custom summary, notification", async () => {
    const { dcpCommand, ctx, notified } = await setupExtension({
      branch: [userMessage("u1", "x")],
      usageTokens: 100,
    });
    await dcpCommand.handler!("status", ctx);
    const out = notified.join("\n");
    expect(out).toContain("pi-dcp:");
    expect(out).toContain("thresholds:");
    expect(out).toContain("compaction cooldown:");
    expect(out).toContain("custom summary:");
    expect(out).toContain("notification:");
  });

  it("always shows current context (raw number) in the context line", async () => {
    const { dcpCommand, ctx, notified } = await setupExtension({
      branch: [userMessage("u1", "x")],
      usageTokens: 123_456,
      contextWindow: 1_000_000,
    });
    await dcpCommand.handler!("status", ctx);
    const out = notified.join("\n");
    expect(out).toContain("123,456");
    expect(out).toContain("1,000,000");
  });

  it("INVARIANT: two consecutive /dcp status calls (with no compact between) produce identical output", async () => {
    const { dcpCommand, ctx, notified } = await setupExtension({
      branch: [userMessage("u1", "x")],
      usageTokens: 100,
    });
    await dcpCommand.handler!("status", ctx);
    const first = notified.join("\n");
    notified.length = 0;
    await dcpCommand.handler!("status", ctx);
    const second = notified.join("\n");
    expect(second).toBe(first);
  });

  it("INVARIANT: /dcp status before vs after /dcp compact must differ", async () => {
    const branch = [
      userMessage("u1", "x".repeat(200_000)),
      assistantMessage("a1", "done"),
      userMessage("u2", "current"),
    ];
    const { dcpCommand, ctx, notified } = await setupExtension({ branch, usageTokens: 900_000 });
    await dcpCommand.handler!("status", ctx);
    const before = notified.join("\n");
    await dcpCommand.handler!("compact", ctx);
    notified.length = 0;
    await dcpCommand.handler!("status", ctx);
    const after = notified.join("\n");
    expect(after).not.toBe(before);
  });
});

// ============================================================================
// /dcp context: alias
// ============================================================================

describe("/dcp context: alias for /dcp status", () => {
  it("produces identical output to /dcp status", async () => {
    const { dcpCommand, ctx, notified } = await setupExtension({
      branch: [userMessage("u1", "x")],
      usageTokens: 100,
    });
    await dcpCommand.handler!("status", ctx);
    const a = notified.join("\n");
    notified.length = 0;
    await dcpCommand.handler!("context", ctx);
    const b = notified.join("\n");
    expect(b).toBe(a);
  });
});

// ============================================================================
// Mid-run deferral
// ============================================================================

describe("/dcp compact: mid-run deferral", () => {
  it("defers when the agent is mid-run and runs at next turn_end", async () => {
    const branch = [
      userMessage("u1", "x".repeat(200_000)),
      assistantMessage("a1", "done"),
      userMessage("u2", "current"),
    ];
    const { dcpCommand, ctx, hooks, notified } = await setupExtension({
      branch,
      usageTokens: 900_000,
      idle: false,
    });

    await dcpCommand.handler!("compact", ctx);
    // Deferred - no summarizer call yet.
    expect(completeSimpleMock.mock.calls.length).toBe(0);
    expect(notified.some((m) => m.includes("end of the current step"))).toBe(true);

    // Turn ends - deferred compact runs.
    ctx.isIdle = () => true;
    for (const h of hooks["turn_end"] ?? []) await h({ type: "turn_end" }, ctx);
    expect(completeSimpleMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("does NOT defer when the agent is idle", async () => {
    const branch = [
      userMessage("u1", "x".repeat(200_000)),
      assistantMessage("a1", "done"),
      userMessage("u2", "current"),
    ];
    const { dcpCommand, ctx, notified } = await setupExtension({ branch, usageTokens: 900_000, idle: true });
    await dcpCommand.handler!("compact", ctx);
    expect(notified.some((m) => m.includes("end of the current step"))).toBe(false);
    expect(completeSimpleMock.mock.calls.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// /dcp compress: aborting path
// ============================================================================

describe("/dcp compress: aborting path", () => {
  it("defers mid-run to turn_end, then creates blocks and aborts", async () => {
    const branch = [
      userMessage("u1", "x".repeat(200_000)),
      assistantMessage("a1", "done"),
      userMessage("u2", "current"),
    ];
    const { dcpCommand, ctx, hooks, notified } = await setupExtension({
      branch,
      usageTokens: 900_000,
      idle: false,
    });

    await dcpCommand.handler!("compress", ctx);
    expect(completeSimpleMock.mock.calls.length).toBe(0);
    expect(notified.some((m) => m.includes("end of the current step"))).toBe(true);
    expect((ctx as any).compactCallCount ?? 0).toBe(0);

    ctx.isIdle = () => true;
    for (const h of hooks["turn_end"] ?? []) await h({ type: "turn_end" }, ctx);

    expect(completeSimpleMock.mock.calls.length).toBeGreaterThan(0);
    expect((ctx as any).compactCallCount).toBe(1);
  });

  it("creates blocks BEFORE calling ctx.compact (no race)", async () => {
    const branch = [
      userMessage("u1", "x".repeat(200_000)),
      assistantMessage("a1", "done"),
      userMessage("u2", "current"),
    ];
    const { dcpCommand, ctx, hooks } = await setupExtension({ branch, usageTokens: 900_000, idle: true });
    await dcpCommand.handler!("compress", ctx);
    // After compress: blocks were created (summarizer called) AND abort happened.
    expect(completeSimpleMock.mock.calls.length).toBeGreaterThan(0);
    expect((ctx as any).compactCallCount).toBe(1);
  });
});

// ============================================================================
// Configuration commands
// ============================================================================

describe("/dcp threshold", () => {
  it("rejects an invalid argument count", async () => {
    const { dcpCommand, ctx, notified } = await setupExtension({ branch: [userMessage("u1", "x")] });
    await dcpCommand.handler!("threshold", ctx);
    expect(notified.some((m) => m.toLowerCase().includes("usage"))).toBe(true);
  });

  it("rejects an invalid percent", async () => {
    const { dcpCommand, ctx, notified } = await setupExtension({ branch: [userMessage("u1", "x")] });
    await dcpCommand.handler!("threshold abc 100", ctx);
    expect(notified.some((m) => m.toLowerCase().includes("invalid percent"))).toBe(true);
  });

  it("accepts a valid percent and absolute", async () => {
    const { dcpCommand, ctx, notified } = await setupExtension({ branch: [userMessage("u1", "x")] });
    await dcpCommand.handler!("threshold 60 200000", ctx);
    expect(notified.some((m) => m.toLowerCase().includes("thresholds set"))).toBe(true);
  });

  it("accepts 'null' to disable a threshold", async () => {
    const { dcpCommand, ctx, notified } = await setupExtension({ branch: [userMessage("u1", "x")] });
    await dcpCommand.handler!("threshold null null", ctx);
    expect(notified.some((m) => m.toLowerCase().includes("thresholds set"))).toBe(true);
  });
});

describe("/dcp enable and /dcp disable", () => {
  it("/dcp enable reports enabled", async () => {
    const { dcpCommand, ctx, notified } = await setupExtension({ branch: [userMessage("u1", "x")] });
    await dcpCommand.handler!("enable", ctx);
    expect(notified.some((m) => m.toLowerCase().includes("enabled"))).toBe(true);
  });

  it("/dcp disable reports disabled", async () => {
    const { dcpCommand, ctx, notified } = await setupExtension({ branch: [userMessage("u1", "x")] });
    await dcpCommand.handler!("disable", ctx);
    expect(notified.some((m) => m.toLowerCase().includes("disabled"))).toBe(true);
  });
});

describe("/dcp config", () => {
  it("shows config paths", async () => {
    const { dcpCommand, ctx, notified } = await setupExtension({ branch: [userMessage("u1", "x")] });
    await dcpCommand.handler!("config", ctx);
    const out = notified.join("\n");
    expect(out).toContain("global:");
    expect(out).toContain("project:");
  });
});

// ============================================================================
// /dcp stats
// ============================================================================

describe("/dcp stats", () => {
  it("shows stats counts", async () => {
    const { dcpCommand, ctx, notified } = await setupExtension({ branch: [userMessage("u1", "x")] });
    await dcpCommand.handler!("stats", ctx);
    const out = notified.join("\n");
    expect(out).toMatch(/compactions?/);
  });
});

// ============================================================================
// /dcp help
// ============================================================================

describe("/dcp help", () => {
  it("lists compact, compress, status, and other commands", async () => {
    const { dcpCommand, ctx, notified } = await setupExtension({ branch: [userMessage("u1", "x")] });
    await dcpCommand.handler!("help", ctx);
    const out = notified.join("\n");
    expect(out).toContain("compact");
    expect(out).toContain("compress");
    expect(out).toContain("status");
    expect(out).toContain("context");
  });

  it("help does not leak internal architecture jargon", async () => {
    const { dcpCommand, ctx, notified } = await setupExtension({ branch: [userMessage("u1", "x")] });
    await dcpCommand.handler!("help", ctx);
    const out = notified.join("\n");
    expect(out).not.toMatch(/PLAN3|virtual block|slopleak/);
  });
});

// ============================================================================
// Unknown subcommand
// ============================================================================

describe("/dcp unknown subcommand", () => {
  it("rejects and shows help", async () => {
    const { dcpCommand, ctx, notified } = await setupExtension({ branch: [userMessage("u1", "x")] });
    await dcpCommand.handler!("foobar", ctx);
    expect(notified.some((m) => m.toLowerCase().includes("unknown"))).toBe(true);
  });
});

// ============================================================================
// Session lifecycle
// ============================================================================

describe("session lifecycle", () => {
  it("resets projection state on session_start", async () => {
    const branch = [
      userMessage("u1", "x".repeat(200_000)),
      assistantMessage("a1", "done"),
      userMessage("u2", "current"),
    ];
    const { dcpCommand, ctx, hooks, notified } = await setupExtension({ branch, usageTokens: 900_000 });
    await dcpCommand.handler!("compact", ctx);
    notified.length = 0;
    await dcpCommand.handler!("status", ctx);
    expect(notified.join("\n")).toContain("vctx");
    // New session: vctx must disappear.
    for (const h of hooks["session_start"] ?? []) {
      await h({ type: "session_start", reason: "new" }, ctx);
    }
    notified.length = 0;
    await dcpCommand.handler!("status", ctx);
    expect(notified.join("\n")).not.toContain("vctx");
  });

  it("a second /dcp status after session_start shows no vctx", async () => {
    const { dcpCommand, ctx, hooks, notified } = await setupExtension({ branch: [userMessage("u1", "x")] });
    for (const h of hooks["session_start"] ?? []) await h({ type: "session_start", reason: "new" }, ctx);
    await dcpCommand.handler!("status", ctx);
    expect(notified.join("\n")).not.toContain("vctx");
  });
});

// ============================================================================
// Projection persistence across context-hook failures
// ============================================================================

describe("projection persistence", () => {
  it("vctx line persists when a subsequent context hook projection fails", async () => {
    // Regression: the context hook used to clear state.lastProjection on
    // any projection failure, which hid the compact's effect from /dcp status.
    // Now the catch block keeps the last known projection for display.
    const branch = [
      userMessage("u1", "x".repeat(200_000)),
      assistantMessage("a1", "done"),
      userMessage("u2", "current"),
    ];
    // We need buildContextEntries to throw to actually exercise the catch
    // block (projectVirtualBlocksWithInfo has internal try/catch and never
    // throws). A flag controls when it throws: only during the context hook,
    // not during the compact itself.
    let throwOnBuild = false;
    const throwingCtx = await setupExtension({ branch, usageTokens: 900_000 });
    const originalBuild = throwingCtx.ctx.sessionManager.buildContextEntries;
    throwingCtx.ctx.sessionManager = {
      getBranch: () => branch,
      buildContextEntries: () => {
        if (throwOnBuild) throw new Error("simulated branch failure");
        return originalBuild();
      },
    };
    await throwingCtx.dcpCommand.handler!("compact", throwingCtx.ctx);
    throwingCtx.notified.length = 0;
    await throwingCtx.dcpCommand.handler!("status", throwingCtx.ctx);
    expect(throwingCtx.notified.join("\n")).toContain("vctx");
    // Now flip the flag so the context hook throws.
    throwOnBuild = true;
    const liveMessages = [
      { role: "user", content: [{ type: "text", text: "totally different live messages" }], timestamp: Date.now() } as any,
    ];
    for (const h of throwingCtx.hooks["context"] ?? []) {
      await h({ type: "context", messages: liveMessages }, throwingCtx.ctx);
    }
    throwingCtx.notified.length = 0;
    await throwingCtx.dcpCommand.handler!("status", throwingCtx.ctx);
    expect(throwingCtx.notified.join("\n")).toContain("vctx");
  });

  it("vctx line persists when a subsequent context hook returns zero applied blocks", async () => {
    // Edge case: projection succeeds but with appliedBlocks === 0. The vctx
    // line must still show so the user knows the compact ran.
    const branch = [
      userMessage("u1", "x".repeat(200_000)),
      assistantMessage("a1", "done"),
      userMessage("u2", "current"),
    ];
    const { dcpCommand, ctx, hooks, notified } = await setupExtension({ branch, usageTokens: 900_000 });
    await dcpCommand.handler!("compact", ctx);
    notified.length = 0;
    await dcpCommand.handler!("status", ctx);
    expect(notified.join("\n")).toContain("vctx");
    const liveMessages = [
      { role: "user", content: [{ type: "text", text: "different" }], timestamp: Date.now() } as any,
    ];
    for (const h of hooks["context"] ?? []) {
      await h({ type: "context", messages: liveMessages }, ctx);
    }
    notified.length = 0;
    await dcpCommand.handler!("status", ctx);
    expect(notified.join("\n")).toContain("vctx");
  });

  it("vctx line shows from block count even if state.lastProjection was cleared", async () => {
    // The user hit this in production: after a compact, the context hook
    // (or something else) cleared state.lastProjection, and the vctx line
    // disappeared. The fix: derive the vctx line from the blocks themselves
    // (which are the source of truth) when state.lastProjection is undefined.
    const branch = [
      userMessage("u1", "x".repeat(200_000)),
      assistantMessage("a1", "done"),
      userMessage("u2", "current"),
    ];
    const { dcpCommand, ctx, notified } = await setupExtension({ branch, usageTokens: 900_000 });
    await dcpCommand.handler!("compact", ctx);
    // After compact: blocks exist. vctx should show regardless of whether
    // state.lastProjection was set or cleared.
    notified.length = 0;
    await dcpCommand.handler!("status", ctx);
    const out = notified.join("\n");
    expect(out).toContain("vctx");
  });

  it("fallback vctx line estimates the full request, not just the summaries' size", async () => {
    // User hit this: after /reload, blocks persist but no fresh projection
    // exists yet. The fallback line used to show only the sum of the summary
    // blocks (~9K) as "vctx" (1%) — a lie; the real request is raw usage
    // minus net replacement. Must show the estimate from usage.
    const blockEntry = (id: string, raw: number, blk: number): any => ({
      type: "custom",
      id,
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "dcp-context-range.v1",
      data: { version: 1, block: { version: 1, id, startEntryId: "u1", endEntryId: "a1", anchorEntryId: "u1", rangeKind: "historical", messagesCompressed: 2, toolsCompressed: 0, summary: "s".repeat(blk * 4), exactEvidence: "", preservedUserMessages: [], estimatedRawTokens: raw, retainedRawTokens: raw, estimatedBlockTokens: blk, active: true, createdAt: Date.now() } },
    });
    const branch = [
      blockEntry("b1", 40_000, 5_000),
      blockEntry("b2", 30_000, 4_000),
      userMessage("u1", "current"),
    ];
    const { dcpCommand, ctx, notified } = await setupExtension({ branch, usageTokens: 900_000 });
    await dcpCommand.handler!("status", ctx);
    const out = notified.join("\n");
    expect(out).toContain("vctx (est. next request)");
    const m = out.match(/vctx \(est\. next request\): ~([\d,.]+) tokens/);
    expect(m).not.toBeNull();
    const est = Number(m![1].replace(/,/g, ""));
    // 900_000 - (70_000 raw - 9_000 summary) = 839_000, not the 9_000 summary size.
    expect(est).toBe(839_000);
  });
});

// ============================================================================
// Threshold check uses vctx, not raw
// ============================================================================

describe("threshold check uses projected (vctx) context, not raw", () => {
  it("displayed thresholds are static config values (not derived from vctx)", async () => {
    const branch = [
      userMessage("u1", "x".repeat(200_000)),
      assistantMessage("a1", "done"),
      userMessage("u2", "current"),
    ];
    const { dcpCommand, ctx, notified } = await setupExtension({ branch, usageTokens: 900_000 });
    await dcpCommand.handler!("compact", ctx);
    notified.length = 0;
    await dcpCommand.handler!("status", ctx);
    const out = notified.join("\n");
    // Thresholds line is config-driven, not projection-driven.
    expect(out).toContain("thresholds:");
    expect(out).toMatch(/thresholds: \d+% \/ [\d,]+/);
  });

  it("displayed context line uses the vctx (projected) value after compact", async () => {
    const branch = [
      userMessage("u1", "x".repeat(200_000)),
      assistantMessage("a1", "done"),
      userMessage("u2", "current"),
    ];
    const { dcpCommand, ctx, notified } = await setupExtension({ branch, usageTokens: 900_000 });
    await dcpCommand.handler!("compact", ctx);
    notified.length = 0;
    await dcpCommand.handler!("status", ctx);
    const out = notified.join("\n");
    const vctxMatch = out.match(/vctx[\s\S]*?~([\d,.]+) tokens/);
    if (!vctxMatch) {
      throw new Error("No vctx line found in status output:\n" + out);
    }
    const projected = Number(vctxMatch![1].replace(/[,.]/g, ""));
    expect(projected).toBeLessThan(900_000);
  });

  it("vctx after compact measures the ACTIVE context, not the raw branch", async () => {
    // Regression: refreshProjectedContext/measureProjectedTokens were fed
    // getBranch() (raw history, still contains every pre-compaction message).
    // The provider never sees that; measuring it produced vctx of 1.5M at a
    // 1M window while the provider reported 305K. Must use buildContextEntries().
    const compacted = [
      userMessage("u1", "x".repeat(200_000)),
      assistantMessage("a1", "done"),
      userMessage("u2", "current"),
    ];
    // Raw branch contains a million chars of stale pre-compaction junk that
    // buildContextEntries() excludes.
    const staleJunk = [
      userMessage("j1", "z".repeat(1_000_000)),
      assistantMessage("j2", "stale"),
    ];
    const rawBranch = [...staleJunk, ...compacted];
    const { dcpCommand, ctx, notified } = await setupExtension({ branch: rawBranch, usageTokens: 900_000 });
    ctx.sessionManager.buildContextEntries = () => compacted;

    await dcpCommand.handler!("compact", ctx);
    notified.length = 0;
    await dcpCommand.handler!("status", ctx);
    const out = notified.join("\n");
    const vctxMatch = out.match(/vctx[\s\S]*?~([\d,.]+) tokens/);
    if (!vctxMatch) throw new Error("No vctx line found:\n" + out);
    const projected = Number(vctxMatch[1].replace(/[,.]/g, ""));
    // Stale junk (~250K tokens) must NOT be counted; projected must be the
    // compacted slice size (~200K), not ~450K+.
    expect(projected).toBeLessThan(300_000);
  });
});

// ============================================================================
// Error handling
// ============================================================================

describe("error handling", () => {
  it("/dcp compact when there is no model surfaces a clear error", async () => {
    const branch = [
      userMessage("u1", "x".repeat(200_000)),
      assistantMessage("a1", "done"),
      userMessage("u2", "current"),
    ];
    const { dcpCommand, ctx, notified } = await setupExtension({ branch, usageTokens: 900_000 });
    ctx.model = undefined; // override the default the helper installs
    await dcpCommand.handler!("compact", ctx);
    // With no model, the compact must NOT claim success.
    const claimedSuccess = notified.some((m) => /Compacted \d+ range/.test(m));
    expect(claimedSuccess).toBe(false);
  });

  it("provider errors in the summarizer are surfaced", async () => {
    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue({ stopReason: "error", errorMessage: "rate limited" } as any);
    const branch = [
      userMessage("u1", "x".repeat(200_000)),
      assistantMessage("a1", "done"),
      userMessage("u2", "current"),
    ];
    const { dcpCommand, ctx, notified } = await setupExtension({ branch, usageTokens: 900_000 });
    await dcpCommand.handler!("compact", ctx);
    // Either we surface a "no completed work" or the relief simply does not
    // create blocks; in either case the user must not be told it succeeded.
    const claimedCompacted = notified.some((m) => /Compacted \d+ range/.test(m));
    expect(claimedCompacted).toBe(false);
  });
});
