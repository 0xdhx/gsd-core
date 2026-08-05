/**
 * GSD Tools Test Helpers – cleanup() behavioral tests
 *
 * Three deterministic, cross-platform tests that verify cleanup()'s
 * observable contract at the seam rather than probing its internals.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const os = require('os');

const { cleanup, createTempDir } = require('./helpers.cjs');

// ─── Test 1: Real-FS happy path ──────────────────────────────────────────────

test('cleanup removes a real temp dir with nested subdirs and files', () => {
  const dir = createTempDir('gsd-cleanup-test-');
  const nested = path.join(dir, 'a', 'b', 'c');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'file.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'root.txt'), 'world');

  cleanup(dir);

  assert.strictEqual(fs.existsSync(dir), false, 'temp dir should not exist after cleanup');
});

// ─── Test 2: Retry-budget contract ───────────────────────────────────────────

test('cleanup passes recursive/force/maxRetries/retryDelay options to fs.rmSync', () => {
  // Use a real temp dir as the target so cleanup() has a valid path argument.
  // We chdir AWAY from it first so cleanup() does not try to chdir either.
  const dir = createTempDir('gsd-cleanup-opts-test-');

  // Capture original cwd and shift away from the target.
  const originalCwd = process.cwd();
  // Chdir to the parent of the target so cleanup's cwd-guard is a no-op.
  process.chdir(path.dirname(dir));

  let capturedOptions = null;
  const realRmSync = fs.rmSync;

  try {
    // Replace fs.rmSync with a probe that captures options then does nothing.
    // This is an assignment expression (not a CallExpression) so it satisfies
    // the ESLint rule that bans raw fs.rmSync(...) call expressions in tests.
    fs.rmSync = (targetPath, opts) => {
      capturedOptions = opts;
      // Do NOT call through — we don't want the dir actually removed here;
      // we're only testing the options shape.
    };

    cleanup(dir);
  } finally {
    fs.rmSync = realRmSync;
    process.chdir(originalCwd);
    // Remove the dir with the real rmSync now that we restored it.
    cleanup(dir);
  }

  assert.ok(capturedOptions !== null, 'fs.rmSync should have been called');
  assert.strictEqual(capturedOptions.recursive, true, 'recursive must be true');
  assert.strictEqual(capturedOptions.force, true, 'force must be true');
  assert.ok(
    typeof capturedOptions.maxRetries === 'number' && capturedOptions.maxRetries > 0,
    'maxRetries must be a positive number'
  );
  assert.ok(
    typeof capturedOptions.retryDelay === 'number' && capturedOptions.retryDelay > 0,
    'retryDelay must be a positive number'
  );
});

// ─── Test 3: cwd-guard ───────────────────────────────────────────────────────

test('cleanup does not throw when cwd is inside the target dir, and removes the dir', () => {
  const dir = createTempDir('gsd-cleanup-cwd-test-');
  const nested = path.join(dir, 'deep', 'nested');
  fs.mkdirSync(nested, { recursive: true });

  const originalCwd = process.cwd();

  try {
    // Step INTO the nested subdir so cwd is inside the cleanup target.
    process.chdir(nested);

    assert.doesNotThrow(() => {
      cleanup(dir);
    }, 'cleanup should not throw even when cwd is inside the target');
  } finally {
    // Restore original cwd. cleanup() will have chdir'd to dirname(dir),
    // so we always restore explicitly regardless.
    if (process.cwd() !== originalCwd) {
      process.chdir(originalCwd);
    }
  }

  assert.strictEqual(fs.existsSync(dir), false, 'temp dir should not exist after cleanup');
});

// ─── Test 4: out-of-tmpdir refusal ───────────────────────────────────────────

test('cleanup throws and does not chdir or delete when target is outside os.tmpdir()', () => {
  // __dirname (this repo's tests/ directory) must never be deleted. Whether
  // it is actually outside os.tmpdir() is environment-dependent: on Linux
  // os.tmpdir() is /tmp, and a CI container that checks the repo out under
  // /tmp would put __dirname INSIDE tmpdir, in which case a correctly-working
  // cleanup() would not refuse it -- it would delete this directory. The
  // precondition assertion below verifies the "outside tmpdir" assumption
  // before cleanup() is ever called, so that situation fails loudly and
  // safely instead of destructively. No scratch directory is created, so
  // there is nothing to tear down.
  const outsideDir = __dirname;
  const knownFile = path.join(outsideDir, 'helpers-cleanup.test.cjs');

  // Mirror cleanup()'s own out-of-tmpdir predicate (tests/helpers.cjs) so
  // this test cannot run on a target it does not actually control.
  const tmpRoot = path.resolve(os.tmpdir());
  const resolvedOutsideDir = path.resolve(outsideDir);
  const isInsideTmpdir =
    resolvedOutsideDir === tmpRoot || resolvedOutsideDir.startsWith(`${tmpRoot}${path.sep}`);
  assert.strictEqual(
    isInsideTmpdir,
    false,
    `this test cannot run safely when the repo lives under os.tmpdir(): ` +
      `outsideDir (${resolvedOutsideDir}) is inside os.tmpdir() (${tmpRoot})`
  );

  const cwdBefore = process.cwd();

  assert.throws(
    () => cleanup(outsideDir),
    (err) => err instanceof Error && err.message.includes(outsideDir),
    'cleanup must throw an Error whose message names the offending path'
  );

  assert.strictEqual(
    process.cwd(),
    cwdBefore,
    'cleanup must refuse before chdir, so cwd is unchanged'
  );
  assert.strictEqual(fs.existsSync(outsideDir), true, 'target directory must still exist after refusal');
  assert.strictEqual(
    fs.existsSync(knownFile),
    true,
    'a known file inside the target must still exist, proving the dir was not emptied'
  );
});

// ─── Test 5: control — a real os.tmpdir()-rooted path still cleans up ───────

test('cleanup still removes a real os.tmpdir()-rooted directory (control)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cleanup-control-'));

  cleanup(dir);

  assert.strictEqual(fs.existsSync(dir), false, 'os.tmpdir()-rooted directory should be removed');
});

// ─── Test 6b: accepted-roots set always accepts a freshly-minted tmpdir ─────

test('cleanup accepts a freshly-created os.tmpdir()-rooted dir on any platform (accepted-roots invariant)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cleanup-roots-'));
  t.after(() => {
    if (fs.existsSync(dir)) cleanup(dir);
  });

  assert.doesNotThrow(
    () => cleanup(dir),
    'cleanup must accept a directory created directly under os.tmpdir(), regardless of platform-specific canonical spelling (8.3 short/long names, /var symlink, drive-letter case)'
  );
  assert.strictEqual(fs.existsSync(dir), false, 'temp dir should be removed, not refused');
});

// ─── Test 6: realpath'd os.tmpdir() form is not refused (regression) ────────

test('cleanup accepts a realpath()d temp dir even when it differs from the raw path (macOS /var -> /private/var)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cleanup-realpath-'));
  const realPath = fs.realpathSync(dir);

  if (realPath !== dir) {
    // macOS (and any other symlinked-tmpdir platform): the realpath'd form
    // diverges from the raw mkdtempSync() path. This is exactly the shape a
    // caller gets from fs.realpathSync() or from process.cwd() after
    // chdir-ing into a realpath'd dir — assert the guard does NOT refuse it.
    cleanup(realPath);
    assert.strictEqual(fs.existsSync(realPath), false, 'realpath()d form should be removed, not refused');
    assert.strictEqual(fs.existsSync(dir), false, 'raw path should also be gone (same directory)');
  } else {
    // Linux and any platform with no tmpdir symlink indirection: realpath()
    // equals the raw path, so this branch exercises the ordinary path and
    // keeps the test meaningful (non-vacuous) on both platforms.
    t.after(() => {
      if (fs.existsSync(dir)) cleanup(dir);
    });
    cleanup(dir);
    assert.strictEqual(fs.existsSync(dir), false, 'temp dir should be removed');
  }
});
