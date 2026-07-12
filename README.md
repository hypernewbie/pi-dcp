# pi-dcp — Pi Dynamic Context Pruning

[![CI](https://github.com/hypernewbie/pi-dcp/actions/workflows/ci.yml/badge.svg)](https://github.com/hypernewbie/pi-dcp/actions/workflows/ci.yml)

**Modified work based on [OpenCode Dynamic Context Pruning (DCP)](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning).**

A Pi extension adapted from OpenCode's DCP that gives you **controllable, configurable context compaction and pruning** — especially for long agentic runs on large-context / expensive models.

## What it does

- **Dual-threshold compaction triggers**: fire `ctx.compact()` at the **lower** of a percentage-of-window threshold and an absolute token cap. Defaults (`73%` / `450k`) protect the wall on small windows (~200k) and cap cost on huge windows (~1M) — no per-model tuning.
- **Custom compaction summaries**: Replace Pi's default summary with a DCP-style structured summary that preserves protected tools/files, user messages, and `<protect>` blocks.
- **Context-event pruning** (experimental, off by default): deduplicate repeated identical tool calls and purge large inputs from old errored tool calls.
- **Compaction part bar**: detailed compaction notifications show summarized/split-prefix/kept parts using `░`, `⣿`, and `█`.
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
    "protectUserMessages": false,
    "protectTags": false
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
| `/dcp compact [focus]` / `/dcp compress [focus]` | Trigger compaction now with optional focus text |
| `/dcp enable` / `/dcp disable` | Toggle for this session |
| `/dcp config` | Show config paths and any load warnings |
| `/dcp status` | Alias for `/dcp` |

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

## Why context-event pruning is off by default

On cache-heavy providers, mutating messages every turn can invalidate the prompt prefix cache and cost more than it saves. Only enable `pruning.enabled` if you have measured the tradeoff for your provider and workflow.

## License

AGPL-3.0-or-later. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE) for the original project attribution and modification notice.
