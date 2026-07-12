# Changelog

## 0.4.1

- **Fixed: compaction receipt never rendered in real interactive sessions.** `ctx.ui.notify()` renders a transient status line in the chat pane; Pi always rewrites/rebuilds the visible transcript from persisted branch entries immediately after `session_compact` fires (compaction removes messages from history), which wiped the transient notify line before it could ever be seen. Confirmed by reproducing the exact live-session sequence end to end.
- The receipt is now written via `pi.appendEntry("dcp-receipt", { text })` and rendered by a registered `registerEntryRenderer`, exactly like Pi's own built-in `[compaction]` summary box: a durable, persisted transcript entry that survives the rebuild and stays in scrollback/history afterwards.
- `compaction-bar.ts`: replaced `notifyCompaction()` (side-effecting, called `ctx.ui.notify` directly) with `buildCompactionReceiptText()`, a pure function returning the receipt string (or `undefined` when `notification: "off"`). All existing text formatting (`formatCompactionNotification`/`formatMinimalNotification`) is unchanged.
- Added an end-to-end regression test that runs the real registered `session_before_compact`/`session_compact` handlers and the real registered entry renderer (actual `@earendil-works/pi-tui` `Box`/`Text` components) to confirm a non-empty durable entry is produced and renders correctly — not just unit-testing the string formatters in isolation.
- Added `@earendil-works/pi-tui` as a peer/dev dependency (Pi's extension loader aliases this package for extensions at runtime; only needed here for typechecking and tests).

## 0.4.0

- **Corrected the compaction receipt to be faithful to OpenCode DCP.** The `0.3.x` "carried forward: N file refs · N protected · N subagent artifacts" receipt was not based on OpenCode DCP's actual notification and is replaced.
- New receipt shape, ported from OpenCode DCP's `lib/ui/notification.ts` (`sendCompressNotification`/`formatStatsHeader`):
  - cumulative header: `▣ DCP | -~<cumulative removed> removed, +~<summary tokens> summary`
  - per-run line: `▣ Compression #<N> -~<removed this run> removed, +~<summary tokens> summary`
  - `→ Items: <N> messages and <M> tool calls compressed`
  - minimal mode: `▣ DCP | -~<cumulative> removed, +~<summary> summary — Compression #<N>`
  - only rendered for a genuine DCP compression run (`fromExtension: true` and pi-dcp's own persisted run counters present); a DCP-initiated compaction that fell back to Pi's default summary is shown honestly without a fake run identity.
- **Pi-only additions, clearly not from OpenCode**: `→ Origin: command|dual-threshold[, focus: "..."]` (focus only shown when explicitly user-supplied, never the default dual-threshold boilerplate), and `→ Split-turn prefix: N messages, summarized separately` (a genuine Pi concept OpenCode has no equivalent for).
- **Deliberately not ported**: `→ Topic:`. OpenCode derives this from the model's own `compress` tool call; Pi has no equivalent, and a user focus string is not a model-generated topic.
- Added `compaction.showCompression` (default `false`, matches OpenCode's `compress.showCompression`): gates whether the actual committed summary text appears in the notification.
- Removed tokens/summary tokens/message and tool-call counts are computed from `event.preparation` using Pi's own `estimateTokens()`, and are available for both DCP-triggered and Pi-native compactions (they describe what Pi is discarding, independent of who wrote the summary).
- `runNumber` and cumulative removed tokens are persisted in the DCP compaction entry's `details`, read back from prior compaction/branch-summary entries on each subsequent run — same append-only pattern already used for `readFiles`/`modifiedFiles`.
- `/dcp status` last-compaction line now reports the same removed/summary/items/run-number facts instead of the incorrect 0.3.x receipt fields.

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
