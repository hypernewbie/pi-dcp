import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { cloneMessages, createToolSignature, matchesAnyPattern, recentTurnsBoundary } from "../utils.ts";
import type { ResolvedProtection } from "../types.ts";

/**
 * Adapted from OpenCode DCP's lib/strategies/deduplication.ts.
 *
 * Groups unprotected tool calls by normalized signature and prunes every result
 * except the newest call in each group. Pi exposes tool calls/results as
 * separate AgentMessages, so pruning is represented as a replacement result.
 */
export interface DeduplicationResult {
  messages: AgentMessage[];
  deduplicated: number;
  dedupedIds: string[];
}

const PLACEHOLDER = (toolName: string) =>
  `[Output removed to save context — identical to a later ${toolName} call]`;

export function deduplicate(
  messages: AgentMessage[],
  protection: ResolvedProtection,
  recentUserTurnsProtected: number,
): DeduplicationResult {
  const out = cloneMessages(messages);
  const recentBoundary = recentTurnsBoundary(out, recentUserTurnsProtected);
  const groups = new Map<string, string[]>();
  const resultIndexByToolCallId = new Map<string, number>();

  for (let index = 0; index < out.length; index++) {
    const message = out[index];
    if (message.role === "toolResult") resultIndexByToolCallId.set(message.toolCallId, index);
  }

  for (let index = 0; index < out.length; index++) {
    const message = out[index];
    if (message.role !== "assistant") continue;
    if (index >= recentBoundary) continue;

    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      // Subagent results are exempt from deduplication unless explicitly opted in.
      if (block.name === "subagent") continue;
      const path = extractPath(block.arguments);
      if (matchesAnyPattern(block.name, protection.protectedTools)) continue;
      if (path && matchesAnyPattern(path, protection.protectedFilePatterns)) continue;

      const signature = createToolSignature(block.name, block.arguments);
      const ids = groups.get(signature) ?? [];
      ids.push(block.id);
      groups.set(signature, ids);
    }
  }

  let deduplicated = 0;
  const dedupedIds: string[] = [];
  for (const ids of groups.values()) {
    // Exact DCP policy: retain only the most recent call in a duplicate group.
    for (const toolCallId of ids.slice(0, -1)) {
      const resultIndex = resultIndexByToolCallId.get(toolCallId);
      if (resultIndex === undefined || resultIndex >= recentBoundary) continue;
      const result = out[resultIndex];
      if (result.role !== "toolResult") continue;
      result.content = [{ type: "text", text: PLACEHOLDER(result.toolName) }];
      deduplicated++;
      dedupedIds.push(toolCallId);
    }
  }

  return { messages: out, deduplicated, dedupedIds };
}

function extractPath(args: Record<string, unknown>): string | undefined {
  if (typeof args.path === "string") return args.path;
  if (typeof args.filePath === "string") return args.filePath;
  return undefined;
}
