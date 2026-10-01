---
type: Fixed
pr: 5168
---
**Gates and workflows evaluate a phase, plan or quick task through one scope resolver** — code review, the UI safety and TDD checkpoint gates, decision-coverage verify, schema-drift, quick and the execute workflows no longer scope their work with `HEAD~1..HEAD`, `base..HEAD` ranges or any-branch commit lookups, so unrelated interleaved commits and commits that live only on another branch stop appearing in a phase's scope; a scope the resolver had to widen or could not read is reported by name instead of passing as empty. (#5164)
