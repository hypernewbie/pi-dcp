import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { initTheme, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { registerSessionReaderTool } from "../src/session-reader-tool.ts";

function user(id: string, text: string): SessionEntry {
  return {
    type: "message", id, parentId: null, timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage,
  } as SessionEntry;
}

describe("dcp_read_session tool", () => {
  it("registers one plainly-described, sequential, bounded retrieval tool", () => {
    let definition: any;
    registerSessionReaderTool({ registerTool: (tool: any) => { definition = tool; } } as any);
    expect(definition.name).toBe("dcp_read_session");
    expect(definition.label).toBe("Read Session History");
    expect(definition.executionMode).toBe("sequential");
    expect(definition.description).toMatch(/small, specific raw excerpt/i);
    expect(definition.promptGuidelines.join(" ")).toMatch(/never request the whole session/i);
  });

  it("reads getBranch rather than a compacted context projection and never mutates it", async () => {
    let definition: any;
    registerSessionReaderTool({ registerTool: (tool: any) => { definition = tool; } } as any);
    const branch = [user("u1", "raw original request")];
    const ctx: any = {
      sessionManager: {
        getBranch: () => branch,
        buildContextEntries: () => { throw new Error("must not use compacted context"); },
      },
    };
    const result = await definition.execute("call", { action: "read", startEntryId: "u1", endEntryId: "u1", maxTokens: 500 }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("raw original request");
    expect(result.details.returnedIds).toEqual(["u1"]);
    expect(branch).toHaveLength(1);
  });

  it("keeps full output for the model but renders a compact collapsed result", async () => {
    let definition: any;
    registerSessionReaderTool({ registerTool: (tool: any) => { definition = tool; } } as any);
    const branch = [user("u1", `raw original request ${"detail ".repeat(200)}`)];
    const result = await definition.execute("call", { action: "read", startEntryId: "u1", endEntryId: "u1", maxTokens: 500 }, undefined, undefined, { sessionManager: { getBranch: () => branch } });
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    initTheme("dark", false);

    const collapsed = definition.renderResult(result, { expanded: false, isPartial: false }, theme, {}).render(120).join("\n");
    expect(collapsed).toMatch(/1 entry/i);
    expect(collapsed).toMatch(/expand/i);
    expect(collapsed).not.toContain("raw original request");

    const expanded = definition.renderResult(result, { expanded: true, isPartial: false }, theme, {}).render(120).join("\n");
    expect(expanded).toContain("raw original request");
    // Rendering never changes what is persisted and sent to the model.
    expect(result.content[0].text).toContain("raw original request");
  });

  it("renders errors compactly without hiding the reason", async () => {
    let definition: any;
    registerSessionReaderTool({ registerTool: (tool: any) => { definition = tool; } } as any);
    const result = await definition.execute("call", { action: "search", query: "" }, undefined, undefined, { sessionManager: { getBranch: () => [] } });
    expect(result.content[0].text).toMatch(/requires a non-empty query/i);
    expect(result.details.error).toBeDefined();
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const rendered = definition.renderResult(result, { expanded: false, isPartial: false }, theme, {}).render(120).join("\n");
    expect(rendered).toMatch(/requires a non-empty query/i);
  });
});
