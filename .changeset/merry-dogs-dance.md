---
type: Fixed
pr: 0
---
**A throw inside `check prohibition-enforcement` no longer crashes the gate** — it returns a non-blocking `unreadable` verdict like every other gate, and the four drift and prohibition `check` verbs now live in gate modules that the positive-control ratchet covers; `check verify-codebase-drift` now treats a mapped-commit stamp that is not a 7–64 character hex id (a ref name such as `HEAD`, a 6-character abbreviation) as unresolvable instead of handing it to the version-control tool. (#5219)
