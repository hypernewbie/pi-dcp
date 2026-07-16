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
  /**
   * Pi-only addition, not in upstream OpenCode DCP. ctx.compact() always aborts
   * whatever the agent is currently doing before it compacts (Pi has no safe
   * mid-loop compact-and-continue primitive) - so a dual-threshold trigger fired
   * while a multi-step tool-call run is still in flight will cut it short. When
   * true, pi-dcp detects that case and automatically re-prompts to resume the
   * interrupted task once compaction finishes, instead of leaving the run dead.
   */
  autoContinue: boolean;
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
  /** Max tokens for protected input to the summarizer */
  maxProtectedTokens: number;
  /** Per-message cap for deterministic verbatim user-prompt carry-forward */
  preservedUserMessageTokens: number;
  /** Whether to preserve parent-visible subagent results */
  preserveSubagentResults: boolean;
  /** Show the actual committed summary text in the compaction receipt (OpenCode: showCompression, default off) */
  showCompression: boolean;
}

export interface CommandsConfig {
  enabled: boolean;
}

export interface ContextReliefConfig {
  enabled: boolean;
  triggerPercent: number | null;
  targetHeadroomTokens: number;
  maxChunkInputTokens: number;
  maxChunkSummaryTokens: number;
  exactEvidenceTokens: number;
  preservedUserMessageTokens: number;
  activeWorkingSetTokens: number;
}

export interface VirtualCompressionBlock {
  version: 1;
  id: string;
  startEntryId: string;
  endEntryId: string;
  anchorEntryId: string;
  rangeKind: "historical" | "active-prefix";
  messagesCompressed: number;
  toolsCompressed: number;
  summary: string;
  exactEvidence: string;
  preservedUserMessages: string[];
  estimatedRawTokens: number;
  retainedRawTokens: number;
  estimatedBlockTokens: number;
  active: boolean;
  createdAt: number;
}

export interface DcpBlockEntryData {
  version: 1;
  block: VirtualCompressionBlock;
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

export type CompactionInitiator = "dcp-command" | "dcp-dual-threshold" | "pi-native";

export interface CompactionPreview {
  summarized: number;
  splitPrefix: number;
  kept: number;
  tokensBefore: number;
  /** Original Pi host reason */
  reason: "manual" | "threshold" | "overflow";
  /** Who initiated the compaction */
  initiator: CompactionInitiator;
  /**
   * OpenCode-DCP-faithful compression facts, computed from the actual
   * messages being removed this run. Available for ANY compaction
   * (DCP-triggered or Pi-native), since these are facts about what Pi is
   * about to discard, not about who wrote the resulting summary.
   */
  removedTokensThisRun: number;
  messagesCompressed: number;
  toolsCompressed: number;
  /** Focus/custom instructions passed to this compaction, if any. */
  focus?: string;
  /** True only when the user explicitly supplied focus text (e.g. `/dcp compress <focus>`). */
  focusIsUserSupplied: boolean;
}

export interface LastCompactionInfo {
  initiator: CompactionInitiator;
  /** Display reason: command | dual-threshold | manual | threshold | overflow */
  reason: "command" | "dual-threshold" | "manual" | "threshold" | "overflow";
  hostReason: "manual" | "threshold" | "overflow";
  summaryProvider: "dcp" | "pi";
  tokensBefore: number;
  timestamp: number;
  hadBar: boolean;
  fileRefs?: number;
  protectedBlocks?: number;
  subagentArtifacts?: number;
  // OpenCode-DCP-faithful compression receipt fields.
  removedTokensThisRun?: number;
  summaryTokensThisRun?: number;
  messagesCompressed?: number;
  toolsCompressed?: number;
  splitPrefixMessages?: number;
  /** Only present when fromExtension was true this run (a genuine DCP compression). */
  runNumber?: number;
  cumulativeRemovedTokens?: number;
}

export interface RuntimeState {
  config: DcpConfig;
  loaded: LoadedConfig;
  triggerState: TriggerState;
  protection: ResolvedProtection;
  virtualBlocks: VirtualCompressionBlock[];
  /** Facts about the most recent provider request DCP projected (for /dcp status). */
  lastProjection?: {
    projectedTokens: number;
    contextWindow: number;
    appliedBlocks: number;
    skippedBlocks: number;
    timestamp: number;
  };
  compactionPreview?: CompactionPreview;
  stats?: StatsState;
}

export interface DcpConfig {
  enabled: boolean;
  debug: boolean;
  notification: "off" | "minimal" | "detailed";
  pruning: PruningConfig;
  triggers: TriggersConfig;
  compaction: CompactionConfig;
  contextRelief: ContextReliefConfig;
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
  pendingInitiator: CompactionInitiator | null;
  /** True only when the pending trigger carries an explicit user-supplied focus string. */
  pendingFocusIsExplicit: boolean;
  lastCompaction?: LastCompactionInfo;
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
    deduplicatedIds: string[];
    purgedIds: string[];
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

// ----------------------------------------------------------------------------
// Protected content - bounded collector
// ----------------------------------------------------------------------------

export type ProtectedItemKind = "tool-result" | "user-message" | "subagent-result";

export interface ProtectedItem {
  id: string;
  kind: ProtectedItemKind;
  sourceEntryId?: string;
  toolName?: string;
  path?: string;
  content: string;
  originalCharacters: number;
  includedCharacters: number;
  truncated: boolean;
}

export interface ProtectedCollectionResult {
  items: ProtectedItem[];
  truncatedCount: number;
  skippedCount: number;
  totalOriginalChars: number;
  totalIncludedChars: number;
  fileReferences: string[];
  subagentArtifacts: string[];
}

// ----------------------------------------------------------------------------
// Subagent result normalization
// ----------------------------------------------------------------------------

export type SubagentStatus = "completed" | "failed" | "interrupted" | "running" | "unknown";

export interface NormalizedSubagentResult {
  status: SubagentStatus;
  conclusion?: string;
  outputPath?: string;
  artifactPaths: string[];
  rawSummary?: string;
}

// ----------------------------------------------------------------------------
// Stats
// ----------------------------------------------------------------------------

export interface StatsOperation {
  version: 1;
  operationId: string;
  kind: "compaction" | "deduplication" | "purge-errors";
  timestamp: number;
  source?: "dcp-command" | "dcp-dual-threshold" | "pi-native";
  hostReason?: "manual" | "threshold" | "overflow";
  summaryProvider?: "dcp" | "pi";
  tokensBefore?: number;
  summarizedMessages?: number;
  splitPrefixMessages?: number;
  keptMessages?: number;
  affectedToolCallIds?: string[];
  removedCharacters?: number;
}

export interface StatsState {
  compactions: number;
  dcpInitiated: number;
  piInitiated: number;
  dcpSummaries: number;
  piSummaries: number;
  deduplicated: number;
  errorsPurged: number;
  lastCompactionTimestamp?: number;
  operations: StatsOperation[];
  seenToolCallIds: Set<string>;
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
