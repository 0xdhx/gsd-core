/**
 * Health Diagnostic — Worktree health rules (Phase 11, #3309, ADR-3180
 * §8.2/§8.3/§8.5).
 *
 * Group: "Worktree health" (design doc, "Rule table organization" table) —
 * W020 (×3 internal conditions, one subject: "the worktree health scan
 * itself is degraded", design doc "Rejected alternatives" §3), W017 (orphan
 * worktree), W027 (NEW — the split-off "stale worktree" subject, design
 * doc's "New codes for the two split subjects" section).
 *
 * Ported behavior-preserving from `cmdValidateHealth`
 * (`src/verify.cts:2193-2268`), the exact call sites for W020/W017/W027 (the
 * pre-migration source still names the split-off stale-worktree site
 * 'W017' — this batch is what actually applies the W027 split).
 *
 * KNOWN GAP (found while building, reported rather than papered over — see
 * this batch's dispatch report for full detail):
 *
 * 1. W020's original THREE conditions were git_timed_out / git_list_failed /
 *    a per-finding 'unverified' kind, each with its own message. The first
 *    two are scan-level failures reported by `inspectWorktreeHealth`'s own
 *    `reason` field ('git_timed_out' vs 'git_list_failed' vs
 *    'not_a_git_repo') — but `planning-snapshot.cts`'s
 *    `buildWorktreeHealthField` discards `reason` entirely and only
 *    preserves `scope: SCOPE.UNREADABLE` for ANY `!result.ok` case. This
 *    rule therefore CANNOT distinguish "git timed out" from "git worktree
 *    list failed outright" from the snapshot alone — both collapse to the
 *    same `checkScanDegraded` branch below, which emits one reasonable
 *    combined message instead of the original's two separate ones. Fixing
 *    this precisely requires extending `PlanningSnapshot.worktreeHealth`
 *    with the discarded `reason` field — an snapshot-field enhancement
 *    outside this rule-file batch's scope, flagged here rather than guessed
 *    around.
 *
 * W027 restores the pre-migration active-worktree exclusion
 * (`verify.cts:2233-2242`) via `PlanningSnapshot.cwd` — see `checkW027`'s own
 * comment below for the mechanism.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 *
 * ADR-457 build-at-publish: source in
 * src/health-diagnostic-rules/worktree-health.cts, compiled to
 * gsd-core/bin/lib/health-diagnostic-rules/worktree-health.cjs (gitignored).
 */

import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- type-only; erased at compile time, no runtime require emitted
import type planningSnapshotMod = require('../planning-snapshot.cjs');

type PlanningSnapshot = ReturnType<typeof planningSnapshotMod.buildPlanningSnapshot>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import healthDiagnosticMod = require('../health-diagnostic-types.cjs');
const { SEVERITY, adviseRemedy } = healthDiagnosticMod;
type Diagnostic = healthDiagnosticMod.Diagnostic;
type Rule = healthDiagnosticMod.Rule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('../planning-scope.cjs');
const { SCOPE } = planningScopeMod;

// ─── W020 — worktree health scan itself is degraded (verify.cts:2203-2264) ─
//
// ONE rule, THREE internal conditions, all the same subject ("the worktree
// health scan itself is degraded" — design doc "Rejected alternatives" §3):
// (a) `git worktree list` timed out, (b) `git worktree list` failed
// outright, (c) a specific 'unverified' finding (existsSync ok, statSync
// threw). (a) and (b) collapse to a single combined message per the
// module-doc gap note above; (c) is a per-finding, exact port of
// `verify.cts:2256-2263`.

function checkW020(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // (a)+(b) — scan-level degradation. GAP: cannot distinguish timeout from
  // outright failure from `scope` alone (see module doc, gap 1).
  if (snapshot.worktreeHealth.scope === SCOPE.UNREADABLE) {
    diagnostics.push({
      code: 'W020',
      severity: SEVERITY.WARNING,
      message:
        'Worktree health check degraded: git worktree list timed out or failed — orphan/stale worktrees could not be inspected',
      remedy: adviseRemedy(
        'Run: git worktree list --porcelain to diagnose; check for .git/index.lock, a hung git process, or repository permissions',
      ),
    });
  }

  // (c) — per-finding 'unverified' (existsSync ok, statSync threw).
  for (const finding of snapshot.worktreeHealth.value) {
    if (finding.kind !== 'unverified') continue;
    diagnostics.push({
      code: 'W020',
      severity: SEVERITY.WARNING,
      message: `Worktree health check degraded: could not stat ${finding.path} — presence/staleness could not be verified`,
      remedy: adviseRemedy('Check filesystem permissions on the worktree path, or investigate why statSync failed for it'),
    });
  }

  return diagnostics;
}

// ─── W017 — orphan git worktree (verify.cts:2222-2229) ─────────────────────
//
// `finding.kind === 'orphan'` — path no longer exists on disk. One
// Diagnostic per orphan finding. Remedy mirrors the exact original literal
// fix, `verify.cts:2227`: `'Run: git worktree prune'`.

function checkW017(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const finding of snapshot.worktreeHealth.value) {
    if (finding.kind !== 'orphan') continue;
    diagnostics.push({
      code: 'W017',
      severity: SEVERITY.WARNING,
      message: `Orphan git worktree: ${finding.path} (path no longer exists on disk)`,
      remedy: adviseRemedy('git worktree prune'),
    });
  }
  return diagnostics;
}

// ─── W027 — stale git worktree (verify.cts:2232-2249, the split-off half of
// the pre-migration 'W017' site) ─────────────────────────────────────────
//
// `finding.kind === 'stale'` — age-based. Excludes the active session's own
// worktree, restored via `snapshot.cwd` (see module doc, gap 2 — RESOLVED):
// a 'stale' finding is skipped when `snapshot.cwd` equals the finding's path
// or is nested under it, the exact comparison `verify.cts:2238-2241` made
// against `process.cwd()`. Per this batch's brief: the interpolated command
// (with the real path) lives in `message`; `remedy.args.command` stays a
// static `<path>` template, mirroring the split the brief specifies.

function checkW027(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const activeCwd = snapshot.cwd;
  for (const finding of snapshot.worktreeHealth.value) {
    if (finding.kind !== 'stale') continue;
    const normalizedWorktree = path.resolve(finding.path);
    const isActiveWorktree =
      activeCwd === normalizedWorktree || activeCwd.startsWith(normalizedWorktree + path.sep);
    if (isActiveWorktree) continue;
    diagnostics.push({
      code: 'W027',
      severity: SEVERITY.WARNING,
      message: `Stale git worktree: ${finding.path} (last modified ${finding.ageMinutes} minutes ago). Run: git worktree remove ${finding.path} --force`,
      remedy: adviseRemedy('git worktree remove <path> --force'),
    });
  }
  return diagnostics;
}

// ─── Exports ────────────────────────────────────────────────────────────────

const RULES: Rule[] = [
  { code: 'W020', severity: SEVERITY.WARNING, check: checkW020 },
  { code: 'W017', severity: SEVERITY.WARNING, check: checkW017 },
  { code: 'W027', severity: SEVERITY.WARNING, check: checkW027 },
];

export = { RULES };
