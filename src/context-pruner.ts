import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PruningConfig, PruneResult, ResolvedProtection } from "./types.ts";
import { deduplicate } from "./strategies/deduplication.ts";
import { purgeErrors } from "./strategies/purge-errors.ts";
import { applyRecencyCaps } from "./strategies/recency.ts";

const RECENT_USER_TURNS_PROTECTED = 2;

export function pruneContext(
  messages: AgentMessage[],
  config: PruningConfig,
  protection: ResolvedProtection,
): PruneResult {
  let working = messages;
  let deduplicated = 0;
  let errorsPurged = 0;

  if (config.deduplication.enabled) {
    const result = deduplicate(working, protection, RECENT_USER_TURNS_PROTECTED);
    working = result.messages;
    deduplicated = result.deduplicated;
  }

  if (config.purgeErrors.enabled) {
    const result = purgeErrors(working, config.purgeErrors.turns, protection);
    working = result.messages;
    errorsPurged = result.purged;
  }

  const recency = applyRecencyCaps(working, config.maxMessages, config.maxUserTurns);

  return {
    messages: recency.messages,
    stats: {
      deduplicated,
      errorsPurged,
      droppedByMaxMessages: recency.droppedByMaxMessages,
      droppedByMaxUserTurns: recency.droppedByMaxUserTurns,
    },
  };
}
