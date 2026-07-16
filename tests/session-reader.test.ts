import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  MAX_READ_TOKENS,
  buildRawSessionIndex,
  listSessionHistory,
  readSessionHistory,
  searchSessionHistory,
} from "../src/session-reader.ts";

function entry(id: string, message: AgentMessage): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message } as SessionEntry;
}
function user(id: string, text: string): SessionEntry {
  return entry(id, { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage);
}
function assistant(id: string, text: string, toolId?: string): SessionEntry {
  return entry(id, {
    role: "assistant",
    content: toolId ? [{ type: "toolCall", id: toolId, name: "read", arguments: { path: "src/a.ts" } }] : [{ type: "text", text }],
    timestamp: Date.now(),
  } as AgentMessage);
}
function toolResult(id: string, toolCallId: string, text: string): SessionEntry {
  return entry(id, { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage);
}

const branch = [
  user("u1", "Original request: preserve the migration decision"),
  assistant("a1", "I will inspect the migration", "call-1"),
  toolResult("r1", "call-1", "migration test failed with E_MIGRATION"),
  user("u2", "Please repair the auth parser"),
  assistant("a2", "Parser changed"),
];

describe("raw session reader", () => {
  it("indexes only context-visible raw entries and ignores extension state", () => {
    const entries = [...branch, { type: "custom", id: "state", parentId: null, timestamp: "now", customType: "dcp-context-range.v1", data: {} } as SessionEntry];
    const index = buildRawSessionIndex(entries);
    expect(index.map((item) => item.id)).toEqual(["u1", "a1", "r1", "u2", "a2"]);
  });

  it("lists bounded newest-first entry IDs with previews", () => {
    const result = listSessionHistory(branch, 2);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("a2");
    expect(result.text).toContain("u2");
    expect(result.text).not.toContain("u1 | user");
  });

  it("searches literal text case-insensitively with match excerpts", () => {
    const result = searchSessionHistory(branch, "MIGRATION");
    expect(result.ok).toBe(true);
    expect(result.details.returnedIds).toEqual(expect.arrayContaining(["u1", "r1"]));
    expect(result.text).toContain("E_MIGRATION");
  });

  it("searches assistant tool names and arguments", () => {
    const result = searchSessionHistory(branch, "src/a.ts");
    expect(result.details.returnedIds).toEqual(["a1"]);
  });

  it("rejects empty searches and unknown or reversed ranges", () => {
    expect(searchSessionHistory(branch, "").ok).toBe(false);
    expect(readSessionHistory(branch, "missing", "a1").ok).toBe(false);
    expect(readSessionHistory(branch, "u2", "u1").ok).toBe(false);
  });

  it("returns an inclusive raw range in chronological order", () => {
    const result = readSessionHistory(branch, "u1", "r1", 4_000);
    expect(result.ok).toBe(true);
    expect(result.details.returnedIds).toEqual(["u1", "a1", "r1"]);
    expect(result.text).toContain("--- entry u1 | user ---");
    expect(result.text).toContain("--- entry r1 | tool result (read) ---");
  });

  it("expands a requested tool result to include its paired assistant call", () => {
    const result = readSessionHistory(branch, "r1", "r1", 4_000);
    expect(result.ok).toBe(true);
    expect(result.details.returnedIds).toEqual(["a1", "r1"]);
  });

  it("does not split tool call/result pairs when a range is budgeted", () => {
    const result = readSessionHistory(branch, "u1", "a2", 500);
    const ids = result.details.returnedIds;
    expect(ids.includes("a1")).toBe(ids.includes("r1"));
    expect(result.details.estimatedTokens).toBeLessThanOrEqual(MAX_READ_TOKENS);
  });

  it("returns a continuation ID when a large range does not fit", () => {
    const longBranch = [user("u1", "a".repeat(3_000)), user("u2", "b".repeat(3_000)), user("u3", "c".repeat(3_000))];
    const result = readSessionHistory(longBranch, "u1", "u3", 500);
    expect(result.ok).toBe(true);
    expect(result.details.moreAvailable).toBe(true);
    expect(result.details.nextEntryId).toBe("u2");
  });

  it("head/tail bounds a huge individual entry with an omission marker", () => {
    const huge = [user("u1", `BEGIN${"x".repeat(20_000)}END`)];
    const result = readSessionHistory(huge, "u1", "u1", 500);
    expect(result.text).toContain("BEGIN");
    expect(result.text).toContain("END");
    expect(result.text).toContain("characters omitted");
  });

  it("caps final read output including metadata at the hard maximum", () => {
    const huge = [user("u1", "a".repeat(100_000))];
    const result = readSessionHistory(huge, "u1", "u1", 99_999);
    expect(result.details.estimatedTokens).toBeLessThanOrEqual(MAX_READ_TOKENS);
  });

  it("retains Pi compaction summaries in the raw session index", () => {
    const entries = [{ type: "compaction", id: "c1", parentId: null, timestamp: "now", summary: "Older auth work", firstKeptEntryId: "u1", tokensBefore: 50_000 } as SessionEntry];
    const result = searchSessionHistory(entries, "auth");
    expect(result.ok).toBe(true);
    expect(result.details.returnedIds).toEqual(["c1"]);
  });
});
