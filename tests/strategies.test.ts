import { describe, it, expect } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { deduplicate } from "../src/strategies/deduplication.ts";
import { purgeErrors } from "../src/strategies/purge-errors.ts";

function makeUser(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function makeAssistant(toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[]): AgentMessage {
  return {
    role: "assistant",
    content: toolCalls.map((t) => ({ type: "toolCall" as const, ...t })),
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function makeResult(toolCallId: string, text: string, isError = false): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
  };
}

describe("deduplicate", () => {
  it("replaces earlier duplicate tool result with a placeholder", () => {
    const messages: AgentMessage[] = [
      makeUser("read file"),
      makeAssistant([{ id: "tc1", name: "read", arguments: { path: "/x" } }]),
      makeResult("tc1", "content A"),
      makeUser("read file again"),
      makeAssistant([{ id: "tc2", name: "read", arguments: { path: "/x" } }]),
      makeResult("tc2", "content A"),
    ];

    const result = deduplicate(messages, { protectedTools: [], protectedFilePatterns: [] }, 0);
    expect(result.deduplicated).toBe(1);
    const firstResult = result.messages[2];
    expect(firstResult.role).toBe("toolResult");
    if (firstResult.role === "toolResult" && firstResult.content[0].type === "text") {
      expect(firstResult.content[0].text).toContain("removed to save context");
    }
  });

  it("skips protected tools", () => {
    const messages: AgentMessage[] = [
      makeUser("task"),
      makeAssistant([{ id: "tc1", name: "task", arguments: { x: 1 } }]),
      makeResult("tc1", "task output"),
      makeUser("task again"),
      makeAssistant([{ id: "tc2", name: "task", arguments: { x: 1 } }]),
      makeResult("tc2", "task output"),
    ];

    const result = deduplicate(messages, { protectedTools: ["task"], protectedFilePatterns: [] }, 0);
    expect(result.deduplicated).toBe(0);
  });
});

describe("purgeErrors", () => {
  it("replaces old errored tool call arguments with a placeholder", () => {
    const messages: AgentMessage[] = [
      makeUser("run"),
      makeAssistant([{ id: "tc1", name: "bash", arguments: { command: "very long command" } }]),
      makeResult("tc1", "error", true),
      makeUser("run again"),
      makeAssistant([{ id: "tc2", name: "bash", arguments: { command: "ok" } }]),
      makeResult("tc2", "ok"),
    ];

    const result = purgeErrors(messages, 1, { protectedTools: [], protectedFilePatterns: [] });
    expect(result.purged).toBe(1);
    const toolCall = result.messages[1];
    expect(toolCall.role).toBe("assistant");
    if (toolCall.role === "assistant") {
      expect(toolCall.content[0].type === "toolCall" && toolCall.content[0].arguments.__dcp_purged__).toContain("input removed");
    }
  });

  it("does not purge recent errors", () => {
    const messages: AgentMessage[] = [
      makeUser("run"),
      makeAssistant([{ id: "tc1", name: "bash", arguments: { command: "fail" } }]),
      makeResult("tc1", "error", true),
    ];

    const result = purgeErrors(messages, 2, { protectedTools: [], protectedFilePatterns: [] });
    expect(result.purged).toBe(0);
  });
});
