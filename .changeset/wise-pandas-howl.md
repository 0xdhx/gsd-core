---
type: Fixed
pr: 0
---
**The installer no longer tells pi (and windsurf global installs) to run a command they never registered** — the completion message is now generated from the runtime's registered command surface, so a runtime that registers no `/gsd-new-project` says so instead of sending you to a command that does not exist. (#4567)
