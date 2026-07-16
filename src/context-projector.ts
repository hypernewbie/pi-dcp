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
  for (let i = 0; i < segments.length; i++) {
    for (const message of segments[i].messages) {
      if (message.role === "assistant") {
        for (const part of message.content) if (part.type === "toolCall") toolCallPositions.set(part.id, i);
      }
      if (message.role === "toolResult") toolResultPositions.set(message.toolCallId, i);
    }
  }
  for (const [id, position] of toolCallPositions) {
    const pairedResult = toolResultPositions.get(id);
    if (pairedResult === undefined) continue;
    if ((position >= start && position <= end) !== (pairedResult >= start && pairedResult <= end)) return false;
  }
  return true;
}

function messageKey(message: AgentMessage): string {
  switch (message.role) {
    case "user":
      return `user:${contentKey(message.content)}`;
    case "assistant":
      return `assistant:${message.content.map((part) => {
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
