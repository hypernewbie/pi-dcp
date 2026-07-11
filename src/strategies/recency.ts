import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { cloneMessages, findNthRecentUserMessage } from "../utils.ts";

export interface RecencyResult {
  messages: AgentMessage[];
  droppedByMaxMessages: number;
  droppedByMaxUserTurns: number;
}

export function applyRecencyCaps(
  messages: AgentMessage[],
  maxMessages: number | null,
  maxUserTurns: number | null,
): RecencyResult {
  let droppedByMaxMessages = 0;
  let droppedByMaxUserTurns = 0;
  let out = cloneMessages(messages);

  if (maxUserTurns !== null && maxUserTurns > 0) {
    const boundary = findNthRecentUserMessage(out, maxUserTurns);
    if (boundary > 0) {
      droppedByMaxUserTurns = boundary;
      out = out.slice(boundary);
    }
  }

  if (maxMessages !== null && maxMessages > 0 && out.length > maxMessages) {
    droppedByMaxMessages = out.length - maxMessages;
    out = out.slice(-maxMessages);
  }

  return { messages: out, droppedByMaxMessages, droppedByMaxUserTurns };
}
