---
type: Fixed
pr: 3739
---
**`deferred-items.md` entries written with `*`, `+` or an ordered marker are no longer silently dropped** — the parser recognised only `- `, so a deferred list written with any other standard Markdown list marker contributed zero entries and reported as a clean zero to `audit-open`. (#3702)
