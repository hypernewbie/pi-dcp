import { describe, it, expect } from "vitest";
import { resolve } from "node:path";

const EXTENSION_PATH = resolve(import.meta.dirname, "../src/index.ts");

describe("extension entry point", () => {
  it("registers expected commands and hooks", async () => {
    const mod = await import(EXTENSION_PATH);
    const commands: Array<{ name: string; description?: string }> = [];
    const hooks: Array<{ event: string }> = [];

    const mockApi = {
      registerCommand: (name: string, options: any) => commands.push({ name, ...options }),
      on: (event: string, _handler: unknown) => hooks.push({ event }),
      registerTool: () => {},
      registerShortcut: () => {},
      registerFlag: () => {},
      getFlag: () => undefined,
      registerMessageRenderer: () => {},
      registerEntryRenderer: () => {},
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

    mod.default(mockApi as any);

    const commandNames = commands.map((c) => c.name).sort();
    expect(commandNames).toEqual(["dcp"]);

    const hookEvents = hooks.map((h) => h.event).sort();
    expect(hookEvents).toContain("session_start");
    expect(hookEvents).toContain("turn_end");
    expect(hookEvents).toContain("session_compact");
    expect(hookEvents).toContain("before_agent_start");
    expect(hookEvents).toContain("context");
    expect(hookEvents).toContain("session_before_compact");
  });
});
