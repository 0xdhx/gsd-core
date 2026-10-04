---
type: Fixed
pr: 0
---
**A throw inside `check prohibition-enforcement` no longer crashes the gate** — it returns a non-blocking `unreadable` verdict like every other gate, and the four drift and prohibition `check` verbs now live in gate modules that the positive-control ratchet covers. (#5219)
