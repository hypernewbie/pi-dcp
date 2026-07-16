# pi-dcp — Pi Dynamic Context Pruning

[![CI](https://github.com/hypernewbie/pi-dcp/actions/workflows/ci.yml/badge.svg)](https://github.com/hypernewbie/pi-dcp/actions/workflows/ci.yml)

**Modified work based on [OpenCode Dynamic Context Pruning (DCP)](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning).**

A Pi extension adapted from OpenCode's DCP that gives you **controllable, configurable context compaction and pruning** — especially for long agentic runs on large-context / expensive models.

## What it does

- **Automatic context relief without aborting work**: at the **lower** of a percentage-of-window threshold and an absolute token cap, folds completed older work into bounded summary blocks while the current task stays raw. Defaults (`73%` / `450k`) protect the wall on small windows (~200k) and cap cost on huge windows (~1M).
- **Two manual modes**: `/dcp compact` folds completed work without interrupting the task; `/dcp compress` keeps the full one-shot compaction path with a detailed summary.
- **Deterministic user-prompt preservation**: real user prompts are carried into DCP-generated summaries after the model responds, so the summarizer cannot omit them. Oversized prompts are bounded by a separate head/tail limit.
- **Custom compaction summaries**: The one-shot path can replace Pi's default summary with a DCP-style structured summary that preserves protected tools/files and artifact references. Bounded input budget prevents giant outputs from wrecking compaction.
- **Subagent result preservation**: Parent-visible `subagent` results (conclusions + artifact paths) survive compaction without importing full child transcripts.
- **Context-event pruning** (experimental, off by default): deduplicate repeated identical tool calls and purge large inputs from old errored tool calls (subagent results are exempt).
- **OpenCode-faithful compression receipt**: for genuine DCP compressions, a cumulative `▣ DCP | -X removed, +Y summary` header, a per-run `▣ Compression #N` line, `░ ⣿ █` part bar, and `→ Items:`/`→ Origin:` lines — same shape as OpenCode DCP's own notification. Native Pi compactions are labelled `PI COMPACT` and never claim a fake DCP run identity.
- **Honest stats**: `/dcp stats` shows persistent, branch-local compaction/pruning counts via custom session entries.
- **`/dcp` commands**: inspect status, trigger compaction with focus, enable/disable, and locate config files.

## Install

```bash
pi install git:github.com/hypernewbie/pi-dcp
```

Or clone and symlink for local development:

```bash
git clone https://github.com/hypernewbie/pi-dcp.git
ln -s "$PWD/pi-dcp" ~/.pi/agent/extensions/pi-dcp
```
```

## Configuration

Config is layered (last wins). The package includes [`dcp.schema.json`](./dcp.schema.json) for editor autocomplete:

| Layer | Path |
|---|---|
| Global | `~/.pi/agent/dcp.json` |
| Project | `.pi/dcp.json` |

Example:

```jsonc
{
  "enabled": true,
  "triggers": {
    "endOfTurn": {
      "enabled": true,
      "tokenThresholdPercent": 73,
      "tokenThresholdAbsolute": 450000,
      "cooldownTurns": 2,
      "focus": "Preserve architecture decisions, file changes, and current task. Drop verbose logs and repeated outputs.",
      "autoContinue": true
    }
  },
  "compaction": {
    "customSummary": true,
    "summaryModel": null,
    "maxSummaryTokens": 20000,
    "maxProtectedTokens": 24000,
    "preservedUserMessageTokens": 2000,
    "preserveSubagentResults": true,
    "protectUserMessages": false,
    "showCompression": false
  },
  "contextRelief": {
    "enabled": true,
    "targetHeadroomTokens": 60000,
    "maxChunkInputTokens": 60000,
    "maxChunkSummaryTokens": 25000,
    "exactEvidenceTokens": 8000,
    "preservedUserMessageTokens": 2000,
    "activeWorkingSetTokens": 35000
  },
  "pruning": {
    "enabled": false,
    "turnProtection": { "enabled": false, "turns": 4 },
    "deduplication": { "enabled": true },
    "purgeErrors": { "enabled": true, "turns": 4 }
  },
  "protectedTools": ["write", "edit"]
}
```

User prompts are always carried forward in DCP-generated summaries; `protectUserMessages` controls whether they are also supplied as protected input while the summary is being written. `preservedUserMessageTokens` is the per-message cap for the deterministic carry-forward.

`compaction.summaryModel` (default `null` → use the session's current model) lets you point DCP's own summarizer at a *different* model/provider (`"provider/model-id"`, e.g. `"deepseek/deepseek-v4-pro"`). Useful if your active model can't reliably complete a standalone, non-conversational request (some provider/account setups issue session-scoped model IDs that only work as part of an ongoing conversation thread, and reject a fresh, isolated completion call outright). If DCP's own summarizer fails for any reason, the real provider error is reported honestly instead of silently falling back — but pi-dcp cannot fix a model/provider that also can't complete Pi's own native fallback summary; `summaryModel` is the way to route around it.

## Commands

| Command | Description |
|---|---|
| `/dcp` | Show commands and current status: enabled, tokens, thresholds, settings |
| `/dcp status` | Show detailed status including last compaction |
| `/dcp stats` | Show compaction/pruning stats (current branch) |
| `/dcp compact [focus]` | Fold older completed work into a summary without interrupting the task |
| `/dcp compress [focus]` | Run full one-shot context compaction with a detailed summary |
| `/dcp compact_continue [focus]` | Same as `/dcp compact`; the task continues automatically |
| `/dcp compress_continue [focus]` | Compress now, then resume the interrupted task afterward |
| `/dcp threshold <percent\|null> <absolute\|null>` | Set the dual-threshold for this session only (in-memory, not written to `dcp.json`) |
| `/dcp enable` / `/dcp disable` | Toggle for this session |
| `/dcp config` | Show config paths and any load warnings |

## How the compaction threshold works

Compaction fires at the **lower** of two thresholds, resolved against the current model's context window:

```
effective = min(tokenThresholdPercent × window, tokenThresholdAbsolute)
```

This adapts automatically across windows with **zero per-model config**:

| Window | 73% | 450k cap | Fires at | Governs |
|---|---|---|---|---|
| 200k | 146k | 450k | 146k | percent (capacity) |
| 272k | 198k | 450k | 198k | percent |
| 372k | 271k | 450k | 271k | percent |
| 1M | 730k | 450k | 450k | absolute (cost) |

A big window is a *ceiling, not a target* — the absolute cap prevents filling a 1M window (≈ $10/turn) just because the model allows it. Either threshold can be set to `null` to disable it; both `null` defers entirely to Pi's built-in compaction.

The check runs on every turn (`turn_end`), including mid-task inside a long multi-step tool-call loop. Automatic relief folds one completed range at a time and does not abort the running task. If no completed range is available, Pi's own safety compaction remains available. The `autoContinue` setting applies to the explicit `/dcp compress` path and its automatic legacy fallback; `/dcp compact` never needs a resume nudge.

## Compaction notifications

The receipt is rendered as a durable custom entry in the transcript (not a transient status toast), so it survives the chat rebuild that always follows a compaction and stays visible in scrollback/history afterwards.

When `notification: "detailed"` (the default) and pi-dcp itself performed the compression (a "DCP compression run"), the notification is faithful to OpenCode DCP's own shape:

```text
▣ DCP | -~248K removed, +~6.1K summary

│░░░░░░░░⣿⣿████████████████████████│
▣ Compression #4 -~62K removed, +~6.1K summary
→ Items: 38 messages and 9 tool calls compressed
→ Origin: command, focus: "preserve the auth migration decision"
```

`-X removed` / `+Y summary` are estimated with Pi's own token estimator (same char/4 heuristic Pi uses internally), not billed/exact tokens. `Compression #N` and the cumulative removed total are pi-dcp's own persisted counters — they only increment when pi-dcp's own summarizer actually produced the committed summary (`fromExtension: true`). `→ Origin` and any focus text are only shown for a real DCP-initiated run, and the default dual-threshold focus text is never shown as a fake "topic" — only an explicit `/dcp compress <focus>` argument is.

When the compaction was Pi-native (native `/compact`, threshold, or overflow), pi-dcp's custom summarizer never runs at all — Pi's own default summary is left completely untouched, and the notification never claims a `Compression #N` identity or cumulative totals DCP didn't produce. (The same honest fallback labeling also applies on the rare occasion DCP asked for a compression but its own summarizer failed and Pi's default summary was used instead.)

```text
▣ PI COMPACT · threshold · Pi default summary

│░░░░░░░░████████████████████████████████████████████│
→ Removed: ~62K, Summary: ~6.1K
→ Items: 38 messages and 9 tool calls compacted
```

`compaction.showCompression` (default `false`, matching OpenCode) controls whether the actual committed summary text is included in the notification.

## Why context-event pruning is off by default

On cache-heavy providers, mutating messages every turn can invalidate the prompt prefix cache and cost more than it saves. Only enable `pruning.enabled` if you have measured the tradeoff for your provider and workflow.

## License

AGPL-3.0-or-later. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE) for the original project attribution and modification notice.
