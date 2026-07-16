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

/** Select whole finished turns first, then an early active prefix. */
export function selectCompressibleRange(
  entries: readonly SessionEntry[],
  blocks: readonly VirtualCompressionBlock[],
  maxInputTokens: number,
  targetTokens = maxInputTokens,
  activeWorkingSetTokens = 0,
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

  for (const range of completeRanges) {
    const candidate = entries.slice(range.start, range.end + 1);
    if (candidate.length === 0) continue;
    // Never make one range jump across an existing summary. That would create
    // overlapping blocks and make one of their summaries stale.
    if (candidate.some((entry) => covered.has(entry.id))) {
      if (selected.length > 0) break;
      continue;
    }
    if (candidate.some((entry) => entry.type === "compaction" || entry.type === "branch_summary")) continue;
    const messages = candidate.flatMap((entry) => sessionEntryToContextMessages(entry));
    if (messages.length === 0) continue;
    const tokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    if (selected.length > 0 && estimated + tokens > maxInputTokens) break;
    if (selected.length === 0 && tokens > maxInputTokens) continue;
    if (startIndex < 0) startIndex = range.start;
    endIndex = range.end;
    selected.push(...candidate);
    estimated += tokens;
    if (estimated >= Math.min(targetTokens, maxInputTokens)) break;
  }

  if (selected.length > 0 && startIndex >= 0 && endIndex >= 0) {
    return makeRange(entries, selected, startIndex, endIndex, estimated);
  }

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
  let prefixTokens = 0;
  for (let i = 0; i < activeEntries.length; i++) {
    const entry = activeEntries[i];
    const entryMessages = sessionEntryToContextMessages(entry);
    prefixTokens += entryMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    const suffixTokens = activeTokens - prefixTokens;
    if (suffixTokens >= activeWorkingSetTokens && prefixTokens <= maxInputTokens) prefixEnd = i;
  }
  if (prefixEnd < 1) return undefined;
  const prefix = activeEntries.slice(0, prefixEnd + 1);
  if (prefix.some((entry) => covered.has(entry.id))) return undefined;
  return {
    kind: "active-prefix",
    startEntryId: prefix[0].id,
    endEntryId: prefix[prefix.length - 1].id,
    entries: prefix,
    messages: prefix.flatMap((entry) => sessionEntryToContextMessages(entry)),
    retainedMessages: [...currentRequest, ...activeEntries.slice(prefixEnd + 1).flatMap((entry) => sessionEntryToContextMessages(entry))],
    retainedRawTokens: currentRequest.reduce((sum, message) => sum + estimateMessageTokens(message), 0) + (activeTokens - prefixTokens),
    estimatedRawTokens: prefixTokens,
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
