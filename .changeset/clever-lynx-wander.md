---
type: Fixed
pr: 5041
---
**The debugger's knowledge base is no longer treated as a debug session** — `gsd-debugger` appends every resolved session to `.planning/debug/knowledge-base.md`, and every reader of the debug directory treated that file as a session: `audit-open` reported it as open on every run (so every milestone-close audit carried a permanent false positive), `/gsd-debug list` listed it, `/gsd-debug`'s resume prompt offered it as a session to resume, `/gsd-progress` counted it as an active debug session, and the debugger's own active-session check listed it. All of them now skip it by name. The shell readers also no longer hide a real active session whose slug contains "resolved" (e.g. `unresolved-promise-hang`). (#4869, #5011)
