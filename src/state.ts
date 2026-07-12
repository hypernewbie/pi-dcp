import type { TriggerState } from "./types.ts";

export function createTriggerState(): TriggerState {
  return {
    isCompacting: false,
    turnsSinceCompaction: 0,
    tokensAtLastCompaction: null,
    pendingInitiator: null,
  };
}
