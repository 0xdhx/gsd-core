---
type: Fixed
pr: 5044
---
**Shipped instructions now point at live phase and backlog commands** — references to the absorbed `/gsd-add-phase`, `/gsd-insert-phase` and `/gsd-add-backlog` commands now use `/gsd:phase "<description>"`, `/gsd:phase --insert <after-phase> "<description>"` and `/gsd:capture --backlog`. A guard walks every shipped prose directory and rejects the colon, hyphen and space spellings of all three removed commands. MVP instructions also use `/gsd:<cmd>` for live commands, replacing the unregistered `/gsd <cmd>` spelling; a second guard covers every live command. (#5002)
