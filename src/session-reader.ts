import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { estimateTextTokens } from "./utils.ts";

export const DEFAULT_READ_TOKENS = 4_000;
export const MAX_READ_TOKENS = 8_000;
export const LIST_LIMIT = 40;
export const SEARCH_LIMIT = 20;
export const PREVIEW_CHARS = 500;

export interface SessionHistoryItem {
  id: string;
  entry: SessionEntry;
  messages: AgentMessage[];
  role: string;
  searchableText: string;
  estimatedTokens: number;
}

export interface SessionHistoryResult {
  ok: boolean;
  text: string;
  details: {
    action: "list" | "search" | "read";
    returnedIds: string[];
    nextEntryId?: string;
    moreAvailable: boolean;
    estimatedTokens: number;
    error?: string;
  };
}

export function buildRawSessionIndex(entries: readonly SessionEntry[]): SessionHistoryItem[] {
  const index: SessionHistoryItem[] = [];
  for (const entry of entries) {
    const messages = sessionEntryToContextMessages(entry);
    if (messages.length === 0) continue;
    const searchableText = messages.map(messageToSearchText).join("\n");
    index.push({
      id: entry.id,
      entry,
      messages,
      role: describeEntry(entry, messages),
      searchableText,
      estimatedTokens: estimateTextTokens(searchableText),
    });
  }
  return index;
}

export function listSessionHistory(entries: readonly SessionEntry[], limit = LIST_LIMIT): SessionHistoryResult {
  const index = buildRawSessionIndex(entries);
  const items = index.slice(-clampLimit(limit, LIST_LIMIT)).reverse();
  const lines = items.map((item) =>
    `id: ${item.id} | ${item.role} | ~${item.estimatedTokens} tokens | ${quotePreview(item.searchableText)}`,
  );
  return success("list", items.map((item) => item.id), lines.length > 0
    ? `Session history index (newest first)\n${lines.join("\n")}`
    : "Session history index is empty.", false);
}

export function searchSessionHistory(
  entries: readonly SessionEntry[],
  query: string | undefined,
  limit = SEARCH_LIMIT,
): SessionHistoryResult {
  const needle = query?.trim().toLowerCase();
  if (!needle) return failure("search", "Search requires a non-empty query.");

  const matches = buildRawSessionIndex(entries)
    .filter((item) => item.searchableText.toLowerCase().includes(needle))
    .reverse()
    .slice(0, clampLimit(limit, SEARCH_LIMIT));
  const lines = matches.map((item) =>
    `id: ${item.id} | ${item.role} | ~${item.estimatedTokens} tokens | ${quotePreview(matchExcerpt(item.searchableText, needle))}`,
  );
  return success("search", matches.map((item) => item.id), lines.length > 0
    ? `Session history matches for ${JSON.stringify(query)} (newest first)\n${lines.join("\n")}`
    : `No raw session entries match ${JSON.stringify(query)}.`, false);
}

export function readSessionHistory(
  entries: readonly SessionEntry[],
  startEntryId: string | undefined,
  endEntryId: string | undefined,
  requestedTokens?: number,
): SessionHistoryResult {
  if (!startEntryId || !endEntryId) return failure("read", "Read requires both startEntryId and endEntryId from list or search.");
  const index = buildRawSessionIndex(entries);
  let start = index.findIndex((item) => item.id === startEntryId);
  let end = index.findIndex((item) => item.id === endEntryId);
  if (start < 0 || end < 0) return failure("read", "One or both entry IDs are not on the active raw session branch.");
  if (start > end) return failure("read", "startEntryId must come before or equal endEntryId on the active branch.");

  const pairBounds = toolPairBounds(index);
  ({ start, end } = expandToWholeToolPairs(start, end, pairBounds));
  const maxTokens = clampTokens(requestedTokens);
  // Reserve room for stable metadata/header lines so the final tool result
  // remains within the requested bound, not merely its raw body.
  const maxChars = Math.max(500, maxTokens * 4 - 600);
  const rendered: string[] = [];
  const returnedIds: string[] = [];
  let cursor = start;
  let usedChars = 0;

  while (cursor <= end) {
    const groupEnd = Math.max(cursor, pairBounds.get(cursor)?.end ?? cursor);
    const group = index.slice(cursor, groupEnd + 1);
    const remaining = maxChars - usedChars;
    if (remaining <= 0) break;
    const groupText = renderGroup(group, remaining);
    if (groupText.length > remaining && rendered.length > 0) break;
    if (groupText.length > remaining) {
      // A first atomic group is too large. Return bounded head/tail excerpts of
      // every member rather than splitting a call/result pair.
      const bounded = renderGroup(group, Math.max(500, remaining));
      rendered.push(boundText(bounded, remaining));
      returnedIds.push(...group.map((item) => item.id));
      cursor = groupEnd + 1;
      break;
    }
    rendered.push(groupText);
    returnedIds.push(...group.map((item) => item.id));
    usedChars += groupText.length;
    cursor = groupEnd + 1;
  }

  if (returnedIds.length === 0) return failure("read", "The requested range could not fit the bounded output. Use list or search to select a narrower range.");
  const moreAvailable = cursor <= end;
  const nextEntryId = moreAvailable ? index[cursor]?.id : undefined;
  const body = rendered.join("\n\n");
  const header = [
    "Session history excerpt",
    "- Source: active branch raw entries",
    `- Returned: ${returnedIds[0]} .. ${returnedIds[returnedIds.length - 1]}`,
    `- Estimated size: ~${estimateTextTokens(body)} tokens`,
    `- More available: ${moreAvailable ? `yes (continue from ${nextEntryId})` : "no"}`,
  ].join("\n");
  return success("read", returnedIds, `${header}\n\n${body}`, moreAvailable, nextEntryId);
}

function success(
  action: SessionHistoryResult["details"]["action"],
  returnedIds: string[],
  text: string,
  moreAvailable: boolean,
  nextEntryId?: string,
): SessionHistoryResult {
  return {
    ok: true,
    text,
    details: { action, returnedIds, nextEntryId, moreAvailable, estimatedTokens: estimateTextTokens(text) },
  };
}

function failure(action: SessionHistoryResult["details"]["action"], error: string): SessionHistoryResult {
  return {
    ok: false,
    text: `Cannot read session history: ${error}`,
    details: { action, returnedIds: [], moreAvailable: false, estimatedTokens: 0, error },
  };
}

function clampTokens(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_READ_TOKENS;
  return Math.max(500, Math.min(MAX_READ_TOKENS, Math.floor(value!)));
}

function clampLimit(value: number | undefined, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.max(1, Math.min(max, Math.floor(value!)));
}

function describeEntry(entry: SessionEntry, messages: AgentMessage[]): string {
  if (entry.type === "compaction") return "compaction summary";
  if (entry.type === "branch_summary") return "branch summary";
  if (messages.length === 1) {
    const message = messages[0];
    if (message.role === "toolResult") return `tool result (${message.toolName ?? "tool"})`;
    return message.role;
  }
  return "messages";
}

function messageToSearchText(message: AgentMessage): string {
  if (message.role === "compactionSummary") return message.summary;
  if (message.role === "branchSummary") return message.summary;
  if (message.role === "toolResult") return `${message.toolName ?? "tool"}\n${textFromContent(message.content)}`;
  if (message.role === "assistant") {
    const parts: string[] = [];
    for (const part of message.content) {
      if (part.type === "text") parts.push(part.text);
      if (part.type === "toolCall") parts.push(`${part.name}\n${safeJson(part.arguments)}`);
    }
    return parts.join("\n");
  }
  if (message.role === "user" || message.role === "custom") return textFromContent(message.content);
  return safeJson(message);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text")
    .map((part) => String((part as { text?: unknown }).text ?? ""))
    .join("\n");
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return "[unserializable]"; }
}

function quotePreview(text: string): string {
  return JSON.stringify(boundText(text.replace(/\s+/g, " ").trim(), PREVIEW_CHARS));
}

function matchExcerpt(text: string, needle: string): string {
  const lower = text.toLowerCase();
  const index = lower.indexOf(needle);
  if (index < 0) return boundText(text, PREVIEW_CHARS);
  const start = Math.max(0, index - Math.floor(PREVIEW_CHARS / 2));
  const end = Math.min(text.length, index + needle.length + Math.floor(PREVIEW_CHARS / 2));
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function renderGroup(items: SessionHistoryItem[], maxChars: number): string {
  const perItem = Math.max(300, Math.floor(maxChars / Math.max(1, items.length)) - 80);
  return items.map((item) => {
    const content = boundText(item.searchableText, perItem);
    return `--- entry ${item.id} | ${item.role} ---\n${content}\n--- end entry ${item.id} ---`;
  }).join("\n\n");
}

function boundText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.max(1, Math.ceil(maxChars * 0.7));
  const tail = Math.max(1, maxChars - head);
  const omitted = Math.max(0, text.length - head - tail);
  return `${text.slice(0, head)}\n[... ${omitted} characters omitted ...]\n${text.slice(-tail)}`;
}

function toolPairBounds(index: SessionHistoryItem[]): Map<number, { start: number; end: number }> {
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (let i = 0; i < index.length; i++) {
    for (const message of index[i].messages) {
      if (message.role === "assistant") {
        for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, i);
      }
      if (message.role === "toolResult") results.set(message.toolCallId, i);
    }
  }
  const bounds = new Map<number, { start: number; end: number }>();
  for (const [callId, callIndex] of calls) {
    const resultIndex = results.get(callId);
    if (resultIndex === undefined) continue;
    const start = Math.min(callIndex, resultIndex);
    const end = Math.max(callIndex, resultIndex);
    bounds.set(callIndex, { start, end });
    bounds.set(resultIndex, { start, end });
  }
  return bounds;
}

function expandToWholeToolPairs(start: number, end: number, bounds: Map<number, { start: number; end: number }>): { start: number; end: number } {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = start; i <= end; i++) {
      const bound = bounds.get(i);
      if (!bound) continue;
      if (bound.start < start) { start = bound.start; changed = true; }
      if (bound.end > end) { end = bound.end; changed = true; }
    }
  }
  return { start, end };
}
