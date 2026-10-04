---
type: Fixed
pr: 5208
---
**Installer no longer crashes on a malformed extended-hook entry in settings.json** — a non-array value under SubagentStop, Stop, PreCompact, SubagentStart or FileChanged now repairs to an empty list like the other extended events do, because hook registration is now one table behind the settings-json adapter instead of per-hook branches. (#5207)
