/**
 * Health Diagnostic — frozen rule-table types, enums, and evaluator for
 * `validate health` (Phase 11, #3309, ADR-3180 §8.2/§8.3/§8.5).
 *
 * SKELETON (this phase). Establishes the exact contract every later batch of
 * extracted rules builds onto: the frozen `SEVERITY`/`REMEDY_ACTION`/
 * `REMEDY_RISK` enums, the `Diagnostic`/`Remedy`/`Rule` shapes, the `RULES`
 * container (starts EMPTY — a later migration step appends the 32 rules
 * extracted from `cmdValidateHealth`, `src/verify.cts:1616-2577`), the
 * `evaluateRules` evaluator, and the `applyRepairs` `--repair`/`--backfill`
 * dispatcher. `applyRepairs`'s per-action handlers are stubs in this phase —
 * they land alongside the rules that need them.
 *
 * `PlanningSnapshot` is deliberately NOT re-exported as a type from
 * `planning-snapshot.cts` here (see the design doc's "Known limits" and this
 * phase's brief): `ReturnType<typeof buildPlanningSnapshot>` is used inline
 * instead, via a type-only `import ... = require(...)` that is fully erased
 * at compile time — zero changes to the already-shipped, already-tested
 * `planning-snapshot.cts`.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 * Test matrix: .gsd/phase/refactor-3309-health-diagnostic-rule-table/50-test-matrix.md
 *
 * ADR-457 build-at-publish: source in src/health-diagnostic.cts, compiled to
 * gsd-core/bin/lib/health-diagnostic.cjs (gitignored).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- type-only; erased at compile time, no runtime require emitted
import type planningSnapshotMod = require('./planning-snapshot.cjs');

type PlanningSnapshot = ReturnType<typeof planningSnapshotMod.buildPlanningSnapshot>;

// Runtime values (SEVERITY/REMEDY_ACTION/REMEDY_RISK) are needed here — not
// just types — for `applyRepairs`'s comparisons, so this is a normal
// (non type-only) `import ... = require(...)`. `health-diagnostic-types.cjs`
// is the leaf module these enums/types were extracted to, so that this file
// can `require()` every rule-group file below without a circular dependency
// (see that module's file-level comment for the full explanation).
// eslint-disable-next-line @typescript-eslint/no-require-imports
import healthDiagnosticTypesMod = require('./health-diagnostic-types.cjs');
const { SEVERITY, REMEDY_ACTION, REMEDY_RISK } = healthDiagnosticTypesMod;
type Severity = healthDiagnosticTypesMod.Severity;
type RemedyAction = healthDiagnosticTypesMod.RemedyAction;
type RemedyRisk = healthDiagnosticTypesMod.RemedyRisk;
type Remedy = healthDiagnosticTypesMod.Remedy;
type Diagnostic = healthDiagnosticTypesMod.Diagnostic;
type Rule = healthDiagnosticTypesMod.Rule;

// ─── Rule table ─────────────────────────────────────────────────────────────

// Populated by concatenating each rule group's exported `RULES` array (design
// doc, "Rule table organization" section) — the 32 rule functions extracted
// from `cmdValidateHealth`, `src/verify.cts:1616-2577`.

// eslint-disable-next-line @typescript-eslint/no-require-imports
import rootExistenceMod = require('./health-diagnostic-rules/root-existence.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import stateConsistencyMod = require('./health-diagnostic-rules/state-consistency.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configValidationMod = require('./health-diagnostic-rules/config-validation.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseStructureMod = require('./health-diagnostic-rules/phase-structure.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import agentInstallMod = require('./health-diagnostic-rules/agent-install.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapDiskConsistencyMod = require('./health-diagnostic-rules/roadmap-disk-consistency.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import worktreeHealthMod = require('./health-diagnostic-rules/worktree-health.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import milestoneArchiveHygieneMod = require('./health-diagnostic-rules/milestone-archive-hygiene.cjs');

const RULES: Rule[] = [
  ...rootExistenceMod.RULES,
  ...stateConsistencyMod.RULES,
  ...configValidationMod.RULES,
  ...phaseStructureMod.RULES,
  ...agentInstallMod.RULES,
  ...roadmapDiskConsistencyMod.RULES,
  ...worktreeHealthMod.RULES,
  ...milestoneArchiveHygieneMod.RULES,
];

// ─── Evaluator ──────────────────────────────────────────────────────────────

/**
 * Evaluate an explicit `rules` array against `snapshot`, throwing if any two
 * entries share a `code` (defense in depth beside the future static lint
 * guard, §8.2 rule 1). Separated from `evaluateRules` so the duplicate-code
 * guard is unit-testable against a small, locally-constructed fake rule
 * array, independent of whether `RULES` itself has any entries yet (it does
 * not, in this skeleton).
 */
function evaluateRuleTable(rules: Rule[], snapshot: PlanningSnapshot): Diagnostic[] {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.code)) {
      throw new Error(`health-diagnostic: duplicate rule code "${rule.code}" in rule table`);
    }
    seen.add(rule.code);
  }
  return rules.flatMap((rule) => rule.check(snapshot));
}

/**
 * Evaluate every rule in `RULES` against `snapshot`, flattening each rule's
 * `Diagnostic[]` into one array.
 */
function evaluateRules(snapshot: PlanningSnapshot): Diagnostic[] {
  return evaluateRuleTable(RULES, snapshot);
}

// ─── Repair dispatcher ──────────────────────────────────────────────────────

/**
 * Stub repair handler. Real per-action handlers (`createConfig`,
 * `resetConfig`, `regenerateState`, `addNyquistKey`,
 * `addAiIntegrationPhaseKey`, `backfillMilestones`) land in a later
 * migration batch alongside the rules that need them — see this phase's
 * brief. Applying a NONE-risk remedy is a no-op beyond recording it, in this
 * skeleton.
 */
function applyStubRepair(_cwd: string, _diagnostic: Diagnostic): void {
  /* intentionally empty — real handlers land with the rules that need them */
}

/**
 * `--repair`/`--backfill` dispatcher (design doc "`--repair` behavior
 * change" section; §8.3 rule 3). For each diagnostic whose remedy is not
 * `ADVISE`:
 *
 * - Not requested — `repair` is false, and for `backfillMilestones`
 *   specifically `backfill` is also false (mirrors `cmdValidateHealth`'s
 *   existing `backfillMilestones` gate, `verify.cts:2504`:
 *   `if (!options['backfill'] && !options['repair']) break;`) — skipped
 *   entirely, recorded in neither `applied` nor `refused`.
 * - Requested and `remedy.risk === DESTRUCTIVE` — pushed onto `refused`,
 *   handler never invoked. This is the §8.3 rule 3 breaking-change
 *   enforcement point: a DESTRUCTIVE remedy is describable but is never
 *   applied by `--repair`.
 * - Requested and `remedy.risk === NONE` — stub handler invoked, pushed
 *   onto `applied`.
 */
function applyRepairs(
  cwd: string,
  diagnostics: Diagnostic[],
  repair: boolean,
  backfill: boolean,
): { applied: string[]; refused: string[] } {
  const applied: string[] = [];
  const refused: string[] = [];

  for (const diagnostic of diagnostics) {
    const { remedy } = diagnostic;
    if (remedy.action === REMEDY_ACTION.ADVISE) continue;

    const requested =
      remedy.action === REMEDY_ACTION.BACKFILL_MILESTONES ? repair || backfill : repair;
    if (!requested) continue;

    if (remedy.risk === REMEDY_RISK.DESTRUCTIVE) {
      refused.push(diagnostic.code);
      continue;
    }

    applyStubRepair(cwd, diagnostic);
    applied.push(diagnostic.code);
  }

  return { applied, refused };
}

// ─── Exports ────────────────────────────────────────────────────────────────

const healthDiagnostic = {
  SEVERITY,
  REMEDY_ACTION,
  REMEDY_RISK,
  RULES,
  evaluateRules,
  // Additive beyond the phase's required-exports list — exposed so the
  // duplicate-code guard (row 13) is directly unit-testable against a fake
  // rule array without mutating the real, still-empty `RULES` export.
  evaluateRuleTable,
  applyRepairs,
};

// Namespace merge (same binding name as the value above) is how a CommonJS
// `export =` module exposes a type alongside its runtime export — `export
// type` is rejected by TS2309 ("An export assignment cannot be used in a
// module with other exported elements") when combined with `export =`, so
// these types ride along on the exported object via declaration merging
// instead. Mirrors `src/planning-scope.cts`'s exact mechanism. Consumers
// doing `import x = require('./health-diagnostic.cjs')` can reference the
// types as `x.Severity`, `x.RemedyAction`, etc.
// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace healthDiagnostic {
  export { Severity, RemedyAction, RemedyRisk, Remedy, Diagnostic, Rule };
}

export = healthDiagnostic;
