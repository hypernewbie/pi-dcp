import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { cloneMessages, matchesAnyPattern, recentTurnsBoundary } from "../utils.ts";
import type { ResolvedProtection } from "../types.ts";

/**
 * Adapted from OpenCode DCP's lib/strategies/purge-errors.ts and
 * lib/messages/prune.ts.
 *
 * For old failed calls, preserve the error result but replace only string
 * inputs. Pi stores calls and results in separate messages, so the input lives
 * in the matching assistant toolCall block.
 */
export interface PurgeErrorsResult {
  messages: AgentMessage[];
  purged: number;
}

const PLACEHOLDER = "[input removed due to failed tool call]";

export function purgeErrors(
  messages: AgentMessage[],
  turns: number,
  protection: ResolvedProtection,
): PurgeErrorsResult {
  let purged = 0;
  const out = cloneMessages(messages);
  const turnThreshold = Math.max(1, turns);
  const recentBoundary = recentTurnsBoundary(out, turnThreshold);

  for (let index = 0; index < out.length; index++) {
    const result = out[index];
    if (result.role !== "toolResult" || !result.isError) continue;
    if (index >= recentBoundary) continue;
    if (matchesAnyPattern(result.toolName, protection.protectedTools)) continue;

    const toolCall = findToolCall(out, result.toolCallId);
    if (!toolCall) continue;

    const path = extractPath(toolCall.arguments);
    if (path && matchesAnyPattern(path, protection.protectedFilePatterns)) continue;

    let changed = false;
    for (const key of Object.keys(toolCall.arguments)) {
      if (typeof toolCall.arguments[key] === "string") {
        toolCall.arguments[key] = PLACEHOLDER;
        changed = true;
      }
    }
    if (changed) purged++;
  }

  return { messages: out, purged };
}

function findToolCall(messages: AgentMessage[], toolCallId: string) {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "toolCall" && block.id === toolCallId) return block;
    }
  }
  return undefined;
}

function extractPath(args: Record<string, unknown>): string | undefined {
  if (typeof args.path === "string") return args.path;
  if (typeof args.filePath === "string") return args.filePath;
  return undefined;
}
