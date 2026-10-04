---
type: Fixed
pr: 5216
---
**The installer no longer tells pi, windsurf (global) and cline/kimi/kimi-code (local) installs to run a command they never registered** — the completion message is now generated from the runtime's registered command surface, so a runtime that registers no `/gsd-new-project` says so (and, for pi, names the `/gsd` command its extension does register) instead of sending you to a command that does not exist. (#4567)
