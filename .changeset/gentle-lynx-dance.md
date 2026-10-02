---
type: Fixed
pr: 5043
---
**Quick-task rows, audit acknowledgements and the context-exhaustion breadcrumb are dated with your local day, and honor the test clock pin** — `quick-tasks-append` (the Date column of STATE.md's Quick Tasks Completed table), `audit-open acknowledge` without `--at`, and the context monitor's CRITICAL auto-record (the day in STATE.md's `Stopped At: context exhaustion at N% (<day>)`) took the UTC calendar day of the real wall clock, so work done between local midnight and UTC midnight was stamped with the wrong day, and `GSD_NOW_MS` could not pin any of them. All three now use the local calendar day through the clock seam, like every other operator-facing date field; an explicit `--at` still wins. (#4905)
