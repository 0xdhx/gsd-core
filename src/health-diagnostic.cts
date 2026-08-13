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

// ─── Severity ───────────────────────────────────────────────────────────────

const SEVERITY = Object.freeze({
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
});
type Severity = (typeof SEVERITY)[keyof typeof SEVERITY];

// ─── Remedy action / risk ───────────────────────────────────────────────────

// Harvested from health.md's published table + the corrected 6-action
// implementation (`src/verify.cts:2405-2553`) — not 5; `addAiIntegrationPhaseKey`
// (verify.cts:1860/2481-2502) was live in code, missing from docs (design
// doc, "Ground truth vs. issue #3309's claims" section).
const REMEDY_ACTION = Object.freeze({
  CREATE_CONFIG: 'createConfig',
  RESET_CONFIG: 'resetConfig',
  REGENERATE_STATE: 'regenerateState',
  ADD_NYQUIST_KEY: 'addNyquistKey',
  ADD_AI_INTEGRATION_PHASE_KEY: 'addAiIntegrationPhaseKey',
  BACKFILL_MILESTONES: 'backfillMilestones',
  // §8.3 rule 5 — every non-repairable finding's `fix` string becomes an
  // ADVISE payload; ADVISE never acts, only describes.
  ADVISE: 'advise',
});
type RemedyAction = (typeof REMEDY_ACTION)[keyof typeof REMEDY_ACTION];

const REMEDY_RISK = Object.freeze({
  NONE: 'none',
  DESTRUCTIVE: 'destructive',
});
type RemedyRisk = (typeof REMEDY_RISK)[keyof typeof REMEDY_RISK];

// ─── Diagnostic / Rule shapes ───────────────────────────────────────────────

interface Remedy {
  action: RemedyAction;
  risk: RemedyRisk;
  args: Record<string, unknown>;
}

interface Diagnostic {
  code: string; // e.g. 'W010' — append-only, never renumbered (§8.2 rule 2)
  severity: Severity; // property of the RULE, never the emit call (§8.2 rule 3)
  message: string;
  remedy: Remedy;
}

interface Rule {
  code: string;
  severity: Severity;
  check: (snapshot: PlanningSnapshot) => Diagnostic[]; // §8.1 rule 1 signature, verbatim
}

// ─── Rule table ─────────────────────────────────────────────────────────────

// Starts EMPTY. A later migration batch appends each of the 32 rule
// functions extracted from `cmdValidateHealth` (design doc, "Rule table
// organization" section) — this phase establishes only the container and its
// type.
const RULES: Rule[] = [];

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
