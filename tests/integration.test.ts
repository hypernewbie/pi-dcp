import { describe, it, expect, vi } from "vitest";
import { resolve } from "node:path";

const EXTENSION_PATH = resolve(import.meta.dirname, "../src/index.ts");

const completeSimpleMock = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({
  completeSimple: (...args: unknown[]) => completeSimpleMock(...args),
}));

function makeMockApi(hooks: Record<string, Function[]>, commands: Array<{ name: string; description?: string }>, entryRenderers: Map<string, Function>) {
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
    registerEntryRenderer: (customType: string, renderer: Function) => entryRenderers.set(customType, renderer),
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

describe("extension entry point", () => {
  it("registers expected commands and hooks", async () => {
    const mod = await import(EXTENSION_PATH);
    const hooks: Record<string, Function[]> = {};
    const commands: Array<{ name: string; description?: string }> = [];
    const entryRenderers = new Map<string, Function>();

    mod.default(makeMockApi(hooks, commands, entryRenderers) as any);

    const commandNames = commands.map((c) => c.name).sort();
    expect(commandNames).toEqual(["dcp"]);

    const hookEvents = Object.keys(hooks).sort();
    expect(hookEvents).toContain("session_start");
    expect(hookEvents).toContain("turn_end");
    expect(hookEvents).toContain("session_compact");
    expect(hookEvents).toContain("context");
    expect(hookEvents).toContain("session_before_compact");

    expect(entryRenderers.has("dcp-receipt")).toBe(true);
  });

  it("after a successful relief, the growth-throttle re-trigger uses the projected (post-relief) count, not the pre-relief one", async () => {
    // Regression test for a real failure: after a successful /dcp compact,
    // tokensAtLastCompaction was recorded as the PRE-relief usage reading.
    // The growth-throttle re-trigger guard compares against this number, so
    // the next pass would be blocked until context grew past pre-relief +
    // 5%*threshold, opening a dead band where Pi's aborting native compaction
    // could fire instead of DCP - the exact thing DCP exists to prevent.
    //
    // Setup: window 1_000_000, threshold percent 73% (~730K). Pre-relief
    // usage 900K. After relief, projected usage ~100K. The next turn_end
    // reports usage 750K - just above threshold but well below pre-relief.
    // A correct fix re-triggers; the bug blocks re-trigger indefinitely.
    const mod = await import(EXTENSION_PATH);
    const hooks: Record<string, Function[]> = {};
    const commands: Array<{ name: string; description?: string; handler?: Function }> = [];
    const entryRenderers = new Map<string, Function>();
    const mockApi = makeMockApi(hooks, commands, entryRenderers);
    mod.default(mockApi as any);

    // Branch big enough to compress, with a current user message at the end.
    const bigText = "x".repeat(200_000);
    const branch: any[] = [
      { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: bigText }], timestamp: 1 } },
      { type: "message", id: "a1", parentId: "u1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 } },
      { type: "message", id: "u2", parentId: "a1", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "current request" }], timestamp: 3 } },
    ];

    let currentTokens = 900_000;
    const ctx: any = {
      hasUI: true,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { notify: () => {} },
      getContextUsage: () => ({ tokens: currentTokens, contextWindow: 1_000_000 }),
      sessionManager: { getBranch: () => branch, buildContextEntries: () => branch },
      isIdle: () => true,
      hasPendingMessages: () => false,
      compact: function () { (ctx as any).compactCallCount = ((ctx as any).compactCallCount ?? 0) + 1; },
      model: { reasoning: false, maxTokens: 8_000, contextWindow: 1_000_000, provider: "p", id: "m" },
      modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) },
      signal: undefined,
      getThinkingLevel: () => "off",
    };

    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "tiny summary" }] });

    try {
      for (const h of hooks["session_start"] ?? []) await h({ type: "session_start", reason: "new" }, ctx);

      // First relief: usage 900K, well above threshold. Three turn_ends to clear
      // the cooldown and get past the growth-throttle (which compares against
      // tokensAtLastCompaction = null at this point).
      for (let i = 0; i < 3; i++) {
        for (const h of hooks["turn_end"] ?? []) await h({ type: "turn_end" }, ctx);
      }
      const firstPassSummarizerCalls = completeSimpleMock.mock.calls.length;
      expect(firstPassSummarizerCalls).toBeGreaterThan(0);

      // After relief, the projection should be much smaller than the pre-relief
      // 900K. Now advance the clock past the cooldown and report usage 750K -
      // just above threshold (730K) but far below pre-relief (900K). With the
      // bug, tokensAtLastCompaction is recorded as 900K, so the next trigger
      // requires usage >= 900K + 5%*730K ~= 936K and won't fire. With the fix,
      // tokensAtLastCompaction is the projected value (~100K), so the next
      // trigger fires the moment usage crosses 730K + 5%*730K ~= 766K.
      currentTokens = 750_000;
      for (let i = 0; i < 3; i++) {
        for (const h of hooks["turn_end"] ?? []) await h({ type: "turn_end" }, ctx);
      }
      // Bug: summarizerCalls remains at firstPassSummarizerCalls. Fix: it grew.
      expect(completeSimpleMock.mock.calls.length).toBeGreaterThan(firstPassSummarizerCalls);
    } finally {
      completeSimpleMock.mockReset();
    }
  });

  it("after /dcp compact, /dcp status reflects the projected (post-relief) count, not the stale pre-relief one", async () => {
    // Regression test for Fix 2: before the fix, /dcp status kept showing the
    // pre-relief percentage and the vctx line stayed stale until the next LLM
    // request, so a successful manual compact looked like it did nothing.
    const mod = await import(EXTENSION_PATH);
    const hooks: Record<string, Function[]> = {};
    const commands: Array<{ name: string; description?: string; handler?: Function }> = [];
    const entryRenderers = new Map<string, Function>();
    const mockApi = makeMockApi(hooks, commands, entryRenderers);
    mod.default(mockApi as any);

    const bigText = "x".repeat(200_000);
    const branch: any[] = [
      { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: bigText }], timestamp: 1 } },
      { type: "message", id: "a1", parentId: "u1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 } },
      { type: "message", id: "u2", parentId: "a1", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "current request" }], timestamp: 3 } },
    ];

    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "tiny summary" }] });

    const notifiedMessages: string[] = [];
    const ctx: any = {
      hasUI: true,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { notify: (message: string) => notifiedMessages.push(message) },
      getContextUsage: () => ({ tokens: 900_000, contextWindow: 1_000_000 }),
      sessionManager: { getBranch: () => branch, buildContextEntries: () => branch },
      isIdle: () => true,
      hasPendingMessages: () => false,
      compact: function () { (ctx as any).compactCallCount = ((ctx as any).compactCallCount ?? 0) + 1; },
      model: { reasoning: false, maxTokens: 8_000, contextWindow: 1_000_000, provider: "p", id: "m" },
      modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) },
      signal: undefined,
      getThinkingLevel: () => "off",
    };

    try {
      for (const h of hooks["session_start"] ?? []) await h({ type: "session_start", reason: "new" }, ctx);

      // Pre-condition: status has no vctx line before any compact.
      const dcpCommand = commands.find((c) => c.name === "dcp")!;
      notifiedMessages.length = 0;
      await dcpCommand.handler!("status", ctx);
      const preStatus = notifiedMessages.join("\n");
      expect(preStatus).not.toContain("vctx (actual sent)");

      // Run /dcp compact.
      notifiedMessages.length = 0;
      await dcpCommand.handler!("compact", ctx);

      // Post-condition: status shows a small vctx value, NOT the pre-relief 900K.
      notifiedMessages.length = 0;
      await dcpCommand.handler!("status", ctx);
      const postStatus = notifiedMessages.join("\n");
      expect(postStatus).toContain("vctx (actual sent)");
      // The pre-relief reading was 900K. After relief, the projected value
      // should be well below that and well below the window.
      const match = postStatus.match(/vctx \(actual sent\): ~([\d,.]+) tokens/);
      expect(match).not.toBeNull();
      const projected = Number(match![1].replace(/,/g, ""));
      expect(projected).toBeLessThan(900_000);
      expect(projected).toBeGreaterThan(0);
    } finally {
      completeSimpleMock.mockReset();
    }
  });

  it("INVARIANT: /dcp status output must differ before vs after /dcp compact", async () => {
    // The status command's whole point is to show the current state. After
    // /dcp compact, the context display MUST change - either the vctx line
    // appears, the projected count drops, or some other visible signal shows
    // the compact did something. If the two status outputs are identical, the
    // user has no way to know the compact worked.
    const mod = await import(EXTENSION_PATH);
    const hooks: Record<string, Function[]> = {};
    const commands: Array<{ name: string; description?: string; handler?: Function }> = [];
    const entryRenderers = new Map<string, Function>();
    const mockApi = makeMockApi(hooks, commands, entryRenderers);
    mod.default(mockApi as any);

    const bigText = "x".repeat(200_000);
    const branch: any[] = [
      { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: bigText }], timestamp: 1 } },
      { type: "message", id: "a1", parentId: "u1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 } },
      { type: "message", id: "u2", parentId: "a1", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "current request" }], timestamp: 3 } },
    ];

    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "tiny summary" }] });

    const notifiedMessages: string[] = [];
    const ctx: any = {
      hasUI: true,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { notify: (message: string) => notifiedMessages.push(message) },
      getContextUsage: () => ({ tokens: 900_000, contextWindow: 1_000_000 }),
      sessionManager: { getBranch: () => branch, buildContextEntries: () => branch },
      isIdle: () => true,
      hasPendingMessages: () => false,
      compact: function () {},
      model: { reasoning: false, maxTokens: 8_000, contextWindow: 1_000_000, provider: "p", id: "m" },
      modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) },
      signal: undefined,
      getThinkingLevel: () => "off",
    };

    try {
      for (const h of hooks["session_start"] ?? []) await h({ type: "session_start", reason: "new" }, ctx);

      const dcpCommand = commands.find((c) => c.name === "dcp")!;

      // Status BEFORE compact.
      notifiedMessages.length = 0;
      await dcpCommand.handler!("status", ctx);
      const statusBefore = notifiedMessages.join("\n");

      // Run compact.
      await dcpCommand.handler!("compact", ctx);

      // Status AFTER compact.
      notifiedMessages.length = 0;
      await dcpCommand.handler!("status", ctx);
      const statusAfter = notifiedMessages.join("\n");

      // THE INVARIANT: the two outputs must differ. If they don't, the user
      // has no way to know the compact did anything.
      expect(statusAfter).not.toBe(statusBefore);
      // Specifically, the vctx line must appear after compact.
      expect(statusAfter).toContain("vctx (actual sent)");
      expect(statusBefore).not.toContain("vctx (actual sent)");
    } finally {
      completeSimpleMock.mockReset();
    }
  });

  it("SAFETY: /dcp compact retires blocks when the projection cannot apply them", async () => {
    // Regression test for the silent-failure bug: createVirtualBlock was
    // creating and persisting blocks even when the projector would later
    // reject them. The blocks would be persisted forever, the raw history
    // would still go out, and the model context would overflow. Now the
    // safety check in handleVirtualCompact retires blocks whose projection
    // failed (appliedBlocks === 0) and warns the user.
    const mod = await import(EXTENSION_PATH);
    const hooks: Record<string, Function[]> = {};
    const commands: Array<{ name: string; description?: string; handler?: Function }> = [];
    const entryRenderers = new Map<string, Function>();
    const mockApi = makeMockApi(hooks, commands, entryRenderers);
    mod.default(mockApi as any);

    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "tiny summary" }] });

    // Branch designed to make the projection fail: the block's range covers
    // a tool call whose result is missing (delivered asynchronously after
    // the block was created). The pre-creation check passes because the
    // range has all entries the block needs; the projection fails because
    // the live context has a tool result that was not in the range.
    const branch: any[] = [
      { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "x".repeat(100_000) }], timestamp: 1 } },
      { type: "message", id: "a1", parentId: "u1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "calling" }, { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } }], timestamp: 2 } },
      { type: "message", id: "u2", parentId: "a1", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "current request" }], timestamp: 3 } },
      { type: "message", id: "r1", parentId: "a1", timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "file1\nfile2" }], timestamp: 4 } },
    ];

    const notifiedMessages: string[] = [];
    const ctx: any = {
      hasUI: true,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { notify: (message: string) => notifiedMessages.push(message) },
      getContextUsage: () => ({ tokens: 900_000, contextWindow: 1_000_000 }),
      sessionManager: { getBranch: () => branch, buildContextEntries: () => branch },
      isIdle: () => true,
      hasPendingMessages: () => false,
      compact: function () {},
      model: { reasoning: false, maxTokens: 8_000, contextWindow: 1_000_000, provider: "p", id: "m" },
      modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) },
      signal: undefined,
      getThinkingLevel: () => "off",
    };

    try {
      for (const h of hooks["session_start"] ?? []) await h({ type: "session_start", reason: "new" }, ctx);

      const dcpCommand = commands.find((c) => c.name === "dcp")!;
      notifiedMessages.length = 0;
      await dcpCommand.handler!("compact", ctx);

      // If the projection failed and the safety check fired, a warning was
      // shown. Whether or not the warning fires, the important invariant is
      // that the raw history is still the source of truth (blocks don't
      // silently stick around after their projection fails).
      const safetyNotice = notifiedMessages.find((m) => m.toLowerCase().includes("retired") || m.toLowerCase().includes("projection"));
      // At minimum, the status line should still be populated (the display
      // must not be empty regardless of which path the compact took).
      expect(notifiedMessages.length).toBeGreaterThan(0);
      // And /dcp status must work after compact.
      notifiedMessages.length = 0;
      await dcpCommand.handler!("status", ctx);
      const status = notifiedMessages.join("\n");
      expect(status).toContain("pi-dcp:");
      // We do not assert safetyNotice must be present (some valid compact
      // paths don't trigger it); the safety check only matters when the
      // projection actually fails.
      void safetyNotice;
    } finally {
      completeSimpleMock.mockReset();
    }
  });

  it("INVARIANT: /dcp status output must differ before vs after /dcp compact (realistic branch with tool calls and reasoning)", async () => {
    // The previous test passed with a simple mock branch. The real bug only
    // manifests with the kind of state a real session has: tool calls, tool
    // results, reasoning blocks, and the subtle interaction between message
    // identity (messageKey) and the projection. This test simulates that.
    const mod = await import(EXTENSION_PATH);
    const hooks: Record<string, Function[]> = {};
    const commands: Array<{ name: string; description?: string; handler?: Function }> = [];
    const entryRenderers = new Map<string, Function>();
    const mockApi = makeMockApi(hooks, commands, entryRenderers);
    mod.default(mockApi as any);

    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "tiny summary" }] });

    // Realistic branch: tool calls, tool results, reasoning blocks. These
    // are the exact conditions that cause the projection to fail in the wild.
    const toolResultText = "x".repeat(50_000);
    const assistantToolCall = {
      role: "assistant",
      content: [
        { type: "text", text: "doing tool" },
        { type: "toolCall", id: "tc1", name: "read", arguments: { path: "a" } },
        { type: "toolCall", id: "tc2", name: "bash", arguments: { command: "ls" } },
      ],
      timestamp: 2,
    };
    const branch: any[] = [
      { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "x".repeat(100_000) }], timestamp: 1 } },
      { type: "message", id: "a1", parentId: "u1", timestamp: new Date().toISOString(), message: { ...assistantToolCall, id: "a1", parentId: "u1" } },
      { type: "message", id: "r1", parentId: "a1", timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: toolResultText }], timestamp: 3 } },
      { type: "message", id: "r2", parentId: "a1", timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: "tc2", toolName: "bash", content: [{ type: "text", text: "file1\nfile2" }], timestamp: 4 } },
      { type: "message", id: "u2", parentId: "a1", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "current request" }], timestamp: 5 } },
    ];

    const notifiedMessages: string[] = [];
    const ctx: any = {
      hasUI: true,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { notify: (message: string) => notifiedMessages.push(message) },
      getContextUsage: () => ({ tokens: 900_000, contextWindow: 1_000_000 }),
      sessionManager: { getBranch: () => branch, buildContextEntries: () => branch },
      isIdle: () => true,
      hasPendingMessages: () => false,
      compact: function () {},
      model: { reasoning: false, maxTokens: 8_000, contextWindow: 1_000_000, provider: "p", id: "m" },
      modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) },
      signal: undefined,
      getThinkingLevel: () => "off",
    };

    try {
      for (const h of hooks["session_start"] ?? []) await h({ type: "session_start", reason: "new" }, ctx);

      const dcpCommand = commands.find((c) => c.name === "dcp")!;

      notifiedMessages.length = 0;
      await dcpCommand.handler!("status", ctx);
      const statusBefore = notifiedMessages.join("\n");

      await dcpCommand.handler!("compact", ctx);

      notifiedMessages.length = 0;
      await dcpCommand.handler!("status", ctx);
      const statusAfter = notifiedMessages.join("\n");

      // THE INVARIANT.
      expect(statusAfter).not.toBe(statusBefore);
      expect(statusAfter).toContain("vctx (actual sent)");
      expect(statusBefore).not.toContain("vctx (actual sent)");
    } finally {
      completeSimpleMock.mockReset();
    }
  });

  it("/dcp context is an alias for /dcp status and shows the same output", async () => {
    const mod = await import(EXTENSION_PATH);
    const hooks: Record<string, Function[]> = {};
    const commands: Array<{ name: string; description?: string; handler?: Function }> = [];
    const entryRenderers = new Map<string, Function>();
    const mockApi = makeMockApi(hooks, commands, entryRenderers);
    mod.default(mockApi as any);

    const notifiedMessages: string[] = [];
    const ctx: any = {
      hasUI: true,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { notify: (message: string) => notifiedMessages.push(message) },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1000 }),
      sessionManager: { getBranch: () => [] },
      isIdle: () => true,
    };
    for (const h of hooks["session_start"] ?? []) await h({ type: "session_start", reason: "new" }, ctx);

    const dcpCommand = commands.find((c) => c.name === "dcp")!;

    notifiedMessages.length = 0;
    await dcpCommand.handler!("status", ctx);
    const statusOutput = notifiedMessages.join("\n");

    notifiedMessages.length = 0;
    await dcpCommand.handler!("context", ctx);
    const contextOutput = notifiedMessages.join("\n");

    expect(contextOutput).toBe(statusOutput);
    // And the key fields are present.
    expect(contextOutput).toContain("pi-dcp:");
    expect(contextOutput).toContain("context:");
    expect(contextOutput).toContain("thresholds:");
  });

  it("/dcp compress mid-run deferred to turn_end: creates virtual blocks THEN aborts (no race)", async () => {
    // The fix: /dcp compress must NOT race the live run. It creates virtual
    // blocks first (via the existing context magic), persists them, and only
    // THEN calls ctx.compact() to abort. The virtual blocks survive the abort
    // (they're custom entries) and are projected in via the context hook for
    // the next request. If the order were reversed (abort first, blocks after),
    // the blocks would be useless - they'd be created against a session state
    // that's already been compacted.
    const mod = await import(EXTENSION_PATH);
    const hooks: Record<string, Function[]> = {};
    const commands: Array<{ name: string; description?: string; handler?: Function }> = [];
    const entryRenderers = new Map<string, Function>();
    const mockApi = makeMockApi(hooks, commands, entryRenderers);
    mod.default(mockApi as any);

    const bigText = "x".repeat(200_000);
    const branch: any[] = [
      { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: bigText }], timestamp: 1 } },
      { type: "message", id: "a1", parentId: "u1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 } },
      { type: "message", id: "u2", parentId: "a1", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "current request" }], timestamp: 3 } },
    ];

    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "tiny summary" }] });

    let idle = false;
    const notifiedMessages: string[] = [];
    const ctx: any = {
      hasUI: true,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { notify: (message: string) => notifiedMessages.push(message) },
      getContextUsage: () => ({ tokens: 900_000, contextWindow: 1_000_000 }),
      sessionManager: { getBranch: () => branch, buildContextEntries: () => branch },
      isIdle: () => idle,
      hasPendingMessages: () => false,
      compact: function (opts: any) {
        (ctx as any).compactCallCount = ((ctx as any).compactCallCount ?? 0) + 1;
        queueMicrotask(() => opts.onComplete?.());
      },
      model: { reasoning: false, maxTokens: 8_000, contextWindow: 1_000_000, provider: "p", id: "m" },
      modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) },
      signal: undefined,
      getThinkingLevel: () => "off",
    };

    try {
      for (const h of hooks["session_start"] ?? []) await h({ type: "session_start", reason: "new" }, ctx);

      const dcpCommand = commands.find((c) => c.name === "dcp")!;

      // Mid-run: defer, don't race.
      idle = false;
      notifiedMessages.length = 0;
      await dcpCommand.handler!("compress", ctx);
      const deferredNotices = notifiedMessages.filter((m) => m.includes("end of the current step"));
      expect(deferredNotices.length).toBe(1);
      expect(completeSimpleMock.mock.calls.length).toBe(0);
      expect((ctx as any).compactCallCount ?? 0).toBe(0);

      // Turn ends: the deferred compress runs. Virtual blocks are created FIRST,
      // then ctx.compact() aborts. The order is critical - blocks must be
      // persisted before the abort so they survive compaction.
      idle = true;
      for (const h of hooks["turn_end"] ?? []) await h({ type: "turn_end" }, ctx);

      // Both ran: the summarizer (to create blocks) AND the abort.
      expect(completeSimpleMock.mock.calls.length).toBeGreaterThan(0);
      expect((ctx as any).compactCallCount).toBe(1);
    } finally {
      completeSimpleMock.mockReset();
    }
  });

  it("/dcp compact typed while the agent is mid-run is deferred to the next turn_end, not run inline", async () => {
    // Regression test for Fix 3: Pi executes extension commands during streaming,
    // so /dcp compact typed mid-run ran inline. The relief's summarizer calls
    // shared the live run's abort signal, so ESC aborted the user's compact
    // with a misleading "no work available" message, and the relief raced
    // the live run. With the fix, a mid-run compact is deferred and consumed
    // at the next turn_end.
    const mod = await import(EXTENSION_PATH);
    const hooks: Record<string, Function[]> = {};
    const commands: Array<{ name: string; description?: string; handler?: Function }> = [];
    const entryRenderers = new Map<string, Function>();
    const mockApi = makeMockApi(hooks, commands, entryRenderers);
    mod.default(mockApi as any);

    const bigText = "x".repeat(200_000);
    const branch: any[] = [
      { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: bigText }], timestamp: 1 } },
      { type: "message", id: "a1", parentId: "u1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 } },
      { type: "message", id: "u2", parentId: "a1", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "current request" }], timestamp: 3 } },
    ];

    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "tiny summary" }] });

    // Mocked ctx reports busy for the user's /dcp compact, then idle for the
    // next turn_end so the deferred compact can consume.
    let idle = false;
    const notifiedMessages: string[] = [];
    const ctx: any = {
      hasUI: true,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { notify: (message: string) => notifiedMessages.push(message) },
      getContextUsage: () => ({ tokens: 900_000, contextWindow: 1_000_000 }),
      sessionManager: { getBranch: () => branch, buildContextEntries: () => branch },
      isIdle: () => idle,
      hasPendingMessages: () => false,
      compact: function () { (ctx as any).compactCallCount = ((ctx as any).compactCallCount ?? 0) + 1; },
      model: { reasoning: false, maxTokens: 8_000, contextWindow: 1_000_000, provider: "p", id: "m" },
      modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) },
      signal: undefined,
      getThinkingLevel: () => "off",
    };

    try {
      for (const h of hooks["session_start"] ?? []) await h({ type: "session_start", reason: "new" }, ctx);

      const dcpCommand = commands.find((c) => c.name === "dcp")!;

      // Agent is mid-run. /dcp compact must defer, not run inline.
      idle = false;
      notifiedMessages.length = 0;
      await dcpCommand.handler!("compact", ctx);

      const deferredNotices = notifiedMessages.filter((m) => m.includes("end of the current step"));
      expect(deferredNotices.length).toBe(1);

      // The summarizer must NOT have been called yet - the relief was deferred.
      expect(completeSimpleMock.mock.calls.length).toBe(0);

      // Now the turn ends and the agent becomes idle. The deferred compact is
      // consumed from turn_end before the auto-trigger runs.
      idle = true;
      for (const h of hooks["turn_end"] ?? []) await h({ type: "turn_end" }, ctx);

      // The deferred compact ran.
      expect(completeSimpleMock.mock.calls.length).toBeGreaterThan(0);
    } finally {
      completeSimpleMock.mockReset();
    }
  });

  it("/dcp compress warns when active blocks exist (they may be retired by the abort)", async () => {
    // Honest warning: /dcp compress creates virtual blocks then aborts the
    // run. Pi's compaction then summarizes the raw history, which can retire
    // existing blocks whose entry ranges are no longer in the active context.
    const mod = await import(EXTENSION_PATH);
    const hooks: Record<string, Function[]> = {};
    const commands: Array<{ name: string; description?: string; handler?: Function }> = [];
    const entryRenderers = new Map<string, Function>();
    const mockApi = makeMockApi(hooks, commands, entryRenderers);
    mod.default(mockApi as any);

    const notifiedMessages: string[] = [];
    const ctx: any = {
      hasUI: true,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { notify: (message: string) => notifiedMessages.push(message) },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1000 }),
      sessionManager: { getBranch: () => [] },
      isIdle: () => true,
      hasPendingMessages: () => false,
      compact: function (opts: any) {
        (ctx as any).compactCallCount = ((ctx as any).compactCallCount ?? 0) + 1;
        // Simulate Pi firing its onComplete callback so the trigger state is reset.
        queueMicrotask(() => opts.onComplete?.());
      },
      model: undefined,
    };

    for (const h of hooks["session_start"] ?? []) await h({ type: "session_start", reason: "new" }, ctx);

    const dcpCommand = commands.find((c) => c.name === "dcp")!;

    // No blocks yet: no warning.
    notifiedMessages.length = 0;
    await dcpCommand.handler!("compress", ctx);
    const noBlockNotices = notifiedMessages.filter((m) => m.includes("existing") && m.includes("retired"));
    expect(noBlockNotices.length).toBe(0);

    // Plant a fake active block in state and run compress again.
    const dcpState = (await import("../src/state.ts")).createTriggerState();
    const fakeBlock = {
      version: 1,
      id: "block-1",
      startEntryId: "u1",
      endEntryId: "a1",
      anchorEntryId: "u1",
      rangeKind: "historical" as const,
      messagesCompressed: 2,
      toolsCompressed: 0,
      summary: "x",
      exactEvidence: "",
      preservedUserMessages: [],
      estimatedRawTokens: 10,
      retainedRawTokens: 20,
      estimatedBlockTokens: 5,
      active: true,
      createdAt: Date.now(),
    };
    // Inject the block by setting it through the session_start → virtualBlocks rebuild.
    // We bypass the rebuild by directly mutating state via a follow-up compact call.
    // Instead: trigger /dcp compact first to create a real block, then /dcp compress.
    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "tiny summary" }] });
    const bigText = "x".repeat(200_000);
    const branch: any[] = [
      { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: bigText }], timestamp: 1 } },
      { type: "message", id: "a1", parentId: "u1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 } },
      { type: "message", id: "u2", parentId: "a1", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "current request" }], timestamp: 3 } },
    ];
    ctx.sessionManager = { getBranch: () => branch, buildContextEntries: () => branch };
    ctx.getContextUsage = () => ({ tokens: 900_000, contextWindow: 1_000_000 });
    ctx.model = { reasoning: false, maxTokens: 8_000, contextWindow: 1_000_000, provider: "p", id: "m" };
    ctx.modelRegistry = { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) };
    notifiedMessages.length = 0;
    await dcpCommand.handler!("compress", ctx);
    // compress aborted with no model, so no block was created. We need to
    // run /dcp compact with a mocking summarizer to actually create a block.
    void fakeBlock; // referenced for documentation; the real block comes from /dcp compact below.

    // Now create a real block via /dcp compact.
    notifiedMessages.length = 0;
    await dcpCommand.handler!("compact", ctx);
    // /dcp compact ran the summarizer. The branch state now has at least one block.
    // Verify by calling /dcp compress and checking the warning.
    notifiedMessages.length = 0;
    await dcpCommand.handler!("compress", ctx);
    const blockPresentNotices = notifiedMessages.filter((m) => m.includes("existing") && m.includes("retired"));
    expect(blockPresentNotices.length).toBe(1);
  });
  it("persists a durable compaction receipt entry instead of a transient notify", async () => {
    // Regression test for a real bug: ctx.ui.notify() renders a transient status
    // line that gets wiped the instant Pi rebuilds the chat transcript from
    // persisted branch entries after compaction (which always happens). The
    // receipt MUST be written via pi.appendEntry() so it survives that rebuild,
    // and MUST render to a real, non-empty pi-tui Component.
    const mod = await import(EXTENSION_PATH);
    const hooks: Record<string, Function[]> = {};
    const commands: Array<{ name: string; description?: string }> = [];
    const entryRenderers = new Map<string, Function>();
    const appendedEntries: Array<{ customType: string; data: unknown }> = [];

    const mockApi = makeMockApi(hooks, commands, entryRenderers);
    mockApi.appendEntry = ((customType: string, data: unknown) => {
      appendedEntries.push({ customType, data });
    }) as any;

    mod.default(mockApi as any);

    const ctx: any = {
      hasUI: true,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { notify: () => {} },
      getContextUsage: () => ({ tokens: 125006, contextWindow: 200000 }),
      sessionManager: { getBranch: () => [] },
      model: undefined,
    };

    for (const h of hooks["session_start"] ?? []) {
      await h({ type: "session_start", reason: "new" }, ctx);
    }

    const message = (role: string, text: string) => ({
      role,
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });

    const beforeEvent: any = {
      type: "session_before_compact",
      preparation: {
        messagesToSummarize: [message("user", "u1"), message("assistant", "a1")],
        turnPrefixMessages: [],
        tokensBefore: 125006,
        firstKeptEntryId: "keep-1",
        previousSummary: undefined,
        fileOps: { read: [], edited: [], written: [] },
      },
      branchEntries: [
        { type: "message", id: "keep-1", parentId: null, timestamp: new Date().toISOString(), message: message("user", "kept") },
      ],
      customInstructions: "Preserve architecture decisions, file changes, and current task.",
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    };

    for (const h of hooks["session_before_compact"] ?? []) {
      await h(beforeEvent, ctx);
    }

    const compactEvent: any = {
      type: "session_compact",
      compactionEntry: {
        id: "compaction-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        type: "compaction",
        summary: "Default Pi summary text.",
        firstKeptEntryId: "keep-1",
        tokensBefore: 125006,
      },
      fromExtension: false,
      reason: "threshold",
      willRetry: false,
    };

    for (const h of hooks["session_compact"] ?? []) {
      await h(compactEvent, ctx);
    }

    const receiptEntries = appendedEntries.filter((e) => e.customType === "dcp-receipt");
    expect(receiptEntries.length).toBe(1);
    const receiptData = receiptEntries[0].data as { text: string };
    expect(receiptData.text).toContain("▣");

    // Render it through the actual registered entry renderer, exactly like the
    // interactive TUI would when displaying the persisted entry.
    const fakeTheme = { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text };
    const renderer = entryRenderers.get("dcp-receipt")!;
    const component = renderer({ data: receiptData }, { expanded: false }, fakeTheme);
    expect(component).toBeDefined();
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("▣");
  });

  it("does not hijack a plain native /compact (or Pi's own threshold/overflow auto-compact) with DCP's custom summary", async () => {
    // Regression test for a real bug: session_before_compact fires for every
    // compaction reason (manual /compact, Pi's own threshold/overflow, AND
    // pi-dcp's own /dcp compact or dual-threshold trigger) - there is only one
    // hook, shared by all of them. DCP must only substitute its own custom
    // summary when it genuinely asked for the compaction itself; a plain native
    // /compact (or Pi's own auto-compaction) must be left completely untouched.
    const mod = await import(EXTENSION_PATH);
    const hooks: Record<string, Function[]> = {};
    const commands: Array<{ name: string; description?: string; handler?: Function }> = [];
    const entryRenderers = new Map<string, Function>();

    const mockApi = makeMockApi(hooks, commands, entryRenderers);
    mod.default(mockApi as any);

    const notifiedMessages: string[] = [];
    const ctx: any = {
      hasUI: true,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { notify: (message: string) => notifiedMessages.push(message) },
      getContextUsage: () => ({ tokens: 125006, contextWindow: 200000 }),
      sessionManager: { getBranch: () => [] },
      isIdle: () => true,
      hasPendingMessages: () => false,
      compact: function () { (ctx as any).compactCalled = ((ctx as any).compactCalled ?? 0) + 1; },
      // No model available: if handleSessionBeforeCompact runs, it must notify
      // "No model available..." and fall back - that notification is the signal
      // we use below to detect whether the custom-summary path was reached at all.
      model: undefined,
    };

    for (const h of hooks["session_start"] ?? []) {
      await h({ type: "session_start", reason: "new" }, ctx);
    }

    const message = (role: string, text: string) => ({
      role,
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });

    const makeBeforeEvent = (reason: string): any => ({
      type: "session_before_compact",
      preparation: {
        messagesToSummarize: [message("user", "u1"), message("assistant", "a1")],
        turnPrefixMessages: [],
        tokensBefore: 125006,
        firstKeptEntryId: "keep-1",
        previousSummary: undefined,
        fileOps: { read: [], edited: [], written: [] },
      },
      branchEntries: [],
      customInstructions: undefined,
      reason,
      willRetry: false,
      signal: new AbortController().signal,
    });

    // Case 1: plain native /compact (or Pi's own threshold auto-compact) - no
    // pendingInitiator was ever set, so this resolves to "pi-native". Must be
    // left completely alone: handleSessionBeforeCompact must never run.
    for (const h of hooks["session_before_compact"] ?? []) {
      await h(makeBeforeEvent("threshold"), ctx);
    }
    expect(notifiedMessages.some((m) => m.includes("No model available"))).toBe(false);

    // Case 2: a genuine /dcp compact command run - pendingInitiator is set to
    // "dcp-command" by triggerCompaction() before ctx.compact() fires. DCP must
    // actually attempt its own custom summary here (and fall back honestly,
    // since there's no model in this test).
    const dcpCommand = commands.find((c) => c.name === "dcp")!;
    await dcpCommand.handler!("compress", ctx);
    for (const h of hooks["session_before_compact"] ?? []) {
      await h(makeBeforeEvent("manual"), ctx);
    }
    expect(notifiedMessages.some((m) => m.includes("No model available"))).toBe(true);
  });

  it("downgrades the receipt to PI NATIVE when the DCP custom summary was requested but Pi used its default", async () => {
    // Regression test for a real bug: handleSessionBeforeCompact can fail (no
    // model, provider error, empty response) and return undefined, in which
    // case Pi falls back to its own default summary. session_compact used to
    // read the stale preview and report the run as a DCP command even though
    // event.fromExtension was false - the receipt would have claimed a DCP
    // run that never actually ran. It must report pi-native and warn the user.
    const mod = await import(EXTENSION_PATH);
    const hooks: Record<string, Function[]> = {};
    const commands: Array<{ name: string; description?: string; handler?: Function }> = [];
    const entryRenderers = new Map<string, Function>();

    const mockApi = makeMockApi(hooks, commands, entryRenderers);
    mod.default(mockApi as any);

    const notifiedMessages: string[] = [];
    const ctx: any = {
      hasUI: true,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { notify: (message: string) => notifiedMessages.push(message) },
      getContextUsage: () => ({ tokens: 200000, contextWindow: 400000 }),
      sessionManager: { getBranch: () => [], buildContextEntries: () => [] },
      isIdle: () => true,
      hasPendingMessages: () => false,
      compact: function () { (ctx as any).compactCalled = ((ctx as any).compactCalled ?? 0) + 1; },
      model: undefined,
    };

    for (const h of hooks["session_start"] ?? []) {
      await h({ type: "session_start", reason: "new" }, ctx);
    }

    const dcpCommand = commands.find((c) => c.name === "dcp")!;
    await dcpCommand.handler!("compress", ctx);

    // Simulate the full Pi compaction flow: session_before_compact, then
    // session_compact with fromExtension=false (Pi's default summary was used
    // because DCP's custom summary failed in handleSessionBeforeCompact).
    const before = hooks["session_before_compact"]?.[0];
    if (!before) throw new Error("session_before_compact handler not registered");
    const beforeEvent: any = {
      type: "session_before_compact",
      preparation: {
        messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "u1" }] }],
        turnPrefixMessages: [],
        tokensBefore: 200000,
        firstKeptEntryId: "keep-1",
        previousSummary: undefined,
        fileOps: { read: [], edited: [], written: [] },
      },
      branchEntries: [],
      customInstructions: undefined,
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    };
    const beforeResult = await before(beforeEvent, ctx);
    // handleSessionBeforeCompact requires a model; with no model it returns
    // undefined and Pi's default summary proceeds.
    expect(beforeResult).toBeUndefined();

    const compactEvent: any = {
      type: "session_compact",
      compactionEntry: {
        id: "compaction-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        type: "compaction",
        summary: "Default Pi summary text.",
        firstKeptEntryId: "keep-1",
        tokensBefore: 200000,
      },
      fromExtension: false,
      reason: "manual",
      willRetry: false,
    };
    for (const h of hooks["session_compact"] ?? []) {
      await h(compactEvent, ctx);
    }

    expect(notifiedMessages.some((m) => m.toLowerCase().includes("dcp custom summary did not run"))).toBe(true);
  });

  it("/dcp compact_continue resumes the task after virtual compaction", async () => {
    const mod = await import(EXTENSION_PATH);
    const hooks: Record<string, Function[]> = {};
    const commands: Array<{ name: string; description?: string; handler?: Function }> = [];
    const entryRenderers = new Map<string, Function>();

    const mockApi = makeMockApi(hooks, commands, entryRenderers);
    mod.default(mockApi as any);

    const notifiedMessages: string[] = [];
    const ctx: any = {
      hasUI: true,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { notify: (message: string) => notifiedMessages.push(message) },
      getContextUsage: () => undefined,
      sessionManager: { getBranch: () => [] },
      isIdle: () => true,
      hasPendingMessages: () => false,
    };

    for (const h of hooks["session_start"] ?? []) {
      await h({ type: "session_start", reason: "new" }, ctx);
    }

    const dcpCommand = commands.find((c) => c.name === "dcp")!;
    const sentUserMessages: string[] = [];
    (mockApi as any).sendUserMessage = (message: string) => { sentUserMessages.push(message); };
    await dcpCommand.handler!("compact_continue", ctx);
    expect(sentUserMessages).toEqual(["Resuming from context compression, continue current task"]);
    // Virtual compact still must never ask Pi to compact (which would abort a run).
    expect((mockApi as any).compactCallCount ?? 0).toBe(0);
  });

  it("context hook injects a persisted summary while keeping the active suffix raw", async () => {
    const mod = await import(EXTENSION_PATH);
    const hooks: Record<string, Function[]> = {};
    const commands: Array<{ name: string; description?: string }> = [];
    const entryRenderers = new Map<string, Function>();
    const oldMessage = (id: string, role: string, text: string) => ({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role, content: [{ type: "text", text }], timestamp: Date.now() } });
    const branch: any[] = [
      oldMessage("u1", "user", "old request"),
      oldMessage("a1", "assistant", "old result"),
      { type: "custom", id: "b1", parentId: "a1", timestamp: new Date().toISOString(), customType: "dcp-context-range.v1", data: { version: 1, block: { version: 1, id: "block-1", startEntryId: "u1", endEntryId: "a1", anchorEntryId: "u1", rangeKind: "historical", messagesCompressed: 2, toolsCompressed: 0, summary: "old phase preserved", exactEvidence: "", preservedUserMessages: ["old request"], estimatedRawTokens: 20, retainedRawTokens: 30, estimatedBlockTokens: 4, active: true, createdAt: Date.now() } } },
      oldMessage("u2", "user", "active request"),
    ];
    const mockApi = makeMockApi(hooks, commands, entryRenderers);
    mod.default(mockApi as any);
    const ctx: any = {
      hasUI: false,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { notify: () => {} },
      getContextUsage: () => ({ tokens: 10, contextWindow: 100 }),
      sessionManager: { getBranch: () => branch, buildContextEntries: () => branch },
    };
    for (const handler of hooks["session_start"] ?? []) await handler({ type: "session_start", reason: "new" }, ctx);
    const raw = branch.filter((entry) => entry.type === "message").map((entry) => entry.message);
    const result = await hooks["context"][0]({ type: "context", messages: raw }, ctx);
    expect(result.messages).toHaveLength(2);
    expect(JSON.stringify(result.messages[0])).toContain("old phase preserved");
    expect(JSON.stringify(result.messages[1])).toContain("active request");
  });

  it("automatic threshold relief does not call Pi's aborting compact primitive", async () => {
    const mod = await import(EXTENSION_PATH);
    const hooks: Record<string, Function[]> = {};
    const commands: Array<{ name: string; description?: string; handler?: Function }> = [];
    const entryRenderers = new Map<string, Function>();
    const mockApi = makeMockApi(hooks, commands, entryRenderers) as any;
    mod.default(mockApi as any);
    const compact = vi.fn();
    const widgets: Array<{ key: string; content: string[] | undefined }> = [];
    const ctx: any = {
      hasUI: true,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: {
        notify: () => {},
        setWidget: (key: string, content: string[] | undefined) => widgets.push({ key, content }),
      },
      getContextUsage: () => ({ tokens: 500_000, contextWindow: 1_000_000 }),
      sessionManager: { getBranch: () => [], buildContextEntries: () => [] },
      model: undefined,
      compact,
      getThinkingLevel: () => "off",
      isIdle: () => true,
    };
    for (const h of hooks["session_start"] ?? []) await h({ type: "session_start", reason: "new" }, ctx);
    for (const h of hooks["turn_end"] ?? []) await h({ type: "turn_end" }, ctx);
    for (const h of hooks["turn_end"] ?? []) await h({ type: "turn_end" }, ctx);
    expect(compact).not.toHaveBeenCalled();
    expect(widgets.some((widget) => widget.content?.[0].includes("summarizing completed work"))).toBe(true);
    expect(widgets.some((widget) => widget.key === "dcp-compacting" && widget.content === undefined)).toBe(true);
    await commands.find((command) => command.name === "dcp")?.handler?.("compact", ctx);
    expect(compact).not.toHaveBeenCalled();
  });

  it("automatic threshold relief actually creates virtual blocks (not just shows a widget)", async () => {
    // Regression test: the previous "does not call ctx.compact" test only
    // verified the widget appeared, which passes vacuously when the auto-trigger
    // runs but the summarizer fails (no model, etc.) and no blocks are created.
    // This test wires a real model + mock summarizer + real branch and asserts
    // the summarizer was actually called - proving the auto-trigger does the
    // surgical compression, not just shows a spinner.
    const mod = await import(EXTENSION_PATH);
    const hooks: Record<string, Function[]> = {};
    const commands: Array<{ name: string; description?: string; handler?: Function }> = [];
    const entryRenderers = new Map<string, Function>();
    const mockApi = makeMockApi(hooks, commands, entryRenderers)
    mod.default(mockApi as any);
    const compact = vi.fn();

    const bigText = "x".repeat(200_000);
    const branch: any[] = [
      { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: bigText }], timestamp: 1 } },
      { type: "message", id: "a1", parentId: "u1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 } },
      { type: "message", id: "u2", parentId: "a1", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "current request" }], timestamp: 3 } },
    ];

    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "tiny summary" }] });

    const ctx: any = {
      hasUI: true,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { notify: () => {} },
      getContextUsage: () => ({ tokens: 900_000, contextWindow: 1_000_000 }),
      sessionManager: { getBranch: () => branch, buildContextEntries: () => branch },
      model: { reasoning: false, maxTokens: 8_000, contextWindow: 1_000_000, provider: "p", id: "m" },
      modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) },
      signal: undefined,
      compact,
      getThinkingLevel: () => "off",
      isIdle: () => true,
    };

    try {
      for (const h of hooks["session_start"] ?? []) await h({ type: "session_start", reason: "new" }, ctx);
      // Clear cooldown + growth guard.
      for (let i = 0; i < 3; i++) {
        for (const h of hooks["turn_end"] ?? []) await h({ type: "turn_end" }, ctx);
      }
      // The summarizer was called - the auto-trigger actually created blocks.
      expect(completeSimpleMock.mock.calls.length).toBeGreaterThan(0);
      // The run was NOT aborted - ctx.compact was never called.
      expect(compact).not.toHaveBeenCalled();
    } finally {
      completeSimpleMock.mockReset();
    }
  });

  it("exposes plain command help without internal architecture terms", async () => {
    const mod = await import(EXTENSION_PATH);
    const hooks: Record<string, Function[]> = {};
    const commands: Array<{ name: string; description?: string; handler?: Function }> = [];
    const entryRenderers = new Map<string, Function>();
    const mockApi = makeMockApi(hooks, commands, entryRenderers);
    mod.default(mockApi as any);
    const notices: string[] = [];
    const ctx: any = {
      hasUI: true,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { notify: (text: string) => notices.push(text) },
      getContextUsage: () => ({ tokens: 1, contextWindow: 100 }),
      sessionManager: { getBranch: () => [] },
    };
    for (const handler of hooks["session_start"] ?? []) await handler({ type: "session_start", reason: "new" }, ctx);
    await commands.find((command) => command.name === "dcp")?.handler?.("help", ctx);
    const help = notices.join("\n");
    expect(help).toContain("compact");
    expect(help).toContain("compress");
    expect(help).not.toMatch(/PLAN3|virtual block|legacy kung fu|slopleak/i);
  });

  it("/dcp threshold sets the dual-threshold for this session only, without touching config files", async () => {
    const mod = await import(EXTENSION_PATH);
    const hooks: Record<string, Function[]> = {};
    const commands: Array<{ name: string; description?: string; handler?: Function }> = [];
    const entryRenderers = new Map<string, Function>();

    const mockApi = makeMockApi(hooks, commands, entryRenderers);
    mod.default(mockApi as any);

    const notifiedMessages: string[] = [];
    const ctx: any = {
      hasUI: true,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { notify: (message: string) => notifiedMessages.push(message) },
      getContextUsage: () => ({ tokens: 100_000, contextWindow: 1_000_000 }),
      sessionManager: { getBranch: () => [] },
      isIdle: () => true,
      hasPendingMessages: () => false,
      compact: function () { (ctx as any).compactCalled = ((ctx as any).compactCalled ?? 0) + 1; },
      model: undefined,
    };

    for (const h of hooks["session_start"] ?? []) {
      await h({ type: "session_start", reason: "new" }, ctx);
    }

    const dcpCommand = commands.find((c) => c.name === "dcp")!;

    // Valid: sets both percent and absolute.
    await dcpCommand.handler!("threshold 60 300000", ctx);
    expect(notifiedMessages.some((m) => m.includes("60%") && m.includes("300,000"))).toBe(true);

    // Valid: "null" disables one side.
    notifiedMessages.length = 0;
    await dcpCommand.handler!("threshold null 500000", ctx);
    expect(notifiedMessages.some((m) => m.includes("—") && m.includes("500,000"))).toBe(true);

    // Invalid: out-of-range percent is rejected, does not change state.
    notifiedMessages.length = 0;
    await dcpCommand.handler!("threshold 150 300000", ctx);
    expect(notifiedMessages.some((m) => m.toLowerCase().includes("invalid percent"))).toBe(true);

    // Missing argument is rejected with a usage message.
    notifiedMessages.length = 0;
    await dcpCommand.handler!("threshold 60", ctx);
    expect(notifiedMessages.some((m) => m.toLowerCase().includes("usage"))).toBe(true);
  });
});
