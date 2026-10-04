---
type: Fixed
pr: 5218
---
**`roadmap upgrade` and `phase complete` no longer rewrite planning documents with raw string edits** — the migration now rewrites ROADMAP.md headings and checklist lines, PROJECT.md and STATE.md phase references through the shared planning seams, so a reference inside a fenced code block is left alone, a plan file edited after the plan was computed is refused instead of overwritten, and an edit the migration cannot apply stops and rolls back instead of leaving a half-migrated roadmap; `phase complete` flips the real plan bullet rather than the first mention of its id. (#5217)
