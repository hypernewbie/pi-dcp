import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { VirtualCompressionBlock } from "./types.ts";

interface Segment {
  entry: SessionEntry;
  messages: AgentMessage[];
  actualStart?: number;
  actualEnd?: number;
}

export interface ProjectionResult {
  messages: AgentMessage[];
  appliedBlocks: number;
  /** Benign: an older overlapping summary was superseded by a newer one. */
  supersededBlocks: number;
  /** Real failures: these block ranges could not be applied to this request. */
  failedBlockIds: string[];
}

/**
 * Project verified ranges only. Live agent messages may differ from their stored
 * copies in usage, timestamps, or extension metadata, so mapping deliberately
 * compares stable conversational identity rather than whole JSON objects.
 *
 * Unknown live messages are retained. A broken range skips only that block;
 * it never disables all other verified blocks or drops context.
 */
export function projectVirtualBlocksWithInfo(
  contextMessages: AgentMessage[],
  contextEntries: readonly SessionEntry[],
  blocks: readonly VirtualCompressionBlock[],
): ProjectionResult {
  if (blocks.length === 0 || contextEntries.length === 0) {
    return { messages: contextMessages, appliedBlocks: 0, supersededBlocks: 0, failedBlockIds: [] };
  }

  const segments = mapSegments(contextMessages, contextEntries);
  const failedBlockIds: string[] = [];
  let supersededBlocks = 0;

  const candidates = blocks
    .map((block) => ({
      block,
      start: segments.findIndex((segment) => segment.entry.id === block.startEntryId),
      end: segments.findIndex((segment) => segment.entry.id === block.endEntryId),
    }))
    .filter((candidate) => {
      if (candidate.start >= 0 && candidate.end >= candidate.start) return true;
      failedBlockIds.push(candidate.block.id);
      return false;
    })
    .filter((candidate) => {
      if (hasClosedToolPairs(segments, candidate.start, candidate.end)) return true;
      failedBlockIds.push(candidate.block.id);
      return false;
    })
    .sort((a, b) => b.block.createdAt - a.block.createdAt || b.block.id.localeCompare(a.block.id));

  const replacements = new Map<number, { end: number; message: AgentMessage; blockId: string }>();
  for (const candidate of candidates) {
    const span = mappedContiguousSpan(segments, candidate.start, candidate.end);
    if (!span) {
      failedBlockIds.push(candidate.block.id);
      continue;
    }
    // A newer summary is authoritative if a persisted session contains overlap.
    if ([...replacements.entries()].some(([start, replacement]) => span.start <= replacement.end && span.end >= start)) {
      supersededBlocks++;
      continue;
    }
    replacements.set(span.start, { end: span.end, message: makeBlockMessage(candidate.block), blockId: candidate.block.id });
  }

  // Defensive live-pairing guard: a replacement must never orphan a live tool
  // call/result whose partner is retained outside the replaced span.
  for (const [start, replacement] of [...replacements.entries()]) {
    if (!livePairsStayClosed(contextMessages, replacements, start, replacement.end)) {
      replacements.delete(start);
      failedBlockIds.push(replacement.blockId);
    }
  }

  if (replacements.size === 0) {
    return { messages: contextMessages, appliedBlocks: 0, supersededBlocks, failedBlockIds };
  }

  const output: AgentMessage[] = [];
  for (let i = 0; i < contextMessages.length; i++) {
    const replacement = replacements.get(i);
    if (replacement) {
      output.push(replacement.message);
      i = replacement.end;
      continue;
    }
    output.push(contextMessages[i]);
  }
  return { messages: output, appliedBlocks: replacements.size, supersededBlocks, failedBlockIds };
}

export function projectVirtualBlocks(
  contextMessages: AgentMessage[],
  contextEntries: readonly SessionEntry[],
  blocks: readonly VirtualCompressionBlock[],
): AgentMessage[] {
  return projectVirtualBlocksWithInfo(contextMessages, contextEntries, blocks).messages;
}

/**
 * Measure the projected token count of the next request after applying the
 * given blocks to the given branch. Used after a relief pass to record what
 * the provider actually receives, so the growth-throttle re-trigger guard
 * doesn't compare a new raw measurement against a stale pre-relief number.
 * Returns 0 when the branch cannot be projected.
 */
export function measureProjectedTokens(
  branch: readonly SessionEntry[],
  blocks: readonly VirtualCompressionBlock[],
): number {
  try {
    const contextMessages: AgentMessage[] = [];
    for (const entry of branch) {
      for (const message of sessionEntryToContextMessages(entry)) contextMessages.push(message);
    }
    const projected = projectVirtualBlocksWithInfo(contextMessages, branch, blocks);
    let total = 0;
    for (const message of projected.messages) {
      total += estimateMessageTokens(message);
    }
    return total;
  } catch {
    return 0;
  }
}

export interface ProjectedRefreshResult {
  projectedTokens: number;
  appliedBlocks: number;
  contextWindow: number;
}

/**
 * Re-run the projection against the given branch so the next call to the
 * patched AgentSession.getContextUsage() returns the projected figure instead
 * of the stale pre-relief one. Returns the projected token count and the
 * number of blocks that actually applied. Returns 0/0 when the branch cannot
 * be projected, so the caller can fall back to the raw usage value.
 */
export function refreshProjectedContext(
  branch: readonly SessionEntry[],
  blocks: readonly VirtualCompressionBlock[],
  contextWindow: number,
): ProjectedRefreshResult {
  try {
    const contextMessages: AgentMessage[] = [];
    for (const entry of branch) {
      for (const message of sessionEntryToContextMessages(entry)) contextMessages.push(message);
    }
    const projected = projectVirtualBlocksWithInfo(contextMessages, branch, blocks);
    let total = 0;
    for (const message of projected.messages) {
      total += estimateMessageTokens(message);
    }
    return { projectedTokens: total, appliedBlocks: projected.appliedBlocks, contextWindow };
  } catch {
    return { projectedTokens: 0, appliedBlocks: 0, contextWindow };
  }
}

function estimateMessageTokens(message: AgentMessage): number {
  try {
    return JSON.stringify(message).length / 4;
  } catch {
    return 0;
  }
}

export function makeBlockMessage(block: VirtualCompressionBlock): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: `[Context summary of completed work]\n\n${block.summary}` }],
    timestamp: block.createdAt,
  } as AgentMessage;
}

function mapSegments(contextMessages: AgentMessage[], contextEntries: readonly SessionEntry[]): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const entry of contextEntries) {
    const messages = sessionEntryToContextMessages(entry);
    const start = messages.length === 0 ? undefined : findMessageSequence(contextMessages, messages, cursor);
    const segment: Segment = { entry, messages };
    if (start !== undefined) {
      segment.actualStart = start;
      segment.actualEnd = start + messages.length - 1;
      cursor = segment.actualEnd + 1;
    }
    segments.push(segment);
  }
  return segments;
}

function findMessageSequence(actual: AgentMessage[], expected: AgentMessage[], from: number): number | undefined {
  for (let start = from; start + expected.length <= actual.length; start++) {
    let matches = true;
    for (let i = 0; i < expected.length; i++) {
      if (messageKey(actual[start + i]) !== messageKey(expected[i])) {
        matches = false;
        break;
      }
    }
    if (matches) return start;
  }
  return undefined;
}

function mappedContiguousSpan(segments: Segment[], start: number, end: number): { start: number; end: number } | undefined {
  let first: number | undefined;
  let previousEnd: number | undefined;
  for (let i = start; i <= end; i++) {
    const segment = segments[i];
    if (segment.messages.length === 0) continue;
    if (segment.actualStart === undefined || segment.actualEnd === undefined) return undefined;
    if (first === undefined) first = segment.actualStart;
    if (previousEnd !== undefined && segment.actualStart !== previousEnd + 1) return undefined;
    previousEnd = segment.actualEnd;
  }
  return first === undefined || previousEnd === undefined ? undefined : { start: first, end: previousEnd };
}

function livePairsStayClosed(
  contextMessages: AgentMessage[],
  replacements: Map<number, { end: number }>,
  start: number,
  end: number,
): boolean {
  const isReplaced = (index: number): boolean => {
    for (const [spanStart, span] of replacements) {
      if (index >= spanStart && index <= span.end) return true;
    }
    return false;
  };
  const callPositions = new Map<string, number>();
  const resultPositions = new Map<string, number>();
  for (let i = 0; i < contextMessages.length; i++) {
    const message = contextMessages[i];
    if (message.role === "assistant") {
      for (const part of message.content) if (part.type === "toolCall") callPositions.set(part.id, i);
    }
    if (message.role === "toolResult") resultPositions.set(message.toolCallId, i);
  }
  for (const [id, callIndex] of callPositions) {
    const resultIndex = resultPositions.get(id);
    if (resultIndex === undefined) continue;
    const callInSpan = callIndex >= start && callIndex <= end;
    const resultInSpan = resultIndex >= start && resultIndex <= end;
    if (callInSpan === resultInSpan) continue;
    // The partner is acceptable only when another replacement removes it too.
    const partnerIndex = callInSpan ? resultIndex : callIndex;
    if (!isReplaced(partnerIndex)) return false;
  }
  return true;
}

function hasClosedToolPairs(segments: Segment[], start: number, end: number): boolean {
  const toolCallPositions = new Map<string, number>();
  const toolResultPositions = new Map<string, number>();
  for (let i = start; i <= end; i++) {
    for (const message of segments[i].messages) {
      if (message.role === "assistant") {
        for (const part of message.content) if (part.type === "toolCall") toolCallPositions.set(part.id, i);
      }
      if (message.role === "toolResult") toolResultPositions.set(message.toolCallId, i);
    }
  }
  // Every tool call in the range must have its result inside the range.
  // If a result is missing entirely, the projections live-pairing guard would
  // orphan the call, so the block must not be created.
  for (const id of toolCallPositions.keys()) {
    if (!toolResultPositions.has(id)) return false;
  }
  // Every tool result in the range must have its call inside the range too.
  for (const id of toolResultPositions.keys()) {
    if (!toolCallPositions.has(id)) return false;
  }
  return true;
}

/** Model-internal reasoning content, in any of the shapes Pi/providers emit. */
function isReasoningPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const type = (part as { type?: unknown }).type;
  return type === "thinking" || type === "reasoning" || type === "redacted_thinking";
}

/**
 * True when the entry range can actually be replaced without orphaning a tool
 * call from its result. Creation and projection MUST share this check, or a
 * block gets created (paying for a summary) that the projector rejects forever.
 */
export function entryRangeCanBeReplaced(
  contextEntries: readonly SessionEntry[],
  startEntryId: string,
  endEntryId: string,
): boolean {
  const segments: Segment[] = contextEntries.map((entry) => ({
    entry,
    messages: sessionEntryToContextMessages(entry),
  }));
  const start = segments.findIndex((segment) => segment.entry.id === startEntryId);
  const end = segments.findIndex((segment) => segment.entry.id === endEntryId);
  if (start < 0 || end < start) return false;
  return hasClosedToolPairs(segments, start, end);
}

function messageKey(message: AgentMessage): string {
  switch (message.role) {
    case "user":
      return `user:${contentKey(message.content)}`;
    case "assistant":
      // Reasoning/thinking parts are deliberately excluded from identity. They
      // carry no conversational meaning and are legitimately rewritten by
      // providers, redaction, and session repair tools (a repaired turn gains a
      // thinking block before its reply). Including them made an otherwise
      // identical turn unrecognizable, which permanently stranded stored
      // summaries and produced "no longer match this session's history".
      return `assistant:${message.content
        .filter((part) => !isReasoningPart(part))
        .map((part) => {
          if (part.type === "text") return `text:${part.text}`;
          if (part.type === "toolCall") return `call:${part.id}:${part.name}:${stableJson(part.arguments)}`;
          return part.type;
        }).join("|")}`;
    case "toolResult":
      return `result:${message.toolCallId}:${message.toolName ?? ""}:${contentKey(message.content)}`;
    case "compactionSummary":
      return `compaction:${message.summary}`;
    case "branchSummary":
      return `branch:${message.fromId}:${message.summary}`;
    case "custom":
      return `custom:${message.customType}:${contentKey(message.content)}`;
    default:
      return `${message.role}:${stableJson(message)}`;
  }
}

function contentKey(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return String(part);
    const value = part as { type?: unknown; text?: unknown; mimeType?: unknown };
    if (value.type === "text") return `text:${String(value.text ?? "")}`;
    if (value.type === "image") return `image:${String(value.mimeType ?? "")}`;
    return stableJson(part);
  }).join("|");
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}
