# Changelog

## 0.3.0

- **Truthful compaction notifications**: compaction bar now shows provenance — `DCP COMPRESS · command/dual-threshold · DCP summary` vs `PI COMPACT · manual/threshold/overflow · Pi default summary`. Supports `off`/`minimal`/`detailed` modes and fallback when preview is unavailable.
- **Last compaction tracking**: `/dcp status` reports initiator, reason, summary provider, tokens-before, and carried-forward counts.
- **Honest stats**: new `/dcp stats` command with persistent, branch-local `pi-dcp.stats.v1` custom entries. Counts compactions (DCP vs Pi initiated), DCP vs Pi summaries, deduplicated outputs, and purged errors. Idempotent via seen tool-call IDs.
- **Bounded protected content**: rewrote `buildProtectedAppendix` with typed `ProtectedItem` collector, indexed toolCall→result map, priority ordering (user messages → write/edit evidence → subagent results → other protected tools), and `maxProtectedTokens` (default 24000) input budget with deterministic truncation.
- **Artifact-first memory**: summaries now include `Relevant Files` and `Artifacts` sections from cumulative file ops and protected subagent artifact paths; receipt reports file refs / protected blocks / subagent artifacts.
- **Safe subagent preservation**: normalized parent-visible `subagent` results (status, bounded conclusion, output/artifact paths) via `normalizeSubagentResult`. Exempt from deduplication and error-input purge by default. Controlled by `compaction.preserveSubagentResults` (default true).
- **Removed `<protect>` tagging**: `protectTags` config, schema, and implementation deleted — manual tagging is poor UX.
- Added `/dcp compress` alias earlier (0.2.1) retained.

## 0.2.1

- Added `/dcp compress [focus]` as an alias for `/dcp compact [focus]`.

## 0.2.0

- **Dual-threshold compaction model.** Compaction fires at the lower of `tokenThresholdPercent` (default `73%` of window) and `tokenThresholdAbsolute` (default `450000`). Protects the wall on small windows and caps cost on huge windows, with zero per-model config.
- **Removed the nudge subsystem.** The "be concise" system-prompt injection was slop; deleted entirely (no behavioral value, adds tokens).
- `/dcp status` now shows both thresholds and the resolved effective value.

## 0.1.3

- Made `/dcp` display both command help and the current status.

## 0.1.2

- Relicensed under AGPL-3.0-or-later.
- Added OpenCode DCP attribution and modified-work notice.
- Ported DCP's duplicate grouping and string-only failed-input purge semantics to Pi's message format.

## 0.1.1

- Added OpenCode-style compaction part-bar notifications (`░` summarized, `⣿` split-turn prefix, `█` kept).
- Preserved cumulative file tracking across extension-provided compactions.
- Made recent-turn protection explicit and disabled by default, matching DCP.
- Removed unsafe generic message-count truncation from the Pi context tree.
- Restricted defaults to Pi-native `write` and `edit` tools.
- Added config validation warnings and `dcp.schema.json`.

## 0.1.0

- Initial release.
- End-of-turn compaction trigger with configurable token/percentage threshold and cooldown.
- Custom DCP-style compaction summary with protected tools/files, user messages, and `<protect>` tags.
- System-prompt nudges when context grows large.
- `/dcp` command family for status, manual compaction, enable/disable, and config paths.
- Experimental context-event pruning: deduplication and purge-errors (disabled by default).
- Layered config: global `~/.pi/agent/dcp.json` + project `.pi/dcp.json`.
