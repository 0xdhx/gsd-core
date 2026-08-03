'use strict';

/**
 * #2483 — the claude reviewer lane spawned headless from the project cwd, so the spawned session
 * inherited the invoking user's global CLAUDE.md, the project CLAUDE.md, and Claude Code
 * auto-memory.
 *
 * That made it the only reviewer seeing anything beyond the prompt file: the prompt is assembled
 * once (PROJECT.md, the roadmap section, every PLAN file, CONTEXT.md, RESEARCH.md, REQUIREMENTS.md)
 * before any lane runs, gemini receives only that prompt, and codex runs `--ephemeral`. Beyond the
 * measured injection cost, the asymmetry cuts at the workflow's premise — "independent review"
 * meant something different for the claude lane than for the other two.
 *
 * The fix is declared data, not a handler: the claude lane carries `invoke.env`, the resolver folds
 * it into the plan, and the runner merges it over the inherited environment for that ONE child.
 * Two variables because these are two independently-toggled mechanisms —
 * CLAUDE_CODE_DISABLE_CLAUDE_MDS suppresses CLAUDE.md file loading and
 * CLAUDE_CODE_DISABLE_AUTO_MEMORY suppresses the auto-memory system. The pair is also robust
 * against a host that exports `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0`, which forces auto-memory back on.
 *
 * Per-invocation, never process-wide: the guard must not reach the orchestrating session (which may
 * itself be Claude Code on the SELF_CLI="auto" path) or any later lane in the same run. The
 * process-env assertions below are what hold that, and they are the reason this file exercises the
 * real runner rather than reading source text.
 *
 * ADR-2782 Phase 5b moved reviewer dispatch out of `review.md` prose and into the declared lane
 * table, so this is a behavioural regression against the resolver and runner. The prior revision of
 * this file asserted against `review.md`'s dispatch lines; that surface no longer exists.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
const { resolveLanePlan } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');
const { runLane } = require('../gsd-core/bin/lib/review-lane-runner.cjs');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const TOOLS = path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');

const GUARD = Object.freeze({
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
});

const RUN = '/run';
const ROOT = '/repo';

function laneFor(slug) {
  const lane = REVIEWER_LANES.find((l) => l.slug === slug);
  assert.ok(lane, `no declared lane '${slug}'`);
  return lane;
}

function planFor(slug) {
  const r = resolveLanePlan({
    lane: laneFor(slug),
    configGet: () => undefined,
    runDir: RUN,
    repoRoot: ROOT,
    effortArgs: [],
  });
  assert.equal(r.ok, true, `${slug} failed to resolve: ${r.ok ? '' : r.detail}`);
  return r.plan;
}

/** Records what the runner handed spawn, so the assertions are about the real call. */
function spyDeps(seen) {
  return {
    spawn: (binary, argv, opts) => {
      seen.push({ binary, argv, opts });
      return { status: 0, stdout: 'a review body long enough not to trip the empty guard.', stderr: '' };
    },
    httpJson: async () => ({ ok: false, status: 0, body: '', error: 'not used' }),
    readFile: () => 'prompt',
    writeFile: () => {},
    exists: () => true,
    hasBinary: () => true,
    configGet: () => undefined,
    homeDir: '/home/test',
    warn: () => {},
  };
}

describe('#2483 the claude reviewer lane suppresses CLAUDE.md + auto-memory injection', () => {
  test('the claude lane declares both guard variables', () => {
    const { env } = laneFor('claude').invoke;
    assert.deepStrictEqual(
      env, GUARD,
      'the claude lane must declare BOTH CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 and ' +
      'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 — CLAUDE.md loading and auto-memory are ' +
      'independently-toggled mechanisms, and a lane missing either re-inherits that half of the ' +
      'context, reintroducing the asymmetry against the prompt-fed gemini and codex lanes'
    );
  });

  test('the resolver carries the pair through to the plan', () => {
    assert.deepStrictEqual(planFor('claude').env, GUARD);
  });

  test('the runner passes the pair to the spawn call', async () => {
    const seen = [];
    await runLane(planFor('claude'), spyDeps(seen), { repoRoot: ROOT });
    // The probe spawns `--help` first; the dispatch is the call carrying the prompt.
    const dispatch = seen.find((c) => !c.argv.includes('--help'));
    assert.ok(dispatch, 'the runner never reached the claude dispatch');
    assert.deepStrictEqual(dispatch.opts.env, GUARD);
  });

  test('the guard is per-invocation — process.env is never mutated', async () => {
    // The load-bearing property, and the one a source-text assertion could only approximate. A
    // guard written into this process leaks into the orchestrating session and into every later
    // lane in the same run, suppressing memory far outside the review.
    for (const key of Object.keys(GUARD)) delete process.env[key];
    await runLane(planFor('claude'), spyDeps([]), { repoRoot: ROOT });
    for (const key of Object.keys(GUARD)) {
      assert.equal(
        process.env[key], undefined,
        `${key} must not be set on the orchestrating process — the lane's env is merged into the ` +
        'child only'
      );
    }
  });

  test('the guard is scoped to the claude lane only', () => {
    for (const lane of REVIEWER_LANES) {
      if (lane.slug === 'claude' || lane.transport !== 'spawn') continue;
      assert.equal(
        lane.invoke.env, undefined,
        `${lane.slug} must not carry the CLAUDE_CODE_DISABLE_* guard — no other reviewer reads ` +
        'CLAUDE.md or auto-memory, and codex already scopes its own context with --ephemeral'
      );
      assert.equal(planFor(lane.slug).env, null, `${lane.slug}'s plan must resolve env to null`);
    }
  });

  // The spy tests above stop at the runner's `deps.spawn` seam. Production supplies that seam in
  // `gsd-core/bin/gsd-tools.cjs`, as a hand-written object no unit test constructs — so the whole
  // chain could be correct up to `SpawnPlan.env` and the merge could still be wrong or absent. This
  // is the only assertion that runs the real `spawnSync`, via a `claude` shim on PATH that records
  // the environment it was handed. POSIX-only: the shim is a shebang script, and mediating a Windows
  // `.cmd` is a separate concern the repo tests on its own.
  test(
    'end-to-end: the real spawn hands the child both variables AND still inherits the rest',
    { skip: process.platform === 'win32' ? 'POSIX shim (see win32 shim mediation tests)' : false },
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-2483-'));
      try {
        const bin = path.join(dir, 'bin');
        const runDir = path.join(dir, 'run');
        const seen = path.join(dir, 'seen.txt');
        fs.mkdirSync(bin);
        fs.mkdirSync(runDir);
        fs.writeFileSync(path.join(runDir, 'gsd-review-prompt.md'), 'prompt');
        fs.writeFileSync(
          path.join(bin, 'claude'),
          '#!/usr/bin/env bash\ncat >/dev/null\n{\n' +
          '  echo "MDS=${CLAUDE_CODE_DISABLE_CLAUDE_MDS:-<unset>}"\n' +
          '  echo "AUTOMEM=${CLAUDE_CODE_DISABLE_AUTO_MEMORY:-<unset>}"\n' +
          '  echo "INHERITED=${FEAT_2483_INHERITED:-<unset>}"\n' +
          `} > "${seen}"\n` +
          'echo "a review body long enough to clear the empty-output guard."\n',
          { mode: 0o755 },
        );

        const r = cp.spawnSync(
          process.execPath,
          [TOOLS, 'review-lane', 'invoke', '--slug', 'claude', '--run-dir', runDir,
            '--repo-root', REPO_ROOT, '--json'],
          {
            encoding: 'utf8',
            timeout: 60_000,
            killSignal: 'SIGKILL',
            env: {
              ...process.env,
              PATH: `${bin}${path.delimiter}${process.env.PATH}`,
              FEAT_2483_INHERITED: 'yes',
            },
          },
        );
        assert.equal(r.status, 0, `gsd-tools review-lane invoke failed: ${r.stderr}`);
        assert.ok(fs.existsSync(seen), `the claude shim never ran; stdout was: ${r.stdout}`);

        const env = fs.readFileSync(seen, 'utf8');
        assert.match(env, /^MDS=1$/m, 'the child did not receive CLAUDE_CODE_DISABLE_CLAUDE_MDS=1');
        assert.match(env, /^AUTOMEM=1$/m, 'the child did not receive CLAUDE_CODE_DISABLE_AUTO_MEMORY=1');
        // The other half of "merged OVER", and the reason this is one test rather than two: a wiring
        // that REPLACED the environment instead of merging would satisfy the two assertions above
        // and break every lane's PATH, HOME and proxy settings.
        assert.match(
          env, /^INHERITED=yes$/m,
          'the lane env REPLACED the inherited environment instead of merging over it'
        );
      } finally {
        cleanup(dir);
      }
    },
  );

  test('a manifest-declared env is not honored — only first-party lanes execute', async () => {
    // The scope boundary this change deliberately does not cross, asserted rather than asserted-in-
    // prose. `invoke.env` changes what a spawned binary does, so on a THIRD-PARTY manifest it would
    // be trust-disclosure surface (`capability-trust`'s rawArgs is folded into the signature for
    // exactly that reason, and `env` is not). That is safe only while no manifest body reaches the
    // resolver: the registry's reviewer bodies contribute SLUGS to the parity check, and execution
    // resolves lanes from REVIEWER_LANES. If manifest lanes are ever made executable, `env` must
    // join the disclosed surface before that lands — and this test is what will fail first.
    const forged = {
      ...laneFor('gemini'),
      invoke: { ...laneFor('gemini').invoke, env: { LD_PRELOAD: '/tmp/evil.so' } },
    };
    assert.ok(
      !REVIEWER_LANES.some((l) => l.invoke && l.invoke.env && l.invoke.env.LD_PRELOAD),
      'the forged lane must not have leaked into the shipped table'
    );
    // The resolver is total over any lane handed to it — that is not the guarantee. The guarantee
    // is that nothing hands it a manifest-derived lane.
    const r = resolveLanePlan({
      lane: forged, configGet: () => undefined, runDir: RUN, repoRoot: ROOT, effortArgs: [],
    });
    assert.deepStrictEqual(
      r.plan.env, { LD_PRELOAD: '/tmp/evil.so' },
      'resolveLanePlan is total and folds whatever it is given — so the boundary must be upstream'
    );
    assert.equal(
      REVIEWER_LANES.includes(forged), false,
      'REVIEWER_LANES is the only lane source the runtime resolves from'
    );
  });

  test('an unguarded lane hands spawn no env at all', async () => {
    // Pins the absent-vs-empty distinction: a lane with no declared env must leave the child's
    // environment untouched rather than passing an empty object, which on some spawn wirings is
    // the difference between inheriting and being handed a stripped environment.
    const seen = [];
    await runLane(planFor('gemini'), spyDeps(seen), { repoRoot: ROOT });
    const dispatch = seen.find((c) => !c.argv.includes('--help'));
    assert.ok(dispatch, 'the runner never reached the gemini dispatch');
    assert.ok(!('env' in dispatch.opts), 'an unguarded lane must not pass an env key to spawn');
  });
});
