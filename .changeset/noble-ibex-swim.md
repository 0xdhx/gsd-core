---
type: Fixed
pr: 0
---
**A top-level `context_coverage_gate: false` no longer disables the blocking decision-coverage gate** — a config holding only that key switched the gate off even though `plan-phase` and `config-get` treated it as enabled; gate config is now read from nested `workflow.*` keys exactly as `config-get` answers, and honors `GSD_WORKSTREAM` (#5139).
