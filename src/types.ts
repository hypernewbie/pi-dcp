import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ============================================================================
// User-facing configuration
// ============================================================================


export interface DeduplicationConfig {
  enabled: boolean;
  /** null means inherit global protectedTools */
  protectedTools: string[] | null;
}

export interface PurgeErrorsConfig {
  enabled: boolean;
  turns: number;
  /** null means inherit global protectedTools */
  protectedTools: string[] | null;
}

export interface TurnProtectionConfig {
  enabled: boolean;
  turns: number;
}

export interface PruningConfig {
  enabled: boolean;
  turnProtection: TurnProtectionConfig;
  deduplication: DeduplicationConfig;
  purgeErrors: PurgeErrorsConfig;
}

export interface EndOfTurnTriggerConfig {
  enabled: boolean;
  /** Percent of the context window, 0-100. null = ignore. */
  tokenThresholdPercent: number | null;
  /** Absolute token cap. null = ignore. */
  tokenThresholdAbsolute: number | null;
  cooldownTurns: number;
  focus: string;
}

export interface TriggersConfig {
  endOfTurn: EndOfTurnTriggerConfig;
}

export interface CompactionConfig {
  customSummary: boolean;
  summaryModel: string | null;
  maxSummaryTokens: number;
  /** null means inherit global protectedTools */
  protectedTools: string[] | null;
  /** null means inherit global protectedFilePatterns */
  protectedFilePatterns: string[] | null;
  protectUserMessages: boolean;
  protectTags: boolean;
}

export interface CommandsConfig {
  enabled: boolean;
}

export interface PiCompactionSettings {
  reserveTokens?: number;
  keepRecentTokens?: number;
}

export interface LoadedConfig {
  config: DcpConfig;
  warnings: string[];
  globalPath: string | null;
  projectPath: string | null;
}

export interface CompactionPreview {
  summarized: number;
  splitPrefix: number;
  kept: number;
  tokensBefore: number;
  reason: "manual" | "threshold" | "overflow";
}

export interface RuntimeState {
  config: DcpConfig;
  loaded: LoadedConfig;
  triggerState: TriggerState;
  protection: ResolvedProtection;
  compactionPreview?: CompactionPreview;
}

export interface DcpConfig {
  enabled: boolean;
  debug: boolean;
  notification: "off" | "minimal" | "detailed";
  pruning: PruningConfig;
  triggers: TriggersConfig;
  compaction: CompactionConfig;
  protectedTools: string[];
  protectedFilePatterns: string[];
  commands: CommandsConfig;
}

export type PartialDcpConfig = DeepPartial<DcpConfig>;

// ============================================================================
// Internal state
// ============================================================================

export interface TriggerState {
  isCompacting: boolean;
  turnsSinceCompaction: number;
  tokensAtLastCompaction: number | null;
}

export interface ResolvedProtection {
  protectedTools: string[];
  protectedFilePatterns: string[];
}

// ============================================================================
// Strategy / pruning internals
// ============================================================================

export interface PruneContext {
  messages: AgentMessage[];
  config: PruningConfig;
  protection: ResolvedProtection;
}

export interface PruneResult {
  messages: AgentMessage[];
  stats: {
    deduplicated: number;
    errorsPurged: number;
  };
}

// ============================================================================
// Compaction internals
// ============================================================================

export interface SummaryPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export interface FileOperations {
  read: Set<string>;
  modified: Set<string>;
}

// ============================================================================
// Utility types
// ============================================================================

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? U[] | undefined
    : T[P] extends object
      ? DeepPartial<T[P]>
      : T[P] | undefined;
};
