import { describe, it, expect } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildProtectedAppendix } from "../src/compaction/protected-appendix.ts";
import type { CompactionConfig, ResolvedProtection } from "../src/types.ts";

function makeUser(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as any;
}

function makeAssistant(calls: { id: string; name: string; arguments: Record<string, unknown> }[]): AgentMessage {
  return {
    role: "assistant",
    content: calls.map((c) => ({ type: "toolCall" as const, ...c })),
    api: "openai",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as any;
}

function makeResult(toolCallId: string, toolName: string, text: string, details?: unknown): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    details,
    timestamp: Date.now(),
  } as any;
}

const baseConfig: CompactionConfig = {
  customSummary: true,
  summaryModel: null,
  maxSummaryTokens: 8192,
  protectedTools: null,
  protectedFilePatterns: null,
  protectUserMessages: false,
  maxProtectedTokens: 24000,
  preserveSubagentResults: true,
  showCompression: false,
};

const protection: ResolvedProtection = {
  protectedTools: ["write", "edit"],
  protectedFilePatterns: [],
};

describe("protected appendix", () => {
  it("preserves write tool outputs", () => {
    const messages: AgentMessage[] = [
      makeAssistant([{ id: "tc1", name: "write", arguments: { path: "src/a.ts", content: "hi" } }]),
      makeResult("tc1", "write", "wrote file"),
    ];
    const result = buildProtectedAppendix(messages, baseConfig, protection);
    expect(result.text).toContain("Protected Tool Outputs");
    expect(result.text).toContain("write");
    expect(result.collection.items.length).toBeGreaterThan(0);
  });

  it("preserves user messages when enabled", () => {
    const cfg = { ...baseConfig, protectUserMessages: true };
    const messages: AgentMessage[] = [makeUser("keep this note")];
    const result = buildProtectedAppendix(messages, cfg, protection);
    expect(result.collection.items.some((i) => i.kind === "user-message")).toBe(true);
  });

  it("respects maxProtectedTokens budget", () => {
    const huge = "x".repeat(50000);
    const messages: AgentMessage[] = [
      makeAssistant([{ id: "tc1", name: "write", arguments: { path: "src/a.ts" } }]),
      makeResult("tc1", "write", huge),
      makeAssistant([{ id: "tc2", name: "write", arguments: { path: "src/b.ts" } }]),
      makeResult("tc2", "write", huge),
    ];
    const cfg = { ...baseConfig, maxProtectedTokens: 1000 }; // ~4000 chars
    const result = buildProtectedAppendix(messages, cfg, protection);
    expect(result.collection.totalIncludedChars).toBeLessThanOrEqual(5000);
    expect(result.collection.truncatedCount + result.collection.skippedCount).toBeGreaterThan(0);
  });

  it("preserves subagent parent results with artifact paths", () => {
    const messages: AgentMessage[] = [
      makeAssistant([{ id: "tc1", name: "subagent", arguments: { task: "research" } }]),
      makeResult("tc1", "subagent", "completed research", {
        status: "completed",
        outputPath: "/tmp/findings.md",
        artifactPaths: ["/tmp/artifact.json"],
      }),
    ];
    const result = buildProtectedAppendix(messages, baseConfig, protection);
    expect(result.text).toContain("Protected Subagent Results");
    expect(result.collection.subagentArtifacts).toContain("/tmp/findings.md");
    expect(result.collection.subagentArtifacts).toContain("/tmp/artifact.json");
  });

  it("does not include subagent when disabled", () => {
    const cfg = { ...baseConfig, preserveSubagentResults: false };
    const messages: AgentMessage[] = [
      makeAssistant([{ id: "tc1", name: "subagent", arguments: { task: "research" } }]),
      makeResult("tc1", "subagent", "completed research", { status: "completed" }),
    ];
    const result = buildProtectedAppendix(messages, cfg, protection);
    expect(result.collection.items.filter((i) => i.kind === "subagent-result").length).toBe(0);
  });

  it("deduplicates file references", () => {
    const messages: AgentMessage[] = [
      makeAssistant([{ id: "tc1", name: "write", arguments: { path: "src/a.ts" } }]),
      makeResult("tc1", "write", "out1"),
      makeAssistant([{ id: "tc2", name: "write", arguments: { path: "src/a.ts" } }]),
      makeResult("tc2", "write", "out2"),
    ];
    const result = buildProtectedAppendix(messages, baseConfig, protection);
    expect(result.collection.fileReferences.filter((f) => f === "src/a.ts").length).toBe(1);
  });
});
