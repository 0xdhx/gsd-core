---
type: Fixed
pr: 5025
---
**`/gsd-quick` now pre-commits the plan when `workflow.use_worktrees` is unset** — with the key absent (documented default: `true`) the executor was dispatched in a worktree, but the section manifest read the unset key as `false` and skipped the pre-dispatch PLAN.md commit, so the isolated executor started without its plan committed at the worktree HEAD. An unset key now selects the same steps as an explicit `true`, and a root-level `use_worktrees` is inherited under `GSD_WORKSTREAM` exactly as `config-get` reports it; an explicit `false` still opts out. (#4977)
