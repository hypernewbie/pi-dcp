# Changelog

## 0.7.1

- Documented the maintenance contract for the context-display override (exact Pi internals it depends on, how breakage manifests, how to re-verify and fix).
- Added CI canary tests that fail when a Pi update changes those internals, and a `/dcp status` line showing whether the override is active.

## 0.7.0

- **Pi's own context percentage now reflects the request DCP actually sends.** When summaries are applied, the live `AgentSession.getContextUsage()` is patched (presentation-only, fail-open, never used by Pi's native compaction decisions) so the existing footer percentage stops over-reporting. No extra footer line.
- **Context relief now frees enough in one pass.** Instead of folding a single bounded range (e.g. ~58K against 300K of pressure), automatic and manual compaction create consecutive bounded summaries until usage is back under the trigger plus the configured headroom.
- **Fixed noisy/incorrect "summary could not be applied" warnings.** Benign supersedes (a newer summary covering an older one) no longer warn; genuine stale-range failures warn once per summary instead of every request.

## 0.6.3

- Removed the footer status line: Pi renders extension statuses on an extra footer row, which costs a terminal line. The actual-sent context size (`vctx`) is now shown on demand in `/dcp status` instead.

## 0.6.2

- Renamed the footer status to `vctx` (virtual context) for clarity.

## 0.6.1

- **Fixed: stored context summaries frequently failed to apply to live requests, leaving the real provider context raw.** Projection previously required exact JSON equality between live agent messages and stored session copies and abandoned every summary on any mismatch. Live messages legitimately differ in usage/timestamps/metadata, so compression silently became a no-op (observed as GPT running at 97-100% context and a native overflow compaction). Mapping now compares stable conversational identity, retains unmatched live messages, applies each verified summary independently, and refuses only replacements that would orphan a live tool call/result pair.
- Added a footer status showing the estimated context DCP actually sent (only when summaries were genuinely applied), plus a warning when a stored summary could not be applied to a request.

## 0.6.0

- Added `dcp_read_session`, a bounded, read-only tool for retrieving a specific raw excerpt from earlier active-session history.
- The tool supports listing, literal search, and ID-range reads; preserves tool-call/result pairs; and caps returned context.

## 0.5.2

- Fixed the compacting indicator: it now uses a temporary above-editor card that Pi renders even after the agent leaves streaming mode.
- Updated range-compression receipts to use the OpenCode-style header, ASCII bar, compression line, item counts, range, evidence, and retained-context details.

## 0.5.1

- Added a temporary `Compacting older completed work…` working indicator while `/dcp compact` prepares a summary.
- Replaced the generic range prompt with a structured technical summary contract for completed work and active-task prefixes.
- Expanded the compact receipt with an ASCII context breakdown, range, item counts, exact-evidence size, and raw-context retained size.
- Fixed active-prefix selection to keep the current user request raw; strengthened overlap, tool-pair, model-limit, and no-growth safeguards.

## 0.5.0

- Added automatic context relief that folds completed work into bounded summaries without interrupting the running task.
- Kept `/dcp compress` as the explicit full compaction command and raised its summary ceiling to 20,000 tokens.
- User prompts in DCP-generated summaries are carried forward deterministically, with bounded head/tail handling for oversized messages.
- Added durable range projection, branch-safe state recovery, exact error/test evidence, and regression coverage for tool pairing and reasoning-tag failures.

## 0.4.9

- **Fixed: DCP's own summarizer never signaled a reasoning/thinking level to the model, unlike Pi's native compaction fallback.** Pi core's `compaction.js` (`createSummarizationOptions`) always passes `reasoning: thinkingLevel` (the session's current thinking level) to its own summarization completion when the model supports reasoning. `custom-summary.ts` never did this - it called `completeSimple()` with no `reasoning` option at all. Reported symptom: MiniMax M3 (a reasoning model, per the separate `pi-m3fix` project) produces flattened, leaked chain-of-thought as plain text instead of proper structured thinking blocks under DCP compaction specifically, while Pi's native compaction stays clean - `pi-m3fix`'s own changelog documents that leaked-reasoning text left in context causes "the model to imitate on next turn," and a leaked-reasoning-laden DCP summary would get baked into the permanent compacted context and poison every subsequent turn. Now threads `pi.getThinkingLevel()` through to `handleSessionBeforeCompact` and passes the same `model.reasoning && thinkingLevel !== "off"` guarded `reasoning` option Pi core uses.
- Investigated whether DCP's summarizer needs to route through the live agent's own `streamFn` (which Pi's native compaction uses instead of the generic `completeSimple` helper). Confirmed by reading `pi-ai`'s `compat.js` that `completeSimple`/`streamSimple` ultimately call the exact same per-provider `stream()` function `agent.streamFn` uses for a real session - the only material behavioral gap was the missing `reasoning` option above, not a separate code path. No change needed here beyond the reasoning fix.
- Added regression tests confirming `reasoning` is passed through correctly (set to the session's thinking level for reasoning-capable models, omitted when the level is `"off"` or the model doesn't support reasoning).

## 0.4.8

- **Fixed: a genuine provider error during DCP's own custom summarization was silently mislabeled as "summary was empty, falling back to default".** `completeSimple()` does not throw for provider-level failures (auth, rate limits, "model not found", etc.) - it returns a normal, non-throwing `AssistantMessage` with `stopReason: "error"` and `errorMessage` set (the exact shape Pi's own core `generateSummary()` already checks for). `handleSessionBeforeCompact` never checked `response.stopReason`, so any such error had empty `content` and fell straight into the "empty summary" branch, hiding the real, actionable error message entirely. Now checks `stopReason === "error"` first and surfaces `response.errorMessage` verbatim.
- This does **not** create or corrupt any model identifier - verified `ctx.model` is used completely unmodified (no string concatenation exists anywhere in pi-dcp's model resolution) unless `compaction.summaryModel` is explicitly configured. A malformed/rejected model ID reported by the provider (e.g. `Codex error: Model not found ...`) reflects the model **the main conversation is already using** - the same object, same value.
- Added regression tests (`tests/custom-summary.test.ts`) mocking `completeSimple` to return an error-shaped response, confirming the real error is now surfaced and the two other cases (genuinely empty non-error content, genuine success) are unaffected.

## 0.4.7

- **Added `/dcp threshold <percent|null> <absolute|null>`**: sets the dual-threshold (`triggers.endOfTurn.tokenThresholdPercent`/`tokenThresholdAbsolute`) for the current session only — mutates the in-memory config the same way `/dcp enable`/`/dcp disable` already do, never touches `dcp.json`. Either value can be `null` (or `off`/`none`/`-`) to disable that side. Confirms and echoes the new effective threshold on success.

## 0.4.6

- **Added `/dcp compact_continue` and `/dcp compress_continue`** (aliases of each other, same `[focus]` argument as `/dcp compact`/`/dcp compress`): compact now, then always resume the interrupted task afterward, regardless of `triggers.endOfTurn.autoContinue`.
- **Fixed: plain manual `/dcp compact`/`/dcp compress` no longer auto-continues.** `triggerCompaction()`'s auto-continue fallback was keyed only on `autoContinue` + "did this interrupt an active run", with no check on *who* triggered it - so a manual `/dcp compact` run while the agent was busy would auto-resume the task even though the user only asked to compact. Auto-continue (the config-gated fallback) now only applies to the automatic dual-threshold trigger; manual commands only continue when explicitly requested via the new `_continue` variants (`forceContinue`).

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
- **Removed manual protection tagging**: the old config, schema, and implementation were deleted — manual tagging is poor UX.
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
- Custom DCP-style compaction summary with protected tools/files and user messages.
- System-prompt nudges when context grows large.
- `/dcp` command family for status, manual compaction, enable/disable, and config paths.
- Experimental context-event pruning: deduplication and purge-errors (disabled by default).
- Layered config: global `~/.pi/agent/dcp.json` + project `.pi/dcp.json`.
