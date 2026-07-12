# Changelog

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
