Review complete. Here are my prioritized findings.

## Summary

The rewrite of `src/context-projector.ts` is the right architectural fix for the prior fail-open problem, and it aligns with PLAN3 §2. The old projector compared whole-object JSON (`JSON.stringify(a) === JSON.stringify(b)`) and bailed **globally** (returned raw context) on any mismatch — so in real runs, where live messages differ from stored copies in usage/timestamps/extension metadata, DCP compression essentially never applied and context stayed huge. The new design fixes both root causes:

1. **Stable identity mapping** (`messageKey`) ignores volatile fields (usage, timestamps, metadata), matching on conversational identity — so real live messages now map.
2. **Per-block skip instead of global bail** — a broken/unmappable block skips only itself; other verified blocks still project. Unknown live messages are retained, and the output is built from the **live** `contextMessages`, not stored copies. Tool-pair integrity is guarded at candidate-selection time.

This does prevent the prior fail-open problem without dropping live messages or (in the covered cases) tool pairs.

## Blockers

**BLOCKER 1 — test suite is RED.** `tests/virtual-blocks.test.ts:298` ("fails open when another transform changes the message list") fails. The new design *intentionally* no longer globally bails when another transform appends a live message — it retains the injected message and still applies the verified block (correct per PLAN3 "leave unknown entries untouched, fail open non-destructively"). But the diff changed this contract without updating the test. Releasing with a red suite is a hard blocker: the test must be updated to assert the new contract (block applied + injected message retained) and re-reviewed, or the behavior change must be justified. `npx tsc --noEmit` is clean; 111/112 tests pass.

## On the proposed projected-context footer

It is **not implemented** in this diff. The only scaffolding is `ProjectionResult.{appliedBlocks,skippedBlocks}`, which is currently dead: `projectVirtualBlocks` discards it and `index.ts:285` calls the non-info variant. Conceptually:

- The footer is **orthogonal** to fail-open — it neither causes nor prevents it. Fail-open is solved entirely by the mapping rewrite. Do not conflate the two.
- If shipped, it must report **actually-applied** counts (`replacements.size`), not candidate count, or the model gets told work was summarized when a block was actually skipped — a new form of context drift.
- PLAN3 and PLAN4 both list persistent footer/dashboard/statusline UI as explicit **non-goals**. An in-context notice message is defensible; a persistent UI footer is not. Whatever ships must obey PLAN3's HARD RULE (no plan jargon / internal terms in user- or model-facing strings) and should point recovery at `dcp_read_session` (PLAN4), not re-expand ranges.

## Non-blocking concerns (recommend tests before release)

- **Duplicate-content mismapping:** `findMessageSequence` forward-scans for the first key match from a monotonic cursor. Repeated identical messages (e.g. identical tool results, repeated auto-continue nudges) can map a segment to a wrong live index. Monotonic cursor limits blast radius, but add a duplicate-content projection test.
- **Orphaned tool pairs among *unmapped* live messages:** `hasClosedToolPairs` inspects only stored `segments`, not retained-but-unmapped live messages. If a live `toolResult` fails to map (key mismatch) while its call sits in a replaced range, the surviving result is orphaned → provider error. Stable `toolCallId` makes this unlikely, but the guard doesn't cover it; add a defensive test.
- **assistant `messageKey` collapses non-text/non-toolCall parts to `part.type`** (drops reasoning). Fine for identity, but combined with the forward scan it can collide on adjacent assistant messages differing only in reasoning. Minor.
- **`skippedBlocks` accounting** mixes an initial `blocks.length - candidates.length` with per-candidate increments; fine as a rough count, but verify semantics before any footer surfaces it to the model.
- Pi API usage is consistent with the plans: context hook rebuilds blocks from `getBranch()` (raw) and projects against `buildContextEntries()` (compacted view); `session_compact` retires blocks whose entries vanished. Good.