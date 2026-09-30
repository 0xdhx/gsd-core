'use strict';

/**
 * U10 — in-process GateVerdict tests for `check predicate` (#5139, epic #5056, ADR-5057 §4).
 *
 * FAILING-FIRST (RED): `gsd-core/bin/lib/gate-predicate.cjs` does not exist yet, so this file
 * fails at require time on origin/next. The module must export
 * `evaluateCheckPredicate({ projectDir, args })` where `args` is the argv AFTER the verb, returning a
 * GateVerdict ({ outcome, block, payload }) for every arm that prints a payload today and a
 * GateUsageFailure ({ failure: { code, message } }) for every arm that calls `error()` today.
 *
 * Every payload below was captured by EXECUTING the pre-move router (`gsd-tools check predicate`)
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

const gate = require('../gsd-core/bin/lib/gate-predicate.cjs');
const { isGateUsageFailure } = require('../gsd-core/bin/lib/gate-verdict.cjs');

function w(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const h = { w };

const CASES = [
  {
    id: 'U10a',
    title: 'command-exit-zero, exit 0 -> pass',
    args() { return ['--predicate', '{"kind":"command-exit-zero","command":"exit 0"}']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        block: false,
        message: 'command exited 0',
        details: {
          kind: 'command-exit-zero',
          exitCode: 0,
        },
      };
    },
  },
  {
    id: 'U10b',
    title: 'command-exit-zero, exit 3 -> block with details',
    args() { return ['--predicate', '{"kind":"command-exit-zero","command":"exit 3"}']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        block: true,
        message: 'command exited 3',
        details: {
          kind: 'command-exit-zero',
          exitCode: 3,
          signal: null,
        },
      };
    },
  },
  {
    id: 'U10c',
    title: 'artifact-frontmatter-equals, field matches -> pass',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-VERIFICATION.md', ['---', 'status: passed', '---', '# v', ''].join('\n'));
    },
    args() { return ['--predicate', '{"kind":"artifact-frontmatter-equals","artifact":"VERIFICATION.md","field":"status","equals":"passed"}', '--phase-dir', '.planning/phases/01-x']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        block: false,
        message: 'Frontmatter field "status" matches expected value (passed)',
        details: {
          kind: 'artifact-frontmatter-equals',
          match: true,
        },
      };
    },
  },
  {
    id: 'U10d',
    title: 'artifact-frontmatter-equals, artifact absent -> block artifactNotFound',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-PLAN.md', '# p\n');
    },
    args() { return ['--predicate', '{"kind":"artifact-frontmatter-equals","artifact":"VERIFICATION.md","field":"status","equals":"passed"}', '--phase-dir', '.planning/phases/01-x']; },
    outcome: 'block',
    block: true,
    expected(dir, real) {
      return {
        block: true,
        message: `Artifact matching VERIFICATION.md not found in ${real}/.planning/phases/01-x`,
        details: {
          kind: 'artifact-frontmatter-equals',
          artifactNotFound: true,
        },
      };
    },
  },
  {
    id: 'U10e',
    title: 'artifact-frontmatter-equals, field differs -> block with actual/expected',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-VERIFICATION.md', ['---', 'status: gaps_found', '---', '# v', ''].join('\n'));
    },
    args() { return ['--predicate', '{"kind":"artifact-frontmatter-equals","artifact":"VERIFICATION.md","field":"status","equals":"passed"}', '--phase-dir', '.planning/phases/01-x']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        block: true,
        message: 'Frontmatter field "status" in VERIFICATION.md is gaps_found, expected passed',
        details: {
          kind: 'artifact-frontmatter-equals',
          match: false,
          actual: 'gaps_found',
          expected: 'passed',
        },
      };
    },
  },
  {
    id: 'U10f',
    title: 'missing --predicate is a usage failure',
    args() { return []; },
    usage: { code: 'sdk_missing_arg', message: 'predicate requires --predicate <json> (the gate hook check.predicate object)' },
  },
  {
    id: 'U10g',
    title: 'non-JSON --predicate is a usage failure',
    args() { return ['--predicate', 'not-json']; },
    usage: { code: 'usage', message: 'predicate --predicate value must be valid JSON' },
  },
  {
    id: 'U10h',
    title: 'evaluator throw (unknown kind) is a usage failure carrying the evaluator message',
    args() { return ['--predicate', '{"kind":"nope"}']; },
    usage: { code: 'usage', message: 'gate predicate evaluation failed: Unknown predicate kind: "nope". Known kinds: command-exit-zero, artifact-frontmatter-equals' },
  },
  {
    id: 'U10i',
    title: '--phase-dir escaping the project root is a usage failure',
    args() { return ['--predicate', '{"kind":"command-exit-zero","command":"exit 0"}', '--phase-dir', '../outside']; },
    usage: { code: 'usage', message: 'path escapes its allowed directory: ../outside' },
  },
];

function run(c) {
  const dir = createTempProject('gate-u10-');
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
    result = gate.evaluateCheckPredicate({ projectDir: dir, args: c.args(dir) });
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    if (typeof restore === 'function') restore();
    cleanup(dir);
  }
  return { result, writes, dir, real };
}

describe('U10 evaluateCheckPredicate', () => {
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
      const expected = c.expected(dir, real);
      assert.deepStrictEqual(result.payload, expected);
      assert.equal(JSON.stringify(result.payload), JSON.stringify(expected), 'payload key order is part of the contract');
    });
  }
});
