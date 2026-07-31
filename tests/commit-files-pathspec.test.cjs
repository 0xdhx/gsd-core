/**
 * Regression test for #2112: gsd-tools commit --files commits the entire
 * index, not the declared paths.
 *
 * `cmdCommit` staged exactly the files named in --files but then ran a bare
 * `git commit` with no pathspec, absorbing anything else that happened to be
 * staged into a commit whose message described only the named files.
 *
 * The fix adds `'--', ...stagedPaths` to the commit args **only when** the
 * caller declared a scope (explicitFiles), and only for paths that were
 * actually staged (skipped missing files are excluded to avoid #2014).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { createTempGitProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

describe('commit --files: pathspec honors declared scope (#2112)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempGitProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('commit --files does not absorb unrelated staged files', () => {
    // Developer stages a WIP file via git add (not via --files).
    fs.writeFileSync(path.join(tmpDir, 'src-wip.txt'), 'work in progress\n');
    gitOrThrow(['add', 'src-wip.txt'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });

    // GSD writes and commits a planning artifact, naming ONLY that file.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PLAN.md'), '# Plan\n');
    runGsdTools(
      ['commit', 'docs(01): add PLAN.md', '--files', '.planning/PLAN.md'],
      tmpDir,
    );

    // The commit must contain ONLY .planning/PLAN.md.
    const diffOutput = gitOrThrow(['diff', 'HEAD~1', 'HEAD', '--name-only'], {
      cwd: tmpDir,
      timeoutMs: GIT_TIMEOUT_MS,
    }).trim();
    assert.strictEqual(
      diffOutput,
      '.planning/PLAN.md',
      'commit --files must contain only the named files, got:\n' + diffOutput,
    );

    // The WIP file must still be staged, not committed.
    const statusOutput = gitOrThrow(['status', '--porcelain'], {
      cwd: tmpDir,
      timeoutMs: GIT_TIMEOUT_MS,
    }).trim();
    assert.ok(
      statusOutput.includes('A  src-wip.txt') || statusOutput.includes('A\tsrc-wip.txt'),
      'src-wip.txt should remain staged, not committed. Status:\n' + statusOutput,
    );
  });

  test('commit --files with two files commits exactly those two', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'RESEARCH.md'), '# Research\n');

    runGsdTools(
      ['commit', 'docs: artifacts', '--files', '.planning/PLAN.md', '.planning/RESEARCH.md'],
      tmpDir,
    );

    const diffOutput = gitOrThrow(['diff', 'HEAD~1', 'HEAD', '--name-only'], {
      cwd: tmpDir,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    const files = diffOutput.trim().split('\n').sort();
    assert.deepEqual(
      files,
      ['.planning/PLAN.md', '.planning/RESEARCH.md'],
      'commit should contain exactly the two named files',
    );
  });

  test('commit without --files still commits the entire .planning/ index (default path)', () => {
    // Write a planning artifact and stage it.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PLAN.md'), '# Plan\n');
    gitOrThrow(['add', '.planning/PLAN.md'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });

    // Also stage an unrelated file.
    fs.writeFileSync(path.join(tmpDir, 'extra.txt'), 'extra\n');
    gitOrThrow(['add', 'extra.txt'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });

    runGsdTools(['commit', 'docs: default commit'], tmpDir);

    // Default path (no --files) commits everything staged.
    const diffOutput = gitOrThrow(['diff', 'HEAD~1', 'HEAD', '--name-only'], {
      cwd: tmpDir,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    const files = diffOutput.trim().split('\n').sort();
    assert.ok(
      files.includes('.planning/PLAN.md') && files.includes('extra.txt'),
      'default commit (no --files) should commit everything staged, got:\n' + files,
    );
  });

  test('missing tracked file in --files is still not committed as deletion (#2014 guard)', () => {
    // Create and commit STATE.md, then remove it from disk.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n');
    gitOrThrow(['add', '.planning/STATE.md'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'add STATE.md'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    fs.unlinkSync(path.join(tmpDir, '.planning', 'STATE.md'));

    // Also create a valid file to commit.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PLAN.md'), '# Plan\n');

    runGsdTools(
      ['commit', 'docs: add plan', '--files', '.planning/PLAN.md', '.planning/STATE.md'],
      tmpDir,
    );

    const diffOutput = gitOrThrow(['diff', 'HEAD~1', 'HEAD', '--name-status'], {
      cwd: tmpDir,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    assert.ok(
      !diffOutput.includes('D\t.planning/STATE.md'),
      'missing tracked file must not appear as a deletion, diff was:\n' + diffOutput,
    );
    assert.ok(
      diffOutput.includes('.planning/PLAN.md'),
      'PLAN.md should be committed',
    );
  });

  test('commit --files with only missing files returns nothing_to_commit', () => {
    // Create and commit STATE.md, then remove it from disk.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n');
    gitOrThrow(['add', '.planning/STATE.md'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'add STATE.md'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    fs.unlinkSync(path.join(tmpDir, '.planning', 'STATE.md'));

    // Stage an unrelated file so the index is non-empty.
    fs.writeFileSync(path.join(tmpDir, 'extra.txt'), 'extra\n');
    gitOrThrow(['add', 'extra.txt'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });

    const result = runGsdTools(
      ['commit', 'docs: try', '--files', '.planning/STATE.md'],
      tmpDir,
    );

    const parsed = JSON.parse(result.output);
    assert.strictEqual(
      parsed.committed, false,
      'should not commit when all --files are missing',
    );
    assert.strictEqual(
      parsed.reason, 'nothing_to_commit',
      'should report nothing_to_commit, not absorb the index',
    );

    // The unrelated staged file must still be staged, not committed.
    const statusOutput = gitOrThrow(['status', '--porcelain'], {
      cwd: tmpDir,
      timeoutMs: GIT_TIMEOUT_MS,
    }).trim();
    assert.ok(
      statusOutput.includes('extra.txt'),
      'extra.txt should remain staged, not absorbed into a commit',
    );
  });

  test('#2523: absolute --files path inside the repo is committed, not silently dropped', () => {
    // init phase-op emits phase_dir as an ABSOLUTE path (#2428); cmdCommit must
    // accept it. The bug was path.join(cwd, absPath) → cwd+absPath (non-existent)
    // → silently skipped as nothing_to_commit (#2523).
    fs.writeFileSync(path.join(tmpDir, '.planning', 'A.md'), 'a\n');
    const absPath = path.join(tmpDir, '.planning', 'A.md');
    const res = runGsdTools(['commit', 'docs: abs path', '--files', absPath], tmpDir);
    const parsed = JSON.parse(res.output);
    assert.strictEqual(parsed.committed, true, `absolute path must commit, not nothing_to_commit: ${res.output}`);

    // The absolute path must land in the commit, normalized to repo-relative.
    const diff = gitOrThrow(['diff', 'HEAD~1', 'HEAD', '--name-only'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim();
    assert.strictEqual(diff, '.planning/A.md', `absolute --files path must be committed (normalized to relative); got: ${diff}`);
  });

  test('#2523: mixed relative+absolute --files list commits BOTH (no silent partial commit)', () => {
    // The sharpest symptom: a mixed list committed the relative entry, dropped the
    // absolute one, and reported committed:true (#2523). Both must land.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'REL.md'), 'r\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ABS.md'), 'a\n');
    const absPath = path.join(tmpDir, '.planning', 'ABS.md');
    const res = runGsdTools(
      ['commit', 'docs: mixed', '--files', '.planning/REL.md', absPath],
      tmpDir,
    );
    const parsed = JSON.parse(res.output);
    assert.strictEqual(parsed.committed, true, `mixed list must commit: ${res.output}`);

    const diff = gitOrThrow(['diff', 'HEAD~1', 'HEAD', '--name-only'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS })
      .trim().split('\n').sort();
    assert.deepStrictEqual(
      diff,
      ['.planning/ABS.md', '.planning/REL.md'],
      `mixed relative+absolute list must commit BOTH entries (the bug dropped the absolute one); got: ${diff.join(',')}`,
    );
  });

  test('#2523: out-of-repo --files path is rejected by git (staging_failed), no index pollution', (t) => {
    // An absolute path resolving OUTSIDE the project root: git add rejects it. No
    // index pollution (#2523). Not "path_outside_repo" (that guard was removed for
    // macOS symlink compatibility — git's own rejection suffices).
    //
    // #2608 changed the REASON this reports, deliberately. It used to be
    // `nothing_to_commit`, because a failed `git add` was skipped and the empty
    // stagedPaths list fell through to the empty-changeset branch. But "nothing to
    // commit" is not what happened — the caller named a file and git refused it —
    // and that misreport is the very class of defect #2608 closes. The result now
    // carries `staging_failed` plus the offending path and git's own message
    // ("… is outside repository at …"), which is strictly more actionable.
    //
    // #2523's two substantive invariants are unchanged and still asserted below:
    // no commit is created, and the index is left clean.
    const outsideDir = path.join(tmpDir, '..', `gsd-2523-outside-${process.pid}-${Date.now()}`);
    fs.mkdirSync(outsideDir, { recursive: true });
    t.after(() => cleanup(outsideDir));
    const outsideFile = path.join(outsideDir, 'secret.md');
    fs.writeFileSync(outsideFile, 's\n');

    const res = runGsdTools(
      ['commit', 'docs: outside', '--files', path.resolve(outsideFile)],
      tmpDir,
    );
    const parsed = JSON.parse(res.output);
    assert.strictEqual(parsed.committed, false, 'out-of-repo path must not commit');
    assert.strictEqual(parsed.reason, 'staging_failed', `out-of-repo: git rejects → staging_failed (#2608): ${res.output}`);
    assert.strictEqual(parsed.file, path.resolve(outsideFile), 'the rejected path must be named');
    assert.match(parsed.error, /outside repository/, "git's own rejection message must be preserved (#2608)");

    // No new commit created (still at the single initial commit).
    const logCount = gitOrThrow(['rev-list', '--count', 'HEAD'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim();
    assert.strictEqual(logCount, '1', 'no new commit must be created for an out-of-repo path');
    // Index stays clean (git add failed → nothing staged).
    const status = gitOrThrow(['status', '--porcelain'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim();
    assert.strictEqual(status, '', `index must be clean (no pollution): ${status}`);
  });
});

/**
 * ── #2608: commit --files / commit-to-subrepo fail closed when `git add`
 * fails ──────────────────────────────────────────────────────────────────
 *
 * A `git add` that fails (unwritable index in a linked worktree whose git
 * dir is outside the managed writable root, permissions, timeout) was not
 * surfaced. #2523 above had already stopped a failed path entering the
 * commit pathspec, but skipping it silently left two bad outcomes, both
 * reproduced by this suite against the pre-fix build:
 *
 *   - SOME paths fail  -> `{"committed":true}`. `git commit` still ran and
 *                         PARTIALLY committed the subset that happened to
 *                         stage, under a message describing the full
 *                         requested scope.
 *   - EVERY path fails -> `{"reason":"nothing_to_commit"}`, which is not
 *                         what happened and points the operator nowhere.
 *
 * In both cases the original `git add` stderr was discarded, so the user
 * saw a downstream `commit_failed` / pathspec error naming an innocent
 * file.
 *
 * The fix collects staging failures and fails closed BEFORE `git commit`
 * runs, returning `staging_failed` (or `staging_timeout`) with the
 * offending file and the original stderr preserved.
 *
 * ── INJECTION SEAM ──────────────────────────────────────────────────────
 * `execGit` is monkeypatched on the shell-command-projection module object.
 * The compiled call site is `(0, mod.execGit)(...)` — a property lookup at
 * call time — so the override takes effect. Per CLAUDE.md this is required
 * over `chmod 0o000` permission tricks, which do not fault under root (root
 * Docker/CI) and would make these tests silently vacuous.
 *
 * The patched call runs in a short-lived `node -e` CHILD rather than
 * in-process, for two reasons: `output()` writes with `fs.writeSync(1, …)`,
 * which neither `process.stdout.write` nor `console.log` interception can
 * capture; and a child keeps the patch from leaking into sibling suites. It
 * is a plain `process.execPath` spawn — no PATH stub and no exec bit, so it
 * is not subject to DEFECT.WINDOWS-TEST-PORTABILITY and runs on every
 * platform.
 */

// Git plumbing (add/commit/status/rev-parse/rev-list/diff) on a small
// mkdtemp fixture repo, for the #2608 suite below only. Kept as its own
// local constant (distinct from the shared GIT_TIMEOUT_MS imported above)
// per helpers/timeouts.cjs's own guidance: a call site whose class
// genuinely differs keeps its own justified value rather than forcing a
// shared norm that doesn't describe it — 5000ms here vs. 15000ms for the
// shared DEFAULT_GIT_TIMEOUT_MS norm.
const STAGING_GIT_TIMEOUT_MS = 5000;

const LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');

/**
 * Run cmdCommit with `git add <file>` forced to fail for the paths in `failFor`,
 * returning the parsed JSON result and the git argv list that was actually
 * executed (so "git commit never ran" is asserted directly, not inferred).
 */
function commitWithFailingAdd({ cwd, files, failFor = [], stderr = 'fatal: injected staging failure', timeout = false, amend = false, gitVerb = 'add' }) {
  const callsOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2608-')), 'calls.json');
  // `timeout` is `false` | `true` (alias for `'posix'`) | `'posix'` | `'windows'` —
  // #3050: the shared isSpawnTimeout predicate only requires `error.code ===
  // 'ETIMEDOUT'`, NOT `signal === 'SIGTERM'` (Windows does not reliably report
  // SIGTERM), so both shapes must be proven to still read as a timeout.
  const timeoutShape = timeout === true ? 'posix' : timeout;
  const script = `
const path = require('path');
const LIB = ${JSON.stringify(LIB)};
const projection = require(path.join(LIB, 'shell-command-projection.cjs'));
const { cmdCommit } = require(path.join(LIB, 'commands.cjs'));
const failFor = ${JSON.stringify(failFor)};
const stderrText = ${JSON.stringify(stderr)};
const timeoutShape = ${JSON.stringify(timeoutShape)};
const gitVerb = ${JSON.stringify(gitVerb)};
const real = projection.execGit;
const calls = [];
projection.execGit = (args, opts) => {
  calls.push(args);
  if (args[0] === gitVerb && failFor.includes(args[args.length - 1])) {
    if (timeoutShape === 'posix') {
      // The exact shape spawnSync produces on a POSIX timeout, which
      // shell-command-projection surfaces as signal + error.code.
      const e = new Error('spawnSync git ETIMEDOUT');
      e.code = 'ETIMEDOUT';
      return { exitCode: 1, stdout: '', stderr: stderrText, signal: 'SIGTERM', error: e };
    }
    if (timeoutShape === 'windows') {
      // Windows shape: spawnSync's timeout kill does not reliably report
      // signal:'SIGTERM' — only error.code:'ETIMEDOUT' is guaranteed (#3050).
      const e = new Error('spawnSync git ETIMEDOUT');
      e.code = 'ETIMEDOUT';
      return { exitCode: 1, stdout: '', stderr: stderrText, signal: null, error: e };
    }
    return { exitCode: 128, stdout: '', stderr: stderrText, signal: null, error: null };
  }
  return real(args, opts);
};
process.on('exit', () => {
  require('fs').writeFileSync(${JSON.stringify(callsOut)}, JSON.stringify(calls));
});
cmdCommit(${JSON.stringify(cwd)}, 'docs: map existing codebase', ${JSON.stringify(files)}, false, ${JSON.stringify(amend)}, false);
`;

  const run = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 30000,
    killSignal: 'SIGKILL',
    env: { ...process.env, GSD_TEST_MODE: '1' },
  });

  assert.ok(
    run.stdout && run.stdout.trim(),
    `cmdCommit child produced no stdout (status=${run.status}): ${run.stderr}`,
  );
  return {
    result: JSON.parse(run.stdout),
    gitCalls: JSON.parse(fs.readFileSync(callsOut, 'utf8')),
  };
}

function headCount(cwd) {
  return Number(gitOrThrow(['rev-list', '--count', 'HEAD'], { cwd, timeoutMs: STAGING_GIT_TIMEOUT_MS }).trim());
}

function committedFiles(cwd) {
  return gitOrThrow(['diff', 'HEAD~1', 'HEAD', '--name-only'], { cwd, timeoutMs: STAGING_GIT_TIMEOUT_MS })
    .trim().split('\n').filter(Boolean).sort();
}

/**
 * Same harness for `cmdCommitToSubrepo` — the sub-repo twin of the staging loop,
 * which carried the identical defect (failed `git add` dropped, commit proceeds
 * with the subset that staged).
 */
function subrepoCommitWithFailingAdd({ cwd, files, failFor = [], timeout = false }) {
  // See commitWithFailingAdd above for the timeoutShape rationale (#3050).
  const timeoutShape = timeout === true ? 'posix' : timeout;
  const script = `
const path = require('path');
const LIB = ${JSON.stringify(LIB)};
const projection = require(path.join(LIB, 'shell-command-projection.cjs'));
const { cmdCommitToSubrepo } = require(path.join(LIB, 'commands.cjs'));
const failFor = ${JSON.stringify(failFor)};
const timeoutShape = ${JSON.stringify(timeoutShape)};
const real = projection.execGit;
projection.execGit = (args, opts) => {
  if (args[0] === 'add' && failFor.includes(args[args.length - 1])) {
    if (timeoutShape === 'posix') {
      const e = new Error('spawnSync git ETIMEDOUT');
      e.code = 'ETIMEDOUT';
      return { exitCode: 1, stdout: '', stderr: 'fatal: injected subrepo staging failure', signal: 'SIGTERM', error: e };
    }
    if (timeoutShape === 'windows') {
      const e = new Error('spawnSync git ETIMEDOUT');
      e.code = 'ETIMEDOUT';
      return { exitCode: 1, stdout: '', stderr: 'fatal: injected subrepo staging failure', signal: null, error: e };
    }
    return { exitCode: 128, stdout: '', stderr: 'fatal: injected subrepo staging failure', signal: null, error: null };
  }
  return real(args, opts);
};
cmdCommitToSubrepo(${JSON.stringify(cwd)}, 'feat: subrepo change', ${JSON.stringify(files)}, false);
`;
  const run = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 30000,
    killSignal: 'SIGKILL',
    env: { ...process.env, GSD_TEST_MODE: '1' },
  });
  assert.ok(run.stdout && run.stdout.trim(),
    `cmdCommitToSubrepo child produced no stdout (status=${run.status}): ${run.stderr}`);
  return JSON.parse(run.stdout);
}

describe('#2608: commit-to-subrepo fails closed when git add fails', () => {
  let rootDir;
  let subDir;

  beforeEach(() => {
    rootDir = createTempGitProject();
    fs.writeFileSync(
      path.join(rootDir, '.planning', 'config.json'),
      JSON.stringify({ planning: { sub_repos: ['backend'] } }, null, 2),
    );
    subDir = path.join(rootDir, 'backend');
    fs.mkdirSync(subDir, { recursive: true });
    for (const [cmd, args] of [['init', []], ['config', ['user.email', 'test@example.com']], ['config', ['user.name', 'Test']]]) {
      gitOrThrow([cmd, ...args], { cwd: subDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    }
    fs.writeFileSync(path.join(subDir, 'seed.js'), '// seed\n');
    gitOrThrow(['add', 'seed.js'], { cwd: subDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'seed'], { cwd: subDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    fs.writeFileSync(path.join(subDir, 'a.js'), '// a\n');
    fs.writeFileSync(path.join(subDir, 'b.js'), '// b\n');
  });

  afterEach(() => {
    cleanup(rootDir);
  });

  test('a failed sub-repo git add reports staging_failed and commits nothing', () => {
    const before = headCount(subDir);
    const result = subrepoCommitWithFailingAdd({
      cwd: rootDir,
      files: ['backend/a.js', 'backend/b.js'],
      failFor: ['b.js'],
    });

    assert.equal(result.repos.backend.reason, 'staging_failed',
      `expected staging_failed for the sub-repo, got ${JSON.stringify(result)}`);
    assert.equal(result.repos.backend.committed, false);
    assert.match(result.repos.backend.error, /injected subrepo staging failure/,
      "git's original stderr must be preserved");
    assert.equal(headCount(subDir), before, 'no partial sub-repo commit may be created');

    const status = gitOrThrow(['status', '--porcelain'], { cwd: subDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    assert.deepEqual(status.split('\n').filter((l) => /^A[ \t]/.test(l)), [],
      `the sub-repo index must be rolled back, status:\n${status}`);
  });

  test('successful sub-repo staging still commits', () => {
    const before = headCount(subDir);
    const result = subrepoCommitWithFailingAdd({
      cwd: rootDir,
      files: ['backend/a.js', 'backend/b.js'],
      failFor: [],
    });

    assert.equal(result.repos.backend.committed, true, `expected a commit, got ${JSON.stringify(result)}`);
    assert.equal(headCount(subDir), before + 1);
  });
});

describe('#2608: commit --files fails closed when git add fails', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempGitProject();
    for (const name of ['ARCHITECTURE', 'CONCERNS', 'CONVENTIONS']) {
      fs.writeFileSync(path.join(tmpDir, '.planning', `${name}.md`), `# ${name}\n`);
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── AC1 + AC3: the failure is reported, with its original stderr ──────────

  test('a failed git add returns staging_failed with the file and original stderr', () => {
    const before = headCount(tmpDir);
    const { result, gitCalls } = commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md'],
      failFor: ['.planning/ARCHITECTURE.md'],
      stderr: 'fatal: Unable to create index.lock: Permission denied',
    });

    assert.equal(result.committed, false);
    assert.equal(result.hash, null);
    assert.equal(result.reason, 'staging_failed',
      'the staging cause must be reported, not a downstream commit_failed/pathspec error');
    assert.equal(result.file, '.planning/ARCHITECTURE.md', 'the offending file must be named');
    assert.match(result.error, /Unable to create index\.lock/,
      'the original git add stderr must be preserved');

    // AC2: git commit must never have been invoked.
    assert.ok(
      !gitCalls.some((a) => a[0] === 'commit'),
      `git commit must not run after a staging failure, calls: ${JSON.stringify(gitCalls)}`,
    );
    assert.equal(headCount(tmpDir), before, 'no commit may be created');
  });

  // ── AC4: no partial commit of a multi-file explicit scope ─────────────────

  test('when the second of three paths fails to stage, nothing is committed', () => {
    // Pre-fix this returned {"committed":true} — the two paths that DID stage
    // were committed under a message describing all three.
    const before = headCount(tmpDir);
    const { result, gitCalls } = commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md', '.planning/CONCERNS.md', '.planning/CONVENTIONS.md'],
      failFor: ['.planning/CONCERNS.md'],
    });

    assert.equal(result.reason, 'staging_failed');
    assert.equal(result.file, '.planning/CONCERNS.md');
    assert.ok(
      !gitCalls.some((a) => a[0] === 'commit'),
      'a partial commit of the paths that DID stage must not happen',
    );
    assert.equal(headCount(tmpDir), before, 'no partial commit may be created');
  });

  test('every failing path is reported, not just the first', () => {
    const { result } = commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md', '.planning/CONCERNS.md', '.planning/CONVENTIONS.md'],
      failFor: ['.planning/ARCHITECTURE.md', '.planning/CONVENTIONS.md'],
    });

    assert.equal(result.failures.length, 2);
    assert.deepEqual(
      result.failures.map((f) => f.file).sort(),
      ['.planning/ARCHITECTURE.md', '.planning/CONVENTIONS.md'],
    );
  });

  // ── An all-paths-fail run must not masquerade as nothing_to_commit ────────

  test('when every path fails to stage, the reason is staging_failed not nothing_to_commit', () => {
    const { result } = commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md', '.planning/CONCERNS.md'],
      failFor: ['.planning/ARCHITECTURE.md', '.planning/CONCERNS.md'],
    });

    assert.notEqual(result.reason, 'nothing_to_commit',
      'every path failing to stage is a staging failure, not an empty changeset');
    assert.equal(result.reason, 'staging_failed');
  });

  // ── AC5: a staging timeout is distinguishable from an ordinary failure ────

  test('a staging timeout is reported as staging_timeout, not staging_failed', () => {
    const { result } = commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md'],
      failFor: ['.planning/ARCHITECTURE.md'],
      stderr: '',
      timeout: true,
    });

    assert.equal(result.reason, 'staging_timeout',
      'the projection exposes SIGTERM+ETIMEDOUT; a timeout must not read as an ordinary failure');
    assert.equal(result.failures[0].timed_out, true);
  });

  // #3050 item 4: this site (commands.cts's `git add` staging loop) now routes
  // through the shared isSpawnTimeout predicate, which drops the `signal ===
  // 'SIGTERM'` requirement — a Windows-shaped timeout (no signal, only
  // error.code === 'ETIMEDOUT') must still be detected.
  test('a staging timeout is reported as staging_timeout even without SIGTERM (Windows shape, #3050)', () => {
    const { result } = commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md'],
      failFor: ['.planning/ARCHITECTURE.md'],
      stderr: '',
      timeout: 'windows',
    });

    assert.equal(result.reason, 'staging_timeout');
    assert.equal(result.failures[0].timed_out, true);
  });

  // #3050 item 4: the `git rm --cached` branch of the same staging loop (the
  // default-mode "stage the deletion" path, distinct from `git add` above)
  // carries its own inline copy of the timeout check pre-fix. Drive it
  // directly: default mode (no explicit --files) stages '.planning/', and
  // when that path is absent on disk the loop takes the `git rm --cached`
  // branch instead of `git add`.
  test('a `git rm --cached` timeout in default mode is reported as staging_timeout, POSIX and Windows shapes (#3050)', () => {
    // Mid-test fixture mutation (simulating an absent '.planning/' on disk),
    // not teardown; the outer afterEach still runs helpers.cleanup(tmpDir) on
    // the whole tmpDir.
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- see comment above
    fs.rmSync(path.join(tmpDir, '.planning'), { recursive: true, force: true });

    for (const shape of ['posix', 'windows']) {
      const { result } = commitWithFailingAdd({
        cwd: tmpDir,
        files: undefined,
        failFor: ['.planning/'],
        gitVerb: 'rm',
        stderr: '',
        timeout: shape,
      });

      assert.equal(result.reason, 'staging_timeout', `shape=${shape}`);
      assert.equal(result.failures[0].timed_out, true, `shape=${shape}`);
    }
  });

  test('an ordinary non-zero git add is NOT reported as a timeout', () => {
    // Boundary: the timeout carve-out must not swallow the ordinary case.
    const { result } = commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md'],
      failFor: ['.planning/ARCHITECTURE.md'],
    });

    assert.equal(result.reason, 'staging_failed');
    assert.equal(result.failures[0].timed_out, false);
  });

  // ── Successful staging preserves the current scoped-commit behaviour ──────

  test('successful staging still commits exactly the declared scope', () => {
    const before = headCount(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'unrelated-wip.txt'), 'wip\n');
    gitOrThrow(['add', 'unrelated-wip.txt'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });

    const { result } = commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md', '.planning/CONCERNS.md'],
      failFor: [],
    });

    assert.equal(result.committed, true, `expected a commit, got ${JSON.stringify(result)}`);
    assert.equal(result.reason, 'committed');
    assert.equal(headCount(tmpDir), before + 1);
    assert.deepEqual(
      committedFiles(tmpDir),
      ['.planning/ARCHITECTURE.md', '.planning/CONCERNS.md'],
      'the declared scope must still be honoured, and the unrelated staged file left alone',
    );
  });

  // ── Missing explicit files keep their existing documented handling ────────

  test('a missing explicit file is still skipped, not reported as a staging failure', () => {
    // #2014/#2523 behaviour: an explicitly-named file that does not exist is
    // skipped rather than staged as a deletion. It never reaches `git add`, so
    // it is not a staging failure and must not become one.
    const { result } = commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md', '.planning/DOES-NOT-EXIST.md'],
      failFor: [],
    });

    assert.equal(result.committed, true, `expected a commit, got ${JSON.stringify(result)}`);
    assert.deepEqual(committedFiles(tmpDir), ['.planning/ARCHITECTURE.md']);
  });

  // ── The index must be left clean, not partially staged ───────────────────

  test('a staging failure rolls back the paths this call had already staged', () => {
    // Without the rollback the paths that DID stage stay in the index with no
    // commit made, so the next bare `git commit` sweeps them up — the same
    // silent partial commit this fix exists to prevent, just deferred a step.
    commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md', '.planning/CONCERNS.md', '.planning/CONVENTIONS.md'],
      failFor: ['.planning/CONCERNS.md'],
    });

    const status = gitOrThrow(['status', '--porcelain'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    const stagedAdds = status.split('\n').filter((l) => /^A[ \t]/.test(l));
    assert.deepEqual(stagedAdds, [],
      `no path may remain staged after a staging failure, status:\n${status}`);
  });

  test('the rollback does not unstage work the caller had staged before the call', () => {
    // Boundary: the reset must touch only what THIS call staged. Unstaging a
    // path the caller staged themselves would destroy their work.
    fs.writeFileSync(path.join(tmpDir, 'caller-staged.txt'), 'mine\n');
    gitOrThrow(['add', 'caller-staged.txt'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });

    commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md', '.planning/CONCERNS.md'],
      failFor: ['.planning/CONCERNS.md'],
    });

    const status = gitOrThrow(['status', '--porcelain'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    assert.match(status, /^A[ \t]+caller-staged\.txt$/m,
      `the caller's own staged file must survive the rollback, status:\n${status}`);
  });

  // ── The default (non---files) staging path is guarded too ─────────────────

  test('a failed default-mode git add fails closed instead of committing the index', () => {
    // Default mode stages `.planning/`. Pre-fix a failure there also fell
    // through to an unguarded `git commit`.
    const before = headCount(tmpDir);
    const { result, gitCalls } = commitWithFailingAdd({
      cwd: tmpDir,
      files: undefined,
      failFor: ['.planning/'],
    });

    assert.equal(result.reason, 'staging_failed');
    assert.ok(!gitCalls.some((a) => a[0] === 'commit'), 'git commit must not run');
    assert.equal(headCount(tmpDir), before);
  });

  test('a failed default-mode git add blocks --amend too', () => {
    // --amend has no carve-out: amending on top of a failed staging would
    // rewrite the tip without the changes the caller asked for.
    const before = gitOrThrow(['rev-parse', 'HEAD'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS }).trim();
    const { result, gitCalls } = commitWithFailingAdd({
      cwd: tmpDir,
      files: undefined,
      failFor: ['.planning/'],
      amend: true,
    });

    assert.equal(result.reason, 'staging_failed');
    assert.ok(!gitCalls.some((a) => a[0] === 'commit'), 'git commit --amend must not run');
    assert.equal(
      gitOrThrow(['rev-parse', 'HEAD'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS }).trim(),
      before,
      'HEAD must not be rewritten when staging failed',
    );
  });

  test('when all explicit files are missing the reason is still nothing_to_commit', () => {
    // The nothing_to_commit path must survive: no `git add` ran, so there is no
    // staging failure to report.
    const { result } = commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/GONE-A.md', '.planning/GONE-B.md'],
      failFor: [],
    });

    assert.equal(result.reason, 'nothing_to_commit');
  });
});

describe('workflow call sites declare --files (#2269)', () => {
  // The scan runs two tiers. Tier 1 anchors the command at line start, which
  // keeps bare prose mentions (mid-sentence backtick references in
  // plan-phase.md, quick.md, etc.) out of scope while covering all three
  // invocation forms in use: gsd_run, gsd-tools, gsd-tools.cjs. Tier 2
  // (MIDLINE_INVOCATION_RE below) catches argument-bearing invocations
  // embedded mid-sentence, which tier 1 is structurally blind to.
  //
  // `query` is OPTIONAL. gsd-tools.cjs treats it as a meta-prefix and shifts
  // it off (bin/gsd-tools.cjs, "Accept `query` as a meta-prefix"), so
  // `gsd_run commit "msg"` and `gsd_run query commit "msg"` reach the identical
  // cmdCommit. Requiring the token left the query-less spelling — already live
  // at gsd-core/workflows/ingest-docs.md — outside the scan entirely, so a
  // future bare `gsd_run commit` would reintroduce #2269 uncaught.
  //
  // The `.*` between the binary and the command is load-bearing and must NOT
  // be tightened to `(\s+query)?\s+commit`: invocations may carry flags before
  // the command (gsd-core/workflows/onboard.md is
  // `gsd_run --cwd "$ONBOARDING_ROOT" query commit ...`). Dropping `.*` swaps
  // that call site out of coverage WITHOUT changing the offender count, since
  // the site is scoped either way — a silent coverage loss that no count check
  // would surface. (Deliberately stated as a property rather than an absolute
  // match count: an earlier revision of this comment pinned a census figure,
  // which then drifted three times and was stale by the time it was read.)
  const INVOCATION_RE = /^\s*gsd(_run|-tools(\.cjs)?)\b.*\b(query\s+)?commit\b/;

  // The scan's verdict must agree with the RUNTIME, and the runtime never sees
  // the line — it sees argv, after the shell has already tokenized it
  // (routeCommit, gsd-core/bin/gsd-tools.cjs):
  //
  //   const filesIndex = args.indexOf('--files');
  //   const files = filesIndex !== -1
  //     ? args.slice(filesIndex + 1).filter(a => !a.startsWith('--'))
  //     : [];
  //
  // files.length === 0 lands on the unscoped default branch that IS #2269.
  //
  // Every predicate that approximates that over raw line text has a reachable
  // disagreement, and each one found so far was fixed by widening the
  // approximation, which only moved the disagreement. So the scan stops
  // approximating: it tokenizes the line the way a shell would and then runs
  // the runtime's own predicate over the tokens. Two prior special cases fall
  // out for free rather than being encoded — `--files=x` is UNSCOPED (indexOf
  // needs the exact token) and `--files -weird.md` is SCOPED (the runtime
  // filters on '--', not '-').
  const GSD_BINARY_RE = /^(?:.*\/)?gsd(?:_run|-tools(?:\.cjs)?)$/;
  const COMMIT_TOKENS = new Set(['commit', 'commit-to-subrepo']);

  // Shell-like word splitting. Honours BOTH quote characters (the previous
  // parity walk counted only `"`, so a single-quoted message was transparent
  // to it in both directions), backslash escapes, and unquoted control
  // operators — which become their own tokens, so an operator glued to its
  // neighbour (`"a"&&gsd_run`) still separates. Quoted operators and quoted
  // whitespace stay literal, which is what keeps a command substitution inside
  // a message ("$(gsd-tools query phase-list)") from reading as a second
  // invocation, with no separator lookahead needed.
  //
  // Never throws, and an unterminated quote simply runs to end of input: these
  // inputs are substrings sliced out of prose, so a torn quote is expected
  // rather than exceptional. Tokens carry offsets so callers can slice the
  // ORIGINAL text and report a real excerpt instead of a re-joined echo.
  //
  // Operators are marked STRUCTURALLY (`op: true`), never re-identified by
  // comparing a token's text against the operator set. That distinction is the
  // whole point of tokenizing: `commit '|' --files a.md` produces a token
  // whose VALUE is `|` and which is ordinary message text, and a consumer that
  // matched on value would split there and score a scoped invocation as
  // unscoped — the identify-structure-by-text mistake this rewrite exists to
  // remove, reintroduced one layer up. (Caught by the delimiter-generating
  // property below, on its first run.)
  const tokenize = (str) => {
    const tokens = [];
    let cur = '';
    let started = false;
    let start = 0;
    let quote = null;
    const begin = (i) => {
      if (!started) { started = true; start = i; }
    };
    const flush = (end) => {
      if (started) tokens.push({ value: cur, start, end });
      cur = '';
      started = false;
    };
    for (let i = 0; i < str.length; i += 1) {
      const ch = str[i];
      if (quote) {
        if (ch === '\\' && quote === '"' && i + 1 < str.length) { cur += str[i + 1]; i += 1; continue; }
        if (ch === quote) { quote = null; continue; }
        cur += ch;
        continue;
      }
      if (ch === '\\' && i + 1 < str.length) { begin(i); cur += str[i + 1]; i += 1; continue; }
      if (ch === '"' || ch === "'") { begin(i); quote = ch; continue; }
      if (/\s/.test(ch)) { flush(i); continue; }
      const pair = str.slice(i, i + 2);
      if (pair === '&&' || pair === '||') { flush(i); tokens.push({ value: pair, start: i, end: i + 2, op: true }); i += 1; continue; }
      if (ch === ';' || ch === '|') { flush(i); tokens.push({ value: ch, start: i, end: i + 1, op: true }); continue; }
      begin(i);
      cur += ch;
    }
    flush(str.length);
    return tokens;
  };

  // routeCommit's predicate, verbatim, over one invocation's tokens. Stops at
  // the first control operator so that a later command's --files can never
  // vouch for this one even when the caller passes an unsegmented line.
  const hasScopedFiles = (line) => {
    const all = tokenize(line);
    const cut = all.findIndex((t) => t.op);
    const tokens = (cut === -1 ? all : all.slice(0, cut)).map((t) => t.value);
    const filesIndex = tokens.indexOf('--files');
    if (filesIndex === -1) return false;
    return tokens.slice(filesIndex + 1).some((t) => !t.startsWith('--'));
  };

  // Mid-prose argument-bearing invocations: the line-start anchor above
  // deliberately keeps bare backtick mentions ("the `gsd_run query commit`
  // step") out of scope, but a fully argument-bearing invocation embedded
  // mid-sentence is executable instruction, not prose — new-milestone.md,
  // new-project.md, and plan-phase.md each carry one live. The discriminator
  // is the quoted commit message: `commit "` right after the command token is
  // the executable shape; a bare mention never carries it.
  // The message delimiter is `'` or `"`. Hardcoding `"` here was the same
  // one-quoting-dialect assumption the parity walk made: a single-quoted
  // mid-prose invocation was invisible to the scan entirely, so trimming its
  // --files clause reintroduced #2269 with nothing to fail.
  const MIDLINE_INVOCATION_RE = /\bgsd(_run|-tools(\.cjs)?)\b[^`]*?\b(query\s+)?commit\s+['"]/g;

  // An invocation is split at shell control operators before it is scored, so
  // a later command's --files cannot vouch for an earlier unscoped one:
  //   gsd_run query commit "a" && gsd_run query commit "b" --files x.md
  //   gsd_run query commit "a" ;  gsd-tools query phase-list --files y.md
  //   gsd_run query commit "a" && echo done --files unused.md
  // The third is why the separator is no longer required to be FOLLOWED by a
  // gsd binary: that lookahead left any non-gsd command's arguments fused to
  // the invocation, and `--files` belonging to `echo` scored the commit as
  // scoped. Splitting on every operator and then keeping only the segments
  // that are themselves gsd commit invocations covers all three, and the
  // command-substitution negative control (`commit "$(gsd-tools query x)"
  // --files y.md`) is handled by the tokenizer instead — the operator is
  // inside quotes, so it is never a separator to begin with.
  const isCommitInvocation = (tokens) => tokens.length > 0
    && GSD_BINARY_RE.test(tokens[0].value)
    && tokens.some((t) => COMMIT_TOKENS.has(t.value));

  const segmentInvocations = (str) => {
    const groups = [];
    let cur = [];
    for (const t of tokenize(str)) {
      if (t.op) { groups.push(cur); cur = []; } else { cur.push(t); }
    }
    groups.push(cur);
    // No operator: the whole string is the one invocation, returned verbatim.
    if (groups.length === 1) return [str];
    const hits = groups.filter(isCommitInvocation);
    // Operators present but no segment is a commit invocation — fall back to
    // the whole string rather than silently dropping the line from the scan.
    if (!hits.length) return [str];
    return hits.map((g) => str.slice(g[0].start, g[g.length - 1].end));
  };

  // Candidate invocation substrings for one logical line. A line-start
  // invocation yields one candidate per operator-delimited gsd commit
  // invocation (the whole line when there is only one); otherwise every
  // mid-line executable invocation yields the substring from its token to the
  // end of its enclosing backtick span (or line end), so the tokenizer sees
  // the invocation itself and not surrounding prose quotes.
  const invocationCandidates = (line) => {
    if (INVOCATION_RE.test(line)) return segmentInvocations(line);
    const candidates = [];
    const re = new RegExp(MIDLINE_INVOCATION_RE.source, 'g');
    let m;
    while ((m = re.exec(line)) !== null) {
      const rest = line.slice(m.index);
      const tick = rest.indexOf('`');
      candidates.push(...segmentInvocations(tick === -1 ? rest : rest.slice(0, tick)));
    }
    return candidates;
  };

  // An invocation inside an HTML comment is not executable, and a guard that
  // flags it is hostile to documenting the very bug it protects against —
  // `<!-- WRONG: gsd_run query commit "docs: x" (missing --files!) -->` is a
  // plausible thing to write precisely BECAUSE this issue exists. Comment
  // spans are stripped before scanning, preserving newlines so the surrounding
  // lines keep their identity and a multi-line comment cannot fuse the text on
  // either side of it into one logical line.
  //
  // Defined HERE, beside the other scan primitives, rather than inside the
  // scan test: the test below asserts on this exact symbol, so the assertion
  // and the scan cannot drift apart. A private copy in each place passes its
  // own test while the scan does something else.
  const stripHtmlComments = (text) => text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));

  test('scanner quote-parity handles synthetic edge-case lines', () => {
    // The scan's correctness rests on hasScopedFiles's quote-parity walk,
    // which live workflow content happens not to stress. Pin the claimed
    // edge cases with literal lines so a regex regression fails loudly.
    const bare = [
      // A prose --files inside the quoted commit message must NOT count as
      // a scope — this line is still an unscoped invocation.
      'gsd_run query commit "docs: explain --files usage"',
      // A trailing bare flag carries no value and still selects the
      // unscoped default path.
      'gsd_run query commit "docs: plan" --files',
      // --files followed by ANOTHER FLAG is the same unscoped default, because
      // routeCommit filters `--`-prefixed tokens out of the scope list:
      // args.slice(filesIndex + 1).filter(a => !a.startsWith('--')) === [].
      // Two live sites are one token-deletion from this shape —
      // gsd-core/references/git-planning-commit.md and
      // gsd-core/workflows/execute-plan.md both run
      // `... commit "" --files .planning/codebase/*.md --amend`, so dropping
      // the glob (exactly the #2269 forgot-the-scope class) lands here.
      'gsd_run query commit "docs: plan" --files --amend',
      'gsd_run query commit "docs: plan" --files --no-verify',
    ];
    for (const line of bare) {
      assert.ok(INVOCATION_RE.test(line), `should match invocation: ${line}`);
      assert.strictEqual(
        hasScopedFiles(line), false,
        `must be flagged as unscoped: ${line}`,
      );
    }

    const scoped = [
      // The ordinary scoped shape.
      'gsd_run query commit "docs: plan" --files .planning/PLAN.md',
      // A quoted --files mention BEFORE the real flag must not blind the
      // scanner to the genuine scope that follows (quote parity is even
      // again after the closing quote).
      'gsd_run query commit "docs: explain --files usage" --files .planning/PLAN.md',
      // The negative control for the two --amend rows above: a real value
      // FOLLOWED by a flag is still scoped, and both live sites have this
      // shape today. Without this row the fix could over-correct to "any
      // --files near a flag is unscoped" and nothing would fail.
      'gsd_run query commit "" --files .planning/codebase/*.md --amend',
      // The runtime filters on '--', not '-', so a single-dash token IS a
      // value and the scanner must agree.
      'gsd_run query commit "docs: plan" --files -weird-name.md',
    ];
    for (const line of scoped) {
      assert.ok(INVOCATION_RE.test(line), `should match invocation: ${line}`);
      assert.strictEqual(
        hasScopedFiles(line), true,
        `must be recognized as scoped: ${line}`,
      );
    }

    // The query-less spelling reaches the same cmdCommit and must be in
    // scope, scoped or not. ingest-docs.md uses this form live.
    assert.ok(
      INVOCATION_RE.test('gsd_run commit "docs: ingest" --files .planning/PROJECT.md'),
      'query-less invocation must match (query is an optional meta-prefix)',
    );
    assert.strictEqual(
      hasScopedFiles('gsd_run commit "docs: ingest"'), false,
      'a bare query-less invocation must be flagged as unscoped',
    );
    assert.ok(
      INVOCATION_RE.test('gsd_run commit "docs: ingest"'),
      'a bare query-less invocation must still match the anchor',
    );

    // Flags may precede the command. onboard.md is a live instance; a regex
    // that anchors `commit` directly after the binary drops it silently.
    assert.ok(
      INVOCATION_RE.test('gsd_run --cwd "$ROOT" query commit "docs: x" --files .planning/S.md'),
      'invocation with a flag before the command must stay in scope',
    );

    // Prose mention mid-sentence: the line-start anchor keeps it out of
    // the scan entirely.
    assert.strictEqual(
      INVOCATION_RE.test('the `gsd_run query commit` step then records the artifact'),
      false,
      'prose mention must not match the invocation anchor',
    );

    // Widening `query` to optional must not pull in unrelated commands that
    // merely mention the word: `commit_docs` is a JSON key in new-project.md's
    // config-new-project payload, and the \b...\b anchors must exclude it.
    assert.strictEqual(
      INVOCATION_RE.test('gsd_run query config-new-project \'{"commit_docs":true}\''),
      false,
      'a config payload mentioning commit_docs is not a commit invocation',
    );
  });

  test('the scanner agrees with the runtime on every quoting dialect', () => {
    // These three shapes were each scored WRONG by the line-text heuristic
    // that preceded tokenization, and each was reachable in live content.
    // They are pinned as literals because they are the exact inputs that
    // proved the approximation could not be patched into correctness.
    const unscoped = [
      // 1. An unrelated command's --files vouched for the commit. At runtime
      //    `--files` never reaches gsd-tools argv at all — it is echo's
      //    argument — so cmdCommit takes the blanket-.planning/ default. This
      //    is #2269 verbatim, and the old separator lookahead could not see
      //    it because the far side of `&&` is not a gsd binary.
      'gsd_run query commit "docs: update ROADMAP.md" && echo done --files unused.md',
      // 2. Same root cause with no shell chaining at all: the message is
      //    SINGLE-quoted, so a parity walk that counts only `"` reads the
      //    --files inside it as a real argument. The double-quoted twin was
      //    always caught, which is what made the hole so easy to miss.
      "gsd_run query commit 'docs: explain --files usage'",
    ];
    for (const line of unscoped) {
      assert.ok(INVOCATION_RE.test(line), `should match invocation: ${line}`);
      const cands = invocationCandidates(line);
      assert.ok(
        cands.some((c) => !hasScopedFiles(c)),
        `must surface as unscoped: ${line}`,
      );
    }

    // 3. The mirror-image failure, and the reason a `'`-aware parity COUNTER
    //    would have been the wrong fix: a double quote living inside a
    //    single-quoted message is ordinary text, but it flips a parity walk
    //    and takes a genuinely scoped invocation out of scope — a false
    //    NEGATIVE introduced by the fix for a false negative.
    const scopedDespiteQuotes = "gsd_run query commit 'prints a \" sometimes' --files .planning/PLAN.md";
    assert.ok(INVOCATION_RE.test(scopedDespiteQuotes));
    assert.ok(
      invocationCandidates(scopedDespiteQuotes).every((c) => hasScopedFiles(c)),
      `a " inside a '-quoted message must not take the invocation out of scope: ${scopedDespiteQuotes}`,
    );

    // The single-quoted spellings of the shapes already pinned for `"`, so the
    // two dialects cannot drift apart again.
    assert.strictEqual(hasScopedFiles("gsd_run query commit 'docs: plan' --files"), false);
    assert.strictEqual(hasScopedFiles("gsd_run query commit 'docs: plan' --files --amend"), false);
    assert.strictEqual(hasScopedFiles("gsd_run query commit 'docs: plan' --files .planning/PLAN.md"), true);
    // Unquoted messages reach the same cmdCommit and must behave identically.
    assert.strictEqual(hasScopedFiles('gsd_run query commit plan --files'), false);
    assert.strictEqual(hasScopedFiles('gsd_run query commit plan --files .planning/PLAN.md'), true);

    // --files=x stays UNSCOPED without a special case: routeCommit does
    // args.indexOf('--files'), which the fused token cannot satisfy.
    assert.strictEqual(hasScopedFiles('gsd_run query commit "docs: plan" --files=.planning/PLAN.md'), false);
    // And a flag BEFORE a real value is still scoped, because the runtime
    // filters the whole tail rather than inspecting only the next token.
    assert.strictEqual(hasScopedFiles('gsd_run query commit "docs: plan" --files --amend .planning/PLAN.md'), true);

    // An operator glued to its neighbour still separates.
    assert.ok(
      invocationCandidates('gsd_run query commit "a"&&gsd_run query commit "b" --files x.md')
        .some((c) => !hasScopedFiles(c)),
      'an unspaced && must still split the invocation',
    );

    // A QUOTED operator is message text, not structure. Both the candidate
    // split and the scope predicate must key on how the token was PARSED, not
    // on what it spells — re-deriving "is this an operator" from the token's
    // value reintroduces the identify-structure-by-text mistake one layer up,
    // and turns each of these scoped invocations into a false offender.
    // The message is EXACTLY an operator in the first four: that is the case a
    // value-based check actually mis-reads, and it is the shape fast-check
    // shrank to on this predicate's first run. A message that merely CONTAINS
    // an operator (the last three) tokenizes to one token whose value is the
    // whole string, so it never matches the operator set by equality and is
    // not a control for this — keep both, but do not mistake the second group
    // for coverage of the first.
    for (const line of [
      'gsd_run query commit "|" --files .planning/PLAN.md',
      "gsd_run query commit '|' --files .planning/PLAN.md",
      'gsd_run query commit "&&" --files .planning/PLAN.md',
      'gsd_run query commit ";" --files .planning/PLAN.md',
      'gsd_run query commit "docs: a | b" --files .planning/PLAN.md',
      "gsd_run query commit 'docs: a | b' --files .planning/PLAN.md",
      'gsd_run query commit "docs: x && y" --files .planning/PLAN.md',
    ]) {
      const cands = invocationCandidates(line);
      assert.strictEqual(cands.length, 1, `a quoted operator must not split the invocation: ${line}`);
      assert.ok(hasScopedFiles(cands[0]), `a quoted operator must not defeat the scope: ${line}`);
    }
  });

  test('an invocation inside an HTML comment is not executable content', () => {
    // The scan must not be hostile to documenting the bug it guards. This is
    // the shape the scan's own strip step exists for; asserted on the helper
    // so it holds independently of which roots are scanned.
    const strip = stripHtmlComments;
    const commented = '<!-- WRONG: gsd_run query commit "docs: message" (missing --files!) -->';
    assert.strictEqual(strip(commented).trim(), '', 'the commented invocation must be stripped');

    // A multi-line comment must not fuse the lines on either side of it.
    const around = 'before\n<!-- gsd_run query commit "x"\nstill inside -->\nafter';
    const lines = strip(around).split('\n');
    assert.strictEqual(lines.length, 4, 'newlines must survive the strip');
    assert.strictEqual(lines[0], 'before');
    assert.strictEqual(lines[3], 'after');

    // A real invocation on the same line as a comment still scans.
    const mixed = '<!-- note --> gsd_run query commit "docs: x"';
    const cands = invocationCandidates(strip(mixed).trim());
    assert.ok(cands.length === 1 && !hasScopedFiles(cands[0]), 'a live invocation beside a comment must still be scanned');
  });

  test('a later --files on the same line cannot vouch for an earlier invocation', () => {
    // Whole-line scoring is satisfied by ONE match anywhere on the line, so a
    // second, scoped invocation masked an earlier unscoped one. No live line
    // has this shape today; it is the same "one hit vouches for the whole
    // candidate" class as the --files-value bug, so it is pinned rather than
    // left to be rediscovered.
    const masked = [
      'gsd_run query commit "a" && gsd_run query commit "b" --files x.md',
      'gsd_run query commit "a" ; gsd-tools query phase-list --files y.md',
    ];
    for (const line of masked) {
      const cands = invocationCandidates(line);
      assert.ok(
        cands.some((c) => !hasScopedFiles(c)),
        `the unscoped invocation must surface as its own candidate: ${line}`,
      );
    }

    // Both invocations scoped => nothing to flag.
    assert.strictEqual(
      invocationCandidates('gsd_run query commit "a" --files a.md && gsd_run query commit "b" --files x.md')
        .every((c) => hasScopedFiles(c)),
      true,
      'two scoped invocations on one line must both read as scoped',
    );

    // A binary inside a command substitution is NOT a second invocation: the
    // separator requirement is what keeps this from becoming a false offender.
    const substitution = 'gsd_run query commit "$(gsd-tools query phase-list)" --files a.md';
    assert.deepEqual(
      invocationCandidates(substitution), [substitution],
      'a command substitution must not split the invocation',
    );
    assert.ok(hasScopedFiles(invocationCandidates(substitution)[0]));
  });

  test('mid-prose argument-bearing invocations enter the candidate set', () => {
    // Literal shapes of the three live sites the anchored tier is blind to:
    // new-milestone.md / new-project.md (identical instruction) and
    // plan-phase.md. All three are scoped today — the point is that they are
    // SCANNED, so trimming their --files clause fails the sweep instead of
    // silently reintroducing #2269.
    const live = [
      'then commit ALL research artifacts the synthesizer owns with `gsd-tools query commit "docs: complete project research" --files .planning/research/` unless they are already committed.',
      '6. Commit with `gsd-tools.cjs query commit "docs(${padded_phase}): generate context from ADR ingest" --files "${phase_dir}/${padded_phase}-CONTEXT.md"` and set `context_content`; continue to step 5.',
    ];
    for (const line of live) {
      const cands = invocationCandidates(line);
      assert.strictEqual(cands.length, 1, `must yield one candidate: ${line}`);
      assert.ok(hasScopedFiles(cands[0]), `live site is scoped today: ${line}`);
    }

    // Trimming the --files clause off the embedded invocation must surface
    // it as unscoped — the regression class the anchored tier cannot see.
    const trimmed =
      'then commit the artifacts with `gsd-tools query commit "docs: complete project research"` unless already committed.';
    const trimmedCands = invocationCandidates(trimmed);
    assert.strictEqual(trimmedCands.length, 1, 'trimmed invocation must stay in the candidate set');
    assert.strictEqual(
      hasScopedFiles(trimmedCands[0]), false,
      'trimmed invocation must be flagged as unscoped',
    );

    // Bare mentions stay out of scope: no quoted message, not an executable
    // shape — the anchored tier's deliberate exclusion survives the widening.
    assert.deepEqual(
      invocationCandidates('the `gsd_run query commit` step then records the artifact'),
      [],
      'a bare prose mention must yield no candidates',
    );

    // Prose quotes BEFORE the invocation must not blind the parity walk —
    // the candidate substring starts at the invocation token, not column 0.
    const quotedProse =
      'the "research summary" is committed via `gsd_run query commit "docs: x" --files .planning/S.md` at the end.';
    const quotedCands = invocationCandidates(quotedProse);
    assert.strictEqual(quotedCands.length, 1);
    assert.ok(
      hasScopedFiles(quotedCands[0]),
      'scoped mid-line invocation must not be false-flagged by prose quotes before it',
    );

    // The config-payload negative from the anchored tier holds mid-line too:
    // commit_docs is a JSON key, not a commit invocation.
    assert.deepEqual(
      invocationCandidates('set via `gsd_run query config-new-project \'{"commit_docs":true}\'` in step 2'),
      [],
      'a config payload mentioning commit_docs must yield no candidates',
    );

    // A SINGLE-quoted mid-prose invocation is the same executable shape. The
    // mid-line tier keyed on `commit "` only, so this one was invisible to the
    // scan entirely — not merely mis-scored — and trimming its --files clause
    // reintroduced #2269 with nothing to fail.
    const singleQuoted =
      "commit the artifacts with `gsd-tools query commit 'docs: complete research' --files .planning/research/` at the end.";
    const sqCands = invocationCandidates(singleQuoted);
    assert.strictEqual(sqCands.length, 1, `single-quoted mid-prose invocation must be scanned: ${singleQuoted}`);
    assert.ok(hasScopedFiles(sqCands[0]), 'and must read as scoped');

    const sqTrimmed =
      "commit the artifacts with `gsd-tools query commit 'docs: complete research'` at the end.";
    const sqTrimmedCands = invocationCandidates(sqTrimmed);
    assert.strictEqual(sqTrimmedCands.length, 1, 'the trimmed single-quoted form must stay in the candidate set');
    assert.strictEqual(
      hasScopedFiles(sqTrimmedCands[0]), false,
      'the trimmed single-quoted form must be flagged as unscoped',
    );
  });

  // The scan's verdict rests entirely on hasScopedFiles's quote-parity walk,
  // which is parser-shaped logic over adversarial text. Live workflow content
  // exercises only a handful of shapes, so pin the invariant by property:
  // a `--files` occurring ONLY inside the quoted commit message never counts,
  // and appending a real one outside the quotes always does.
  describe('property: tokenization is what decides scope', () => {
    // THE DELIMITER IS PART OF THE DOMAIN. Every property here used to build
    // its line from a hardcoded `"` template, so no number of runs could ever
    // generate a single-quoted or unquoted invocation — the properties pinned
    // one quoting dialect while reading as though they pinned the predicate,
    // and that is precisely what let a single-quoted false negative through.
    // Draw the delimiter, and the shape that got through is inside the
    // generator's domain rather than outside it.
    const delimiter = fc.constantFrom('"', "'");
    // The unquoted spelling too — `commit msg --files x` reaches the same
    // cmdCommit, and it was outside every generator's domain before.
    const anyDelimiter = fc.constantFrom('"', "'", '');
    // A token the shell passes through VERBATIM — no quote, no whitespace, and
    // no control operator. The operator exclusion is load-bearing rather than
    // tidiness: an unconstrained generator can draw `&&` or `|` as a "path",
    // and the scanner is then RIGHT to read it as a separator while a
    // token-list oracle reads it as a value. That disagreement is a defect in
    // the generator's domain, not in the predicate, and it would surface as a
    // rare seed-dependent red — the same flake class the `--` exclusion below
    // was added for.
    const SAFE = 'abcXYZ019._/@:,+=~*-';
    const safeToken = fc
      .string({ minLength: 1, maxLength: 24 })
      .map((s) => s.replace(/[^A-Za-z0-9._/@:,+=~*-]/g, () => SAFE[0]))
      .filter((s) => s.length > 0);
    // A message body compatible with the delimiter wrapping it. Inside quotes
    // it may now contain the OTHER quote character — `commit "docs: don't
    // break"` is a legitimate line the old parity walk mis-scored — but never
    // a backslash, which is an escape on both sides of the comparison.
    const messageFor = (d) => (d === ''
      ? fc.oneof(fc.constant(''), safeToken)
      : fc.string({ maxLength: 60 }).map((s) => s.split(d).join('').split('\\').join('')));
    // A path the shell passes through as a VALUE. The `--` exclusion is not
    // cosmetic: routeCommit drops every `--`-prefixed token after --files, so
    // such a token is not a path at all and the invocation is unscoped — which
    // is the flag property below, not this one. Without the exclusion this
    // generator reaches that input space roughly once per 7,700 draws
    // (measured: 26 hits in 200,000), i.e. ~1 CI run in 77 at fast-check's
    // default 100 runs — a property that fails rarely and looks like a flake.
    const arg = safeToken.filter((s) => !s.startsWith('--'));
    // The complement: a `--`-prefixed token, which the runtime discards.
    const flagArg = safeToken.map((s) => `--${s}`);

    test('a --files mentioned only inside the quoted message is never a scope', () => {
      // Only the quoted delimiters appear here: an unquoted message cannot
      // contain a space, so "--files inside the message" is not a shape a bare
      // invocation can express. It is covered by the two properties below.
      fc.assert(
        fc.property(
          delimiter.chain((d) => fc.tuple(fc.constant(d), messageFor(d), messageFor(d))),
          ([d, a, b]) => {
            const line = `gsd_run query commit ${d}${a} --files ${b}${d}`;
            assert.strictEqual(
              hasScopedFiles(line), false,
              `a --files inside the message must not count as scope: ${line}`,
            );
          },
        ),
      );
    });

    test('a real --files outside the message always counts, whatever the message says', () => {
      fc.assert(
        fc.property(
          anyDelimiter.chain((d) => fc.tuple(fc.constant(d), messageFor(d), arg)),
          ([d, message, filePath]) => {
            const line = `gsd_run query commit ${d}${message}${d} --files ${filePath}`;
            assert.strictEqual(
              hasScopedFiles(line), true,
              `a --files outside the message must count as scope: ${line}`,
            );
          },
        ),
      );
    });

    test('a --files with no non-flag token after it is never a scope', () => {
      // The scanner must agree with routeCommit for EVERY flag spelling, not
      // just the --amend instance found in review: args.slice(i+1).filter(a =>
      // !a.startsWith('--')) discards them all, leaving files=[] and the
      // unscoped default.
      fc.assert(
        fc.property(
          anyDelimiter.chain((d) => fc.tuple(fc.constant(d), messageFor(d), flagArg)),
          ([d, message, flag]) => {
            const line = `gsd_run query commit ${d}${message}${d} --files ${flag}`;
            assert.strictEqual(
              hasScopedFiles(line), false,
              `--files followed only by a flag must not count as scope: ${line}`,
            );
          },
        ),
      );
    });

    test('the scanner agrees with routeCommit on the tokens, for any delimiter', () => {
      // The properties above assert against hand-derived expectations. This
      // one asserts against the RUNTIME's own predicate, re-implemented from
      // routeCommit over the same tokens — so a future divergence fails here
      // even if nobody thought to write a case for its shape.
      const runtimeScoped = (tokens) => {
        const i = tokens.indexOf('--files');
        return i !== -1 && tokens.slice(i + 1).some((t) => !t.startsWith('--'));
      };
      fc.assert(
        fc.property(
          anyDelimiter.chain((d) => fc.tuple(
            fc.constant(d),
            messageFor(d),
            fc.array(fc.oneof(arg, flagArg, fc.constant('--files')), { maxLength: 4 }),
          )),
          ([d, message, tail]) => {
            const line = `gsd_run query commit ${d}${message}${d} ${tail.join(' ')}`;
            // The argv the shell would hand routeCommit for that same line.
            const argv = ['commit', message, ...tail];
            assert.strictEqual(
              hasScopedFiles(line), runtimeScoped(argv),
              `scanner and routeCommit must agree: ${line}`,
            );
          },
        ),
      );
    });

    test('never throws, whatever the input line looks like', () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 200 }), (line) => {
          assert.strictEqual(typeof hasScopedFiles(line), 'boolean');
        }),
      );
    });
  });

  test('every query commit invocation passes --files', () => {
    // #2269: three workflow call sites omitted --files, landing on the
    // default branch that blanket-stages .planning/ and commits the entire
    // index. The #2112 pathspec fix is gated on explicitFiles, so it cannot
    // reach a caller that never declares a scope. This scan keeps every
    // invocation on the scoped path (and catches future bare sites) —
    // across every directory that carries live invocations, not just
    // gsd-core/workflows/: agents/, commands/, skills/, and
    // gsd-core/references/ invoke the same seam.
    //
    // docs/ is in the list because the claim above has to be TRUE, not
    // aspirational. It was not: docs/zh-CN/references/ carries 7 live
    // invocations — the Chinese mirrors of three gsd-core/references/ files
    // that ARE scanned. Those mirrors are exactly where an unscoped example
    // survives unnoticed, since the locales already drift per-locale
    // (ja-JP/ko-KR/pt-BR have no references/ subtree at all). New files under
    // an existing root are picked up automatically by the recursive walk, so
    // the gap was only ever at the ROOT level — which is why it needed a root
    // rather than a rule.
    const scanRoots = [
      'gsd-core/workflows',
      'gsd-core/references',
      'agents',
      'commands',
      'skills',
      'docs',
    ];
    const offenders = [];
    const scanned = [];
    for (const root of scanRoots) {
      const rootDir = path.join(__dirname, '..', root);
      const mdFiles = fs
        .readdirSync(rootDir, { recursive: true })
        .filter((f) => f.endsWith('.md'));
      for (const file of mdFiles) {
        const raw = stripHtmlComments(fs.readFileSync(path.join(rootDir, file), 'utf-8'));
        // Join backslash-continued lines first: several invocations pass
        // --files on a continuation line (docs-update.md, code-review.md,
        // gsd-code-fixer.md), and a per-physical-line scan would
        // false-flag them.
        const logical = raw.replace(/\\\r?\n/g, ' ');
        for (const line of logical.split(/\r?\n/)) {
          for (const inv of invocationCandidates(line)) {
            scanned.push(`${root}/${file}`);
            if (!hasScopedFiles(inv)) {
              offenders.push(`${root}/${file}: ${inv.trim()}`);
            }
          }
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'workflow query commit invocations without --files (unscoped commits sweep the index):\n' +
        offenders.join('\n'),
    );

    // A zero is only evidence if the scan actually reached the content. The
    // docs/ root was added because docs/zh-CN/references/ carries live
    // invocations; since they are all scoped, dropping the root again would
    // NOT move the offender count and the coverage loss would be silent.
    // Assert reach as a property rather than a census figure — a hardcoded
    // count is the drift this file has already been bitten by twice.
    assert.ok(
      scanned.some((s) => s.startsWith('docs/')),
      'the docs/ root must contribute scanned invocations — the localized mirrors of '
        + 'gsd-core/references/ are exactly where an unscoped example survives unnoticed',
    );
    assert.ok(
      scanned.length > 0 && scanRoots.every((root) => root === 'commands' || scanned.some((s) => s.startsWith(root))),
      'every scan root except commands/ must contribute at least one invocation, or the root is dead weight:\n'
        + scanRoots.join(', '),
    );
  });

  describe('behavioral', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = createTempGitProject();
    });

    afterEach(() => {
      cleanup(tmpDir);
    });

    test('the workflow commit shape excludes unrelated staged files (secure-phase step 7)', () => {
      // Mirrors gsd-core/workflows/secure-phase.md step 7 after #2269. The
      // --files scope is DERIVED from the workflow's own commit line rather
      // than hardcoded, so a revert of that line's --files (the #2269
      // regression) fails this behavioral test too, not only the scan above.
      const workflowRaw = fs.readFileSync(
        path.join(__dirname, '..', 'gsd-core', 'workflows', 'secure-phase.md'),
        'utf-8',
      );
      // Join backslash-continued lines first, exactly as the scan above does:
      // the workflow wraps --files onto a continuation line, so the invocation
      // token and the SECURITY.md scope live on two different physical lines
      // and a raw per-line find would miss the invocation entirely.
      const commitLine = workflowRaw
        .replace(/\\\r?\n/g, ' ')
        .split(/\r?\n/)
        .find((l) => INVOCATION_RE.test(l) && l.includes('SECURITY.md'));
      assert.ok(
        commitLine,
        'secure-phase.md step 7 commit invocation not found — did the workflow drop or rename its SECURITY.md commit?',
      );
      const filesArg = /--files\s+"([^"]+)"/.exec(commitLine);
      // Two different failures, two different messages. This test derives the
      // scope from the workflow's own quoted --files value, so an UNQUOTED
      // value breaks the derivation without being the #2269 regression — and
      // reporting it as "no longer declares --files" sends the reader to look
      // for a missing flag that is right there.
      assert.ok(
        // The scan's predicate, not a second copy of it. A duplicated
        // approximation here would drift out of agreement with the scanner
        // silently — this line carried the old `\S` heuristic and would have
        // kept scoring `--files --amend` as scoped after the scanner stopped.
        hasScopedFiles(commitLine),
        'secure-phase.md step 7 no longer declares --files — the #2269 regression this test guards:\n' + commitLine,
      );
      assert.ok(
        filesArg,
        'secure-phase.md step 7 declares --files with an UNQUOTED value; this test derives its scope '
          + 'from the quoted form. Not a #2269 regression — update the derivation below:\n' + commitLine,
      );
      // Instantiate the workflow line's shell variables with concrete values.
      const artifact = filesArg[1]
        .replace('${PHASE_DIR}', '.planning/phases/01-hardening')
        .replace('${PADDED_PHASE}', '01');
      assert.ok(
        !artifact.includes('${'),
        'unresolved shell variable in the derived artifact path — update the substitutions: ' + artifact,
      );

      const phaseDir = path.join(tmpDir, path.dirname(artifact));
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, artifact), '# Security\n');

      // Unrelated staged work a parallel agent / editor left behind.
      fs.writeFileSync(path.join(tmpDir, 'unrelated.txt'), 'in flight\n');
      execSync('git add unrelated.txt', { cwd: tmpDir, stdio: 'pipe' });
      // And an unstaged .planning/ stray the blanket `git add .planning/`
      // used to pull in (the vector a caller cannot defend against).
      fs.writeFileSync(path.join(tmpDir, '.planning', 'scratch.md'), 'stray\n');

      runGsdTools(
        [
          'commit',
          'docs(phase-1): add/update security threat verification',
          '--files',
          artifact,
        ],
        tmpDir,
      );

      const files = execSync('git diff HEAD~1 HEAD --name-only', {
        cwd: tmpDir,
        encoding: 'utf-8',
      })
        .trim()
        .split('\n');
      assert.deepEqual(
        files,
        [artifact],
        'the scoped workflow commit must contain only its own artifact, got:\n' + files.join('\n'),
      );

      const statusOutput = execSync('git status --porcelain', {
        cwd: tmpDir,
        encoding: 'utf-8',
      });
      assert.ok(
        statusOutput.includes('unrelated.txt'),
        'unrelated.txt should remain staged, not committed. Status:\n' + statusOutput,
      );
      assert.ok(
        statusOutput.includes('.planning/scratch.md'),
        'the unstaged .planning/ stray must not be swept in. Status:\n' + statusOutput,
      );
    });
  });
});
