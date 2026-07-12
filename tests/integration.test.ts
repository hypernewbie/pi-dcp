import { describe, it, expect } from "vitest";
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
    expect(hookEvents).toContain("agent_settled");
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
});
