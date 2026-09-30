---
type: Fixed
pr: 0
---
**A top-level `context_coverage_gate: false` no longer disables the blocking decision-coverage gate** — a config holding only that key switched the gate off even though `plan-phase` and `config-get` treated it as enabled; gate config is now read from nested `workflow.*` keys exactly as `config-get` answers, and honors `GSD_WORKSTREAM`; a malformed `config.json` is read as an absent key without a stderr warning, `verify context-drift` / `codebase-drift` read their `workflow.*` keys through the same reader, `check tdd-red-evidence` refuses a record path outside the project directory, and the `tdd-review-checkpoint` plan id reaches `git log --grep` as an escaped literal (#5139).
