import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { resolveProtection } from "../src/protection.ts";

const completeSimpleMock = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: (...args: unknown[]) => completeSimpleMock(...args) }));
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { projectVirtualBlocks } from "../src/context-projector.ts";
import { appendVirtualBlock, appendVirtualBlockReceipt, createVirtualBlock, rebuildVirtualBlocks, relieveContextPressure, selectExactEvidence } from "../src/virtual-blocks.ts";
import { entryRangeCanBeReplaced, projectVirtualBlocksWithInfo } from "../src/context-projector.ts";
import { MIN_RANGE_RAW_TOKENS, selectCompressibleRange } from "../src/range-selector.ts";
import { estimateTextTokens } from "../src/utils.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { VirtualCompressionBlock } from "../src/types.ts";

function message(id: string, role: "user" | "assistant", text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role, content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage,
  } as SessionEntry;
}

function toolResult(id: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], timestamp: Date.now() },
  } as unknown as SessionEntry;
}

function block(startEntryId: string, endEntryId: string): VirtualCompressionBlock {
  return {
    version: 1,
    id: "block-1",
    startEntryId,
    endEntryId,
    anchorEntryId: startEntryId,
    rangeKind: "historical",
    messagesCompressed: 2,
    toolsCompressed: 0,
    summary: "completed phase summary",
    exactEvidence: "",
    preservedUserMessages: [],
    estimatedRawTokens: 10,
    retainedRawTokens: 35,
    estimatedBlockTokens: 3,
    active: true,
    createdAt: Date.now(),
  };
}

describe("virtual range compression", () => {
  beforeEach(() => completeSimpleMock.mockReset());

  it("creates a durable-ready block with bounded summary, evidence, and preserved prompts", async () => {
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "phase summary" }] });
    const entries = [
      message("u1", "user", "Keep this instruction"),
      message("a1", "assistant", `done ${"x".repeat(30_000)}`),
      { type: "message", id: "r1", parentId: null, timestamp: new Date().toISOString(), message: { role: "toolResult", content: [{ type: "text", text: "test failed: exact error" }], toolCallId: "t1", timestamp: Date.now() } } as unknown as SessionEntry,
      message("u2", "user", "current"),
    ];
    const ctx = {
      model: { reasoning: true, maxTokens: 10_000 },
      signal: undefined,
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {}, env: {} }) },
      sessionManager: { buildContextEntries: () => entries },
    } as any;
    const config = { ...DEFAULT_CONFIG, contextRelief: { ...DEFAULT_CONFIG.contextRelief, maxChunkInputTokens: 10_000, targetHeadroomTokens: 1, activeWorkingSetTokens: 1 } };
    const result = await createVirtualBlock({ appendEntry: () => {} } as any, ctx, config, resolveProtection(config.pruning, config.compaction, [], []), [], undefined, "high" as any);
    expect(result).toBeDefined();
    expect(result?.summary).toContain("phase summary");
    expect(result?.summary).toContain("Keep this instruction");
    expect(result?.summary).toContain("test failed: exact error");
    expect(result?.anchorEntryId).toBe("u1");
    expect(result?.active).toBe(true);
    expect(completeSimpleMock.mock.calls[0][2].reasoning).toBe("high");
  });

  it("does not spend a summary call on a range below the minimum useful size", async () => {
    const entries = [message("u1", "user", "small"), message("a1", "assistant", "done"), message("u2", "user", "current")];
    const ctx = { model: { reasoning: false, maxTokens: 100_000 }, signal: undefined, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) }, sessionManager: { buildContextEntries: () => entries } } as any;
    const result = await createVirtualBlock({ appendEntry: () => {} } as any, ctx, DEFAULT_CONFIG, resolveProtection(DEFAULT_CONFIG.pruning, DEFAULT_CONFIG.compaction, [], []), [], undefined, "off" as any);
    expect(result).toBeUndefined();
    expect(completeSimpleMock).not.toHaveBeenCalled();
  });

  it("does not build a range larger than the selected summary model can accept", async () => {
    const entries = [message("u1", "user", "x".repeat(10_000)), message("a1", "assistant", "done"), message("u2", "user", "current")];
    const ctx = { model: { reasoning: false, maxTokens: 500, contextWindow: 1_000 }, signal: undefined, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) }, sessionManager: { buildContextEntries: () => entries } } as any;
    const result = await createVirtualBlock({ appendEntry: () => {} } as any, ctx, DEFAULT_CONFIG, resolveProtection(DEFAULT_CONFIG.pruning, DEFAULT_CONFIG.compaction, [], []), [], undefined, "off" as any);
    expect(result).toBeUndefined();
    expect(completeSimpleMock).not.toHaveBeenCalled();
  });

  it("uses the range summary contract instead of a generic prose prompt", async () => {
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "brief" }] });
    const entries = [message("u1", "user", "x".repeat(30_000)), message("a1", "assistant", "done"), message("u2", "user", "current")];
    const ctx = { model: { reasoning: false, maxTokens: 100_000 }, signal: undefined, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) }, sessionManager: { buildContextEntries: () => entries } } as any;
    await createVirtualBlock({ appendEntry: () => {} } as any, ctx, DEFAULT_CONFIG, resolveProtection(DEFAULT_CONFIG.pruning, DEFAULT_CONFIG.compaction, [], []), [], undefined, "off" as any);
    const prompt = completeSimpleMock.mock.calls[0][1].messages[0].content[0].text;
    expect(prompt).toContain("### Goal");
    expect(prompt).toContain("### Constraints & Preferences");
    expect(prompt).toContain("### Progress");
    expect(prompt).toContain("### Technical Record");
  });

  it("uses the active-prefix prompt and keeps the current request as retained context", async () => {
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "brief prefix" }] });
    const entries = [
      message("u1", "user", "current request must stay raw"),
      message("a1", "assistant", "first action " + "x".repeat(30_000)),
      { type: "message", id: "r1", parentId: null, timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "first result" }], timestamp: Date.now() } } as unknown as SessionEntry,
      message("a2", "assistant", "newest action " + "y".repeat(30_000)),
      { type: "message", id: "r2", parentId: null, timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: "t2", content: [{ type: "text", text: "newest result" }], timestamp: Date.now() } } as unknown as SessionEntry,
    ];
    const config = { ...DEFAULT_CONFIG, contextRelief: { ...DEFAULT_CONFIG.contextRelief, activeWorkingSetTokens: 1, maxChunkInputTokens: 60_000 } };
    const ctx = { model: { reasoning: false, maxTokens: 100_000 }, signal: undefined, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) }, sessionManager: { buildContextEntries: () => entries } } as any;
    const result = await createVirtualBlock({ appendEntry: () => {} } as any, ctx, config, resolveProtection(config.pruning, config.compaction, [], []), [], undefined, "off" as any);
    expect(result?.startEntryId).toBe("a1");
    const prompt = completeSimpleMock.mock.calls[0][1].messages[0].content[0].text;
    expect(prompt).toContain("EARLY PREFIX of an active task");
    expect(prompt).toContain("current request must stay raw");
    expect(prompt).toContain("### Technical Record");
  });

  it("uses compaction.summaryModel for range summaries when configured", async () => {
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "brief" }] });
    const entries = [message("u1", "user", "x".repeat(30_000)), message("a1", "assistant", "done"), message("u2", "user", "current")];
    const summaryModel = { provider: "summary", id: "fast", reasoning: false, maxTokens: 10_000 };
    const ctx = {
      model: { provider: "main", id: "slow", reasoning: false, maxTokens: 10_000 },
      signal: undefined,
      modelRegistry: { find: (provider: string, id: string) => provider === "summary" && id === "fast" ? summaryModel : undefined, getApiKeyAndHeaders: async (model: unknown) => ({ ok: true, apiKey: model === summaryModel ? "summary-key" : "wrong" }) },
      sessionManager: { buildContextEntries: () => entries },
    } as any;
    const config = { ...DEFAULT_CONFIG, compaction: { ...DEFAULT_CONFIG.compaction, summaryModel: "summary/fast" } };
    const result = await createVirtualBlock({ appendEntry: () => {} } as any, ctx, config, resolveProtection(config.pruning, config.compaction, [], []), [], undefined, "off" as any);
    expect(result).toBeDefined();
    expect(completeSimpleMock.mock.calls[0][0]).toBe(summaryModel);
  });

  it("does not activate a summary that costs at least as much as its raw range", async () => {
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "x".repeat(20_000) }] });
    const entries = [message("u1", "user", "short"), message("a1", "assistant", "done"), message("u2", "user", "current")];
    const ctx = { model: { reasoning: false, maxTokens: 100_000 }, signal: undefined, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) }, sessionManager: { buildContextEntries: () => entries } } as any;
    const result = await createVirtualBlock({ appendEntry: () => {} } as any, ctx, DEFAULT_CONFIG, resolveProtection(DEFAULT_CONFIG.pruning, DEFAULT_CONFIG.compaction, [], []), [], undefined, "off" as any);
    expect(result).toBeUndefined();
  });

  it("rejects a summary with negligible net relief", async () => {
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "s".repeat(21_000) }] });
    const entries = [message("u1", "user", "brief request"), message("a1", "assistant", "x".repeat(24_000)), message("u2", "user", "current")];
    const ctx = { model: { reasoning: false, maxTokens: 100_000 }, signal: undefined, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) }, sessionManager: { buildContextEntries: () => entries } } as any;
    const result = await createVirtualBlock({ appendEntry: () => {} } as any, ctx, DEFAULT_CONFIG, resolveProtection(DEFAULT_CONFIG.pruning, DEFAULT_CONFIG.compaction, [], []), [], undefined, "off" as any);
    expect(completeSimpleMock).toHaveBeenCalledOnce();
    expect(result).toBeUndefined();
  });

  it("rejects a summary that saves less than 25 percent of its range", async () => {
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "s".repeat(64_000) }] });
    const entries = [message("u1", "user", "brief request"), message("a1", "assistant", "x".repeat(80_000)), message("u2", "user", "current")];
    const ctx = { model: { reasoning: false, maxTokens: 100_000 }, signal: undefined, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) }, sessionManager: { buildContextEntries: () => entries } } as any;
    const result = await createVirtualBlock({ appendEntry: () => {} } as any, ctx, DEFAULT_CONFIG, resolveProtection(DEFAULT_CONFIG.pruning, DEFAULT_CONFIG.compaction, [], []), [], undefined, "off" as any);
    expect(completeSimpleMock).toHaveBeenCalledOnce();
    expect(result).toBeUndefined();
  });

  it("fails closed for provider errors and does not activate a block", async () => {
    completeSimpleMock.mockResolvedValue({ stopReason: "error", errorMessage: "rate limited", content: [] });
    const entries = [message("u1", "user", "first"), message("a1", "assistant", "done"), message("u2", "user", "current")];
    const ctx = { model: { reasoning: false, maxTokens: 10_000 }, signal: undefined, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) }, sessionManager: { buildContextEntries: () => entries } } as any;
    const result = await createVirtualBlock({ appendEntry: () => {} } as any, ctx, DEFAULT_CONFIG, resolveProtection(DEFAULT_CONFIG.pruning, DEFAULT_CONFIG.compaction, [], []), [], undefined, "off" as any);
    expect(result).toBeUndefined();
  });

  it("selects finished turns and leaves the final active turn alone", () => {
    const entries = [message("u1", "user", "first"), message("a1", "assistant", "done"), message("u2", "user", "current"), message("a2", "assistant", "working")];
    const range = selectCompressibleRange(entries, [], 10_000, 10_000, 0, true, 0);
    expect(range?.startEntryId).toBe("u1");
    expect(range?.endEntryId).toBe("a1");
  });

  it("combines oldest complete turns only up to the input cap", () => {
    const entries = [message("u1", "user", "one"), message("a1", "assistant", "done one"), message("u2", "user", "two"), message("a2", "assistant", "done two"), message("u3", "user", "active")];
    const range = selectCompressibleRange(entries, [], 50_000, 50_000, 0, true, 0);
    expect(range?.startEntryId).toBe("u1");
    expect(range?.endEntryId).toBe("a2");
  });

  it("skips a range already represented by a durable block", () => {
    const entries = [message("u1", "user", "one"), message("a1", "assistant", "done one"), message("u2", "user", "two"), message("a2", "assistant", "done two"), message("u3", "user", "active")];
    const range = selectCompressibleRange(entries, [block("u1", "a1")], 50_000, 1, 0, true, 0);
    expect(range?.startEntryId).toBe("u2");
    expect(range?.endEntryId).toBe("a2");
  });

  it("does not select a turn larger than the configured input cap", () => {
    const entries = [message("u1", "user", "x".repeat(20_000)), message("a1", "assistant", "done"), message("u2", "user", "active")];
    expect(selectCompressibleRange(entries, [], 10)).toBeUndefined();
  });

  it("can select an early active-turn prefix while leaving a raw suffix", () => {
    const entries = [
      message("u1", "user", "current request"),
      message("a1", "assistant", "first tool call"),
      toolResult("r1", "first result"),
      message("a2", "assistant", "second tool call"),
      toolResult("r2", "second result"),
    ];
    const range = selectCompressibleRange(entries, [], 10_000, 1_000, 1, true, 0);
    expect(range?.kind).toBe("active-prefix");
    expect(range?.startEntryId).toBe("a1");
    expect(range?.endEntryId).toBe("r1");
    expect(JSON.stringify(range?.messages)).not.toContain("current request");
    expect(JSON.stringify(range?.retainedMessages)).toContain("current request");
  });

  it("accounts active-prefix tokens at the actual cut point", () => {
    const entries = [
      message("u1", "user", "current request"),
      message("a1", "assistant", "x".repeat(30_000)),
      toolResult("r1", "first result"),
      message("a2", "assistant", "y".repeat(30_000)),
      toolResult("r2", "second result"),
    ];
    const range = selectCompressibleRange(entries, [], 60_000, 60_000, 5_000)!;
    expect(range.kind).toBe("active-prefix");
    const actualPrefixTokens = range.messages.reduce((sum, item) => sum + estimateTextTokens(JSON.stringify(item)), 0);
    const actualRetainedTokens = range.retainedMessages.reduce((sum, item) => sum + estimateTextTokens(JSON.stringify(item)), 0);
    expect(range.estimatedRawTokens).toBe(actualPrefixTokens);
    expect(range.retainedRawTokens).toBe(actualRetainedTokens);
    expect(range.retainedRawTokens).toBeGreaterThanOrEqual(5_000);
  });

  it("skips a tiny island and an oversized turn to find useful later history", () => {
    const entries = [
      message("u1", "user", "tiny"), message("a1", "assistant", "done"),
      message("u2", "user", "oversized"), message("a2", "assistant", "x".repeat(280_000)),
      message("u3", "user", "useful"), message("a3", "assistant", "y".repeat(30_000)),
      message("u4", "user", "active"),
    ];
    const range = selectCompressibleRange(entries, [], 60_000, 60_000);
    expect(range?.kind).toBe("historical");
    expect(range?.startEntryId).toBe("u3");
    expect(range?.endEntryId).toBe("a3");
    expect(range?.estimatedRawTokens).toBeGreaterThanOrEqual(MIN_RANGE_RAW_TOKENS);
  });

  it("skips a tiny island before a covered range to find useful later history", () => {
    const entries = [
      message("u1", "user", "tiny"), message("a1", "assistant", "done"),
      message("u2", "user", "covered"), message("a2", "assistant", "already summarized"),
      message("u3", "user", "useful"), message("a3", "assistant", "y".repeat(30_000)),
      message("u4", "user", "active"),
    ];
    const range = selectCompressibleRange(entries, [block("u2", "a2")], 60_000, 60_000);
    expect(range?.startEntryId).toBe("u3");
    expect(range?.endEntryId).toBe("a3");
  });

  it("replaces a mapped range and preserves the raw active suffix", () => {
    const entries = [message("u1", "user", "first"), message("a1", "assistant", "done"), message("u2", "user", "current"), message("a2", "assistant", "working")];
    const raw = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    const result = projectVirtualBlocks(raw, entries, [block("u1", "a1")]);
    expect(result).toHaveLength(3);
    expect(JSON.stringify(result[0])).toContain("completed phase summary");
    expect(JSON.stringify(result[1])).toContain("current");
    expect(JSON.stringify(result[2])).toContain("working");
  });

  it("rejects flattened reasoning tags before activating a block", async () => {
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "<think>hidden</think>summary" }] });
    const entries = [message("u1", "user", "request"), message("a1", "assistant", "done"), message("u2", "user", "next")];
    const ctx = {
      model: { reasoning: true, maxTokens: 10_000 },
      signal: undefined,
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {}, env: {} }) },
      sessionManager: { buildContextEntries: () => entries },
    } as any;
    const result = await createVirtualBlock({ appendEntry: () => {} } as any, ctx, DEFAULT_CONFIG, resolveProtection(DEFAULT_CONFIG.pruning, DEFAULT_CONFIG.compaction, [], []), [], undefined, "high" as any);
    expect(result).toBeUndefined();
  });

  it("keeps error and test tails as bounded exact evidence", () => {
    const result = selectExactEvidence([
      { role: "toolResult", content: [{ type: "text", text: "test failed: expected A but received B" }], toolCallId: "t1", timestamp: Date.now() } as AgentMessage,
    ], "", 100);
    expect(result).toContain("test failed");
  });

  it("prioritizes the newest unresolved error before older preserved material", () => {
    const result = selectExactEvidence([
      { role: "toolResult", content: [{ type: "text", text: "old test failed" }], toolCallId: "old", timestamp: 1 } as AgentMessage,
      { role: "toolResult", content: [{ type: "text", text: "new test failed" }], toolCallId: "new", timestamp: 2 } as AgentMessage,
    ], "### Preserved Tool: write\nold write", 1_000);
    expect(result.indexOf("new test failed")).toBeLessThan(result.indexOf("old test failed"));
    expect(result.indexOf("old test failed")).toBeLessThan(result.indexOf("old write"));
  });

  it("removes a whole tool-call/result pair together", () => {
    const entries = [
      message("u1", "user", "first"),
      { type: "message", id: "a1", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a" } }], timestamp: Date.now() } } as unknown as SessionEntry,
      { type: "message", id: "r1", parentId: null, timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "result" }], timestamp: Date.now() } } as unknown as SessionEntry,
      message("u2", "user", "current"),
    ];
    const raw = entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
    const result = projectVirtualBlocks(raw, entries, [block("u1", "r1")]);
    expect(result).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("tc1");
    expect(JSON.stringify(result)).toContain("current");
  });

  it("fails open for a persisted range that would split a tool call from its result", () => {
    const entries = [
      message("u1", "user", "first"),
      { type: "message", id: "a1", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a" } }], timestamp: Date.now() } } as unknown as SessionEntry,
      { type: "message", id: "r1", parentId: null, timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "result" }], timestamp: Date.now() } } as unknown as SessionEntry,
      message("u2", "user", "current"),
    ];
    const raw = entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
    expect(projectVirtualBlocks(raw, entries, [block("u1", "a1")])).toBe(raw);
  });

  it("projects across state-only entries without dropping the replacement", () => {
    const entries = [
      message("u1", "user", "first"),
      { type: "custom", id: "state", parentId: null, timestamp: "now", customType: "dcp-receipt", data: {} },
      message("a1", "assistant", "done"),
      message("u2", "user", "current"),
    ] as unknown as SessionEntry[];
    const raw = entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
    const result = projectVirtualBlocks(raw, entries, [block("u1", "a1")]);
    expect(result).toHaveLength(2);
    expect(JSON.stringify(result[0])).toContain("completed phase summary");
  });

  it("persists the block and its user-facing receipt as separate custom entries", () => {
    const appended: unknown[][] = [];
    const pi = { appendEntry: (...args: unknown[]) => appended.push(args) } as any;
    const item = block("u1", "a1");
    appendVirtualBlock(pi, item);
    appendVirtualBlockReceipt(pi, item, { number: 1, activeWorkingSetTokens: 35_000 });
    expect(appended[0][0]).toBe("dcp-context-range.v1");
    expect(appended[1][0]).toBe("dcp-receipt");
    expect(JSON.stringify(appended[1][1])).toContain("░ summarized completed work");
    expect(JSON.stringify(appended[1][1])).toContain("Raw context after this range");
    expect(JSON.stringify(appended[1][1])).not.toContain("Raw working set retained");
    expect(JSON.stringify(appended[1][1])).not.toMatch(/PLAN3|virtual block|legacy/i);
  });

  it("rebuilds durable blocks and honors retire entries", () => {
    const stored = [
      { type: "custom", id: "c1", parentId: null, timestamp: "now", customType: "dcp-context-range.v1", data: { version: 1, block: block("u1", "a1") } },
    ] as unknown as SessionEntry[];
    expect(rebuildVirtualBlocks(stored)).toHaveLength(1);
    stored.push({ type: "custom", id: "r1", parentId: "c1", timestamp: "now", customType: "dcp-context-range-retired.v1", data: { version: 1, blockId: "block-1" } } as unknown as SessionEntry);
    expect(rebuildVirtualBlocks(stored)).toHaveLength(0);
  });

  it("does not inject overlapping ranges twice", () => {
    const entries = [message("u1", "user", "one"), message("a1", "assistant", "done"), message("u2", "user", "two"), message("a2", "assistant", "done"), message("u3", "user", "active")];
    const raw = entries.map((entry) => (entry as any).message) as AgentMessage[];
    const first = { ...block("u1", "a1"), createdAt: 1 };
    const second = { ...block("a1", "a2"), id: "block-2", summary: "second", createdAt: 2 };
    const result = projectVirtualBlocks(raw, entries, [first, second]);
    expect(result.filter((message) => JSON.stringify(message).includes("completed phase summary"))).toHaveLength(0);
    expect(result.filter((message) => JSON.stringify(message).includes("second"))).toHaveLength(1);
  });

  it("applies verified blocks while retaining live messages other transforms injected", () => {
    const entries = [message("u1", "user", "first"), message("a1", "assistant", "done"), message("u2", "user", "current")];
    const raw = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    const injected = { role: "user", content: [{ type: "text", text: "injected by another extension" }], timestamp: Date.now() } as AgentMessage;
    const changed = [...raw, injected];
    const result = projectVirtualBlocks(changed, entries, [block("u1", "a1")]);
    expect(JSON.stringify(result[0])).toContain("completed phase summary");
    expect(JSON.stringify(result)).toContain("injected by another extension");
    expect(JSON.stringify(result)).toContain("current");
    expect(result).toHaveLength(3);
  });

  it("still projects when live messages differ from stored copies in volatile metadata", () => {
    const entries = [message("u1", "user", "first"), message("a1", "assistant", "done"), message("u2", "user", "current")];
    const raw = entries.map((entry) => ({ ...(entry as any).message, usage: { input: 5, output: 9, totalTokens: 14 }, timestamp: 999999 })) as AgentMessage[];
    const result = projectVirtualBlocks(raw, entries, [block("u1", "a1")]);
    expect(result).toHaveLength(2);
    expect(JSON.stringify(result[0])).toContain("completed phase summary");
  });

  it("still projects after a session repair inserted reasoning blocks into assistant turns", () => {
    // Regression test for a real production symptom: "N stored context summaries
    // no longer match this session's history". A session-repair tool (pi-m3fix)
    // inserts a synthetic thinking block before an assistant reply. Identity
    // used to include reasoning parts, so the repaired turn stopped matching
    // its stored copy and every affected summary was stranded permanently.
    const entries = [message("u1", "user", "first"), message("a1", "assistant", "done"), message("u2", "user", "current")];
    const raw = entries.map((entry) => {
      const live = (entry as any).message as AgentMessage;
      if (live.role !== "assistant") return live;
      return { ...live, content: [{ type: "thinking", thinking: "recovered", signature: "sig" }, ...live.content] };
    }) as AgentMessage[];
    const result = projectVirtualBlocks(raw, entries, [block("u1", "a1")]);
    expect(result).toHaveLength(2);
    expect(JSON.stringify(result[0])).toContain("completed phase summary");
    expect(JSON.stringify(result[1])).toContain("current");
  });

  it("treats reasoning-only differences as the same turn in both directions", () => {
    // Stored copy has the thinking block, live copy does not (redaction).
    const entries = [
      message("u1", "user", "first"),
      { type: "message", id: "a1", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }, { type: "text", text: "done" }], timestamp: Date.now() } } as unknown as SessionEntry,
      message("u2", "user", "current"),
    ];
    const raw = [
      (entries[0] as any).message,
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: Date.now() },
      (entries[2] as any).message,
    ] as AgentMessage[];
    const result = projectVirtualBlocks(raw, entries, [block("u1", "a1")]);
    expect(result).toHaveLength(2);
    expect(JSON.stringify(result[0])).toContain("completed phase summary");
  });

  it("never offers an active-prefix cut that would split a parallel tool-call group", () => {
    // One assistant message issues two tool calls; their results arrive as
    // separate entries. Cutting between them would leave call tc2 inside the
    // summarized range and its result outside, which the projector must reject -
    // so such a block could never be applied and its summary call is wasted.
    const entries = [
      message("u1", "user", "current request"),
      { type: "message", id: "a1", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a" } }, { type: "toolCall", id: "tc2", name: "read", arguments: { path: "b" } }], timestamp: Date.now() } } as unknown as SessionEntry,
      toolResult("tc1", "first result " + "x".repeat(30_000)),
      toolResult("tc2", "second result " + "y".repeat(30_000)),
      message("a2", "assistant", "more " + "z".repeat(30_000)),
      toolResult("tc3", "third result"),
    ];
    // Only a cut immediately after tc1's result leaves a large enough raw
    // suffix, and that cut is exactly the illegal one.
    const range = selectCompressibleRange(entries, [], 60_000, 60_000, 13_000, true, 0);
    expect(range).toBeUndefined();
  });

  it("agrees between creation-time and projection-time replaceability", () => {
    const entries = [
      message("u1", "user", "first"),
      { type: "message", id: "a1", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }], timestamp: Date.now() } } as unknown as SessionEntry,
      toolResult("tc1", "result"),
      message("u2", "user", "current"),
    ];
    // Splitting the pair is refused; covering it whole is allowed.
    expect(entryRangeCanBeReplaced(entries, "u1", "a1")).toBe(false);
    expect(entryRangeCanBeReplaced(entries, "u1", "tc1")).toBe(true);
    // An unknown range is refused rather than assumed safe.
    expect(entryRangeCanBeReplaced(entries, "nope", "tc1")).toBe(false);
  });

  it("maps duplicate identical messages by chronological position, not first match", () => {
    const entries = [message("u1", "user", "same text"), message("a1", "assistant", "done"), message("u2", "user", "same text"), message("a2", "assistant", "working")];
    const raw = entries.map((entry) => (entry as any).message) as AgentMessage[];
    const result = projectVirtualBlocks(raw, entries, [block("u2", "a2")]);
    expect(result).toHaveLength(3);
    // The first occurrence must survive; only the second turn is summarized.
    expect(JSON.stringify(result[0])).toContain("same text");
    expect(JSON.stringify(result[1])).toContain("done");
    expect(JSON.stringify(result[2])).toContain("completed phase summary");
  });

  it("creates multiple blocks in one pass when one range cannot free enough", async () => {
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "short summary" }] });
    const entries = [
      message("u1", "user", "x".repeat(30_000)), message("a1", "assistant", "done one"),
      message("u2", "user", "y".repeat(30_000)), message("a2", "assistant", "done two"),
      message("u3", "user", "z".repeat(30_000)), message("a3", "assistant", "done three"),
      message("u4", "user", "active"),
    ];
    const ctx = { model: { reasoning: false, maxTokens: 100_000, contextWindow: 400_000 }, signal: undefined, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) }, sessionManager: { buildContextEntries: () => entries } } as any;
    const config = { ...DEFAULT_CONFIG, contextRelief: { ...DEFAULT_CONFIG.contextRelief, maxChunkInputTokens: 9_000, targetHeadroomTokens: 9_000 } };
    const blocks: any[] = [];
    const appended: unknown[][] = [];
    const relief = await relieveContextPressure({ appendEntry: (...args: unknown[]) => appended.push(args) } as any, ctx, config, resolveProtection(config.pruning, config.compaction, [], []), blocks, undefined, "off" as any, 16_000, true);
    expect(relief.created.length).toBeGreaterThanOrEqual(2);
    expect(relief.freedTokens).toBeGreaterThanOrEqual(16_000);
    expect(blocks).toHaveLength(relief.created.length);
    // Ranges must be disjoint and chronological.
    expect(relief.created[0].startEntryId).toBe("u1");
    expect(relief.created[1].startEntryId).toBe("u2");
    // Internally bounded ranges produce one consolidated transcript card.
    const receipts = appended.filter(([type]) => type === "dcp-receipt");
    expect(receipts).toHaveLength(1);
    const receiptText = JSON.stringify(receipts[0][1]);
    expect(receiptText).toContain(`${relief.created.length} ranges`);
    expect(receiptText).toContain("Raw context after this pass");
  });

  it("does not escalate from historical work into the active turn in one pass", async () => {
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "short summary" }] });
    const entries = [
      message("u1", "user", "historical"), message("a0", "assistant", "h".repeat(30_000)),
      message("u2", "user", "current request"),
      message("a1", "assistant", "x".repeat(30_000)), toolResult("r1", "first result"),
      message("a2", "assistant", "y".repeat(30_000)), toolResult("r2", "second result"),
    ];
    const ctx = { model: { reasoning: false, maxTokens: 100_000, contextWindow: 400_000 }, signal: undefined, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) }, sessionManager: { buildContextEntries: () => entries } } as any;
    const config = { ...DEFAULT_CONFIG, contextRelief: { ...DEFAULT_CONFIG.contextRelief, maxChunkInputTokens: 10_000, targetHeadroomTokens: 10_000, activeWorkingSetTokens: 5_000 } };
    const relief = await relieveContextPressure({ appendEntry: () => {} } as any, ctx, config, resolveProtection(config.pruning, config.compaction, [], []), [], undefined, "off" as any, 50_000, false);
    expect(relief.created).toHaveLength(1);
    expect(relief.created[0].rangeKind).toBe("historical");
    expect(completeSimpleMock).toHaveBeenCalledOnce();
  });

  it("still allows one automatic active-prefix block when no historical range exists", async () => {
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "short summary" }] });
    const entries = [
      message("u1", "user", "current request"),
      message("a1", "assistant", "x".repeat(30_000)), toolResult("r1", "first result"),
      message("a2", "assistant", "y".repeat(30_000)), toolResult("r2", "second result"),
    ];
    const ctx = { model: { reasoning: false, maxTokens: 100_000, contextWindow: 400_000 }, signal: undefined, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) }, sessionManager: { buildContextEntries: () => entries } } as any;
    const config = { ...DEFAULT_CONFIG, contextRelief: { ...DEFAULT_CONFIG.contextRelief, maxChunkInputTokens: 10_000, targetHeadroomTokens: 10_000, activeWorkingSetTokens: 5_000 } };
    const relief = await relieveContextPressure({ appendEntry: () => {} } as any, ctx, config, resolveProtection(config.pruning, config.compaction, [], []), [], undefined, "off" as any, 50_000, false);
    expect(relief.created).toHaveLength(1);
    expect(relief.created[0].rangeKind).toBe("active-prefix");
    expect(completeSimpleMock).toHaveBeenCalledOnce();
  });

  it("rejects an active-prefix summary larger than the span it replaces", async () => {
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "s".repeat(30_000) }] });
    const entries = [
      message("u1", "user", "current request"),
      message("a1", "assistant", "x".repeat(24_000)), toolResult("r1", "first result"),
      message("a2", "assistant", "y".repeat(24_000)), toolResult("r2", "second result"),
    ];
    const ctx = { model: { reasoning: false, maxTokens: 100_000, contextWindow: 400_000 }, signal: undefined, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) }, sessionManager: { buildContextEntries: () => entries } } as any;
    const config = { ...DEFAULT_CONFIG, contextRelief: { ...DEFAULT_CONFIG.contextRelief, activeWorkingSetTokens: 5_000 } };
    const result = await createVirtualBlock({ appendEntry: () => {} } as any, ctx, config, resolveProtection(config.pruning, config.compaction, [], []), [], undefined, "off" as any);
    expect(completeSimpleMock).toHaveBeenCalledOnce();
    expect(result).toBeUndefined();
  });

  it("stops the relief pass once the target is met", async () => {
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "short summary" }] });
    const entries = [
      message("u1", "user", "x".repeat(30_000)), message("a1", "assistant", "done one"),
      message("u2", "user", "y".repeat(30_000)), message("a2", "assistant", "done two"),
      message("u3", "user", "active"),
    ];
    const ctx = { model: { reasoning: false, maxTokens: 100_000, contextWindow: 400_000 }, signal: undefined, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) }, sessionManager: { buildContextEntries: () => entries } } as any;
    const config = { ...DEFAULT_CONFIG, contextRelief: { ...DEFAULT_CONFIG.contextRelief, maxChunkInputTokens: 9_000, targetHeadroomTokens: 9_000 } };
    const relief = await relieveContextPressure({ appendEntry: () => {} } as any, ctx, config, resolveProtection(config.pruning, config.compaction, [], []), [], undefined, "off" as any, 1_000, false);
    expect(relief.created).toHaveLength(1);
  });

  it("classifies superseded overlaps as benign and dead ranges as failures", () => {
    const entries = [message("u1", "user", "one"), message("a1", "assistant", "done"), message("u2", "user", "two"), message("a2", "assistant", "done"), message("u3", "user", "active")];
    const raw = entries.map((entry) => (entry as any).message) as AgentMessage[];
    const older = { ...block("u1", "a1"), createdAt: 1 };
    const newer = { ...block("a1", "a2"), id: "block-2", summary: "newer", createdAt: 2 };
    const dead = { ...block("gone-1", "gone-2"), id: "block-3" };
    const result = projectVirtualBlocksWithInfo(raw, entries, [older, newer, dead]);
    expect(result.appliedBlocks).toBe(1);
    expect(result.supersededBlocks).toBe(1);
    expect(result.failedBlockIds).toEqual(["block-3"]);
  });

  it("refuses a replacement that would orphan a live tool result outside the span", () => {
    const entries = [
      message("u1", "user", "first"),
      { type: "message", id: "a1", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "tc9", name: "read", arguments: { path: "x" } }], timestamp: Date.now() } } as unknown as SessionEntry,
      message("u2", "user", "current"),
    ];
    const raw = entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
    // A live tool result exists that its stored entries do not cover.
    const live = [...raw.slice(0, 2), { role: "toolResult", toolCallId: "tc9", content: [{ type: "text", text: "live result" }], timestamp: Date.now() } as AgentMessage, raw[2]];
    const result = projectVirtualBlocks(live, entries, [block("u1", "a1")]);
    expect(result).toBe(live);
  });
});
