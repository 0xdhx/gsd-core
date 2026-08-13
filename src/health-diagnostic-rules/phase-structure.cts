/**
 * Health Diagnostic — Phase directory structure rules (Phase 11, #3309,
 * ADR-3180 §8.2/§8.3/§8.5).
 *
 * Group: "Phase directory structure" (design doc, "Rule table organization"
 * table) — W005, W023, I001, W009.
 *
 * Ported behavior-preserving from `cmdValidateHealth`
 * (`src/verify.cts:1893-1990`, the exact call sites for W005/W023/I001/W009),
 * with two disclosed fidelity reductions forced by `PlanningSnapshot`'s
 * current shape (see each rule's own comment below):
 *
 * - I001 cannot name the individual unsummarized PLAN filename (`snapshot.
 *   phases.value[i]` exposes only `planCount`/`summaryCount`, not per-plan
 *   filenames) — this rule reports a coarser per-PHASE message instead.
 * - W023's original "described" list called `determinePhaseStatus`
 *   (`commands.cts:154`), a SIX-way status string ('Not Started'/'Planned'/
 *   'In Progress'/'Executed'/'Needs Review'/'Complete') computed from its own
 *   raw `readdirSync` + `*-VERIFICATION.md` frontmatter read of `phaseDir` —
 *   neither `PhaseSnapshot.complete` (a boolean) nor `PhaseSnapshot.
 *   verificationStatus` (the DIFFERENT, `readVerificationStatus`-routed
 *   status vocabulary: 'passed'/'gaps_found'/'human_needed'/'stale'/
 *   'unknown'/'missing', §7.4 disk-strict) reproduces that six-way string
 *   byte-for-byte — the two computations read the same file independently
 *   and can disagree (e.g. a stale-but-frontmatter-"passed" VERIFICATION.md
 *   reads 'Complete' under the original raw read but routes to a non-'passed'
 *   `verificationStatus` under §7.4's staleness handling). Reproducing the
 *   raw frontmatter read here would violate §8.1 rule 1 (no ambient I/O in a
 *   rule's `check`). This rule instead describes each colliding directory
 *   with the snapshot fields actually available (`planCount`, `summaryCount`,
 *   `verificationStatus`) — a disclosed fidelity reduction, not a silent
 *   reproduction of the original six-way label.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 *
 * ADR-457 build-at-publish: source in
 * src/health-diagnostic-rules/phase-structure.cts, compiled to
 * gsd-core/bin/lib/health-diagnostic-rules/phase-structure.cjs (gitignored).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- type-only; erased at compile time, no runtime require emitted
import type planningSnapshotMod = require('../planning-snapshot.cjs');

type PlanningSnapshot = ReturnType<typeof planningSnapshotMod.buildPlanningSnapshot>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import healthDiagnosticMod = require('../health-diagnostic.cjs');
const { SEVERITY, REMEDY_ACTION, REMEDY_RISK } = healthDiagnosticMod;
type Diagnostic = healthDiagnosticMod.Diagnostic;
type Rule = healthDiagnosticMod.Rule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import validateMod = require('../validate.cjs');
const { phaseDirNameRe } = validateMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('../phase-id.cjs');
const { extractPhaseToken, normalizePhaseName, comparePhaseNum } = phaseIdMod;

// ─── W005 — phase directory doesn't follow NN-name format (verify.cts:1893-1902) ─

function checkW005(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const name of snapshot.phaseDirs.value) {
    if (!name.match(phaseDirNameRe)) {
      diagnostics.push({
        code: 'W005',
        severity: SEVERITY.WARNING,
        message: `Phase directory "${name}" doesn't follow NN-name format`,
        remedy: {
          action: REMEDY_ACTION.ADVISE,
          risk: REMEDY_RISK.NONE,
          args: { command: 'Rename to match pattern (e.g., 01-setup)' },
        },
      });
    }
  }
  return diagnostics;
}

// ─── W023 — phase directories collide on normalized key (verify.cts:1904-1950) ─
//
// Groups `snapshot.phaseDirs.value` by `normalizePhaseName(extractPhaseToken(name))`
// — the exact same two owners (`phase-id.cjs`) the original `verify.cts:1917-1918`
// call site uses, relocated verbatim rather than reimplemented. Sorted with
// `comparePhaseNum` + a `localeCompare` tiebreak, mirroring
// `verify.cts:1930-1932`'s deterministic-output rationale. See the file-level
// comment for the disclosed "described" fidelity reduction.

function checkW023(snapshot: PlanningSnapshot): Diagnostic[] {
  const groups = new Map<string, string[]>();
  for (const name of snapshot.phaseDirs.value) {
    const token = extractPhaseToken(name);
    const key = normalizePhaseName(token);
    const list = groups.get(key);
    if (list) list.push(name);
    else groups.set(key, [name]);
  }

  const phaseByDir = new Map(snapshot.phases.value.map((p) => [p.dir, p]));

  const diagnostics: Diagnostic[] = [];
  for (const [key, dirs] of groups) {
    if (dirs.length < 2) continue;
    const described = dirs
      .slice()
      .sort((a, b) => comparePhaseNum(a, b) || String(a).localeCompare(String(b)))
      .map((d) => {
        const phase = phaseByDir.get(d);
        const plans = phase ? phase.planCount : 0;
        const summaries = phase ? phase.summaryCount : 0;
        const verificationStatus = phase ? phase.verificationStatus : 'missing';
        return `${d} (plans: ${plans}, summaries: ${summaries}, verification: ${verificationStatus})`;
      })
      .join(', ');
    diagnostics.push({
      code: 'W023',
      severity: SEVERITY.WARNING,
      message: `Phase directories collide on normalized key "${key}": ${described}`,
      remedy: {
        action: REMEDY_ACTION.ADVISE,
        risk: REMEDY_RISK.NONE,
        args: {
          command:
            'Inspect each directory; rename or remove the duplicate so only one directory maps to this phase key',
        },
      },
    });
  }
  return diagnostics;
}

// ─── I001 — plan(s) without a matching SUMMARY.md (verify.cts:1952-1965) ───
//
// GENUINE FIDELITY GAP (see file-level comment): the original is PER-PLAN
// (`${e.name}/${plan} has no SUMMARY.md`, `plan` an individual PLAN.md
// filename from `findUnsummarizedPlans`). `PlanningSnapshot`'s
// `phases.value[i]` carries only `planCount`/`summaryCount` NUMBERS per
// phase — no per-plan filenames — so this rule cannot name which plan lacks
// a summary without reading the phase directory directly inside `check`
// (forbidden by §8.1 rule 1). This rule instead reports one coarser
// per-PHASE diagnostic naming the deficit count, not the individual
// filename(s).

function checkI001(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const phase of snapshot.phases.value) {
    const deficit = phase.planCount - phase.summaryCount;
    if (deficit > 0) {
      diagnostics.push({
        code: 'I001',
        severity: SEVERITY.INFO,
        message: `Phase ${phase.dir} has ${deficit} plan(s) without a matching summary`,
        remedy: {
          action: REMEDY_ACTION.ADVISE,
          risk: REMEDY_RISK.NONE,
          args: { command: 'May be in progress' },
        },
      });
    }
  }
  return diagnostics;
}

// ─── W009 — Validation Architecture in RESEARCH.md but no VALIDATION.md ────
// (verify.cts:1967-1990)

function checkW009(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const entry of snapshot.researchValidationStatus.value) {
    if (entry.hasValidationArchitecture && !entry.hasValidationMd) {
      diagnostics.push({
        code: 'W009',
        severity: SEVERITY.WARNING,
        message: `Phase ${entry.dir}: has Validation Architecture in RESEARCH.md but no VALIDATION.md`,
        remedy: {
          action: REMEDY_ACTION.ADVISE,
          risk: REMEDY_RISK.NONE,
          args: { command: 'Re-run /gsd-plan-phase with --research to regenerate' },
        },
      });
    }
  }
  return diagnostics;
}

// ─── Exports ────────────────────────────────────────────────────────────────

const RULES: Rule[] = [
  { code: 'W005', severity: SEVERITY.WARNING, check: checkW005 },
  { code: 'W023', severity: SEVERITY.WARNING, check: checkW023 },
  { code: 'I001', severity: SEVERITY.INFO, check: checkI001 },
  { code: 'W009', severity: SEVERITY.WARNING, check: checkW009 },
];

export = { RULES };
