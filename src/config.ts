import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { parse as parseJsonc } from "jsonc-parser";
import type { DcpConfig, LoadedConfig, PartialDcpConfig, TokenThreshold } from "./types.ts";

const GLOBAL_AGENT_DIR = join(homedir(), ".pi", "agent");
const GLOBAL_CONFIG_PATH = join(GLOBAL_AGENT_DIR, "dcp.json");
const PROJECT_CONFIG_DIR = join(CONFIG_DIR_NAME, "dcp.json");

export const DEFAULT_CONFIG: DcpConfig = {
  enabled: true,
  debug: false,
  notification: "detailed",

  pruning: {
    enabled: false,
    maxMessages: null,
    maxUserTurns: null,
    deduplication: {
      enabled: true,
      protectedTools: null,
    },
    purgeErrors: {
      enabled: true,
      turns: 4,
      protectedTools: null,
    },
  },

  triggers: {
    endOfTurn: {
      enabled: true,
      tokenThreshold: 250_000,
      cooldownTurns: 2,
      focus: "Preserve architecture decisions, file changes, and current task. Drop verbose logs and repeated outputs.",
    },
    nudge: {
      enabled: true,
      tokenThreshold: 150_000,
      frequency: 5,
      force: "soft",
    },
  },

  compaction: {
    customSummary: true,
    summaryModel: null,
    maxSummaryTokens: 8_192,
    protectedTools: null,
    protectedFilePatterns: null,
    protectUserMessages: false,
    protectTags: false,
  },

  protectedTools: [
    "task",
    "skill",
    "todowrite",
    "todoread",
    "write",
    "edit",
    "multiedit",
    "apply_patch",
  ],
  protectedFilePatterns: [],

  commands: {
    enabled: true,
  },
};

/**
 * Load config from global + project layers, merge, and validate.
 */
export function loadConfig(cwd: string, isProjectTrusted: boolean): LoadedConfig {
  const warnings: string[] = [];
  const globalPath = existsSync(GLOBAL_CONFIG_PATH) ? GLOBAL_CONFIG_PATH : null;
  const projectPath = isProjectTrusted ? join(cwd, PROJECT_CONFIG_DIR) : null;

  const globalLayer = globalPath ? readLayer(globalPath, warnings) : {};
  const projectLayer = projectPath && existsSync(projectPath) ? readLayer(projectPath, warnings) : {};

  const merged = mergeConfig(DEFAULT_CONFIG, globalLayer, projectLayer);
  const config = normalizeConfig(merged, warnings);

  return { config, warnings, globalPath, projectPath: projectPath && existsSync(projectPath) ? projectPath : null };
}

function readLayer(path: string, warnings: string[]): PartialDcpConfig {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = parseJsonc(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(`Config ${path} is not a JSON object; ignoring.`);
      return {};
    }
    return parsed as PartialDcpConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Failed to read config ${path}: ${message}`);
    return {};
  }
}

/**
 * Merge layers: later layers override earlier ones.
 * Arrays of tool names / patterns are unioned.
 */
export function mergeConfig(
  base: DcpConfig,
  ...layers: PartialDcpConfig[]
): DcpConfig {
  return layers.reduce<DcpConfig>((acc, layer) => mergeOne(acc, layer), base);
}

function mergeOne(base: DcpConfig, override: PartialDcpConfig): DcpConfig {
  const out: DcpConfig = { ...base };

  if (override.enabled !== undefined) out.enabled = override.enabled;
  if (override.debug !== undefined) out.debug = override.debug;
  if (override.notification !== undefined) out.notification = override.notification;

  if (override.pruning) {
    out.pruning = mergePruning(out.pruning, override.pruning);
  }
  if (override.triggers) {
    out.triggers = mergeTriggers(out.triggers, override.triggers);
  }
  if (override.compaction) {
    out.compaction = mergeCompaction(out.compaction, override.compaction);
  }
  if (override.commands) {
    out.commands = { ...out.commands, ...override.commands };
  }

  if (override.protectedTools !== undefined) {
    out.protectedTools = unionArrays(out.protectedTools, override.protectedTools);
  }
  if (override.protectedFilePatterns !== undefined) {
    out.protectedFilePatterns = unionArrays(out.protectedFilePatterns, override.protectedFilePatterns);
  }

  return out;
}

function mergePruning(base: DcpConfig["pruning"], override: PartialDcpConfig["pruning"]): DcpConfig["pruning"] {
  if (!override) return base;
  return {
    ...base,
    ...override,
    deduplication: override.deduplication
      ? { ...base.deduplication, ...override.deduplication }
      : base.deduplication,
    purgeErrors: override.purgeErrors
      ? { ...base.purgeErrors, ...override.purgeErrors }
      : base.purgeErrors,
  };
}

function mergeTriggers(base: DcpConfig["triggers"], override: PartialDcpConfig["triggers"]): DcpConfig["triggers"] {
  if (!override) return base;
  return {
    endOfTurn: override.endOfTurn ? { ...base.endOfTurn, ...override.endOfTurn } : base.endOfTurn,
    nudge: override.nudge ? { ...base.nudge, ...override.nudge } : base.nudge,
  };
}

function mergeCompaction(
  base: DcpConfig["compaction"],
  override: PartialDcpConfig["compaction"],
): DcpConfig["compaction"] {
  if (!override) return base;
  return { ...base, ...override };
}

function unionArrays(base: string[] | undefined, override: string[] | undefined): string[] {
  return [...new Set([...(base ?? []), ...(override ?? [])])];
}

function normalizeConfig(input: PartialDcpConfig, warnings: string[]): DcpConfig {
  // After merge, fill any missing fields from defaults recursively.
  const merged = mergeConfig(DEFAULT_CONFIG, input);

  // Validate enum-ish fields.
  if (merged.notification !== "off" && merged.notification !== "minimal" && merged.notification !== "detailed") {
    warnings.push(`Invalid notification value "${merged.notification}"; using "detailed".`);
    merged.notification = "detailed";
  }
  if (merged.triggers.nudge.force !== "soft" && merged.triggers.nudge.force !== "strong") {
    warnings.push(`Invalid nudge.force value "${merged.triggers.nudge.force}"; using "soft".`);
    merged.triggers.nudge.force = "soft";
  }

  return merged;
}

/**
 * Resolve a token threshold to an absolute number given a context window.
 */
export function resolveThreshold(threshold: TokenThreshold, contextWindow: number): number {
  if (typeof threshold === "number") return threshold;
  const pct = parseFloat(threshold);
  if (Number.isNaN(pct)) return 0;
  return Math.floor((pct / 100) * contextWindow);
}

/**
 * Validate the end-of-turn threshold against Pi's own compaction settings.
 * Returns warnings only; never hard-fails.
 */
export function validateThreshold(
  threshold: TokenThreshold,
  contextWindow: number,
  piSettings: { reserveTokens?: number; keepRecentTokens?: number } | undefined,
  maxSummaryTokens: number,
): string[] {
  const warnings: string[] = [];
  const absolute = resolveThreshold(threshold, contextWindow);
  if (contextWindow <= 0) return warnings;

  const reserve = piSettings?.reserveTokens ?? 16_384;
  const keep = piSettings?.keepRecentTokens ?? 20_000;

  const piTrigger = contextWindow - reserve;
  if (absolute >= piTrigger) {
    warnings.push(
      `endOfTurn.tokenThreshold (${absolute}) is at or above Pi's auto-compaction trigger (${piTrigger}); pi-dcp may never fire first.`,
    );
  }

  const floor = keep + maxSummaryTokens;
  if (absolute <= floor) {
    warnings.push(
      `endOfTurn.tokenThreshold (${absolute}) is at or below the post-compaction floor (~${floor}); this may cause rapid re-compaction.`,
    );
  }

  return warnings;
}
