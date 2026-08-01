'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fc = require('fast-check');

const {
  GSD_OWNED_ENTRIES,
  MAX_DEPTH,
  resolveLiveConfigRoots,
  resolveExtraWatchTargets,
  snapshotLiveConfig,
  diffLiveConfig,
  formatViolations,
  newestMtime,
} = require('../scripts/live-config-guard.cjs');

const { cleanup } = require('./helpers.cjs');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'live-config-guard-'));
}

/** Create `n` flat files under a fresh dir; returns [dir, entryCount-including-dir]. */
function treeWithEntries(n) {
  const dir = tmpRoot();
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(dir, `f${i}`), 'x');
  return [dir, n + 1]; // +1: the directory itself is lstat'd and costs budget
}

describe('#2665: live-config hermeticity guard', () => {
  test('resolves real runtime config roots via the product resolver', () => {
    const roots = resolveLiveConfigRoots();
    // Guards the guard: an empty set would make every downstream assertion
    // vacuous, and run-tests.cjs would silently skip the check.
    assert.ok(roots.length > 5, `expected many runtime config roots, got ${roots.length}`);
    for (const root of roots) {
      assert.ok(path.isAbsolute(root), `root must be absolute: ${root}`);
    }
  });

  test('a clean run produces no violations', () => {
    const root = tmpRoot();
    try {
      fs.mkdirSync(path.join(root, 'gsd-core', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(root, 'gsd-core', 'bin', 'x.cjs'), 'x');

      const before = snapshotLiveConfig([root]);
      const after = snapshotLiveConfig([root]);
      assert.deepStrictEqual(diffLiveConfig(before, after), []);
    } finally {
      cleanup(root);
    }
  });

  test('detects a global install CREATED during the run', () => {
    const root = tmpRoot();
    try {
      const before = snapshotLiveConfig([root]);
      // Exactly the Blocker 1 shape: an in-process install(true, …) landing a
      // full global install in a live config dir that was previously empty.
      fs.mkdirSync(path.join(root, 'gsd-core'), { recursive: true });
      fs.writeFileSync(path.join(root, 'gsd-file-manifest.json'), '{}');

      const violations = diffLiveConfig(before, snapshotLiveConfig([root]));
      const kinds = Object.fromEntries(violations.map((v) => [path.basename(v.path), v.kind]));
      assert.strictEqual(kinds['gsd-core'], 'created');
      assert.strictEqual(kinds['gsd-file-manifest.json'], 'created');
    } finally {
      cleanup(root);
    }
  });

  test('detects an existing install MODIFIED during the run', () => {
    const root = tmpRoot();
    try {
      const target = path.join(root, 'gsd-core', 'bin');
      fs.mkdirSync(target, { recursive: true });
      const file = path.join(target, 'gsd-tools.cjs');
      fs.writeFileSync(file, 'original');

      const before = snapshotLiveConfig([root]);
      // mtime resolution is coarse on some filesystems; set it forward explicitly
      // rather than racing the clock with a sleep.
      const future = new Date(Date.now() + 10000);
      fs.writeFileSync(file, 'clobbered');
      fs.utimesSync(file, future, future);

      const violations = diffLiveConfig(before, snapshotLiveConfig([root]));
      assert.strictEqual(violations.length, 1);
      assert.strictEqual(violations[0].kind, 'modified');
      assert.strictEqual(path.basename(violations[0].path), 'gsd-core');
    } finally {
      cleanup(root);
    }
  });

  test('ignores non-GSD writes in a shared config root', () => {
    const root = tmpRoot();
    try {
      const before = snapshotLiveConfig([root]);
      // A concurrent host-agent session writing its own state must NOT trip the
      // guard — a guard that cries wolf gets disabled, and then catches nothing.
      fs.writeFileSync(path.join(root, 'history.jsonl'), '{}');
      fs.mkdirSync(path.join(root, 'todos'), { recursive: true });
      fs.writeFileSync(path.join(root, 'settings.json'), '{}');

      assert.deepStrictEqual(diffLiveConfig(before, snapshotLiveConfig([root])), []);
    } finally {
      cleanup(root);
    }
  });

  test('watches exactly the GSD-owned entry set', () => {
    const root = tmpRoot();
    try {
      const snap = snapshotLiveConfig([root]);
      const watched = Object.keys(snap).map((p) => path.basename(p)).sort();
      assert.deepStrictEqual(watched, [...GSD_OWNED_ENTRIES].sort());
    } finally {
      cleanup(root);
    }
  });

  test('detects a gsd-prefixed artifact written into a SHARED dir', () => {
    const root = tmpRoot();
    try {
      fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
      const before = snapshotLiveConfig([root]);
      // The exact leak the first version of this guard MISSED: a writer that
      // sandboxed HOME but inherited an ambient CLAUDE_CONFIG_DIR landed
      // <live>/skills/gsd-dev-preferences/SKILL.md, outside the three
      // top-level GSD entries.
      fs.mkdirSync(path.join(root, 'skills', 'gsd-dev-preferences'), { recursive: true });
      fs.writeFileSync(path.join(root, 'skills', 'gsd-dev-preferences', 'SKILL.md'), '# x');

      const violations = diffLiveConfig(before, snapshotLiveConfig([root]));
      assert.strictEqual(violations.length, 1);
      assert.strictEqual(violations[0].kind, 'created');
      assert.strictEqual(path.basename(violations[0].path), 'gsd-dev-preferences');
    } finally {
      cleanup(root);
    }
  });

  test('ignores NON-gsd artifacts in a shared dir', () => {
    const root = tmpRoot();
    try {
      fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
      const before = snapshotLiveConfig([root]);
      // The host agent's own skills must not trip the guard.
      fs.mkdirSync(path.join(root, 'skills', 'my-personal-skill'), { recursive: true });
      fs.writeFileSync(path.join(root, 'skills', 'my-personal-skill', 'SKILL.md'), '# mine');

      assert.deepStrictEqual(diffLiveConfig(before, snapshotLiveConfig([root])), []);
    } finally {
      cleanup(root);
    }
  });

  test('the report names the path and the remedy', () => {
    const out = formatViolations([{ path: '/live/.claude/gsd-core', kind: 'created' }]);
    assert.match(out, /HERMETICITY WARNING/);
    assert.match(out, /\/live\/\.claude\/gsd-core/);
    assert.match(out, /scrubConfigLocationEnv/);
    assert.match(out, /GSD_SKIP_LIVE_CONFIG_GUARD/);
    assert.match(out, /GSD_STRICT_LIVE_CONFIG_GUARD/);
  });
});

// ── Round 3: the two write surfaces that are not runtime config ROOTS ────────
describe('#2665: guard watches non-root write surfaces', () => {
  test('resolveExtraWatchTargets covers $GSD_HOME/.gsd and kimi config.toml', () => {
    const home = tmpRoot();
    const share = tmpRoot();
    try {
      const targets = resolveExtraWatchTargets({
        env: { GSD_HOME: home, KIMI_SHARE_DIR: share },
        os: { homedir: () => home },
      });
      assert.ok(
        targets.includes(path.resolve(path.join(home, '.gsd'))),
        `expected $GSD_HOME/.gsd in ${JSON.stringify(targets)}`,
      );
      assert.ok(
        targets.some((t) => t === path.resolve(path.join(share, 'config.toml'))),
        `expected kimi config.toml in ${JSON.stringify(targets)}`,
      );
    } finally {
      cleanup(home);
      cleanup(share);
    }
  });

  test('GSD_HOME falls back to homedir when unset', () => {
    const home = tmpRoot();
    try {
      const targets = resolveExtraWatchTargets({ env: {}, os: { homedir: () => home } });
      assert.ok(targets.includes(path.resolve(path.join(home, '.gsd'))));
    } finally {
      cleanup(home);
    }
  });

  test('detects a consent/defaults write into $GSD_HOME/.gsd', () => {
    const home = tmpRoot();
    try {
      const target = path.join(home, '.gsd');
      const before = snapshotLiveConfig([], [target]);
      // The Blocker-1 shape one family over: an ambient GSD_HOME sends real
      // consent records and defaults.json into the developer's own store.
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'consent.json'), '{}');

      const violations = diffLiveConfig(before, snapshotLiveConfig([], [target]));
      assert.strictEqual(violations.length, 1);
      assert.strictEqual(violations[0].kind, 'created');
    } finally {
      cleanup(home);
    }
  });

  test('detects a [[hooks]] write into kimi config.toml', () => {
    const share = tmpRoot();
    try {
      const target = path.join(share, 'config.toml');
      const before = snapshotLiveConfig([], [target]);
      fs.writeFileSync(target, '[[hooks]]\n');

      const violations = diffLiveConfig(before, snapshotLiveConfig([], [target]));
      assert.strictEqual(violations.length, 1);
      assert.strictEqual(violations[0].kind, 'created');
    } finally {
      cleanup(share);
    }
  });

  test('NEGATIVE CONTROL: without the extras both leaks are silent', () => {
    const home = tmpRoot();
    try {
      // This is the pre-round-3 guard shape — roots only. It is what let a leak
      // on either variable pass through the PR's own safety net unreported.
      const before = snapshotLiveConfig([]);
      fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
      fs.writeFileSync(path.join(home, '.gsd', 'consent.json'), '{}');

      assert.deepStrictEqual(diffLiveConfig(before, snapshotLiveConfig([])), []);
    } finally {
      cleanup(home);
    }
  });

  test('a whole-dir extra target does not watch unrelated siblings', () => {
    const home = tmpRoot();
    try {
      const target = path.join(home, '.gsd');
      fs.mkdirSync(target, { recursive: true });
      const before = snapshotLiveConfig([], [target]);
      // A sibling of .gsd is outside the watched target entirely.
      fs.writeFileSync(path.join(home, 'unrelated.json'), '{}');

      assert.deepStrictEqual(diffLiveConfig(before, snapshotLiveConfig([], [target])), []);
    } finally {
      cleanup(home);
    }
  });
});

// ── Round 3: the truncation budget — the module's own safety-critical case ───
describe('#2665: scan-budget truncation', () => {
  test('boundary: limit-1 truncates, limit and limit+1 do not', () => {
    const [dir, entries] = treeWithEntries(24);
    try {
      // RULESET.TESTS.boundary-coverage: N in {limit-1, limit, limit+1}. The
      // budget is injected, so the boundary is exercised at a real threshold
      // without materialising MAX_ENTRIES files.
      assert.strictEqual(
        newestMtime(dir, { remaining: entries - 1 }).truncated,
        true,
        'one entry short of the tree size MUST truncate',
      );
      assert.strictEqual(
        newestMtime(dir, { remaining: entries }).truncated,
        false,
        'a budget exactly equal to the tree size must NOT truncate',
      );
      assert.strictEqual(
        newestMtime(dir, { remaining: entries + 1 }).truncated,
        false,
        'a budget above the tree size must NOT truncate',
      );
    } finally {
      cleanup(dir);
    }
  });

  test('exceeding MAX_DEPTH truncates', () => {
    const dir = tmpRoot();
    try {
      let deep = dir;
      for (let i = 0; i <= MAX_DEPTH + 1; i++) deep = path.join(deep, `d${i}`);
      fs.mkdirSync(deep, { recursive: true });

      const res = newestMtime(dir, { remaining: 1e6 });
      assert.strictEqual(res.truncated, true, 'a tree deeper than MAX_DEPTH must truncate');
    } finally {
      cleanup(dir);
    }
  });

  test('a truncated scan reports UNVERIFIED, never clean', () => {
    const [dir, entries] = treeWithEntries(10);
    try {
      // The safety-critical branch named in this module's own docstring: a scan
      // that hit a bound must not read as an attestation of cleanliness.
      const snap = { [dir]: { exists: true, newest: 1, truncated: true } };
      const violations = diffLiveConfig(snap, {
        [dir]: { exists: true, newest: 1, truncated: true },
      });
      assert.strictEqual(violations.length, 1);
      assert.strictEqual(violations[0].kind, 'unverified');
      assert.match(formatViolations(violations), /UNVERIFIED \(scan bound hit/);
      assert.ok(entries > 0);
    } finally {
      cleanup(dir);
    }
  });

  test('a modified path outranks unverified (a real leak is never downgraded)', () => {
    const p = '/live/.claude/gsd-core';
    const violations = diffLiveConfig(
      { [p]: { exists: true, newest: 1, truncated: true } },
      { [p]: { exists: true, newest: 2, truncated: true } },
    );
    assert.strictEqual(violations[0].kind, 'modified');
  });

  test('property: truncation is monotone in the budget (boundary containment)', () => {
    const [dir, entries] = treeWithEntries(12);
    try {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: entries * 3 }), (budget) => {
          const { truncated } = newestMtime(dir, { remaining: budget });
          // The invariant: a budget at or above the tree size never truncates,
          // and one below it always does. A regression flipping `truncated` to
          // false on an exhausted budget — the exact silent-clean failure the
          // module warns about — breaks this for every budget < entries.
          return budget >= entries ? truncated === false : truncated === true;
        }),
        { numRuns: 100 },
      );
    } finally {
      cleanup(dir);
    }
  });

  test('property: newest mtime never exceeds the true maximum', () => {
    const [dir, entries] = treeWithEntries(8);
    try {
      const trueMax = Math.max(
        ...fs.readdirSync(dir).map((f) => fs.lstatSync(path.join(dir, f)).mtimeMs),
        fs.lstatSync(dir).mtimeMs,
      );
      fc.assert(
        fc.property(fc.integer({ min: 1, max: entries * 2 }), (budget) => {
          const { newest } = newestMtime(dir, { remaining: budget });
          return newest <= trueMax;
        }),
        { numRuns: 50 },
      );
    } finally {
      cleanup(dir);
    }
  });
});
