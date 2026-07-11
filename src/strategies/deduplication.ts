import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { cloneMessages, createToolSignature, findNthRecentUserMessage, matchesAnyPattern } from "../utils.ts";
import type { ResolvedProtection } from "../types.ts";

export interface DeduplicationResult {
  messages: AgentMessage[];
  deduplicated: number;
}

const PLACEHOLDER = (toolName: string) =>
  `[Output removed to save context — identical to a later ${toolName} call]`;

export function deduplicate(
  messages: AgentMessage[],
  protection: ResolvedProtection,
  recentUserTurnsProtected: number,
): DeduplicationResult {
  let deduplicated = 0;
  const out = cloneMessages(messages);

  // toolCallId -> result message index
  const resultIndexByToolCallId = new Map<string, number>();
  for (let i = 0; i < out.length; i++) {
    const msg = out[i];
    if (msg.role === "toolResult") {
      resultIndexByToolCallId.set(msg.toolCallId, i);
    }
  }

  const recentBoundary = findNthRecentUserMessage(out, recentUserTurnsProtected);

  // signature -> first toolCallId seen
  const signatureToFirstToolCallId = new Map<string, string>();

  for (let i = 0; i < out.length; i++) {
    const msg = out[i];
    if (msg.role !== "assistant") continue;

    for (const block of msg.content) {
      if (block.type !== "toolCall") continue;

      const path = extractPath(block.arguments);
      if (matchesAnyPattern(block.name, protection.protectedTools)) continue;
      if (path && matchesAnyPattern(path, protection.protectedFilePatterns)) continue;
      if (recentBoundary >= 0 && i >= recentBoundary) continue;

      const signature = createToolSignature(block.name, block.arguments);
      const firstToolCallId = signatureToFirstToolCallId.get(signature);

      if (firstToolCallId) {
        // Duplicate found: replace the earlier tool result with a placeholder.
        const earlierResultIndex = resultIndexByToolCallId.get(firstToolCallId);
        if (earlierResultIndex !== undefined) {
          const earlierResult = out[earlierResultIndex];
          if (earlierResult.role === "toolResult" && (recentBoundary < 0 || earlierResultIndex < recentBoundary)) {
            earlierResult.content = [{ type: "text", text: PLACEHOLDER(block.name) }];
            deduplicated++;
          }
        }
      } else {
        signatureToFirstToolCallId.set(signature, block.id);
      }
    }
  }

  return { messages: out, deduplicated };
}

function extractPath(args: Record<string, unknown>): string | undefined {
  if (args && typeof args === "object") {
    if (typeof args.path === "string") return args.path;
    if (typeof args.filePath === "string") return args.filePath;
  }
  return undefined;
}
