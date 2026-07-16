import { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * Pi's footer/status percentage reads AgentSession.getContextUsage(), which is
 * derived from raw session usage. DCP shrinks the outgoing request through the
 * context hook, so the raw number over-reports what the provider actually
 * receives (e.g. "99%" while the projected request is a fraction of that).
 *
 * There is no extension API to correct that display, so this patches the live
 * AgentSession prototype - the loader hands extensions Pi's running module
 * instance in both Node and compiled binaries. The patch is presentation-only:
 * Pi's native compaction decisions never read getContextUsage() (verified in
 * agent-session.js _checkCompaction), it fails open, and it only overrides
 * when DCP genuinely applied summaries to the most recent request.
 */

export interface ProjectedUsage {
  projectedTokens: number;
  contextWindow: number;
  appliedBlocks: number;
  timestamp: number;
}

export interface VirtualUsageRef {
  current?: ProjectedUsage;
}

interface ContextUsageLike {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

let installed = false;

export function wrapGetContextUsage(
  original: (this: unknown) => ContextUsageLike | undefined,
  ref: VirtualUsageRef,
): (this: unknown) => ContextUsageLike | undefined {
  return function (this: unknown): ContextUsageLike | undefined {
    const usage = original.call(this);
    try {
      const projection = ref.current;
      if (!usage || !projection || projection.appliedBlocks <= 0) return usage;
      if (typeof usage.contextWindow !== "number" || usage.contextWindow <= 0) return usage;
      // The projected estimate can never legitimately exceed the raw figure.
      const tokens = usage.tokens !== null
        ? Math.min(projection.projectedTokens, usage.tokens)
        : projection.projectedTokens;
      return {
        tokens,
        contextWindow: usage.contextWindow,
        percent: (tokens / usage.contextWindow) * 100,
      };
    } catch {
      return usage;
    }
  };
}

export function installVirtualContextUsage(ref: VirtualUsageRef): boolean {
  if (installed) return true;
  try {
    const prototype = (AgentSession as unknown as { prototype?: Record<string, unknown> })?.prototype;
    if (!prototype || typeof prototype.getContextUsage !== "function") return false;
    const original = prototype.getContextUsage as (this: unknown) => ContextUsageLike | undefined;
    prototype.getContextUsage = wrapGetContextUsage(original, ref);
    installed = true;
    return true;
  } catch {
    return false;
  }
}
