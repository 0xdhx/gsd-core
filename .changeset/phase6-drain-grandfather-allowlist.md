---
type: Fixed
pr: 0
---
**Every remaining hand-rolled phase-heading regex, and every bold-label markdown field mutation that bypassed the PlanningDoc seam, now routes through one owner instead of a duplicated copy** — `/gsd-phase`'s add/insert/renumber/complete paths, `/gsd-roadmap`'s milestone-parsing paths, and the "Depends on" and STATE.md field writers no longer carry their own independently-typed `#{2,4}\s*Phase\s+` literal or ad-hoc `.replace()` mutation of a bold-label field. A new lint (`local/no-adhoc-markdown-parsing`'s field-shaped detector) and a new positive-control check for the PlanningDoc seam's grammars now fail CI on the next such copy, closing the epic (#4906) this phase completes. No user-facing command, flag, or output format changed. (#5007)
