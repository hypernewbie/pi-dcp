import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DcpConfig, TriggerState } from "./types.ts";
import { resolveThreshold } from "./utils.ts";

export function buildNudge(
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
  config: DcpConfig,
  state: TriggerState,
): { systemPrompt: string } | undefined {
  if (!config.enabled || !config.triggers.nudge.enabled) return undefined;

  const usage = ctx.getContextUsage();
  if (!usage || usage.tokens === null) return undefined;

  state.turnsSinceLastNudge++;

  const threshold = resolveThreshold(config.triggers.nudge.tokenThreshold, usage.contextWindow);
  if (usage.tokens <= threshold) return undefined;
  if (state.turnsSinceLastNudge < config.triggers.nudge.frequency) return undefined;

  state.turnsSinceLastNudge = 0;

  const hint =
    config.triggers.nudge.force === "strong"
      ? "\n\n[context-efficiency] Context is large. Avoid re-reading files already shown. Be concise. Do not repeat prior outputs verbatim."
      : "\n\n[context-efficiency] Prefer targeted follow-ups over repeating large outputs.";

  return { systemPrompt: event.systemPrompt + hint };
}
