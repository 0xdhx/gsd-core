const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  withIsolatedProcessState,
  TEST_ENV_BASE,
  CONFIG_LOCATION_ENV_KEYS,
  scrubConfigLocationEnv,
} = require('./helpers.cjs');

describe('withIsolatedProcessState', () => {
  test('restores env, cwd, and exitCode after callback', () => {
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    const originalMarker = process.env.GSD_TEST_ISOLATION_MARKER;

    const tempCwd = path.dirname(originalCwd);

    withIsolatedProcessState(() => {
      process.env.GSD_TEST_ISOLATION_MARKER = 'changed';
      process.exitCode = 73;
      process.chdir(tempCwd);
    });

    assert.strictEqual(process.cwd(), originalCwd);
    assert.strictEqual(process.exitCode, originalExitCode);
    assert.strictEqual(process.env.GSD_TEST_ISOLATION_MARKER, originalMarker);
  });

  test('restores state even when callback throws', () => {
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;

    assert.throws(() => {
      withIsolatedProcessState(() => {
        process.env.PATH = '';
        process.chdir(path.dirname(originalCwd));
        throw new Error('boom');
      });
    }, /boom/);

    assert.strictEqual(process.cwd(), originalCwd);
    assert.strictEqual(process.env.PATH, originalPath);
  });
});

// ─── #2665: the config-location scrub is DERIVED, and stays that way ──────────
//
// The recurrence guard. #2665 documents two prior authors independently
// diagnosing this class and each fixing only the instance in front of them;
// this is the third pass. A hand-maintained scrub list cannot be defended by
// review alone, so the invariant is asserted instead of trusted.
describe('#2665: TEST_ENV_BASE config-location coverage', () => {
  test('every runtime configHome env var in the registry is scrubbed', () => {
    const { runtimes } = require('../gsd-core/bin/lib/capability-registry.cjs');

    const declared = [
      ...new Set(
        Object.values(runtimes).flatMap((r) => r?.runtime?.configHome?.env ?? []),
      ),
    ].sort();

    // Guards the guard: an empty/renamed registry shape would make the
    // assertion below vacuously true and silently retire this test.
    assert.ok(
      declared.length >= 15,
      `expected the registry to declare many configHome env vars, got ${declared.length} — ` +
        'if the registry shape changed, this derivation needs updating, not deleting',
    );

    const missing = declared.filter((k) => !(k in TEST_ENV_BASE));
    assert.deepStrictEqual(
      missing,
      [],
      `config-location env vars reachable by the resolver but not scrubbed: ${missing.join(', ')}. ` +
        'TEST_ENV_BASE derives this set from the capability registry — a gap here means the ' +
        'derivation broke, not that the list needs a manual entry.',
    );
  });

  test('every scrubbed config-location var is blanked, not merely present', () => {
    for (const key of CONFIG_LOCATION_ENV_KEYS) {
      assert.strictEqual(
        TEST_ENV_BASE[key],
        '',
        `${key} must be blanked ('') so the child sees a falsy value on the env-first branch`,
      );
    }
  });

  test('the non-registry config-location vars are covered too', () => {
    // These have no capability descriptor, so the registry derivation alone
    // cannot reach them: GROK_AGENTS_HOME is a hardcoded branch of
    // getGlobalConfigDir, GSD_RUNTIME selects which runtime home resolves, and
    // GSD_PROJECT / GSD_WORKSTREAM move a child's .planning root
    // (src/planning-workspace.cts). Named explicitly so deleting one from the
    // helper is a test failure rather than a silent narrowing.
    for (const key of ['GROK_AGENTS_HOME', 'GSD_RUNTIME', 'GSD_PROJECT', 'GSD_WORKSTREAM']) {
      assert.strictEqual(TEST_ENV_BASE[key], '', `${key} must be scrubbed`);
    }
  });

  test('scrubConfigLocationEnv clears and restores the parent process env', () => {
    // The in-process half of the fix (Blocker 1): TEST_ENV_BASE only reaches
    // children, so a test calling install() in-process needs the PARENT's env
    // cleared. Round-trip both states — set and unset — because restoring an
    // originally-unset var as '' rather than deleting it is itself a leak.
    withIsolatedProcessState(() => {
      process.env.CLAUDE_CONFIG_DIR = '/tmp/ambient-claude';
      delete process.env.CODEX_HOME;

      const restore = scrubConfigLocationEnv();
      assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, undefined,
        'a set config-location var must be deleted, not blanked, on the parent');
      assert.strictEqual(process.env.CODEX_HOME, undefined);

      restore();
      assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, '/tmp/ambient-claude',
        'restore must put back the original value');
      assert.ok(!('CODEX_HOME' in process.env),
        'restore must leave an originally-unset var unset, not set it to empty string');
    });
  });
});
