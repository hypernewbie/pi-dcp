import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type {
  CompactionConfig,
  ResolvedProtection,
  ProtectedItem,
  ProtectedCollectionResult,
} from "../types.ts";
import { matchesAnyPattern } from "../utils.ts";
import { normalizeSubagentResult } from "./subagent-result.ts";

const MAX_SINGLE_ITEM_CHARS = 8000;

export function buildProtectedAppendix(
  messages: AgentMessage[],
  config: CompactionConfig,
  protection: ResolvedProtection,
): { text: string; collection: ProtectedCollectionResult } {
  const collection = collectProtectedItems(messages, config, protection);
  const budgeted = applyBudget(collection, config.maxProtectedTokens);

  const sections: string[] = [];

  if (budgeted.fileReferences.length > 0) {
    sections.push(`### Relevant Files\n\n${budgeted.fileReferences.map((f) => `- ${f}`).join("\n")}`);
  }

  if (budgeted.subagentArtifacts.length > 0) {
    sections.push(`### Artifacts\n\n${budgeted.subagentArtifacts.map((a) => `- ${a}`).join("\n")}`);
  }

  const toolResults = budgeted.items.filter((i) => i.kind === "tool-result");
  const userMessages = budgeted.items.filter((i) => i.kind === "user-message");
  const subagentResults = budgeted.items.filter((i) => i.kind === "subagent-result");

  if (toolResults.length > 0) {
    sections.push(
      `### Protected Tool Outputs\n\n${toolResults.map((it) => formatProtectedItem(it)).join("\n\n")}`,
    );
  }

  if (userMessages.length > 0) {
    sections.push(
      `### Protected User Messages\n\n${userMessages.map((it) => `- ${escapeInline(it.content)}`).join("\n")}`,
    );
  }

  if (subagentResults.length > 0) {
    sections.push(
      `### Protected Subagent Results\n\n${subagentResults.map((it) => formatProtectedItem(it)).join("\n\n")}`,
    );
  }

  const text = sections.join("\n\n");

  return {
    text,
    collection: budgeted,
  };
}

export function collectProtectedItems(
  messages: AgentMessage[],
  config: CompactionConfig,
  protection: ResolvedProtection,
): ProtectedCollectionResult {
  // Indexed map: toolCallId -> { toolCall block, result message }
  const toolCallById = new Map<
    string,
    { name: string; args: Record<string, unknown>; messageIndex: number }
  >();
  const toolResultById = new Map<string, { message: AgentMessage; index: number }>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "toolCall") {
          toolCallById.set(block.id, {
            name: block.name,
            args: (block.arguments as Record<string, unknown>) ?? {},
            messageIndex: i,
          });
        }
      }
    } else if (msg.role === "toolResult") {
      toolResultById.set(msg.toolCallId, { message: msg, index: i });
    }
  }

  const candidates: ProtectedItem[] = [];
  const fileRefs = new Set<string>();
  const subagentArtifacts = new Set<string>();
  const seenIds = new Set<string>();

  // Priority 1: protected user messages
  if (config.protectUserMessages) {
    for (const msg of messages) {
      if (msg.role !== "user") continue;
      const txt = extractText(msg.content);
      if (!txt.trim()) continue;
      const id = `user-${hashString(txt.slice(0, 256))}-${txt.length}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      candidates.push({
        id,
        kind: "user-message",
        content: txt,
        originalCharacters: txt.length,
        includedCharacters: txt.length,
        truncated: false,
      });
    }
  }

  // Priority 2 & 3 & 4: tool calls
  // We preserve deterministic order by scanning assistant messages in order.
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type !== "toolCall") continue;
      const toolCallId = block.id;
      const toolName = block.name;
      const args = (block.arguments as Record<string, unknown>) ?? {};
      const path = extractPath(args);
      if (path) fileRefs.add(path);

      const resultEntry = toolResultById.get(toolCallId);
      if (!resultEntry) continue;
      const resultMsg = resultEntry.message as { content: unknown; details?: unknown; toolName?: string };
      const resultText = extractText(resultMsg.content as string | (TextContent | { type: "image"; data: string; mimeType: string })[]);
      const details = (resultMsg as any).details;

      // Subagent handling
      if (toolName === "subagent") {
        if (!config.preserveSubagentResults) continue;
        // Build normalized result
        const normalized = normalizeSubagentResult(resultText, details);
        const dedupKey = `subagent-${toolCallId}`;
        if (seenIds.has(dedupKey)) continue;
        seenIds.add(dedupKey);

        if (normalized.outputPath) subagentArtifacts.add(normalized.outputPath);
        for (const art of normalized.artifactPaths) subagentArtifacts.add(art);

        const contentParts: string[] = [];
        contentParts.push(`Subagent: ${toolName}`);
        contentParts.push(`Status: ${normalized.status}`);
        if (normalized.conclusion) contentParts.push(`Conclusion:\n${normalized.conclusion}`);
        if (normalized.outputPath) contentParts.push(`Output: ${normalized.outputPath}`);
        if (normalized.artifactPaths.length > 0) {
          contentParts.push(`Artifacts:\n${normalized.artifactPaths.map((p) => `- ${p}`).join("\n")}`);
        }

        const content = contentParts.join("\n\n");
        candidates.push({
          id: dedupKey,
          kind: "subagent-result",
          toolName,
          content,
          originalCharacters: content.length,
          includedCharacters: content.length,
          truncated: false,
        });
        continue;
      }

      const isWriteEdit = toolName === "write" || toolName === "edit";
      const isProtectedTool = isProtectedToolName(toolName, protection.protectedTools);
      const isProtectedPath = path ? matchesAnyPattern(path, protection.protectedFilePatterns) : false;
      const isProtectedByConfigTools = config.protectedTools
        ? matchesAnyPattern(toolName, config.protectedTools)
        : false;
      const isProtectedByConfigFiles = path && config.protectedFilePatterns
        ? matchesAnyPattern(path, config.protectedFilePatterns)
        : false;

      const protectedByAny =
        isWriteEdit ||
        isProtectedTool ||
        isProtectedPath ||
        isProtectedByConfigTools ||
        isProtectedByConfigFiles;

      if (!protectedByAny) continue;

      const dedupKey = `tool-${toolCallId}`;
      if (seenIds.has(dedupKey)) continue;
      seenIds.add(dedupKey);

      if (!resultText.trim()) continue;

      candidates.push({
        id: dedupKey,
        kind: "tool-result",
        toolName,
        path,
        content: resultText,
        originalCharacters: resultText.length,
        includedCharacters: resultText.length,
        truncated: false,
      });
    }
  }

  // Sort by priority then by appearance (stable, already in order, but enforce)
  // Our candidates already in priority order: user messages first, then tool calls in scan order.
  // However we want write/edit evidence before other protected tools.
  // Let's reorder: assign priority score.
  const scored = candidates.map((item, idx) => {
    let priority = 10;
    if (item.kind === "user-message") priority = 1;
    else if (item.kind === "tool-result") {
      if (item.toolName === "write" || item.toolName === "edit" || item.path) priority = 2;
      else priority = 4;
    } else if (item.kind === "subagent-result") priority = 3;
    return { item, priority, idx };
  });

  scored.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.idx - b.idx;
  });

  const sortedItems = scored.map((s) => s.item);
  const totalOriginal = sortedItems.reduce((sum, it) => sum + it.originalCharacters, 0);

  return {
    items: sortedItems,
    truncatedCount: 0,
    skippedCount: 0,
    totalOriginalChars: totalOriginal,
    totalIncludedChars: totalOriginal,
    fileReferences: [...fileRefs].sort(),
    subagentArtifacts: [...subagentArtifacts].sort(),
  };
}

function applyBudget(collection: ProtectedCollectionResult, maxTokens: number): ProtectedCollectionResult {
  const maxChars = Math.max(1000, maxTokens * 4); // rough 1 token ~4 chars
  let includedChars = 0;
  const included: ProtectedItem[] = [];
  let truncatedCount = 0;
  let skippedCount = 0;

  for (const item of collection.items) {
    const remaining = maxChars - includedChars;
    if (remaining <= 0) {
      skippedCount++;
      continue;
    }

    let content = item.content;
    let includedLen = content.length;
    let truncated = false;

    // Per-item cap
    if (content.length > MAX_SINGLE_ITEM_CHARS) {
      content = content.slice(0, MAX_SINGLE_ITEM_CHARS) + `\n\n[... truncated: ${content.length - MAX_SINGLE_ITEM_CHARS} more characters]`;
      includedLen = content.length;
      truncated = true;
      truncatedCount++;
    }

    // Global budget check with potential secondary truncation
    if (includedLen > remaining) {
      if (item.kind === "user-message") {
        // User messages: keep as much as possible but mark truncated
        const allowed = Math.max(200, remaining - 100);
        if (allowed < 200) {
          skippedCount++;
          continue;
        }
        content = content.slice(0, allowed) + `\n\n[... truncated to fit protected budget: ${item.originalCharacters - allowed} chars omitted]`;
        includedLen = content.length;
        truncated = true;
        truncatedCount++;
      } else {
        // For other items, try to truncate to remaining budget
        if (remaining < 500) {
          skippedCount++;
          continue;
        }
        const allowed = remaining - 100;
        content = content.slice(0, allowed) + `\n\n[... truncated to fit protected budget: ${item.originalCharacters - allowed} chars omitted]`;
        includedLen = content.length;
        truncated = true;
        truncatedCount++;
      }
    }

    included.push({
      ...item,
      content,
      includedCharacters: includedLen,
      truncated,
    });
    includedChars += includedLen;
  }

  return {
    items: included,
    truncatedCount,
    skippedCount,
    totalOriginalChars: collection.totalOriginalChars,
    totalIncludedChars: includedChars,
    fileReferences: collection.fileReferences,
    subagentArtifacts: collection.subagentArtifacts,
  };
}

function isProtectedToolName(toolName: string, protectedTools: string[]): boolean {
  return matchesAnyPattern(toolName, protectedTools);
}

function extractPath(args: Record<string, unknown>): string | undefined {
  if (args && typeof args === "object") {
    if (typeof args.path === "string") return args.path;
    if (typeof args.filePath === "string") return args.filePath;
  }
  return undefined;
}

function formatProtectedItem(item: ProtectedItem): string {
  const headerParts: string[] = [];
  headerParts.push(`Tool: ${item.toolName ?? item.kind}`);
  if (item.path) headerParts.push(`path: ${item.path}`);
  const header = headerParts.join(" ");
  const truncNote = item.truncated ? ` [truncated ${item.originalCharacters}→${item.includedCharacters}]` : "";
  return `<protected ${header}${truncNote}>\n${item.content}\n</protected>`;
}

function escapeInline(s: string): string {
  return s.replace(/\n/g, " ").slice(0, 500);
}

function extractText(
  content: string | (TextContent | { type: "image"; data: string; mimeType: string })[],
  maxLength = 8000,
): string {
  if (typeof content === "string") return content;
  const text = content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + `\n\n[... ${text.length - maxLength} more characters]`;
}

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}
