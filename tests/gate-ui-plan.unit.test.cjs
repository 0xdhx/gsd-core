'use strict';

/**
 * U3 — in-process GateVerdict tests for `check ui-plan-gate` (#5139, epic #5056, ADR-5057 §4).
 *
 * FAILING-FIRST (RED): `gsd-core/bin/lib/gate-ui-plan.cjs` does not exist yet, so this file
 * fails at require time on origin/next. The module must export
 * `evaluateUiPlanGate({ projectDir, args })` where `args` is the argv AFTER the verb, returning a
 * GateVerdict ({ outcome, block, payload }) for every arm that prints a payload today and a
 * GateUsageFailure ({ failure: { code, message } }) for every arm that calls `error()` today.
 *
 * Every payload below was captured by EXECUTING the pre-move router (`gsd-tools check ui-plan-gate`)
 * on origin/next in a fixture project; the tests compare the deep value AND the serialized key
 * order (stdout is byte-identical only if the payload's insertion order is preserved).
 * `outcome`/`block` are the new GateVerdict fields; their mapping from today's payload is
 * recorded per case (see 50-test-matrix.md, API contract).
 *
 * Each case also asserts the gate never writes to process.stdout / process.stderr: only the
 * router formats output (design D2).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup } = require('./helpers.cjs');

const gate = require('../gsd-core/bin/lib/gate-ui-plan.cjs');
const { isGateUsageFailure } = require('../gsd-core/bin/lib/gate-verdict.cjs');

function w(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const h = { w };

/** Replace every spelling of the temp project dir (as created, and its realpath) with one token, deeply. */
function normalizeTmp(value, dir, real) {
  if (typeof value === 'string') return value.split(real).join('<tmp>').split(dir).join('<tmp>');
  if (Array.isArray(value)) return value.map((v) => normalizeTmp(v, dir, real));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeTmp(v, dir, real)]));
  }
  return value;
}

const CASES = [
  {
    id: 'U3a',
    title: 'no ROADMAP.md -> not frontend, nothing blocks',
    args() { return ['1']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        frontend: false,
        hasFrontendEvidence: false,
        hasUiSpec: false,
        block: false,
        uiSpecPath: null,
        matchedToken: null,
        matchedLine: null,
      };
    },
  },
  {
    id: 'U3b',
    title: 'frontend phase + static evidence + no UI-SPEC -> blocks',
    setup(dir, h) {
      h.w(dir, '.planning/ROADMAP.md', ['# Roadmap', '', '### Phase 1: Dashboard frontend', '**Goal**: Build the React dashboard UI for operators', ''].join('\n'));
      h.w(dir, 'package.json', '{"dependencies":{"react":"^18.0.0"}}');
      h.w(dir, '.planning/phases/01-dashboard/01-01-PLAN.md', '# p\n');
    },
    args() { return ['1']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        frontend: true,
        hasFrontendEvidence: true,
        hasUiSpec: false,
        block: true,
        uiSpecPath: null,
        matchedToken: 'dashboard',
        matchedLine: '### Phase 1: Dashboard frontend',
      };
    },
  },
  {
    id: 'U3c',
    title: 'frontend phase with a UI-SPEC present -> passes, uiSpecPath reported',
    setup(dir, h) {
      h.w(dir, '.planning/ROADMAP.md', ['# Roadmap', '', '### Phase 1: Dashboard frontend', '**Goal**: Build the React dashboard UI for operators', ''].join('\n'));
      h.w(dir, 'package.json', '{"dependencies":{"react":"^18.0.0"}}');
      h.w(dir, '.planning/phases/01-dashboard/01-UI-SPEC.md', '# spec\n');
    },
    args() { return ['1']; },
    outcome: 'pass',
    block: false,
    expected(dir, real) {
      return {
        frontend: true,
        hasFrontendEvidence: true,
        hasUiSpec: true,
        block: false,
        uiSpecPath: `${real}/.planning/phases/01-dashboard/01-UI-SPEC.md`,
        matchedToken: 'dashboard',
        matchedLine: '### Phase 1: Dashboard frontend',
      };
    },
  },
  {
    id: 'U3d',
    title: 'frontend vocabulary without static evidence -> does not block',
    setup(dir, h) {
      h.w(dir, '.planning/ROADMAP.md', ['# Roadmap', '', '### Phase 1: Dashboard frontend', '**Goal**: Build the React dashboard UI for operators', ''].join('\n'));
      h.w(dir, '.planning/phases/01-dashboard/01-01-PLAN.md', '# p\n');
    },
    args() { return ['1']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        frontend: true,
        hasFrontendEvidence: false,
        hasUiSpec: false,
        block: false,
        uiSpecPath: null,
        matchedToken: 'dashboard',
        matchedLine: '### Phase 1: Dashboard frontend',
      };
    },
  },
  {
    id: 'U3e',
    title: 'ROADMAP present but phase absent -> phaseLookupFailed appended last',
    setup(dir, h) {
      h.w(dir, '.planning/ROADMAP.md', ['# Roadmap', '', '### Phase 1: Dashboard frontend', '**Goal**: Build the React dashboard UI for operators', ''].join('\n'));
    },
    args() { return ['9']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        frontend: false,
        hasFrontendEvidence: false,
        hasUiSpec: false,
        block: false,
        uiSpecPath: null,
        matchedToken: null,
        matchedLine: null,
        phaseLookupFailed: true,
      };
    },
  },
  {
    id: 'U3f',
    title: 'missing phase argument is a usage failure',
    args() { return []; },
    usage: { code: 'sdk_missing_arg', message: 'ui-plan-gate requires a phase argument: check ui-plan-gate <phase>' },
  },
];

function run(c) {
  const dir = createTempProject('gate-u3-');
  const real = fs.realpathSync(dir);
  const writes = [];
  const outWrite = process.stdout.write;
  const errWrite = process.stderr.write;
  let restore;
  let result;
  try {
    restore = c.setup ? c.setup(dir, h) : undefined;
    process.stdout.write = (chunk) => {
      writes.push({ stream: 'stdout', chunk: String(chunk) });
      return true;
    };
    process.stderr.write = (chunk) => {
      writes.push({ stream: 'stderr', chunk: String(chunk) });
      return true;
    };
    result = gate.evaluateUiPlanGate({ projectDir: dir, args: c.args(dir) });
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    if (typeof restore === 'function') restore();
    cleanup(dir);
  }
  return { result, writes, dir, real };
}

describe('U3 evaluateUiPlanGate', () => {
  for (const c of CASES) {
    test(`${c.id}: ${c.title}`, () => {
      const { result, writes, dir, real } = run(c);
      const unexpected = writes.filter(
        (w) => !(c.stderrPrefix && w.stream === 'stderr' && w.chunk.startsWith(c.stderrPrefix)),
      );
      assert.deepStrictEqual(unexpected, [], 'a gate module must not write to stdout/stderr');
      if (c.usage) {
        assert.equal(isGateUsageFailure(result), true);
        assert.deepStrictEqual(result, { failure: { code: c.usage.code, message: c.usage.message } });
        return;
      }
      assert.equal(isGateUsageFailure(result), false);
      assert.equal(result.outcome, c.outcome);
      assert.equal(result.block, c.block);
      // The temp dir may be spelled through a symlink (macOS /var -> /private/var) on either side;
      // both sides go through one normaliser so the comparison is independent of the TMPDIR form.
      const expected = normalizeTmp(c.expected(dir, real), dir, real);
      const actual = normalizeTmp(result.payload, dir, real);
      assert.deepStrictEqual(actual, expected);
      assert.equal(JSON.stringify(actual), JSON.stringify(expected), 'payload key order is part of the contract');
    });
  }
});
