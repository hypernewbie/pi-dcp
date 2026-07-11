import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { CompactionConfig, ResolvedProtection } from "../types.ts";
import { matchesAnyPattern } from "../utils.ts";

export function buildProtectedAppendix(messages: AgentMessage[], config: CompactionConfig, protection: ResolvedProtection): string {
  const sections: string[] = [];

  const protectedToolOutputs: string[] = [];
  const protectedUserMessages: string[] = [];
  const protectedTags: string[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "toolCall") {
          const path = extractPath(block.arguments);
          if (
            isProtectedTool(block.name, protection.protectedTools) ||
            (path && matchesAnyPattern(path, protection.protectedFilePatterns))
          ) {
            // The actual output lives in the following toolResult message(s).
            const result = findToolResult(messages, block.id);
            if (result) {
              protectedToolOutputs.push(formatToolResult(block.name, result));
            }
          }
        }
      }
    } else if (msg.role === "user" && config.protectUserMessages) {
      const text = extractText(msg.content);
      if (text) protectedUserMessages.push(text);
    } else if (msg.role === "toolResult") {
      // Already handled via assistant toolCall pairing above.
    }
  }

  if (config.protectTags) {
    const fullText = messages.map((m) => extractMessageText(m)).join("\n\n");
    const tagRe = /<protect>([\s\S]*?)<\/protect>/g;
    let match: RegExpExecArray | null;
    while ((match = tagRe.exec(fullText)) !== null) {
      protectedTags.push(match[1].trim());
    }
  }

  if (protectedToolOutputs.length > 0) {
    sections.push(
      `### Protected Tool Outputs\n\n${protectedToolOutputs.join("\n\n")}`,
    );
  }
  if (protectedUserMessages.length > 0) {
    sections.push(
      `### Protected User Messages\n\n${protectedUserMessages.map((t) => `- ${t}`).join("\n")}`,
    );
  }
  if (protectedTags.length > 0) {
    sections.push(
      `### Protected <protect> Blocks\n\n${protectedTags.map((t) => `- ${t}`).join("\n")}`,
    );
  }

  return sections.join("\n\n");
}

function isProtectedTool(toolName: string, protectedTools: string[]): boolean {
  return matchesAnyPattern(toolName, protectedTools);
}

function extractPath(args: Record<string, unknown>): string | undefined {
  if (args && typeof args === "object") {
    if (typeof args.path === "string") return args.path;
    if (typeof args.filePath === "string") return args.filePath;
  }
  return undefined;
}

function findToolResult(messages: AgentMessage[], toolCallId: string): string | undefined {
  for (const msg of messages) {
    if (msg.role === "toolResult" && msg.toolCallId === toolCallId) {
      return extractText(msg.content);
    }
  }
  return undefined;
}

function formatToolResult(toolName: string, text: string): string {
  return `<protected-tool name="${toolName}">\n${text}\n</protected-tool>`;
}

function extractText(content: string | (TextContent | { type: "image"; data: string; mimeType: string })[], maxLength = 8_000): string {
  if (typeof content === "string") return content;
  const text = content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + `\n\n[... ${text.length - maxLength} more characters]`;
}

function extractMessageText(message: AgentMessage): string {
  if (message.role === "user") {
    return extractText(message.content);
  }
  if (message.role === "assistant") {
    return message.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  if (message.role === "toolResult") {
    return extractText(message.content);
  }
  return "";
}
