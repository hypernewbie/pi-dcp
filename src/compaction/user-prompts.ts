import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";

const SECTION_HEADER = "## User messages (verbatim, preserved by DCP)";
const START_MARKER = "--- preserved user message ---";
const END_MARKER = "--- end preserved user message ---";
const DEFAULT_MAX_CHARS = 8_000;

/**
 * Return real user text only. Synthetic prompts and DCP command echoes are
 * control messages, not user instructions that must be carried forward.
 */
export function collectRealUserMessages(messages: AgentMessage[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = extractFullText(message.content);
    if (!text.trim() || isSyntheticUserMessage(text) || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }

  return result;
}

/**
 * Compose the deterministic prompt appendix. The summarizer's output is never
 * trusted to preserve this material.
 */
export function appendPreservedUserMessages(
  summary: string,
  messages: AgentMessage[],
  previousSummary: string | undefined,
  maxTokens: number,
): string {
  const preserved = extractPreservedUserMessages(previousSummary ?? "");
  for (const text of collectRealUserMessages(messages)) {
    if (!preserved.includes(text)) preserved.push(text);
  }
  if (preserved.length === 0) return summary;

  const maxChars = Math.max(1_000, Math.floor(maxTokens * 4));
  const formatted = preserved.map((text) => {
    const bounded = boundUserMessage(text, maxChars);
    return `${START_MARKER}\n${bounded}\n${END_MARKER}`;
  });

  return `${summary.trim()}\n\n${SECTION_HEADER}\n\n${formatted.join("\n\n")}`;
}

export function extractPreservedUserMessages(summary: string): string[] {
  const result: string[] = [];
  let cursor = 0;
  while (cursor < summary.length) {
    const start = summary.indexOf(START_MARKER, cursor);
    if (start < 0) break;
    const contentStart = start + START_MARKER.length;
    const end = summary.indexOf(END_MARKER, contentStart);
    if (end < 0) break;
    const text = summary.slice(contentStart, end).replace(/^\n|\n$/g, "");
    if (text && !result.includes(text)) result.push(text);
    cursor = end + END_MARKER.length;
  }
  return result;
}

function isSyntheticUserMessage(text: string): boolean {
  const normalized = text.trim();
  return normalized === "Resuming from context compression, continue current task"
    || normalized === "Continue task"
    || normalized.startsWith("/dcp ")
    || normalized === "/dcp"
    || normalized.startsWith("[Context summary of completed work]")
    || normalized.startsWith("[Compaction summary]")
    || normalized.startsWith("[Branch summary]");
}

function boundUserMessage(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.ceil(maxChars * 0.7);
  const tail = Math.max(1, maxChars - head);
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[... ${omitted} characters elided ...]\n\n${text.slice(-tail)}`;
}

function extractFullText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is TextContent => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text")
    .map((part) => part.text)
    .join("\n");
}
