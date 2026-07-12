import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { minimatch } from "minimatch";

/**
 * Deep-clone an array of AgentMessages so pruning strategies can mutate freely.
 */
export function cloneMessages(messages: AgentMessage[]): AgentMessage[] {
  return JSON.parse(JSON.stringify(messages)) as AgentMessage[];
}

/**
 * Count user messages in an AgentMessage array.
 */
export function countUserMessages(messages: AgentMessage[]): number {
  return messages.filter((m) => m.role === "user").length;
}

/**
 * Find the index of the Nth-most-recent user message, or -1 if fewer exist.
 */
export function findNthRecentUserMessage(messages: AgentMessage[], n: number): number {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      seen++;
      if (seen === n) return i;
    }
  }
  return -1;
}

/**
 * Return the first index that belongs to the protected recent-turn window.
 * If the transcript has fewer than `turns` user turns, protect everything.
 */
export function recentTurnsBoundary(messages: AgentMessage[], turns: number): number {
  if (turns <= 0) return messages.length;
  const userIndices = messages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  if (userIndices.length <= turns) return 0;
  return userIndices[userIndices.length - turns];
}

/**
 * Normalize and stable-stringify tool arguments for deduplication signatures.
 */
export function createToolSignature(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}::${JSON.stringify(sortKeys(stripUndefined(args)))}`;
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out;
  }
  return value;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Glob match a value against a list of patterns. Empty list = no match.
 */
export function matchesAnyPattern(value: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  for (const pattern of patterns) {
    if (matchesPattern(value, pattern)) return true;
  }
  return false;
}

function matchesPattern(value: string, pattern: string): boolean {
  return minimatch(value, pattern, { dot: true, nocase: false });
}

/**
 * Char/4 heuristic for plain text, matching Pi's own `estimateTokens()` text
 * handling. Used for summary text, which is not an AgentMessage.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
