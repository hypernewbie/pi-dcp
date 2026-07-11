import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ============================================================================
// User-facing configuration
// ============================================================================

export type TokenThreshold = number | `${number}%`;

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

export interface PruningConfig {
  enabled: boolean;
  maxMessages: number | null;
  maxUserTurns: number | null;
  deduplication: DeduplicationConfig;
  purgeErrors: PurgeErrorsConfig;
}

export interface EndOfTurnTriggerConfig {
  enabled: boolean;
  tokenThreshold: TokenThreshold;
  cooldownTurns: number;
  focus: string;
}

export interface NudgeConfig {
  enabled: boolean;
  tokenThreshold: TokenThreshold;
  frequency: number;
  force: "soft" | "strong";
}

export interface TriggersConfig {
  endOfTurn: EndOfTurnTriggerConfig;
  nudge: NudgeConfig;
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

export interface LoadedConfig {
  config: DcpConfig;
  warnings: string[];
  globalPath: string | null;
  projectPath: string | null;
}

export interface RuntimeState {
  config: DcpConfig;
  loaded: LoadedConfig;
  triggerState: TriggerState;
  protection: ResolvedProtection;
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
  turnsSinceLastNudge: number;
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
    droppedByMaxMessages: number;
    droppedByMaxUserTurns: number;
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
