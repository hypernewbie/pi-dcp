# pi-dcp — Pi Dynamic Context Pruning

[![CI](https://github.com/hypernewbie/pi-dcp/actions/workflows/ci.yml/badge.svg)](https://github.com/hypernewbie/pi-dcp/actions/workflows/ci.yml)

**Modified work based on [OpenCode Dynamic Context Pruning (DCP)](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning).**

A Pi extension adapted from OpenCode's DCP that gives you **controllable, configurable context compaction and pruning** — especially for long agentic runs on large-context / expensive models.

## What it does

- **Dual-threshold compaction triggers**: fire `ctx.compact()` at the **lower** of a percentage-of-window threshold and an absolute token cap. Defaults (`73%` / `450k`) protect the wall on small windows (~200k) and cap cost on huge windows (~1M) — no per-model tuning.
- **Custom compaction summaries**: Replace Pi's default summary with a DCP-style structured summary that preserves protected tools/files, user messages, and artifact references. Bounded input budget prevents giant outputs from wrecking compaction.
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
      "focus": "Preserve architecture decisions, file changes, and current task. Drop verbose logs and repeated outputs."
    }
  },
  "compaction": {
    "customSummary": true,
    "summaryModel": null,
    "maxSummaryTokens": 8192,
    "maxProtectedTokens": 24000,
    "preserveSubagentResults": true,
    "protectUserMessages": false,
    "showCompression": false
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

## Commands

| Command | Description |
|---|---|
| `/dcp` | Show commands and current status: enabled, tokens, thresholds, settings |
| `/dcp status` | Show detailed status including last compaction |
| `/dcp stats` | Show compaction/pruning stats (current branch) |
| `/dcp compact [focus]` / `/dcp compress [focus]` | Trigger compaction now with optional focus text |
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

The check runs once the agent has **fully settled** (the whole reply, including any multi-step tool-call loop, has finished and Pi guarantees nothing will auto-continue) — never mid-task. Pi's `ctx.compact()` always aborts whatever is currently running before it compacts, so pi-dcp deliberately does not check the threshold while the agent is still actively working; it waits for the same safe point Pi's own built-in threshold/overflow auto-compaction uses.

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

When the compaction was Pi-native (native `/compact`, threshold, or overflow), or DCP asked for it but its summarizer fell back to Pi's own default summary, the notification never claims a `Compression #N` identity or cumulative totals DCP didn't produce:

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
