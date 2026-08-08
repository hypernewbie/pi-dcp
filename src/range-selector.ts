import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { VirtualCompressionBlock } from "./types.ts";
import { estimateTextTokens } from "./utils.ts";

export interface VirtualRange {
  kind: "historical" | "active-prefix";
  startEntryId: string;
  endEntryId: string;
  entries: SessionEntry[];
  messages: AgentMessage[];
  /** The current request and raw suffix that must remain available to the model. */
  retainedMessages: AgentMessage[];
  retainedRawTokens: number;
  estimatedRawTokens: number;
}

// Below this size, the fixed summary/preserved-evidence overhead cannot provide
// worthwhile relief. This is intentionally a safety policy, not a user knob.
export const MIN_RANGE_RAW_TOKENS = 5_000;

/** Select whole finished turns first, then an early active prefix. */
export function selectCompressibleRange(
  entries: readonly SessionEntry[],
  blocks: readonly VirtualCompressionBlock[],
  maxInputTokens: number,
  targetTokens = maxInputTokens,
  activeWorkingSetTokens = 0,
  allowActivePrefix = true,
  minRangeRawTokens = MIN_RANGE_RAW_TOKENS,
): VirtualRange | undefined {
  const covered = new Set<string>();
  for (const block of blocks) {
    const start = entries.findIndex((entry) => entry.id === block.startEntryId);
    const end = entries.findIndex((entry) => entry.id === block.endEntryId);
    if (start < 0 || end < start) continue;
    for (let i = start; i <= end; i++) covered.add(entries[i].id);
  }

  const userStarts = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.type === "message" && entry.message.role === "user")
    .map(({ index }) => index);
  if (userStarts.length === 0) return undefined;

  const completeRanges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < userStarts.length - 1; i++) {
    completeRanges.push({ start: userStarts[i], end: userStarts[i + 1] - 1 });
  }

  let selected: SessionEntry[] = [];
  let startIndex = -1;
  let endIndex = -1;
  let estimated = 0;
  const resetSelection = () => {
    selected = [];
    startIndex = -1;
    endIndex = -1;
    estimated = 0;
  };

  for (const range of completeRanges) {
    const candidate = entries.slice(range.start, range.end + 1);
    if (candidate.length === 0) continue;
    // Never make one range jump across an existing summary or native summary.
    // If the accumulated island is too small to be useful, leave it raw and
    // keep scanning rather than wasting a summary call or hiding a later range.
    const unavailable = candidate.some((entry) => covered.has(entry.id)) ||
      candidate.some((entry) => entry.type === "compaction" || entry.type === "branch_summary");
    if (unavailable) {
      if (selected.length > 0 && estimated >= minRangeRawTokens) break;
      resetSelection();
      continue;
    }
    const messages = candidate.flatMap((entry) => sessionEntryToContextMessages(entry));
    if (messages.length === 0) continue;
    const tokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    if (selected.length > 0 && estimated + tokens > maxInputTokens) {
      if (estimated >= minRangeRawTokens) break;
      resetSelection();
    }
    if (tokens > maxInputTokens) continue;
    if (startIndex < 0) startIndex = range.start;
    endIndex = range.end;
    selected.push(...candidate);
    estimated += tokens;
    const selectionTarget = Math.max(minRangeRawTokens, Math.min(targetTokens, maxInputTokens));
    if (estimated >= selectionTarget) break;
  }

  if (selected.length > 0 && startIndex >= 0 && endIndex >= 0 && estimated >= minRangeRawTokens) {
    // The accumulation must be projectable; otherwise it will be rejected by
    // entryRangeCanBeReplaced and the whole compact will claim nothing.
    if (isClosedRange(entries, startIndex, endIndex)) {
      return makeRange(entries, selected, startIndex, endIndex, estimated);
    }
    // Not projectable (split tool call) — fall through to single-turn fallback.
  }

  // Fragmentation fallback for manual / large-context sessions: if the
  // accumulation above failed due to covered/compaction gaps resetting a tiny
  // island, pick the largest single uncovered historical turn instead of
  // claiming nothing to compact.
  {
    let best: { start: number; end: number; tokens: number } | null = null;
    for (const range of completeRanges) {
      const candidate = entries.slice(range.start, range.end + 1);
      if (candidate.length === 0) continue;
      const unavailable = candidate.some((entry) => covered.has(entry.id)) ||
        candidate.some((entry) => entry.type === "compaction" || entry.type === "branch_summary");
      if (unavailable) continue;
      const messages = candidate.flatMap((entry) => sessionEntryToContextMessages(entry));
      if (messages.length === 0) continue;
      const tokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
      if (tokens > maxInputTokens) continue;
      if (tokens < 1_000) continue; // avoid summarizing trivial turns
      // Must be projectable (closed tool pairs).
      let closed = true;
      const calls = new Set<string>();
      const results = new Set<string>();
      for (const entry of candidate) {
        for (const m of sessionEntryToContextMessages(entry)) {
          if (m.role === "assistant") for (const p of (m.content as any)) if (p.type === "toolCall") calls.add(p.id);
          if (m.role === "toolResult") results.add((m as any).toolCallId);
        }
      }
      for (const id of calls) if (!results.has(id)) { closed = false; break; }
      if (closed) for (const id of results) if (!calls.has(id)) { closed = false; break; }
      if (!closed) continue;
      if (!best || tokens > best.tokens) best = { start: range.start, end: range.end, tokens };
    }
    if (best) {
      const sel = entries.slice(best.start, best.end + 1);
      return makeRange(entries, [...sel], best.start, best.end, best.tokens);
    }
  }

  if (!allowActivePrefix) return undefined;

  // A single uninterrupted tool run has no completed earlier turn. Keep the
  // newest active working set and only select boundaries after tool results.
  const finalStart = userStarts[userStarts.length - 1];
  const finalEntries = entries.slice(finalStart);
  const currentRequest = sessionEntryToContextMessages(finalEntries[0]);
  // The current user request is never part of the compacted prefix.
  if (currentRequest.length === 0) return undefined;
  const activeEntries = finalEntries.slice(1);
  const activeMessages = activeEntries.flatMap((entry) => sessionEntryToContextMessages(entry));
  const activeTokens = activeMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  let prefixEnd = -1;
  let runningPrefixTokens = 0;
  let selectedPrefixTokens = 0;
  // Tool calls awaiting their result. Cutting while any are open would leave a
  // call inside the summarized range and its result outside it, which the
  // projector must reject - so such a block could never be applied at all.
  // Parallel tool calls make this the common case, not an edge case.
  const openToolCallIds = new Set<string>();
  for (let i = 0; i < activeEntries.length; i++) {
    const entry = activeEntries[i];
    const entryMessages = sessionEntryToContextMessages(entry);
    runningPrefixTokens += entryMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    for (const message of entryMessages) {
      if (message.role === "assistant") {
        for (const part of message.content) if (part.type === "toolCall") openToolCallIds.add(part.id);
      }
      if (message.role === "toolResult") openToolCallIds.delete(message.toolCallId);
    }
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    if (openToolCallIds.size > 0) continue;
    const suffixTokens = activeTokens - runningPrefixTokens;
    if (suffixTokens >= activeWorkingSetTokens && runningPrefixTokens <= maxInputTokens) {
      prefixEnd = i;
      // Capture the count at the actual cut point. The scan continues to find
      // the newest safe tool boundary, so the running total cannot be returned.
      selectedPrefixTokens = runningPrefixTokens;
    }
  }
  if (prefixEnd < 1 || selectedPrefixTokens < minRangeRawTokens) return undefined;
  const prefix = activeEntries.slice(0, prefixEnd + 1);
  if (prefix.some((entry) => covered.has(entry.id))) return undefined;
  const currentRequestTokens = currentRequest.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  return {
    kind: "active-prefix",
    startEntryId: prefix[0].id,
    endEntryId: prefix[prefix.length - 1].id,
    entries: prefix,
    messages: prefix.flatMap((entry) => sessionEntryToContextMessages(entry)),
    retainedMessages: [...currentRequest, ...activeEntries.slice(prefixEnd + 1).flatMap((entry) => sessionEntryToContextMessages(entry))],
    retainedRawTokens: currentRequestTokens + (activeTokens - selectedPrefixTokens),
    estimatedRawTokens: selectedPrefixTokens,
  };
}

function makeRange(
  entries: readonly SessionEntry[],
  selected: SessionEntry[],
  startIndex: number,
  endIndex: number,
  estimatedRawTokens: number,
): VirtualRange {
  const retainedMessages = entries.slice(endIndex + 1).flatMap((entry) => sessionEntryToContextMessages(entry));
  return {
    kind: "historical",
    startEntryId: entries[startIndex].id,
    endEntryId: entries[endIndex].id,
    entries: selected,
    messages: selected.flatMap((entry) => sessionEntryToContextMessages(entry)),
    retainedMessages,
    retainedRawTokens: retainedMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0),
    estimatedRawTokens,
  };
}

function estimateMessageTokens(message: AgentMessage): number {
  return estimateTextTokens(JSON.stringify(message));
}

function isClosedRange(entries: readonly SessionEntry[], start: number, end: number): boolean {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (let i = start; i <= end; i++) {
    for (const m of sessionEntryToContextMessages(entries[i])) {
      if (m.role === "assistant") for (const p of (m.content as any)) if (p.type === "toolCall") calls.add(p.id);
      if (m.role === "toolResult") results.add((m as any).toolCallId);
    }
  }
  for (const id of calls) if (!results.has(id)) return false;
  for (const id of results) if (!calls.has(id)) return false;
  return true;
}
