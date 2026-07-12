import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PruningConfig, PruneResult, ResolvedProtection } from "./types.ts";
import { deduplicate } from "./strategies/deduplication.ts";
import { purgeErrors } from "./strategies/purge-errors.ts";

export function pruneContext(
  messages: AgentMessage[],
  config: PruningConfig,
  protection: ResolvedProtection,
): PruneResult {
  let working = messages;
  let deduplicated = 0;
  let errorsPurged = 0;

  let deduplicatedIds: string[] = [];
  let purgedIds: string[] = [];

  if (config.deduplication.enabled) {
    const recentTurns = config.turnProtection.enabled ? config.turnProtection.turns : 0;
    const result = deduplicate(working, protection, recentTurns);
    working = result.messages;
    deduplicated = result.deduplicated;
    deduplicatedIds = result.dedupedIds;
  }

  if (config.purgeErrors.enabled) {
    const result = purgeErrors(working, config.purgeErrors.turns, protection);
    working = result.messages;
    errorsPurged = result.purged;
    purgedIds = result.purgedIds;
  }

  return {
    messages: working,
    stats: {
      deduplicated,
      errorsPurged,
      deduplicatedIds,
      purgedIds,
    },
  };
}
