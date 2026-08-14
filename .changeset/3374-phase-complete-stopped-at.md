---
type: Fixed
pr: 3442
---
**`phase.complete` no longer overwrites a fresher frontmatter `stopped_at` with a stale body `Stopped at:` line** — the transition now refreshes the session continuity line it implies (`Phase N complete, ready to plan Phase N+1`) so the frontmatter projects this completion rather than pre-completion prose, and its frontmatter sync applies the same `applyStatePreservation` policy every other STATE.md write path uses as a backstop. Separately, `state record-session` now reports a field in `updated` only when its on-disk content actually changed — a `--stopped-at` value already present in the body no longer claims a write that never happened (and no longer risks the session-section rewrite resetting an executor-authored resume file). (#3374)
