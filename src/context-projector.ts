import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { VirtualCompressionBlock } from "./types.ts";

/**
 * Replace only ranges that can be mapped exactly. If any mapping is unclear,
 * return the original messages unchanged rather than risking context damage.
 */
export function projectVirtualBlocks(
  contextMessages: AgentMessage[],
  contextEntries: readonly SessionEntry[],
  blocks: readonly VirtualCompressionBlock[],
): AgentMessage[] {
  if (blocks.length === 0 || contextEntries.length === 0) return contextMessages;

  const segments: Array<{ entry: SessionEntry; messages: AgentMessage[]; start: number; end: number }> = [];
  let cursor = 0;
  for (const entry of contextEntries) {
    const expected = sessionEntryToContextMessages(entry);
    const start = cursor;
    if (expected.length > 0) {
      if (!matchesAt(contextMessages, cursor, expected)) return contextMessages;
      cursor += expected.length;
    }
    segments.push({ entry, messages: expected, start, end: cursor });
  }
  if (cursor !== contextMessages.length) return contextMessages;

  const candidates = blocks
    .map((block) => ({
      block,
      start: segments.findIndex((segment) => segment.entry.id === block.startEntryId),
      end: segments.findIndex((segment) => segment.entry.id === block.endEntryId),
    }))
    .filter((candidate) => candidate.start >= 0 && candidate.end >= candidate.start)
    .filter((candidate) => hasClosedToolPairs(segments, candidate.start, candidate.end))
    // A newer summary is the authoritative replacement if ranges overlap.
    .sort((a, b) => b.block.createdAt - a.block.createdAt || b.block.id.localeCompare(a.block.id));

  const accepted: typeof candidates = [];
  for (const candidate of candidates) {
    if (accepted.some((existing) => candidate.start <= existing.end && candidate.end >= existing.start)) continue;
    accepted.push(candidate);
  }

  const replacements = new Map<number, { end: number; message: AgentMessage }>();
  for (const candidate of accepted) {
    // Custom/state entries can sit inside the range and emit no messages; they
    // are safe to skip along with the covered raw entries.
    replacements.set(candidate.start, {
      end: candidate.end,
      message: makeBlockMessage(candidate.block),
    });
  }

  if (replacements.size === 0) return contextMessages;
  const output: AgentMessage[] = [];
  for (let i = 0; i < segments.length; i++) {
    const replacement = replacements.get(i);
    if (replacement) {
      output.push(replacement.message);
      i = replacement.end;
      continue;
    }
    output.push(...segments[i].messages);
  }
  return output;
}

export function makeBlockMessage(block: VirtualCompressionBlock): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: `[Context summary of completed work]\n\n${block.summary}` }],
    timestamp: block.createdAt,
  } as AgentMessage;
}

function hasClosedToolPairs(
  segments: Array<{ entry: SessionEntry; messages: AgentMessage[] }>,
  start: number,
  end: number,
): boolean {
  const toolCallPositions = new Map<string, number>();
  const toolResultPositions = new Map<string, number>();
  for (let i = 0; i < segments.length; i++) {
    for (const message of segments[i].messages) {
      if (message.role === "assistant") {
        for (const part of message.content) {
          if (part.type === "toolCall") toolCallPositions.set(part.id, i);
        }
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

function matchesAt(actual: AgentMessage[], offset: number, expected: AgentMessage[]): boolean {
  if (offset + expected.length > actual.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (!sameMessage(actual[offset + i], expected[i])) return false;
  }
  return true;
}

function sameMessage(a: AgentMessage, b: AgentMessage): boolean {
  // Context events are cloned by the extension runner, so object identity is
  // not reliable. Stable JSON is sufficient for public session messages and
  // keeps the projector fail-open when another extension changes content.
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
