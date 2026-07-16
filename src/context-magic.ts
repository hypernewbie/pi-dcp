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
 *
 * ============================================================================
 * MAINTENANCE CONTRACT - this is an UNSUPPORTED monkey-patch of Pi internals.
 * Re-verify these assumptions whenever Pi ships a notable update:
 *
 * 1. `AgentSession` is still exported from `@earendil-works/pi-coding-agent`
 *    (dist/index.js) AND the extension loader still aliases that package to
 *    Pi's own running instance (dist/core/extensions/loader.js: `getAliases()`
 *    for Node installs, `VIRTUAL_MODULES` for the compiled Bun binary). If the
 *    loader ever gives extensions a *separate copy*, this patch applies to the
 *    copy and silently does nothing.
 * 2. `AgentSession.prototype.getContextUsage()` still exists with the shape
 *    `{ tokens: number|null, contextWindow: number, percent: number|null }`
 *    (dist/core/agent-session.js).
 * 3. Pi's compaction/overflow decisions still do NOT call getContextUsage().
 *    Check `_checkCompaction()` in agent-session.js: it must read assistant
 *    `usage` / `estimateContextTokens(agent.state.messages)` directly. If a
 *    future Pi starts making SAFETY decisions from getContextUsage(), this
 *    patch must be REMOVED or gated to display-only call sites immediately.
 *
 * HOW BREAKAGE MANIFESTS: install() returns false (assumption 2 fails), or
 * returns true but the footer shows raw numbers again (assumption 1 fails -
 * patched a dead copy). Either way behavior degrades to stock Pi; nothing
 * crashes. `/dcp status` surfaces which state we're in via
 * `isVirtualContextUsageInstalled()` - if a user reports the footer
 * over-reporting again, check that line first.
 *
 * HOW TO FIX WHEN IT BREAKS: re-run the verification greps against the
 * installed Pi (`rg -n "getContextUsage" dist/core/agent-session.js`,
 * `rg -n "getAliases|VIRTUAL_MODULES" dist/core/extensions/loader.js`), adapt
 * the property name/shape below, or - if Pi ever exposes an official context
 * display override - delete this file and use that instead. Prefer the
 * official API the moment one exists.
 * ============================================================================
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

/** True when the live prototype patch took effect (see maintenance contract above). */
export function isVirtualContextUsageInstalled(): boolean {
  return installed;
}

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
