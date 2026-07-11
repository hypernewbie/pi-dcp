# pi-dcp — Pi Dynamic Context Pruning

A Pi extension inspired by OpenCode's DCP that gives you **controllable, configurable context compaction and pruning** — especially for long agentic runs on large-context / expensive models.

## What it does

- **Early compaction triggers**: Fire `ctx.compact()` at a token threshold *you* choose (e.g. 250k or `"30%"`), instead of waiting for Pi's default trigger near `contextWindow - reserveTokens`.
- **Custom compaction summaries**: Replace Pi's default summary with a DCP-style structured summary that preserves protected tools/files, user messages, and `<protect>` blocks.
- **Context-efficiency nudges**: Inject a short system-prompt hint when context grows large.
- **Context-event pruning** (experimental, off by default): deduplicate repeated identical tool calls and purge large inputs from old errored tool calls.
- **ASCII context bars**: the footer and `/dcp` status show live usage; compaction notifications show summarized/split-prefix/kept parts using `░`, `⣿`, and `█`.
- **`/dcp` commands**: inspect status, trigger compaction with focus, enable/disable, and locate config files.

## Install

```bash
pi install git:github.com/hypernewbie/pi-dcp
```

Or clone and symlink for local development:

```bash
ln -s "$(pwd)/src" ~/.pi/agent/extensions/pi-dcp
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
      "tokenThreshold": 250000,
      "cooldownTurns": 2,
      "focus": "Preserve architecture decisions, file changes, and current task. Drop verbose logs and repeated outputs."
    },
    "nudge": {
      "enabled": true,
      "tokenThreshold": 150000,
      "frequency": 5,
      "force": "soft"
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
    "deduplication": { "enabled": true },
    "purgeErrors": { "enabled": true, "turns": 4 }
  },
  "protectedTools": ["task", "skill", "todowrite", "todoread", "write", "edit", "multiedit", "apply_patch"]
}
```

## Commands

| Command | Description |
|---|---|
| `/dcp` | Show status: enabled, current tokens, thresholds, settings |
| `/dcp compact [focus]` | Trigger compaction now with optional focus text |
| `/dcp enable` / `/dcp disable` | Toggle for this session |
| `/dcp config` | Show config paths and any load warnings |
| `/dcp status` | Alias for `/dcp` |

## Why context-event pruning is off by default

On cache-heavy providers, mutating messages every turn can invalidate the prompt prefix cache and cost more than it saves. Only enable `pruning.enabled` if you have measured the tradeoff for your provider and workflow.

## License

MIT
