---
type: Fixed
pr: 4922
---
**`verify codebase-drift` now flags a map that went stale through edits** — a file modified or deleted inside a directory `STRUCTURE.md` already describes registers as a drift element (`modified` / `deleted`), counted against `workflow.drift_threshold` exactly like the four added-file categories. Until now only added files could produce an element: a hundred edits inside mapped directories reported `action_required: false` at every threshold, and the stale map reached the planner unflagged. An ordinary addition inside a mapped directory is still not drift (a barrel, migration or route addition counts wherever it lands, as before), and changes in territory the map never described stay out. On an actively edited repo the gate fires more often at the default threshold of 3 — that is the signal it was missing, not a new one; raise `workflow.drift_threshold` if the warn is too chatty.
