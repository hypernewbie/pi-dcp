# Changelog

## 0.4.5

- Changed the auto-continue resume prompt to `"Resuming from context compression, continue current task"` — gives the model explicit grounding for why it's being nudged, to try to avoid it drifting (e.g. treating a bare "continue" as license to move from planning into implementation).

## 0.4.4

- Shortened the auto-continue resume prompt (`triggers.endOfTurn.autoContinue`) from a long explanatory sentence to a terse `"Continue task"` — confirmed better-behaved in practice than a verbose nudge.

## 0.4.3

- **Fixed: `session_before_compact` hijacked plain native `/compact` (and Pi's own threshold/overflow auto-compaction) with DCP's custom summarizer.** There is only one `session_before_compact` hook, shared by every compaction reason - manual `/compact`, Pi's native threshold/overflow auto-compact, and pi-dcp's own `/dcp compact`/dual-threshold trigger all fired it identically. `compaction.customSummary` (default `true`) applied to all of them, so a plain native `/compact` silently got DCP's own LLM-generated summary instead of Pi's. Now gated on `initiator !== "pi-native"`: DCP's custom summarizer only runs for compactions pi-dcp itself asked for. A plain native `/compact`, or Pi's own auto-compaction, is left completely untouched - pi-dcp still reports it honestly in the receipt (`PI COMPACT`, never a fake DCP run identity), it just doesn't rewrite what the user or Pi itself asked for.
- **Reverted 0.4.2's `agent_settled` gating for the dual-threshold trigger** - it silently traded away real cost protection for safety. `agent_settled` only fires once an entire task fully finishes; on a large context window, a long autonomous multi-step run (many tool calls in flight, never settling) could blow straight through the absolute cost cap before pi-dcp's own trigger ever got a chance to check it. The trigger is back on `turn_end` (checked after every step, not just once the task settles), restoring the actual point of the dual-threshold: capping cost/context growth *during* a long run, not just after it.
- **Added `triggers.endOfTurn.autoContinue`** (default `true`, **Pi-only addition, not in upstream OpenCode DCP**) to make firing on `turn_end` safe again: `ctx.compact()` unconditionally aborts whatever the agent is currently doing before it compacts (Pi has no safe mid-loop compact-and-continue primitive), so a threshold crossed mid-task can still cut a running tool-call loop short. `triggerCompaction()` now detects whether it interrupted an active run (`!ctx.isIdle()` at trigger time) and, once compaction completes, automatically re-prompts to resume the interrupted task instead of leaving it dead - unless the user already has a message queued, or `autoContinue: false`.

## 0.4.2

- **Fixed: dual-threshold auto-compaction could abort a running multi-step tool-call loop mid-task.** The trigger was checked on Pi's `turn_end` event, which fires after *every individual* assistant message + tool-result step inside a single agentic run (well before the visible task is actually done). `ctx.compact()` unconditionally aborts the current agent operation before it compacts — it's a standalone/manual primitive (the same one used for a keyboard shortcut or `/compact`), not a checkpoint that lets a run continue afterward. Checking the threshold on `turn_end` meant a long autonomous run (many tool calls in flight) could be killed partway through the instant it crossed the threshold.
- The check now runs on `agent_settled` instead, which Pi only fires once the whole run has fully finished and guarantees no automatic retry/compaction/continuation will follow — the same safe point Pi's own native threshold/overflow auto-compaction uses internally (checked once per fully-settled run, not per tool-call step). `ctx.compact()`'s internal abort is a no-op at that point since nothing is running.
- No config or behavior change for simple (non-tool-loop) exchanges; `cooldownTurns` now counts fully-settled agent runs instead of internal turn steps, which is a closer match to its intended meaning.

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
