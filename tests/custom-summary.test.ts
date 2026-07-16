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
    model: { provider: "openai-codex", id: "gpt-5.6-luna-free-1p-codexswic-ev3", api: "openai-responses", maxTokens: 100_000 },
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

    const result = await handleSessionBeforeCompact(makeEvent(), ctx, DEFAULT_CONFIG, protection, makePreview(), "medium");

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

    const result = await handleSessionBeforeCompact(makeEvent(), ctx, DEFAULT_CONFIG, protection, makePreview(), "medium");

    expect(result).toBeUndefined();
    expect(notified.some((n) => n.message.includes("summary was empty"))).toBe(true);
  });

  it("returns a compaction result on a genuinely successful summary", async () => {
    completeSimpleMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "A real summary of the conversation." }],
    });

    const ctx = makeCtx(() => {});
    const result = await handleSessionBeforeCompact(makeEvent(), ctx, DEFAULT_CONFIG, protection, makePreview(), "medium");

    expect(result).toBeDefined();
    expect(result?.compaction.summary).toContain("A real summary of the conversation.");
    expect(result?.compaction.summary).toContain("u1");
    expect(result?.compaction.summary).toContain("verbatim, preserved by DCP");
  });

  it("uses the 20,000-token ceiling for the explicit one-shot summary path by default", async () => {
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "A real summary." }] });
    await handleSessionBeforeCompact(makeEvent(), makeCtx(() => {}), DEFAULT_CONFIG, protection, makePreview(), "off");
    expect(completeSimpleMock.mock.calls[0][2].maxTokens).toBe(20_000);
  });

  it("uses the configured ceiling when a provider omits model.maxTokens", async () => {
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "A real summary." }] });
    const ctx = makeCtx(() => {});
    delete ctx.model.maxTokens;
    await handleSessionBeforeCompact(makeEvent(), ctx, DEFAULT_CONFIG, protection, makePreview(), "off");
    expect(completeSimpleMock.mock.calls[0][2].maxTokens).toBe(20_000);
  });

  it("clamps the configured ceiling to the model's supported output limit", async () => {
    completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "A real summary." }] });
    const ctx = makeCtx(() => {});
    ctx.model.maxTokens = 8_192;
    await handleSessionBeforeCompact(makeEvent(), ctx, DEFAULT_CONFIG, protection, makePreview(), "off");
    expect(completeSimpleMock.mock.calls[0][2].maxTokens).toBe(8_192);
  });

  it("passes the session's thinking level as the reasoning option for reasoning-capable models", async () => {
    completeSimpleMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "A real summary." }],
    });

    const ctx = makeCtx(() => {});
    ctx.model.reasoning = true;

    await handleSessionBeforeCompact(makeEvent(), ctx, DEFAULT_CONFIG, protection, makePreview(), "high");

    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    const options = completeSimpleMock.mock.calls[0][2];
    expect(options.reasoning).toBe("high");
  });

  it("omits reasoning when the thinking level is off or the model doesn't support reasoning", async () => {
    completeSimpleMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "A real summary." }],
    });

    const ctxOff = makeCtx(() => {});
    ctxOff.model.reasoning = true;
    await handleSessionBeforeCompact(makeEvent(), ctxOff, DEFAULT_CONFIG, protection, makePreview(), "off");
    expect(completeSimpleMock.mock.calls[0][2].reasoning).toBeUndefined();

    completeSimpleMock.mockClear();

    const ctxNonReasoning = makeCtx(() => {});
    ctxNonReasoning.model.reasoning = false;
    await handleSessionBeforeCompact(makeEvent(), ctxNonReasoning, DEFAULT_CONFIG, protection, makePreview(), "high");
    expect(completeSimpleMock.mock.calls[0][2].reasoning).toBeUndefined();
  });
});
