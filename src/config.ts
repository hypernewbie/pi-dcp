import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import type { DcpConfig, LoadedConfig, PartialDcpConfig, PiCompactionSettings } from "./types.ts";

const GLOBAL_AGENT_DIR = join(homedir(), ".pi", "agent");
const GLOBAL_CONFIG_PATH = join(GLOBAL_AGENT_DIR, "dcp.json");
const PROJECT_CONFIG_DIR = join(CONFIG_DIR_NAME, "dcp.json");

const TOP_LEVEL_KEYS = new Set([
  "$schema",
  "enabled",
  "debug",
  "notification",
  "pruning",
  "triggers",
  "compaction",
  "protectedTools",
  "protectedFilePatterns",
  "commands",
]);

export const DEFAULT_CONFIG: DcpConfig = {
  enabled: true,
  debug: false,
  notification: "detailed",

  pruning: {
    enabled: false,
    turnProtection: {
      enabled: false,
      turns: 4,
    },
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
      tokenThresholdPercent: 73,
      tokenThresholdAbsolute: 450_000,
      cooldownTurns: 2,
      focus: "Preserve architecture decisions, file changes, and current task. Drop verbose logs and repeated outputs.",
    },
  },

  compaction: {
    customSummary: true,
    summaryModel: null,
    maxSummaryTokens: 8_192,
    protectedTools: null,
    protectedFilePatterns: null,
    protectUserMessages: false,
    maxProtectedTokens: 24_000,
    preserveSubagentResults: true,
  },

  // Pi-native equivalents of DCP's protected write/edit tools.
  // Add project-specific tools explicitly in dcp.json.
  protectedTools: ["write", "edit"],
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
    const parseErrors: ParseError[] = [];
    const parsed = parseJsonc(raw, parseErrors) as unknown;
    if (parseErrors.length > 0) {
      warnings.push(`Config ${path} contains ${parseErrors.length} JSONC parse error(s); invalid values may be ignored.`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(`Config ${path} is not a JSON object; ignoring.`);
      return {};
    }
    warnUnknownKeys(parsed as Record<string, unknown>, TOP_LEVEL_KEYS, path, warnings);
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
    turnProtection: override.turnProtection
      ? { ...base.turnProtection, ...override.turnProtection }
      : base.turnProtection,
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

  merged.triggers.endOfTurn.tokenThresholdPercent = normalizePercent(
    merged.triggers.endOfTurn.tokenThresholdPercent,
    DEFAULT_CONFIG.triggers.endOfTurn.tokenThresholdPercent,
    "triggers.endOfTurn.tokenThresholdPercent",
    warnings,
  );
  merged.triggers.endOfTurn.tokenThresholdAbsolute = normalizeNullableInteger(
    merged.triggers.endOfTurn.tokenThresholdAbsolute,
    DEFAULT_CONFIG.triggers.endOfTurn.tokenThresholdAbsolute,
    "triggers.endOfTurn.tokenThresholdAbsolute",
    warnings,
  );
  merged.triggers.endOfTurn.cooldownTurns = normalizeInteger(
    merged.triggers.endOfTurn.cooldownTurns,
    DEFAULT_CONFIG.triggers.endOfTurn.cooldownTurns,
    "triggers.endOfTurn.cooldownTurns",
    warnings,
  );
  merged.compaction.maxSummaryTokens = normalizeInteger(
    merged.compaction.maxSummaryTokens,
    DEFAULT_CONFIG.compaction.maxSummaryTokens,
    "compaction.maxSummaryTokens",
    warnings,
  );
  merged.compaction.maxProtectedTokens = normalizeInteger(
    merged.compaction.maxProtectedTokens,
    DEFAULT_CONFIG.compaction.maxProtectedTokens,
    "compaction.maxProtectedTokens",
    warnings,
  );
  if (typeof merged.compaction.preserveSubagentResults !== "boolean") {
    warnings.push(
      `Invalid compaction.preserveSubagentResults; using ${String(
        DEFAULT_CONFIG.compaction.preserveSubagentResults,
      )}.`,
    );
    merged.compaction.preserveSubagentResults = DEFAULT_CONFIG.compaction.preserveSubagentResults;
  }
  merged.pruning.turnProtection.turns = normalizeInteger(
    merged.pruning.turnProtection.turns,
    DEFAULT_CONFIG.pruning.turnProtection.turns,
    "pruning.turnProtection.turns",
    warnings,
  );
  merged.pruning.purgeErrors.turns = normalizeInteger(
    merged.pruning.purgeErrors.turns,
    DEFAULT_CONFIG.pruning.purgeErrors.turns,
    "pruning.purgeErrors.turns",
    warnings,
  );

  return merged;
}

function normalizePercent(value: unknown, fallback: number | null, path: string, warnings: string[]): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100) return value;
  warnings.push(`Invalid ${path}; using ${fallback === null ? "null" : String(fallback)}.`);
  return fallback;
}

function normalizeNullableInteger(value: unknown, fallback: number | null, path: string, warnings: string[]): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  warnings.push(`Invalid ${path}; using ${fallback === null ? "null" : String(fallback)}.`);
  return fallback;
}

function normalizeInteger(value: unknown, fallback: number, path: string, warnings: string[]): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  warnings.push(`Invalid ${path}; using ${fallback}.`);
  return fallback;
}

function warnUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, path: string, warnings: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) warnings.push(`Unknown config key ${path}.${key}; ignored by pi-dcp.`);
  }
}

/** Read Pi's own compaction settings for threshold diagnostics. */
export function loadPiCompactionSettings(cwd: string, isProjectTrusted: boolean): PiCompactionSettings {
  const global = readSettingsFile(join(GLOBAL_AGENT_DIR, "settings.json"));
  const project = isProjectTrusted ? readSettingsFile(join(cwd, CONFIG_DIR_NAME, "settings.json")) : {};
  return {
    reserveTokens: typeof project.reserveTokens === "number" ? project.reserveTokens : global.reserveTokens,
    keepRecentTokens: typeof project.keepRecentTokens === "number" ? project.keepRecentTokens : global.keepRecentTokens,
  };
}

function readSettingsFile(path: string): PiCompactionSettings {
  if (!existsSync(path)) return {};
  try {
    const parsed = parseJsonc(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const compaction = (parsed as { compaction?: unknown }).compaction;
    if (!compaction || typeof compaction !== "object" || Array.isArray(compaction)) return {};
    return compaction as PiCompactionSettings;
  } catch {
    return {};
  }
}

/**
 * Validate the end-of-turn thresholds against Pi's own compaction settings.
 * Returns warnings only; never hard-fails.
 */
export function validateThreshold(
  percent: number | null,
  absolute: number | null,
  contextWindow: number,
  piSettings: PiCompactionSettings | undefined,
  maxSummaryTokens: number,
): string[] {
  const warnings: string[] = [];
  if (contextWindow <= 0) return warnings;

  const effective = resolveEffectiveThreshold(percent, absolute, contextWindow);
  if (effective === null) {
    warnings.push("Both thresholds are null; pi-dcp will not auto-compact (Pi's built-in compaction handles capacity).");
    return warnings;
  }

  const reserve = piSettings?.reserveTokens ?? 16_384;
  const keep = piSettings?.keepRecentTokens ?? 20_000;
  const piTrigger = contextWindow - reserve;

  if (effective >= piTrigger) {
    warnings.push(
      `Effective threshold (${effective.toLocaleString()}) is at or above Pi's auto-compaction trigger (${piTrigger.toLocaleString()}); pi-dcp may never fire first.`,
    );
  }

  const floor = keep + maxSummaryTokens;
  if (effective <= floor) {
    warnings.push(
      `Effective threshold (${effective.toLocaleString()}) is at or below the post-compaction floor (~${floor.toLocaleString()}); this may cause rapid re-compaction.`,
    );
  }

  return warnings;
}

/** Resolve the dual threshold to an absolute number, or null if both disabled. */
export function resolveEffectiveThreshold(
  percent: number | null,
  absolute: number | null,
  contextWindow: number,
): number | null {
  const fromPercent = percent !== null ? Math.floor((percent / 100) * contextWindow) : null;
  const candidates = [fromPercent, absolute].filter((v): v is number => v !== null);
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}
