'use strict';

/**
 * Tests for `src/health-diagnostic.cts` (Phase 11, #3309, ADR-3180 §8.2/§8.3/§8.5).
 *
 * Design:       .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 * Test matrix:  .gsd/phase/refactor-3309-health-diagnostic-rule-table/50-test-matrix.md
 *
 * This file covers ONLY the skeleton's own contract — test-matrix section 2,
 * rows 9-14. `RULES` starts EMPTY in this phase (later batches append the 32
 * extracted rules); rows 15-16 (the DESTRUCTIVE-refusal proof against REAL
 * diagnostics emitted by real rules) and section 3 (per-rule fixtures) are
 * deferred to the migration step that adds rules. This file DOES prove
 * `applyRepairs`'s risk-gating logic directly against hand-constructed fake
 * `Diagnostic` objects, independent of whether any real rule produces them
 * yet — per this phase's brief.
 *
 * TDD RED: `src/health-diagnostic.cts` does not exist yet — this file's
 * `require('../gsd-core/bin/lib/health-diagnostic.cjs')` throws
 * MODULE_NOT_FOUND until this phase's implementation lands. That is the
 * intended starting state.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const healthDiagnostic = require('../gsd-core/bin/lib/health-diagnostic.cjs');

const {
  SEVERITY,
  REMEDY_ACTION,
  REMEDY_RISK,
  RULES,
  evaluateRules,
  evaluateRuleTable,
  applyRepairs,
} = healthDiagnostic;

// ─── Row 9 — REMEDY_ACTION locks exactly 7 members ─────────────────────────

describe('REMEDY_ACTION', () => {
  test('row 9: locks exactly 7 members (6 real repair actions + ADVISE)', () => {
    assert.deepEqual(Object.keys(REMEDY_ACTION).sort(), [
      'ADD_AI_INTEGRATION_PHASE_KEY',
      'ADD_NYQUIST_KEY',
      'ADVISE',
      'BACKFILL_MILESTONES',
      'CREATE_CONFIG',
      'REGENERATE_STATE',
      'RESET_CONFIG',
    ]);
    assert.deepEqual(
      Object.values(REMEDY_ACTION).sort(),
      [
        'addAiIntegrationPhaseKey',
        'addNyquistKey',
        'advise',
        'backfillMilestones',
        'createConfig',
        'regenerateState',
        'resetConfig',
      ],
    );
  });

  test('is frozen', () => {
    assert.equal(Object.isFrozen(REMEDY_ACTION), true);
  });
});

// ─── Row 10 — REMEDY_RISK locks exactly 2 members ──────────────────────────

describe('REMEDY_RISK', () => {
  test('row 10: locks exactly 2 members (NONE, DESTRUCTIVE)', () => {
    assert.deepEqual(Object.keys(REMEDY_RISK).sort(), ['DESTRUCTIVE', 'NONE']);
    assert.deepEqual(Object.values(REMEDY_RISK).sort(), ['destructive', 'none']);
  });

  test('is frozen', () => {
    assert.equal(Object.isFrozen(REMEDY_RISK), true);
  });
});

describe('SEVERITY', () => {
  test('locks exactly 3 members (ERROR, WARNING, INFO)', () => {
    assert.deepEqual(Object.keys(SEVERITY).sort(), ['ERROR', 'INFO', 'WARNING']);
    assert.deepEqual(Object.values(SEVERITY).sort(), ['error', 'info', 'warning']);
  });

  test('is frozen', () => {
    assert.equal(Object.isFrozen(SEVERITY), true);
  });
});

// ─── Rows 11-12 — applyRepairs risk-gating, hand-constructed diagnostics ───
//
// No real rule exists yet to emit these remedies (RULES is empty in this
// skeleton). These diagnostics are hand-built using the risk harvested from
// health.md's published table (design doc, "Risk assignment" section):
// resetConfig/regenerateState are DESTRUCTIVE; every other real action is
// NONE. This proves applyRepairs's gating logic is correct independent of
// whether any real rule exists to produce these shapes yet.

function fakeDiagnostic(code, action, risk) {
  return {
    code,
    severity: SEVERITY.WARNING,
    message: `fake diagnostic for ${code}`,
    remedy: { action, risk, args: {} },
  };
}

describe('applyRepairs — risk gating (hand-constructed diagnostics)', () => {
  test('row 11: resetConfig/regenerateState (DESTRUCTIVE) are refused, never applied, when --repair is requested', () => {
    const diagnostics = [
      fakeDiagnostic('E005', REMEDY_ACTION.RESET_CONFIG, REMEDY_RISK.DESTRUCTIVE),
      fakeDiagnostic('E004', REMEDY_ACTION.REGENERATE_STATE, REMEDY_RISK.DESTRUCTIVE),
    ];
    const result = applyRepairs('/fake/cwd', diagnostics, true, false);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.refused.sort(), ['E004', 'E005']);
  });

  test('row 12: every other real action (NONE risk) is applied, not refused, when --repair is requested', () => {
    const diagnostics = [
      fakeDiagnostic('W003', REMEDY_ACTION.CREATE_CONFIG, REMEDY_RISK.NONE),
      fakeDiagnostic('W008', REMEDY_ACTION.ADD_NYQUIST_KEY, REMEDY_RISK.NONE),
      fakeDiagnostic('W016', REMEDY_ACTION.ADD_AI_INTEGRATION_PHASE_KEY, REMEDY_RISK.NONE),
      fakeDiagnostic('W018', REMEDY_ACTION.BACKFILL_MILESTONES, REMEDY_RISK.NONE),
    ];
    const result = applyRepairs('/fake/cwd', diagnostics, true, false);
    assert.deepEqual(result.applied.sort(), ['W003', 'W008', 'W016', 'W018']);
    assert.deepEqual(result.refused, []);
  });

  test('ADVISE-action diagnostics are never applied nor refused, regardless of --repair', () => {
    const diagnostics = [fakeDiagnostic('W001', REMEDY_ACTION.ADVISE, REMEDY_RISK.NONE)];
    const result = applyRepairs('/fake/cwd', diagnostics, true, true);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.refused, []);
  });

  test('non-backfillMilestones NONE-risk diagnostics are skipped (not applied) when --repair is not requested', () => {
    const diagnostics = [fakeDiagnostic('W003', REMEDY_ACTION.CREATE_CONFIG, REMEDY_RISK.NONE)];
    const result = applyRepairs('/fake/cwd', diagnostics, false, false);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.refused, []);
  });

  test('DESTRUCTIVE-risk diagnostics are skipped (not refused) when --repair is not requested — refusal only fires when actually requested', () => {
    const diagnostics = [fakeDiagnostic('E005', REMEDY_ACTION.RESET_CONFIG, REMEDY_RISK.DESTRUCTIVE)];
    const result = applyRepairs('/fake/cwd', diagnostics, false, false);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.refused, []);
  });

  test('backfillMilestones applies on --backfill alone, without --repair (mirrors verify.cts:2504 intent)', () => {
    const diagnostics = [fakeDiagnostic('W018', REMEDY_ACTION.BACKFILL_MILESTONES, REMEDY_RISK.NONE)];
    const result = applyRepairs('/fake/cwd', diagnostics, false, true);
    assert.deepEqual(result.applied, ['W018']);
    assert.deepEqual(result.refused, []);
  });

  test('backfillMilestones is skipped when neither --repair nor --backfill is set', () => {
    const diagnostics = [fakeDiagnostic('W018', REMEDY_ACTION.BACKFILL_MILESTONES, REMEDY_RISK.NONE)];
    const result = applyRepairs('/fake/cwd', diagnostics, false, false);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.refused, []);
  });
});

// ─── Row 13 — duplicate-code detection, LOCAL fake rule array ──────────────
//
// `RULES` is still empty in this skeleton, so the duplicate check cannot be
// exercised through the real exported table yet. Proven here instead against
// a small, locally-constructed fake rule array — per this phase's brief.

describe('evaluateRuleTable — duplicate-code guard (row 13)', () => {
  test('throws when two rules share the same code', () => {
    const fakeRules = [
      { code: 'W999', severity: SEVERITY.WARNING, check: () => [] },
      { code: 'W999', severity: SEVERITY.WARNING, check: () => [] },
    ];
    assert.throws(() => evaluateRuleTable(fakeRules, {}), /W999/);
  });

  test('does not throw, and flattens all diagnostics, when codes are unique', () => {
    const fakeRules = [
      {
        code: 'W997',
        severity: SEVERITY.WARNING,
        check: () => [
          { code: 'W997', severity: SEVERITY.WARNING, message: 'a', remedy: { action: REMEDY_ACTION.ADVISE, risk: REMEDY_RISK.NONE, args: {} } },
        ],
      },
      {
        code: 'W998',
        severity: SEVERITY.WARNING,
        check: () => [
          { code: 'W998', severity: SEVERITY.WARNING, message: 'b', remedy: { action: REMEDY_ACTION.ADVISE, risk: REMEDY_RISK.NONE, args: {} } },
          { code: 'W998', severity: SEVERITY.WARNING, message: 'c', remedy: { action: REMEDY_ACTION.ADVISE, risk: REMEDY_RISK.NONE, args: {} } },
        ],
      },
    ];
    const diagnostics = evaluateRuleTable(fakeRules, {});
    assert.equal(diagnostics.length, 3);
    assert.deepEqual(diagnostics.map((d) => d.message), ['a', 'b', 'c']);
  });

  test('empty rule array never throws and returns []', () => {
    assert.deepEqual(evaluateRuleTable([], {}), []);
  });
});

// ─── Row 14 — evaluator against an all-clean (here: rule-less) snapshot ───

describe('evaluateRules (row 14)', () => {
  test('RULES starts empty in this skeleton', () => {
    assert.deepEqual(RULES, []);
    assert.equal(Array.isArray(RULES), true);
  });

  test('returns [] against any snapshot, since RULES is empty', () => {
    assert.deepEqual(evaluateRules({}), []);
  });
});
