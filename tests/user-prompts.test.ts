import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { appendPreservedUserMessages, extractPreservedUserMessages } from "../src/compaction/user-prompts.ts";

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

describe("deterministic user-prompt preservation", () => {
  it("appends real prompts after the model summary", () => {
    const output = appendPreservedUserMessages("model summary", [user("Keep this instruction")], undefined, 2_000);
    expect(output.indexOf("model summary")).toBeLessThan(output.indexOf("Keep this instruction"));
    expect(extractPreservedUserMessages(output)).toEqual(["Keep this instruction"]);
  });

  it("carries old prompts forward once across generations", () => {
    const first = appendPreservedUserMessages("first", [user("old"), user("new")], undefined, 2_000);
    const second = appendPreservedUserMessages("second", [user("new"), user("latest")], first, 2_000);
    expect(extractPreservedUserMessages(second)).toEqual(["old", "new", "latest"]);
    expect(second.match(/--- preserved user message ---/g)?.length).toBe(3);
  });

  it("does not carry synthetic control messages", () => {
    const output = appendPreservedUserMessages(
      "summary",
      [user("Resuming from context compression, continue current task"), user("/dcp compress"), user("[Context summary of completed work]\nold"), user("real")],
      undefined,
      2_000,
    );
    expect(extractPreservedUserMessages(output)).toEqual(["real"]);
  });

  it("preserves prompt whitespace when it fits", () => {
    const output = appendPreservedUserMessages("summary", [user("  exact\ntext  ")], undefined, 2_000);
    expect(extractPreservedUserMessages(output)).toEqual(["  exact\ntext  "]);
  });

  it("deduplicates identical prompts but keeps distinct prompts", () => {
    const output = appendPreservedUserMessages("summary", [user("same"), user("same"), user("same ")], undefined, 2_000);
    expect(extractPreservedUserMessages(output)).toEqual(["same", "same "]);
  });

  it("keeps the beginning and end of an oversized prompt", () => {
    const output = appendPreservedUserMessages("summary", [user("BEGIN" + "x".repeat(9_000) + "END")], undefined, 2_000);
    expect(output).toContain("BEGIN");
    expect(output).toContain("END");
    expect(output).toContain("characters elided");
  });
});
