'use strict';

/**
 * U7 — in-process GateVerdict tests for `check verify-command-paths` (#5139, epic #5056, ADR-5057 §4).
 *
 * FAILING-FIRST (RED): `gsd-core/bin/lib/gate-verify-command-paths.cjs` does not exist yet, so this file
 * fails at require time on origin/next. The module must export
 * `evaluateVerifyCommandPaths({ projectDir, args })` where `args` is the argv AFTER the verb, returning a
 * GateVerdict ({ outcome, block, payload }) for every arm that prints a payload today and a
 * GateUsageFailure ({ failure: { code, message } }) for every arm that calls `error()` today.
 *
 * Every payload below was captured by EXECUTING the pre-move router (`gsd-tools check verify-command-paths`)
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

const gate = require('../gsd-core/bin/lib/gate-verify-command-paths.cjs');
const { isGateUsageFailure } = require('../gsd-core/bin/lib/gate-verdict.cjs');

function w(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** Replace every spelling of the temp project dir (as created, and its realpath) with one token, deeply. */
function normalizeTmp(value, dir, real) {
  if (typeof value === 'string') return value.split(real).join('<tmp>').split(dir).join('<tmp>');
  if (Array.isArray(value)) return value.map((v) => normalizeTmp(v, dir, real));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeTmp(v, dir, real)]));
  }
  return value;
}

function planWith(commands) {
  return ['# Plan', '']
    .concat(
      commands.map((cmd, i) =>
        [
          '<task type="auto">',
          '  <name>task-' + i + '</name>',
          '  <files></files>',
          '  <action>do the thing</action>',
          '  <verify><automated>' + cmd + '</automated></verify>',
          '  <acceptance_criteria>it works</acceptance_criteria>',
          '  <done>committed</done>',
          '</task>',
        ].join('\n'),
      ),
    )
    .join('\n');
}

const h = { w, planWith };

const CASES = [
  {
    id: 'U7a',
    title: 'no phase and no --dir -> unresolvable degraded payload',
    args() { return []; },
    outcome: 'skip',
    block: false,
    expected() {
      return {
        status: 'unresolvable',
        commands: [],
        counts: {
          blocker: 0,
          warning: 0,
          total: 0,
        },
        readError: 'verify-command-paths requires a phase argument or --dir: check verify-command-paths <phase> | --dir <plan-dir>',
      };
    },
  },
  {
    id: 'U7b',
    title: '--dir escaping the project root -> unresolvable degraded payload',
    args() { return ['--dir', '../outside']; },
    outcome: 'skip',
    block: false,
    expected() {
      return {
        status: 'unresolvable',
        commands: [],
        counts: {
          blocker: 0,
          warning: 0,
          total: 0,
        },
        readError: '--dir resolves outside the project root: ../outside',
      };
    },
  },
  {
    id: 'U7c',
    title: 'phase that cannot be resolved -> unresolvable degraded payload',
    args() { return ['99']; },
    outcome: 'skip',
    block: false,
    expected() {
      return {
        status: 'unresolvable',
        commands: [],
        counts: {
          blocker: 0,
          warning: 0,
          total: 0,
        },
        readError: 'could not resolve phase directory for phase 99',
      };
    },
  },
  {
    id: 'U7d',
    title: 'phase whose commands resolve -> probe passthrough (ok)',
    setup(dir, h) {
      h.w(dir, 'good/package.json', '{"name":"fx","scripts":{"test":"node --version"}}');
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', h.planWith(['cd good && npm test']));
    },
    args() { return ['1']; },
    outcome: 'pass',
    block: false,
    expected(dir, real) {
      return {
        status: 'ok',
        commands: [
          {
            command: 'cd good && npm test',
            status: 'ok',
            severity: 'none',
            reason: null,
            form: 'cd',
            rawTarget: 'good',
            target: `${real}/good`,
            manifest: 'package.json',
            script: null,
            sentinel: false,
            base: `${real}`,
            plan: '01-01-PLAN.md',
            task: 'task-0',
          },
        ],
        counts: {
          blocker: 0,
          warning: 0,
          total: 1,
        },
        readError: null,
      };
    },
  },
  {
    id: 'U7e',
    title: 'phase with a broken command target -> probe passthrough (broken, blocker counted)',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', h.planWith(['cd nowhere && npm test']));
    },
    args() { return ['1']; },
    outcome: 'block',
    block: true,
    expected(dir, real) {
      return {
        status: 'broken',
        commands: [
          {
            command: 'cd nowhere && npm test',
            status: 'broken',
            severity: 'blocker',
            reason: 'missing_dir',
            form: 'cd',
            rawTarget: 'nowhere',
            target: `${real}/nowhere`,
            manifest: null,
            script: null,
            sentinel: false,
            base: `${real}`,
            plan: '01-01-PLAN.md',
            task: 'task-0',
          },
        ],
        counts: {
          blocker: 1,
          warning: 0,
          total: 1,
        },
        readError: null,
      };
    },
  },
  {
    id: 'U7f',
    title: '--dir pointing at a contained plan directory -> probed like a phase',
    setup(dir, h) {
      h.w(dir, 'good/package.json', '{"name":"fx","scripts":{"test":"node --version"}}');
      h.w(dir, '.planning/quick/abc/01-PLAN.md', h.planWith(['cd good && npm test']));
    },
    args() { return ['--dir', '.planning/quick/abc']; },
    outcome: 'pass',
    block: false,
    expected(dir, real) {
      return {
        status: 'ok',
        commands: [
          {
            command: 'cd good && npm test',
            status: 'ok',
            severity: 'none',
            reason: null,
            form: 'cd',
            rawTarget: 'good',
            target: `${real}/good`,
            manifest: 'package.json',
            script: null,
            sentinel: false,
            base: `${real}`,
            plan: '01-PLAN.md',
            task: 'task-0',
          },
        ],
        counts: {
          blocker: 0,
          warning: 0,
          total: 1,
        },
        readError: null,
      };
    },
  },
];

function run(c) {
  const dir = createTempProject('gate-u7-');
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
    result = gate.evaluateVerifyCommandPaths({ projectDir: dir, args: c.args(dir) });
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    if (typeof restore === 'function') restore();
    cleanup(dir);
  }
  return { result, writes, dir, real };
}

describe('U7 evaluateVerifyCommandPaths', () => {
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
