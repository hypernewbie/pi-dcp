import { describe, it, expect, vi } from "vitest";
import { resolve } from "node:path";

const EXTENSION_PATH = resolve(import.meta.dirname, "../src/index.ts");

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
      compact: () => {},
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

  it("context hook injects a persisted summary while keeping the active suffix raw", async () => {
    const mod = await import(EXTENSION_PATH);
    const hooks: Record<string, Function[]> = {};
    const commands: Array<{ name: string; description?: string }> = [];
    const entryRenderers = new Map<string, Function>();
    const oldMessage = (id: string, role: string, text: string) => ({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role, content: [{ type: "text", text }], timestamp: Date.now() } });
    const branch: any[] = [
      oldMessage("u1", "user", "old request"),
      oldMessage("a1", "assistant", "old result"),
      { type: "custom", id: "b1", parentId: "a1", timestamp: new Date().toISOString(), customType: "dcp-context-range.v1", data: { version: 1, block: { version: 1, id: "block-1", startEntryId: "u1", endEntryId: "a1", anchorEntryId: "u1", summary: "old phase preserved", exactEvidence: "", preservedUserMessages: ["old request"], estimatedRawTokens: 20, estimatedBlockTokens: 4, active: true, createdAt: Date.now() } } },
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
    const ctx: any = {
      hasUI: false,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { notify: () => {} },
      getContextUsage: () => ({ tokens: 500_000, contextWindow: 1_000_000 }),
      sessionManager: { getBranch: () => [], buildContextEntries: () => [] },
      model: undefined,
      compact,
      getThinkingLevel: () => "off",
    };
    for (const h of hooks["session_start"] ?? []) await h({ type: "session_start", reason: "new" }, ctx);
    for (const h of hooks["turn_end"] ?? []) await h({ type: "turn_end" }, ctx);
    expect(compact).not.toHaveBeenCalled();
    await commands.find((command) => command.name === "dcp")?.handler?.("compact", ctx);
    expect(compact).not.toHaveBeenCalled();
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
      compact: () => {},
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
