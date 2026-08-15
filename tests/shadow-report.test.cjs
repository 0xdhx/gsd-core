'use strict';

/**
 * tests/shadow-report.test.cjs — pure IR unit suite for
 * `install-shadow-report.cts`'s `buildShadowReport` (#2873, epic #2866 Phase
 * 4a — governed by `.gsd/phase/feat-2873-cross-scope-shadowing/40-design.md`).
 *
 * Implements matrix section A (`buildShadowReport()`, rows A1-A24) and
 * properties F1/F4 from `.gsd/phase/feat-2873-cross-scope-shadowing/50-test-matrix.md`.
 * The matrix's own "Suites" section names this file `install-shadow-report
 * .test.cjs`; it is shipped as `shadow-report.test.cjs` instead so its
 * `lint-test-file-count.cjs` prefix is `shadow` (0 files before this PR, at
 * the 2-file cap after it) rather than colliding with the already
 * grandfathered, already-at-cap `install` prefix bucket.
 *
 * A21-A24 cover the per-scope truth filter (#2873 Task 1): a `full`-profile
 * global install alongside a `core`-profile local install must never report
 * the profile-only stems as shadowed local artifacts that do not exist on
 * disk. F1 is updated in lockstep — its expected shadowed set is now the
 * INTERSECTION of the two scopes' stems, not their union.
 *
 * F4 ("4b transform is idempotent over arbitrary bodies") targets
 * `resolveSpecRootReference` (`runtime-artifact-conversion.cts`, #2873 Phase
 * 4b), which has since landed — see the "F4" describe block below.
 *
 * Fixture strategy mirrors `tests/installed-surface-resolver.test.cjs`
 * (`buildShadowReport` forwards its `opts` verbatim to
 * `resolveInstalledSurfaces`): an injectable `readManifest` keyed by the
 * REAL `configHome` `resolveScope` computes for a given runtime/scope, never
 * a hand-typed path literal.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  buildShadowReport,
  renderShadowReport,
  SHADOW_REASON,
} = require('../gsd-core/bin/lib/install-shadow-report.cjs');
const { resolveScope } = require('../gsd-core/bin/lib/install-scope.cjs');
const { MANIFEST_NAME } = require('../gsd-core/bin/lib/installer-migrations.cjs');
const { resolveSpecRootReference } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

// ─── Fixture helpers (mirrors tests/installed-surface-resolver.test.cjs) ───

const ABSENT_MANIFEST = Object.freeze({ manifestVersion: null, runtime: null, scope: null, files: {} });

function manifest({ manifestVersion = null, runtime = null, scope = null, files = {} } = {}) {
  return { manifestVersion, runtime, scope, files };
}

function mkReadManifest(byConfigHome) {
  return (configDir) => byConfigHome.get(configDir) ?? ABSENT_MANIFEST;
}

function scopeHomes(runtime, home, cwd) {
  const base = { runtime, env: {}, home, existsSync: () => false, cwd };
  return {
    global: resolveScope({ ...base, id: 'global' }).configHome,
    local: resolveScope({ ...base, id: 'local' }).configHome,
  };
}

function baseOpts(home, cwd, overrides = {}) {
  return { home, cwd, env: {}, existsSync: () => false, ...overrides };
}

/** `commands/gsd/*.md` stems shipped by the real repo — used so A1's "71
 *  entries" tracks the real roster instead of a hardcoded, driftable count. */
const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');
const REAL_STEMS = fs.readdirSync(REAL_COMMANDS_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.slice(0, -3))
  .sort();

function skillFilesFor(stems) {
  const files = {};
  for (const s of stems) files[`skills/gsd-${s}/SKILL.md`] = 'x';
  return files;
}

function commandFilesFor(stems) {
  const files = {};
  for (const s of stems) files[`commands/gsd-${s}.md`] = 'x';
  return files;
}

/** Build a claude coexistence fixture: `stems` installed as global skills AND
 *  local commands (so every one of them is a shadowed trigger). */
function coexistenceOpts(home, cwd, stems, overrides = {}) {
  const homes = scopeHomes('claude', home, cwd);
  const byConfigHome = new Map([
    [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: skillFilesFor(stems) })],
    [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: commandFilesFor(stems) })],
  ]);
  return baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome), ...overrides });
}

// ─── A1-A6 — shape happy/negative paths ────────────────────────────────────

describe('buildShadowReport — shape (A1-A6)', () => {
  test('reports shadowing for a claude coexistence, full real roster (A1)', () => {
    const home = '/fixture/a1-home';
    const cwd = '/fixture/a1-cwd';
    const report = buildShadowReport('claude', coexistenceOpts(home, cwd, REAL_STEMS));
    assert.strictEqual(report.shadowed, true);
    assert.strictEqual(report.reason, SHADOW_REASON.SCOPE_SHADOWED);
    assert.strictEqual(report.triggers.length, REAL_STEMS.length);
    assert.deepStrictEqual(report.winner, { kind: 'skills', scope: 'global' });
    assert.deepStrictEqual(report.shadowedSide, { kind: 'commands', scope: 'local' });
    assert.deepStrictEqual(report.triggers.map((t) => t.trigger).sort(), REAL_STEMS.map((s) => `gsd-${s}`));
  });

  test('no report for a single scope, global only (A2)', () => {
    const home = '/fixture/a2-home';
    const cwd = '/fixture/a2-cwd';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: skillFilesFor(['plan-phase']) })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.shadowed, false);
    assert.strictEqual(report.reason, SHADOW_REASON.NOT_SHADOWED);
    assert.deepStrictEqual(report.triggers, []);
  });

  test('no report for local-only (A3)', () => {
    const home = '/fixture/a3-home';
    const cwd = '/fixture/a3-cwd';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: commandFilesFor(['plan-phase']) })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.shadowed, false);
    assert.deepStrictEqual(report.triggers, []);
  });

  test('same-kind shadowing is reported as override, not a vanished tree (A4)', () => {
    const home = '/fixture/a4-home';
    const cwd = '/fixture/a4-cwd';
    const homes = scopeHomes('cursor', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'cursor', scope: 'global', files: skillFilesFor(['plan-phase']) })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'cursor', scope: 'local', files: skillFilesFor(['plan-phase']) })],
    ]);
    const report = buildShadowReport('cursor', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.shadowed, true);
    assert.strictEqual(report.kindsDiffer, false);
    assert.deepStrictEqual(report.winner, { kind: 'skills', scope: 'global' });
    assert.deepStrictEqual(report.shadowedSide, { kind: 'skills', scope: 'local' });
  });

  test('windsurf asymmetry does not collide (A5)', () => {
    const home = '/fixture/a5-home';
    const cwd = '/fixture/a5-cwd';
    const homes = scopeHomes('windsurf', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'windsurf', scope: 'global', files: { 'agents/gsd-planner.md': 'a' } })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'windsurf', scope: 'local', files: { 'workflows/gsd-plan-phase.md': 'a' } })],
    ]);
    const report = buildShadowReport('windsurf', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.shadowed, false);
  });

  test('same config home is not self-shadowing (A6)', () => {
    const shared = '/fixture/a6-shared-home';
    const homes = scopeHomes('claude', shared, shared);
    assert.strictEqual(homes.global, homes.local, 'fixture assumption: both scopes collapse to one configHome');
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: skillFilesFor(['plan-phase']) })],
    ]);
    const report = buildShadowReport('claude', baseOpts(shared, shared, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.shadowed, false);
  });
});

// ─── A7-A10 — SAMPLE_LIMIT boundary (limit-1, limit, limit+1) ──────────────

describe('buildShadowReport — sample-limit boundary (A7-A10)', () => {
  test('zero triggers renders nothing (A7, limit-1 in the sense of "below any sample")', () => {
    const home = '/fixture/a7-home';
    const cwd = '/fixture/a7-cwd';
    const homes = scopeHomes('claude', home, cwd);
    // Both scopes installed (manifestVersion set) but with an empty `files`
    // map each — `deriveStemsFromManifest` short-circuits to `[]` for an
    // empty `files` BEFORE resolving a layout at all (installed-surface-
    // resolver.cts's C13), so the stem union across both scopes is empty and
    // no trigger is ever synthesized. NOT a disjoint-stems fixture: because
    // `resolveInstalledSurfaces` unions stems across every INSTALLED scope
    // (not per-scope), two scopes installed with genuinely DIFFERENT,
    // non-empty stem sets still produce a shadowed entry for each stem in
    // the union — see A12's comment for the same mechanism.
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: {} })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: {} })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.shadowed, false);
    assert.deepStrictEqual(report.triggers, []);
    assert.deepStrictEqual(renderShadowReport(report), []);
  });

  test('single trigger has no overflow tail (A8, limit=1)', () => {
    const home = '/fixture/a8-home';
    const cwd = '/fixture/a8-cwd';
    const report = buildShadowReport('claude', coexistenceOpts(home, cwd, ['solo']));
    assert.strictEqual(report.triggers.length, 1);
    const lines = renderShadowReport(report);
    // header + exactly one sample line, no "...and N more" tail, no mismatch notes.
    assert.strictEqual(lines.length, 2);
  });

  test('sample limit exactly, 5 shadowed (A9)', () => {
    const home = '/fixture/a9-home';
    const cwd = '/fixture/a9-cwd';
    const stems = ['s1', 's2', 's3', 's4', 's5'];
    const report = buildShadowReport('claude', coexistenceOpts(home, cwd, stems));
    assert.strictEqual(report.triggers.length, 5);
    const lines = renderShadowReport(report);
    // header + 5 samples, still no tail.
    assert.strictEqual(lines.length, 6);
  });

  test('sample limit plus one, 6 shadowed (A10)', () => {
    const home = '/fixture/a10-home';
    const cwd = '/fixture/a10-cwd';
    const stems = ['s1', 's2', 's3', 's4', 's5', 's6'];
    const report = buildShadowReport('claude', coexistenceOpts(home, cwd, stems));
    assert.strictEqual(report.triggers.length, 6);
    const lines = renderShadowReport(report);
    // header + 5 samples + one overflow-tail line.
    assert.strictEqual(lines.length, 7);
  });
});

// ─── A11-A13 — manifest content edge cases ─────────────────────────────────

describe('buildShadowReport — manifest content edge cases (A11-A13)', () => {
  test('v1 manifest still reports shadowing, identical to v2, no reinstall signal in the IR (A11)', () => {
    const home = '/fixture/a11-home';
    const cwd = '/fixture/a11-cwd';
    const homesV1 = scopeHomes('claude', home, cwd);
    const byConfigHomeV1 = new Map([
      [homesV1.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: skillFilesFor(['plan-phase']) })],
      // v1: no manifestVersion key at all, normalized to 1; no declared runtime/scope.
      [homesV1.local, manifest({ manifestVersion: 1, runtime: null, scope: null, files: commandFilesFor(['plan-phase']) })],
    ]);
    const reportV1 = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHomeV1) }));

    const byConfigHomeV2 = new Map([
      [homesV1.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: skillFilesFor(['plan-phase']) })],
      [homesV1.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: commandFilesFor(['plan-phase']) })],
    ]);
    const reportV2 = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHomeV2) }));

    assert.strictEqual(reportV1.shadowed, true);
    assert.deepStrictEqual(reportV1, reportV2, 'a v1-backed report must be structurally identical to its v2 counterpart');

    // No reinstall/version signal anywhere in the IR's shape.
    assert.ok(!('manifestVersion' in reportV1));
    for (const trig of reportV1.triggers) assert.ok(!('manifestVersion' in trig));
    for (const m of reportV1.mismatches) assert.ok(!('manifestVersion' in m));
  });

  test('empty manifest yields no triggers (A12)', () => {
    const home = '/fixture/a12-home';
    const cwd = '/fixture/a12-cwd';
    const homes = scopeHomes('claude', home, cwd);
    // Deliberately only ONE scope present, with an empty `files` map — the
    // clean exercise of the empty-files short-circuit (deriveStemsFromManifest's
    // C13) in isolation. A COEXISTENCE fixture (both scopes installed, one
    // side's `files: {}`) does NOT stay `shadowed: false`: because
    // `resolveInstalledSurfaces` unions stems across every scope it counts as
    // installed (manifestVersion set, regardless of that scope's own file
    // count) rather than per-scope, a real stem contributed by the OTHER,
    // populated scope still gets a synthesized trigger at this empty one —
    // see `installed-surface-resolver.cts`'s `stemUnion` computation. That is
    // established, already-tested Phase 3 (#2872) behavior (the roster is
    // assumed uniform across installed scopes), not something this row
    // exercises.
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: {} })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.shadowed, false);
    assert.deepStrictEqual(report.triggers, []);
  });

  test('unreadable manifest degrades, never throws (A13)', () => {
    const home = '/fixture/a13-home';
    const cwd = '/fixture/a13-cwd';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: skillFilesFor(['plan-phase']) })],
    ]);
    const readManifest = (configDir) => {
      if (configDir === homes.local) throw new Error('EACCES: permission denied');
      return byConfigHome.get(configDir) ?? ABSENT_MANIFEST;
    };
    let report;
    assert.doesNotThrow(() => {
      report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest }));
    });
    assert.strictEqual(report.shadowed, false);
  });
});

// ─── A14-A15 — declared-runtime/scope mismatch surfaced, not corrected ─────

describe('buildShadowReport — mismatches are reported, never corrected (A14-A15)', () => {
  test('declared runtime mismatch is surfaced (A14)', () => {
    const home = '/fixture/a14-home';
    const cwd = '/fixture/a14-cwd';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'cursor', scope: 'global', files: skillFilesFor(['plan-phase']) })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: commandFilesFor(['plan-phase']) })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.mismatches.length, 1);
    assert.strictEqual(report.mismatches[0].scope, 'global');
    assert.strictEqual(report.mismatches[0].declaredRuntime, 'cursor');
    assert.strictEqual(report.mismatches[0].declaredRuntimeMatchesProbe, false);
  });

  test('declared scope mismatch is surfaced (A15)', () => {
    const home = '/fixture/a15-home';
    const cwd = '/fixture/a15-cwd';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: skillFilesFor(['plan-phase']) })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: commandFilesFor(['plan-phase']) })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.mismatches.length, 1);
    assert.strictEqual(report.mismatches[0].scope, 'global');
    assert.strictEqual(report.mismatches[0].declaredScope, 'local');
    assert.strictEqual(report.mismatches[0].declaredScopeMatchesProbe, false);
  });
});

// ─── A16-A17 — malformed runtime degrades, never propagates ───────────────

describe('buildShadowReport — non-installable / unknown runtime degrades (A16-A17)', () => {
  test('non-installable runtime degrades to no report (A16, vscode)', () => {
    const home = '/fixture/a16-home';
    const cwd = '/fixture/a16-cwd';
    let report;
    assert.doesNotThrow(() => {
      report = buildShadowReport('vscode', baseOpts(home, cwd, { readManifest: mkReadManifest(new Map()) }));
    });
    assert.strictEqual(report.reason, SHADOW_REASON.RESOLVER_UNAVAILABLE);
    assert.strictEqual(report.shadowed, false);
    assert.deepStrictEqual(renderShadowReport(report), []);
  });

  test('unknown runtime degrades to no report (A17)', () => {
    const home = '/fixture/a17-home';
    const cwd = '/fixture/a17-cwd';
    let report;
    assert.doesNotThrow(() => {
      report = buildShadowReport('not-a-real-runtime-xyz', baseOpts(home, cwd, { readManifest: mkReadManifest(new Map()) }));
    });
    assert.strictEqual(report.reason, SHADOW_REASON.RESOLVER_UNAVAILABLE);
    assert.strictEqual(report.shadowed, false);
  });
});

// ─── A18 — caller mutation cannot corrupt a later call ─────────────────────

describe('buildShadowReport — independence across calls (A18)', () => {
  test('report is not shared across calls', () => {
    const home = '/fixture/a18-home';
    const cwd = '/fixture/a18-cwd';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'cursor', scope: 'global', files: skillFilesFor(['plan-phase']) })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: commandFilesFor(['plan-phase']) })],
    ]);
    const opts = baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) });

    const first = buildShadowReport('claude', opts);
    const pristine = JSON.parse(JSON.stringify(first));

    first.winner.kind = 'HACKED';
    first.triggers[0].trigger = 'HACKED';
    first.triggers.push({ trigger: 'INJECTED' });
    first.mismatches[0].declaredRuntime = 'HACKED';
    first.mismatches.push({ scope: 'INJECTED' });

    const second = buildShadowReport('claude', opts);
    assert.deepStrictEqual(second, pristine, 'a second call must be unaffected by mutation of the first result');
  });
});

// ─── A19 — the production call shape ───────────────────────────────────────

describe('buildShadowReport — production call shape (A19)', () => {
  test('production call shape resolves, matches the injected-dep rows\' shape', (t) => {
    const home = createTempDir('gsd-shadow-a19-home-');
    const cwd = createTempDir('gsd-shadow-a19-cwd-');
    t.after(() => { cleanup(home); cleanup(cwd); });

    const globalDir = path.join(home, '.claude');
    const localDir = path.join(cwd, '.claude');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, MANIFEST_NAME), JSON.stringify({
      manifestVersion: 2, runtime: 'claude', scope: 'global',
      files: skillFilesFor(['plan-phase']),
    }));
    fs.writeFileSync(path.join(localDir, MANIFEST_NAME), JSON.stringify({
      manifestVersion: 2, runtime: 'claude', scope: 'local',
      files: commandFilesFor(['plan-phase']),
    }));

    let report;
    assert.doesNotThrow(() => {
      // The exact production call shape: no injected registry, no injected
      // readManifest — real fs, real capability registry.
      report = buildShadowReport('claude', { home, cwd });
    });
    assert.strictEqual(report.shadowed, true);
    assert.deepStrictEqual(report.winner, { kind: 'skills', scope: 'global' });
    assert.deepStrictEqual(report.shadowedSide, { kind: 'commands', scope: 'local' });
    assert.strictEqual(report.triggers.length, 1);
    assert.deepStrictEqual(
      Object.keys(report).sort(),
      ['kindsDiffer', 'mismatches', 'reason', 'runtime', 'shadowed', 'shadowedSide', 'triggers', 'winner'],
    );
  });
});

// ─── A20 — frozen reason-code enum key set is locked ───────────────────────

describe('SHADOW_REASON (A20)', () => {
  test('reason enum key set is locked', () => {
    assert.deepStrictEqual(
      Object.keys(SHADOW_REASON).sort(),
      ['NOT_SHADOWED', 'RESOLVER_UNAVAILABLE', 'SCOPE_SHADOWED'],
    );
  });

  test('is frozen', () => {
    assert.strictEqual(Object.isFrozen(SHADOW_REASON), true);
  });
});

// ─── A21-A24 — per-scope truth filter (cross-scope stem-union false positive) ─

describe('buildShadowReport — per-scope truth filter (A21-A24)', () => {
  test('both scopes carry the same stems: every shadowed trigger reported (A21)', () => {
    const home = '/fixture/a21-home';
    const cwd = '/fixture/a21-cwd';
    const stems = ['plan-phase', 'milestone-complete', 'phase-create'];
    const report = buildShadowReport('claude', coexistenceOpts(home, cwd, stems));
    assert.strictEqual(report.shadowed, true);
    assert.deepStrictEqual(report.triggers.map((t) => t.trigger).sort(), stems.map((s) => `gsd-${s}`).sort());
  });

  test('global strict superset of local (full vs core profile): only the intersection is reported (A22)', () => {
    const home = '/fixture/a22-home';
    const cwd = '/fixture/a22-cwd';
    const homes = scopeHomes('claude', home, cwd);
    // global = 'full' profile (a, b, c) — local = 'core' profile (a only).
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: skillFilesFor(['a', 'b', 'c']) })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: commandFilesFor(['a']) })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.shadowed, true);
    // Only 'a' is a REAL local artifact — 'b' and 'c' must never be reported
    // as shadowed local commands; there is no local artifact for either.
    assert.deepStrictEqual(report.triggers.map((t) => t.trigger), ['gsd-a']);
  });

  test('local has a stem global does not: not reported as shadowed (A23)', () => {
    const home = '/fixture/a23-home';
    const cwd = '/fixture/a23-cwd';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: skillFilesFor(['a']) })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: commandFilesFor(['a', 'z']) })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.shadowed, true);
    // 'z' exists ONLY at local (no global artifact "wins" it) — must not
    // appear in the shadowed set at all.
    assert.deepStrictEqual(report.triggers.map((t) => t.trigger), ['gsd-a']);
  });

  test('disjoint stem sets: shadowed is false (A24)', () => {
    const home = '/fixture/a24-home';
    const cwd = '/fixture/a24-cwd';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: skillFilesFor(['a', 'b']) })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: commandFilesFor(['x', 'y']) })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.shadowed, false);
    assert.deepStrictEqual(report.triggers, []);
  });
});

// ─── F1 — bijective property: every trigger has exactly one winner ────────

describe('buildShadowReport — property (F1)', () => {
  test('every trigger has exactly one winner', () => {
    const stemArb = fc.stringMatching(/^[a-z0-9]{1,6}(-[a-z0-9]{1,6}){0,2}$/);
    const setArb = fc.uniqueArray(stemArb, { maxLength: 6 });

    fc.assert(
      fc.property(setArb, setArb, (globalStems, localStems) => {
        const home = '/fixture/f1-home';
        const cwd = '/fixture/f1-cwd';
        const homes = scopeHomes('claude', home, cwd);
        const byConfigHome = new Map([
          [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: skillFilesFor(globalStems) })],
          [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: commandFilesFor(localStems) })],
        ]);
        const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));

        // Both scopes are always "installed" here (manifestVersion set
        // regardless of file-list length), so `resolveOneRuntime`'s
        // `stemUnion` still synthesizes a candidate trigger for every stem
        // observed at EITHER scope. `buildShadowReport`'s per-scope truth
        // filter (#2873 Task 1 — see install-shadow-report.cts's module
        // comment) then narrows that down to the INTERSECTION: a trigger is
        // only reported when a real artifact exists at BOTH scopes.
        const expectedShadowed = globalStems
          .filter((s) => localStems.includes(s))
          .map((s) => `gsd-${s}`)
          .sort();
        const actualShadowed = report.triggers.map((t) => t.trigger).sort();
        assert.deepStrictEqual(actualShadowed, expectedShadowed);

        // Bijection: each shadowed trigger names exactly one winner (kind,scope).
        for (const trig of report.triggers) {
          assert.strictEqual(trig.winnerKind, 'skills');
          assert.strictEqual(trig.winnerScope, 'global');
          assert.strictEqual(trig.shadowedKind, 'commands');
          assert.strictEqual(trig.shadowedScope, 'local');
        }
        // No trigger name appears twice in the shadowed set.
        assert.strictEqual(new Set(actualShadowed).size, actualShadowed.length);
      }),
      // Explicit seed + bounded numRuns (CONTRIBUTING: unseeded property
      // tests are a review blocker). On failure, fast-check's thrown error
      // carries the pinned seed and the shrunk counterexample needed to
      // replay deterministically.
      { seed: 20260814, numRuns: 50 },
    );
  });
});

// ─── F4 — resolveSpecRootReference is idempotent over arbitrary bodies ────

describe('resolveSpecRootReference — property (F4)', () => {
  test('spec-root transform is idempotent over arbitrary bodies', () => {
    // A bare fc.string() body would almost never contain the exact
    // `@~/.claude/gsd-core/workflows/<stem>.md` shape `resolveSpecRootReference`
    // matches, making the property vacuous (see this suite's F4 comment and
    // CONTRIBUTING's writer-seeded-vs-document-shaped generator guidance).
    // Instead, bodies are assembled from chunks that actually exercise every
    // branch of the transform: a real include line (rewritten), a fenced
    // block wrapping the SAME include shape (left untouched — Claude Code
    // documents backticks as the way to prevent an `@`-import), a
    // `@.planning/…` include (a different spec root, untouched), plain prose
    // that merely MENTIONS `gsd-core/workflows/<stem>.md` without the
    // line-start `@` (untouched), and arbitrary free text.
    const stemArb = fc.stringMatching(/^[a-z][a-z0-9._-]{0,20}$/);
    const includeLineArb = stemArb.map((s) => `@~/.claude/gsd-core/workflows/${s}.md`);
    const proseMentionArb = stemArb.map((s) => `See gsd-core/workflows/${s}.md for background.`);
    const planningIncludeArb = stemArb.map((s) => `@.planning/${s}.md`);
    const fencedIncludeArb = fc.tuple(fc.constantFrom('```', '~~~'), stemArb).map(
      ([fence, s]) => `${fence}\n@~/.claude/gsd-core/workflows/${s}.md\n${fence}`,
    );
    const plainTextArb = fc.string({ maxLength: 40 });

    const chunkArb = fc.oneof(
      includeLineArb,
      proseMentionArb,
      planningIncludeArb,
      fencedIncludeArb,
      plainTextArb,
    );
    const bodyArb = fc.array(chunkArb, { maxLength: 12 }).map((chunks) => chunks.join('\n'));

    fc.assert(
      fc.property(bodyArb, (body) => {
        const once = resolveSpecRootReference(body);
        const twice = resolveSpecRootReference(once);
        assert.strictEqual(
          twice,
          once,
          `not idempotent — body: ${JSON.stringify(body)}\nonce: ${JSON.stringify(once)}\ntwice: ${JSON.stringify(twice)}`,
        );
      }),
      // Explicit seed + bounded numRuns, replay data printed on failure via
      // the assertion message above (fast-check's own thrown error additionally
      // carries the pinned seed + shrunk counterexample needed to replay).
      { seed: 20260814, numRuns: 300 },
    );
  });
});
