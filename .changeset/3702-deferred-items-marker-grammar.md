---
type: Fixed
pr: 0
---
**`deferred-items.md` entries written with `*`, `+` or an ordered marker are no longer silently dropped** — the parser recognised only the `- ` hyphen marker, so a deferred list written with any other standard Markdown list marker contributed zero entries and reported as a clean zero to `audit-open`, while a mixed file dropped its non-hyphen entries and under-reported without ever looking empty. Asterisk, plus and dot-terminated ordered markers now count wherever the hyphen does — as entry openers, as heading-entry body evidence, and in the marker strip feeding field extraction, so a `**Status:**` field written under any of them resolves its entry as the hyphen form does. The `## Gaps` section keeps its template-mandated hyphen grammar, and the "prose is not an item" contract is unchanged. (#3702)
