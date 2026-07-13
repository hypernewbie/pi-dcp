import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { resolveProtection } from "../src/protection.ts";
import type { CompactionPreview } from "../src/types.ts";

// completeSimple() does not throw for provider-level failures - it can return a
// normal (non-throwing) AssistantMessage with stopReason "error" and errorMessage
// set. handleSessionBeforeCompact must surface that real error instead of
// silently mislabeling it as "summary was empty".
const completeSimpleMock = vi.fn();

vi.mock("@earendil-works/pi-ai/compat", () => ({
  completeSimple: (...args: unknown[]) => completeSimpleMock(...args),
}));

const { handleSessionBeforeCompact } = await import("../src/compaction/custom-summary.ts");

function makePreview(): CompactionPreview {
  return {
    initiator: "dcp-command",
    focus: "",
    focusIsUserSupplied: false,
    removedTokensThisRun: 1000,
    messagesCompressed: 2,
    toolsCompressed: 0,
  } as any;
}

function makeEvent(): any {
  const message = (role: string, text: string) => ({
    role,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });
  return {
    preparation: {
      messagesToSummarize: [message("user", "u1"), message("assistant", "a1")],
      turnPrefixMessages: [],
      tokensBefore: 50_000,
      firstKeptEntryId: "keep-1",
      previousSummary: undefined,
      fileOps: { read: [], edited: [], written: [] },
    },
    branchEntries: [],
    customInstructions: undefined,
    signal: new AbortController().signal,
  };
}

function makeCtx(notify: (message: string, type?: string) => void): any {
  return {
    hasUI: true,
    model: { provider: "openai-codex", id: "gpt-5.6-luna-free-1p-codexswic-ev3", api: "openai-responses" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {}, env: {} }),
      find: () => undefined,
    },
    ui: { notify },
  };
}

describe("handleSessionBeforeCompact - provider error surfacing", () => {
  const protection = resolveProtection(DEFAULT_CONFIG.pruning, DEFAULT_CONFIG.compaction, [], []);

  beforeEach(() => {
    completeSimpleMock.mockReset();
  });

  it("surfaces a real provider error instead of mislabeling it as an empty summary", async () => {
    // Regression test for a real bug: a provider error (e.g. Codex "Model not
    // found") comes back as a normal AssistantMessage with stopReason "error",
    // not a thrown exception. Without checking stopReason, this had empty
    // content and was silently reported as "summary was empty, falling back".
    completeSimpleMock.mockResolvedValue({
      stopReason: "error",
      errorMessage: "Codex error: Model not found gpt-5.6-luna-free-1p-codexswic-ev3",
      content: [],
    });

    const notified: Array<{ message: string; type?: string }> = [];
    const ctx = makeCtx((message, type) => notified.push({ message, type }));

    const result = await handleSessionBeforeCompact(makeEvent(), ctx, DEFAULT_CONFIG, protection, makePreview());

    expect(result).toBeUndefined();
    expect(notified.some((n) => n.type === "error" && n.message.includes("Codex error: Model not found"))).toBe(true);
    expect(notified.some((n) => n.message.includes("summary was empty"))).toBe(false);
  });

  it("still reports a genuinely empty (but non-error) summary as empty", async () => {
    completeSimpleMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "   " }],
    });

    const notified: Array<{ message: string; type?: string }> = [];
    const ctx = makeCtx((message, type) => notified.push({ message, type }));

    const result = await handleSessionBeforeCompact(makeEvent(), ctx, DEFAULT_CONFIG, protection, makePreview());

    expect(result).toBeUndefined();
    expect(notified.some((n) => n.message.includes("summary was empty"))).toBe(true);
  });

  it("returns a compaction result on a genuinely successful summary", async () => {
    completeSimpleMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "A real summary of the conversation." }],
    });

    const ctx = makeCtx(() => {});
    const result = await handleSessionBeforeCompact(makeEvent(), ctx, DEFAULT_CONFIG, protection, makePreview());

    expect(result).toBeDefined();
    expect(result?.compaction.summary).toBe("A real summary of the conversation.");
  });
});
