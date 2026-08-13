/**
 * Health Diagnostic Types — shared, dependency-free rule-table types (Phase
 * 11, #3309, ADR-3180 §8.2/§8.3/§8.5).
 *
 * Split out from `src/health-diagnostic.cts` to break a CJS circular
 * dependency between the evaluator and its own rule-group files
 * (`src/health-diagnostic-rules/*.cts`): those files need the frozen
 * `SEVERITY`/`REMEDY_ACTION`/`REMEDY_RISK` enums and the `Diagnostic`/
 * `Remedy`/`Rule` shapes, but the evaluator (`health-diagnostic.cts`) also
 * needs to `require()` every rule-group file to populate its `RULES` array —
 * a rule-group file requiring `health-diagnostic.cjs` back, mid-load, reads
 * `module.exports` before it is assigned, so the destructured enums come
 * back `undefined`. This leaf has NO runtime dependency on anything in that
 * cycle, so both sides can depend on it directly.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 * Test matrix: .gsd/phase/refactor-3309-health-diagnostic-rule-table/50-test-matrix.md
 *
 * ADR-457 build-at-publish: source in src/health-diagnostic-types.cts,
 * compiled to gsd-core/bin/lib/health-diagnostic-types.cjs (gitignored).
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

// ─── Exports ────────────────────────────────────────────────────────────────

const healthDiagnosticTypes = {
  SEVERITY,
  REMEDY_ACTION,
  REMEDY_RISK,
};

// Namespace merge (same binding name as the value above) is how a CommonJS
// `export =` module exposes a type alongside its runtime export — `export
// type` is rejected by TS2309 ("An export assignment cannot be used in a
// module with other exported elements") when combined with `export =`, so
// these types ride along on the exported object via declaration merging
// instead. Mirrors `src/planning-scope.cts`'s exact mechanism. Consumers
// doing `import x = require('./health-diagnostic-types.cjs')` can reference
// the types as `x.Severity`, `x.RemedyAction`, etc.
// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace healthDiagnosticTypes {
  export { Severity, RemedyAction, RemedyRisk, Remedy, Diagnostic, Rule };
}

export = healthDiagnosticTypes;
