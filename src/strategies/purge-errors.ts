import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { cloneMessages, findNthRecentUserMessage, matchesAnyPattern } from "../utils.ts";
import type { ResolvedProtection } from "../types.ts";

export interface PurgeErrorsResult {
  messages: AgentMessage[];
  purged: number;
}

const PLACEHOLDER = (toolName: string) =>
  `[input removed due to failed ${toolName} call; error message preserved above]`;

export function purgeErrors(
  messages: AgentMessage[],
  turns: number,
  protection: ResolvedProtection,
): PurgeErrorsResult {
  let purged = 0;
  const out = cloneMessages(messages);

  if (turns <= 0) return { messages: out, purged: 0 };

  const recentBoundary = findNthRecentUserMessage(out, turns);

  // Find toolResult messages that are errors and older than the boundary.
  for (let i = 0; i < out.length; i++) {
    const msg = out[i];
    if (msg.role !== "toolResult" || !msg.isError) continue;
    if (recentBoundary >= 0 && i >= recentBoundary) continue;
    if (matchesAnyPattern(msg.toolName, protection.protectedTools)) continue;

    // Find the corresponding assistant toolCall and replace its arguments.
    const toolCall = findToolCall(out, msg.toolCallId);
    if (!toolCall) continue;

    const path = extractPath(toolCall.arguments);
    if (path && matchesAnyPattern(path, protection.protectedFilePatterns)) continue;

    toolCall.arguments = { __dcp_purged__: PLACEHOLDER(msg.toolName) };
    purged++;
  }

  return { messages: out, purged };
}

function findToolCall(messages: AgentMessage[], toolCallId: string) {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type === "toolCall" && block.id === toolCallId) {
        return block;
      }
    }
  }
  return undefined;
}

function extractPath(args: Record<string, unknown>): string | undefined {
  if (args && typeof args === "object") {
    if (typeof args.path === "string") return args.path;
    if (typeof args.filePath === "string") return args.filePath;
  }
  return undefined;
}
