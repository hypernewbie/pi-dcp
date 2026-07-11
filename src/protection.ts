import type { CompactionConfig, DeduplicationConfig, PruningConfig, PurgeErrorsConfig, ResolvedProtection } from "./types.ts";

export function resolveProtection(
  pruning: PruningConfig,
  compaction: CompactionConfig,
  globalProtectedTools: string[],
  globalProtectedFilePatterns: string[],
): ResolvedProtection {
  const dedupTools = resolveToolList(pruning.deduplication.protectedTools, globalProtectedTools);
  const purgeTools = resolveToolList(pruning.purgeErrors.protectedTools, globalProtectedTools);
  const compactionTools = resolveToolList(compaction.protectedTools, globalProtectedTools);
  const compactionPatterns = resolvePatternList(compaction.protectedFilePatterns, globalProtectedFilePatterns);

  return {
    protectedTools: [...new Set([...dedupTools, ...purgeTools, ...compactionTools])],
    protectedFilePatterns: compactionPatterns,
  };
}

function resolveToolList(local: string[] | null, globalList: string[]): string[] {
  return local === null ? globalList : local;
}

function resolvePatternList(local: string[] | null, globalList: string[]): string[] {
  return local === null ? globalList : local;
}
