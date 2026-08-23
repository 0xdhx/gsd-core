---
type: Fixed
pr: 3773
---
**Acknowledging a deferred item whose `status:` line is a nested bullet now sticks** — `acknowledgeDeferredItem` matched the nested `- status:` sub-line, rewrote it in place with the bullet preserved, and the parser (which deliberately reads a later `- ` line as a nested sub-list, not a field) still reported the entry outstanding, so `audit-open` kept resurfacing just-acknowledged items. The writer's status-line search now mirrors the parser (a bullet marker counts only on the entry's opening line), routing the nested-marker shape to the existing insert branch whose output the parser reads. (#3740)
