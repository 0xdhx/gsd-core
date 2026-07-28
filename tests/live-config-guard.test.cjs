'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  GSD_OWNED_ENTRIES,
  resolveLiveConfigRoots,
  snapshotLiveConfig,
  diffLiveConfig,
  formatViolations,
} = require('../scripts/live-config-guard.cjs');

const { cleanup } = require('./helpers.cjs');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'live-config-guard-'));
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
