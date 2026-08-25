---
type: Fixed
pr: 3744
---
**`phase complete` now warns when the ROADMAP `**Requirements**:` line under-selects REQ-IDs** — a spaced range (`REQ-01 … REQ-05`) silently selected only its two endpoints and, when those writes landed, still reported `requirements_updated: true` with zero warnings, and a tight range (`REQ-01…05`) silently selected nothing at all, leaving the whole line inert. Both shapes now emit a warning naming the IDs actually selected and any unparsed ID-shaped text, pointing back at the canonical comma list; range expansion is deliberately not added. (#3697)
