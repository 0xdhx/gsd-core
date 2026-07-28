#!/usr/bin/env node
'use strict';

/**
 * #2665 — post-suite hermeticity guard.
 *
 * The test suite must never write into a runtime's LIVE config directory. Two
 * mechanisms defend that, and neither one can see this failure:
 *
 *   - `TEST_ENV_BASE` (tests/helpers.cjs) blanks every config-location env var,
 *     but only for CHILD processes. A test that calls the installer IN-PROCESS
 *     is untouched by it.
 *   - CI is blind to the ambient-env half of the class outright, because CI
 *     never has `CLAUDE_CONFIG_DIR` and friends set.
 *
 * So the class is silent by construction: it damages the developer's machine and
 * reports nothing. #2665 records two prior authors each diagnosing it and fixing
 * only the instance in front of them. This module converts it from silent to
 * loud by snapshotting GSD's own install footprint before the suite and
 * re-checking it after.
 *
 * LOCATION — `scripts/`, deliberately NOT `scripts/lib/`. The installer copies
 * `scripts/lib/` into every user's config dir wholesale (readdirSync), while
 * uninstall removes only an explicit allowlist, so a test-only module placed
 * there would ship to users AND survive uninstall. `scripts/affected-tests-lib.cjs`
 * is the precedent for a non-shipped helper at this level.
 *
 * SCOPE — ownership-based, not whole-root. It watches entries GSD unambiguously
 * owns: the top-level install footprint (`GSD_OWNED_ENTRIES`) plus `gsd-`-prefixed
 * children of the dirs GSD shares with the host agent (`GSD_PREFIXED_PARENTS`).
 * It does NOT watch whole config roots. A root such as `~/.claude` is shared with
 * the host agent, which may legitimately write `history.jsonl`, `todos/`, or
 * `settings.json` while the suite runs; watching the root would turn that into a
 * false failure, and a guard that cries wolf gets disabled — after which it
 * catches nothing at all.
 *
 * The ownership test is the prefix, not the location. That distinction is load
 * bearing: the first version of this guard watched only the three top-level
 * entries and MISSED a real leak into `<live>/skills/gsd-dev-preferences/`.
 *
 * KNOWN GAP — a leak into a file GSD does not own (e.g. mutating the host's own
 * `.claude.json`) is outside this guard by construction. Closing it would require
 * watching shared files, which is the false-positive trap above.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Top-level entries only a GSD install creates. See SCOPE above before widening. */
const GSD_OWNED_ENTRIES = ['gsd-core', 'gsd-file-manifest.json', 'gsd-pristine'];

/**
 * Directories GSD SHARES with the host agent. Watching them wholesale would
 * false-positive on the host's own writes, so only `gsd-`-prefixed children are
 * watched — those are unambiguously ours.
 *
 * Added after the first version of this guard MISSED a real leak: a raw
 * `spawnSync` that sandboxed HOME but inherited an ambient CLAUDE_CONFIG_DIR
 * wrote `<live>/skills/gsd-dev-preferences/SKILL.md`, which sits under none of
 * the three top-level entries above.
 */
const GSD_PREFIXED_PARENTS = ['agents', 'commands', 'skills'];
const GSD_ARTIFACT_PREFIX = 'gsd-';

/** Bounds on the recursive walk, so a pathological tree cannot stall the suite. */
const MAX_ENTRIES = 20000;
const MAX_DEPTH = 12;

/**
 * Resolve every runtime config root the product could write to, using the REAL
 * resolver rather than a reimplementation — the guard must watch wherever the
 * product actually points, including through an ambient env var.
 *
 * @returns {string[]} deduped, sorted roots; empty if the built lib is absent.
 */
function resolveLiveConfigRoots(deps = {}) {
  const libDir = deps.libDir || path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
  let getGlobalConfigDir;
  let runtimes;
  try {
    ({ getGlobalConfigDir } = require(path.join(libDir, 'runtime-homes.cjs')));
    ({ runtimes } = require(path.join(libDir, 'capability-registry.cjs')));
  } catch {
    // Unbuilt tree: the guard is advisory infrastructure and must never be the
    // reason a test run cannot start. Callers treat [] as "guard unavailable".
    return [];
  }

  const roots = new Set();
  // 'grok' is a hardcoded branch of getGlobalConfigDir with no registry entry.
  for (const runtime of [...Object.keys(runtimes || {}), 'grok']) {
    try {
      const dir = getGlobalConfigDir(runtime);
      if (typeof dir === 'string' && dir.length > 0) roots.add(path.resolve(dir));
    } catch {
      // A descriptor the resolver cannot satisfy is not this module's problem.
    }
  }
  return [...roots].sort();
}

/**
 * Newest mtime within a tree, bounded. Returns `truncated: true` when a bound
 * was hit — the caller must NOT report such a result as clean, on the same
 * principle that an existence probe passing vacuously is worse than no probe.
 */
function newestMtime(target, budget) {
  let newest = 0;
  let truncated = false;

  const walk = (current, depth) => {
    if (budget.remaining <= 0) { truncated = true; return; }
    if (depth > MAX_DEPTH) { truncated = true; return; }
    let st;
    try {
      st = fs.lstatSync(current);
    } catch {
      return;
    }
    budget.remaining -= 1;
    if (st.mtimeMs > newest) newest = st.mtimeMs;
    if (!st.isDirectory()) return;
    let entries;
    try {
      entries = fs.readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) walk(path.join(current, entry), depth + 1);
  };

  walk(target, 0);
  return { newest, truncated };
}

/**
 * Snapshot GSD-owned entries under each root.
 *
 * @returns {Record<string, {exists: boolean, newest: number, truncated: boolean}>}
 *   keyed by absolute entry path.
 */
function snapshotLiveConfig(roots) {
  const budget = { remaining: MAX_ENTRIES };
  const snap = {};

  const record = (target) => {
    if (!fs.existsSync(target)) {
      snap[target] = { exists: false, newest: 0, truncated: false };
      return;
    }
    const { newest, truncated } = newestMtime(target, budget);
    snap[target] = { exists: true, newest, truncated };
  };

  for (const root of roots) {
    for (const entry of GSD_OWNED_ENTRIES) record(path.join(root, entry));

    // Shared dirs: enumerate only gsd-prefixed children. A child that appears
    // between the two snapshots is absent from `before` entirely — diffLiveConfig
    // treats after-only paths as created, which is exactly the leak signal.
    for (const parent of GSD_PREFIXED_PARENTS) {
      const parentDir = path.join(root, parent);
      let children;
      try {
        children = fs.readdirSync(parentDir);
      } catch {
        continue; // parent absent — nothing of ours can be in it yet
      }
      for (const child of children) {
        if (child.startsWith(GSD_ARTIFACT_PREFIX)) record(path.join(parentDir, child));
      }
    }
  }
  return snap;
}

/**
 * Compare two snapshots. A path is a violation when it was created during the
 * run, or when its newest mtime advanced.
 *
 * @returns {{path: string, kind: 'created'|'modified'|'unverified'}[]}
 */
function diffLiveConfig(before, after) {
  const violations = [];
  for (const [target, post] of Object.entries(after)) {
    const pre = before[target];
    // Absent from `before` entirely: a gsd-prefixed child that did not exist
    // when the run started. Both snapshots cover the same roots, so an
    // after-only path was created BY the run — never skip it.
    if (!pre) {
      if (post.exists) violations.push({ path: target, kind: 'created' });
      continue;
    }
    if (!pre.exists && post.exists) {
      violations.push({ path: target, kind: 'created' });
    } else if (pre.exists && post.exists && post.newest > pre.newest) {
      violations.push({ path: target, kind: 'modified' });
    } else if (pre.truncated || post.truncated) {
      // Bound hit: we cannot attest this path either way, and saying nothing
      // would let a truncated scan read as a clean one.
      violations.push({ path: target, kind: 'unverified' });
    }
  }
  return violations;
}

/** Human-facing report for a non-empty violation set. */
function formatViolations(violations) {
  const lines = [
    '',
    'run-tests: HERMETICITY FAILURE — the suite wrote into a LIVE config directory.',
    '',
    'A test resolved a runtime config dir from the ambient environment instead of a',
    'sandbox. The usual cause is an IN-PROCESS install() call: tests/helpers.cjs',
    'TEST_ENV_BASE only scrubs CHILD process env, so an in-process caller must also',
    'use scrubConfigLocationEnv() (see tests/install.test.cjs) alongside its HOME',
    'sandbox. CI cannot catch this class — it never has these env vars set.',
    '',
  ];
  for (const v of violations) {
    const label = v.kind === 'unverified'
      ? 'UNVERIFIED (scan bound hit — not attested clean)'
      : v.kind.toUpperCase();
    lines.push(`  ${label}: ${v.path}`);
  }
  lines.push('');
  lines.push('Set GSD_SKIP_LIVE_CONFIG_GUARD=1 to bypass (intentionally loud).');
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  GSD_OWNED_ENTRIES,
  GSD_PREFIXED_PARENTS,
  GSD_ARTIFACT_PREFIX,
  MAX_ENTRIES,
  MAX_DEPTH,
  resolveLiveConfigRoots,
  snapshotLiveConfig,
  diffLiveConfig,
  formatViolations,
  newestMtime,
  os, // exported for test seams only
};
