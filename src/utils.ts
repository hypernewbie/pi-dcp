import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { minimatch } from "minimatch";
import type { TokenThreshold } from "./types.ts";

/**
 * Deep-clone an array of AgentMessages so pruning strategies can mutate freely.
 */
export function cloneMessages(messages: AgentMessage[]): AgentMessage[] {
  return JSON.parse(JSON.stringify(messages)) as AgentMessage[];
}

/**
 * Resolve a token threshold to an absolute number given a context window.
 */
export function resolveThreshold(threshold: TokenThreshold, contextWindow: number): number {
  if (typeof threshold === "number") return threshold;
  const pct = parseFloat(threshold);
  if (Number.isNaN(pct)) return 0;
  return Math.floor((pct / 100) * contextWindow);
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
