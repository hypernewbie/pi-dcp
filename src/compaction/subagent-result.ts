import type { NormalizedSubagentResult, SubagentStatus } from "../types.ts";

interface RawDetails {
  status?: unknown;
  conclusion?: unknown;
  outputPath?: unknown;
  artifactPaths?: unknown;
  output?: unknown;
  artifacts?: unknown;
  // pi-subagents shapes we should tolerate
  summary?: unknown;
  result?: unknown;
  error?: unknown;
}

/**
 * Normalize parent-visible subagent tool result into a small, bounded shape.
 * Only uses already-parent-visible information — never fetches child session history.
 */
export function normalizeSubagentResult(content: string, details: unknown): NormalizedSubagentResult {
  const raw: RawDetails = (details && typeof details === "object" ? details : {}) as RawDetails;

  let status: SubagentStatus = "unknown";
  if (typeof raw.status === "string") {
    const lower = raw.status.toLowerCase();
    if (["completed", "success", "ok"].includes(lower)) status = "completed";
    else if (["failed", "failure", "error"].includes(lower)) status = "failed";
    else if (["interrupted", "cancelled", "canceled"].includes(lower)) status = "interrupted";
    else if (["running", "in_progress", "pending"].includes(lower)) status = "running";
  } else if (content.toLowerCase().includes("failed") || content.toLowerCase().includes("error")) {
    // Heuristic fallback
    status = content.length > 0 ? "unknown" : "unknown";
  } else if (content.length > 0) {
    status = "completed";
  }

  // Try to extract conclusion — bounded.
  let conclusion: string | undefined;
  if (typeof raw.conclusion === "string") conclusion = raw.conclusion;
  else if (typeof raw.summary === "string") conclusion = raw.summary;
  else if (typeof raw.result === "string") conclusion = raw.result;
  else if (typeof raw.output === "string") conclusion = raw.output;
  else if (content.trim().length > 0) conclusion = content;

  // Bound conclusion to avoid huge outputs being treated as "reference".
  if (conclusion && conclusion.length > 4000) {
    conclusion = conclusion.slice(0, 4000) + "\n[... truncated]";
  }

  // Output path
  let outputPath: string | undefined;
  if (typeof raw.outputPath === "string") outputPath = raw.outputPath;
  else if (typeof raw.output === "string" && isPathLike(raw.output) && raw.output.length < 1024) {
    // Some implementations put path in output field
    outputPath = raw.output;
  }

  // Artifact paths
  const artifactPaths: string[] = [];

  function pushPath(p: unknown): void {
    if (typeof p === "string" && p.length > 0 && p.length < 2048) {
      artifactPaths.push(p);
    }
  }

  function pushPaths(arr: unknown): void {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (typeof item === "string") pushPath(item);
      else if (item && typeof item === "object") {
        const obj = item as { path?: unknown; file?: unknown };
        if (typeof obj.path === "string") pushPath(obj.path);
        else if (typeof obj.file === "string") pushPath(obj.file);
      }
    }
  }

  pushPaths(raw.artifactPaths);
  pushPaths(raw.artifacts);

  // Deduplicate artifact paths
  const deduped = [...new Set(artifactPaths)];

  // If we still have no status but have artifacts, consider completed
  if (status === "unknown" && (deduped.length > 0 || outputPath)) {
    status = "completed";
  }

  return {
    status,
    conclusion: conclusion?.trim() ? conclusion.trim() : undefined,
    outputPath,
    artifactPaths: deduped,
    rawSummary: typeof content === "string" && content.length > 0 ? content.slice(0, 2000) : undefined,
  };
}

function isPathLike(s: string): boolean {
  return s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || s.startsWith("~") || /^[a-zA-Z]:[\\/]/.test(s);
}
