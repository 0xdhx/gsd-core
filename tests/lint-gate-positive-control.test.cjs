'use strict';

/**
 * #5204 (epic #5056, ADR-5057 §4 ratchet): the gate positive-control lint
 * (scripts/lint-gate-positive-control.cjs).
 *
 * Positive controls for the lint itself: every rule has an inline gate/control pair that must be
 * flagged, the clean pair must not be, and the census over the real tree is zero. Sources are in
 * memory (a gate is TypeScript), so no compiler or linter walks a deliberately violating file.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fc = require('fast-check');

const { scanSources, census, loadParser, RULES, ALLOWLIST, gateIdOf, deriveRed } = require('../scripts/lint-gate-positive-control.cjs');

const ROOT = path.join(__dirname, '..');
const parser = loadParser(ROOT);

const GATE_IMPORTS = [
  "import { gateVerdict, gateUnreadable } from './gate-verdict.cjs';",
  "import type { GateResult } from './gate-verdict.cjs';",
].join('\n');

/** A gate source whose body is `body`, exporting `evaluate<Name>` with the declared return type. */
function gateSource(name, body, returns = ': GateResult') {
  return `${GATE_IMPORTS}\nexport function evaluate${name}(input: { projectDir: string; args: readonly string[] })${returns} {\n${body}\n}\n`;
}

const BLOCKING_BODY = "  const blocked = input.args.length === 0;\n  return gateVerdict(blocked ? 'block' : 'pass', blocked, {});";
const ADVISORY_BODY = "  if (input.args.length === 0) return gateUnreadable(false, {});\n  return gateVerdict('advisory', false, {});";
const CANNOT_FAIL_BODY = "  return gateVerdict('pass', false, {});";

function gate(id, name, body, returns) {
  return { file: `src/gate-${id}.cts`, text: gateSource(name, body, returns) };
}

/** A test source with one `gateControl` call; every field is overridable (a field set to null is omitted). */
function control({ id = 'foo', fn = 'evaluateFoo', red = 'block', module: modulePath = `../gsd-core/bin/lib/gate-${id}.cjs`, file = 'tests/gate-positive-control.test.cjs' } = {}) {
  const fields = [
    id === null ? null : `gate: '${id}'`,
    fn === null ? null : `fn: '${fn}'`,
    red === null ? null : `red: '${red}'`,
    modulePath === null ? null : `module: require('${modulePath}')`,
    'redScenario: {}',
    'greenScenario: {}',
  ].filter((f) => f !== null);
  return { file, text: `gateControl({ ${fields.join(', ')} });\n` };
}

function scan(gates, controls, options) {
  return scanSources({ gates, controls }, parser, options);
}

function ruleSet(result) {
  return [...new Set(result.violations.map((v) => v.rule))].sort();
}

describe('lint-gate-positive-control — clean pairs pass', () => {
  test('cleanBlockingGatePasses: a blocking gate with a block control', () => {
    const result = scan([gate('foo', 'Foo', BLOCKING_BODY)], [control({ red: 'block' })]);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.problems, []);
    assert.equal(result.gates[0].red, 'block');
  });

  test('cleanAdvisoryGatePasses: a gate that never blocks with an unreadable control', () => {
    const result = scan([gate('foo', 'Foo', ADVISORY_BODY)], [control({ red: 'unreadable' })]);
    assert.deepEqual(result.violations, []);
    assert.equal(result.gates[0].red, 'unreadable');
  });

  test('conditionalBlockArmCounts: a block decided by a variable (not the literal false) is a blocking arm', () => {
    assert.equal(deriveRed(parser.parse(gateSource('Foo', BLOCKING_BODY), { range: true, loc: true, sourceType: 'module', filePath: 'src/gate-foo.cts' })), 'block');
  });

  test('gateIdOf names gate-<id>.cts and nothing else', () => {
    assert.equal(gateIdOf('src/gate-foo-bar.cts'), 'foo-bar');
    assert.equal(gateIdOf('src/foo.cts'), null);
    assert.equal(gateIdOf('src/gate-foo.cjs'), null);
  });
});

describe('lint-gate-positive-control — each rule is flagged (positive controls)', () => {
  test('gateWithoutControlIsFlagged', () => {
    assert.deepEqual(ruleSet(scan([gate('foo', 'Foo', BLOCKING_BODY)], [])), [RULES.NO_CONTROL]);
  });

  test('blockingGateWithUnreadableControlIsFlagged: a control may not dodge a blocking arm', () => {
    const result = scan([gate('foo', 'Foo', BLOCKING_BODY)], [control({ red: 'unreadable' })]);
    assert.deepEqual(ruleSet(result), [RULES.WRONG_RED]);
  });

  test('advisoryGateWithBlockControlIsFlagged', () => {
    const result = scan([gate('foo', 'Foo', ADVISORY_BODY)], [control({ red: 'block' })]);
    assert.deepEqual(ruleSet(result), [RULES.WRONG_RED]);
  });

  test('gateThatCannotFailIsFlagged: neither a blocking arm nor an unreadable one', () => {
    const result = scan([gate('foo', 'Foo', CANNOT_FAIL_BODY)], [control({ red: 'unreadable' })]);
    assert.ok(ruleSet(result).includes(RULES.NO_FAILING_VERDICT));
  });

  test('orphanControlIsFlagged: a control naming a gate that does not exist', () => {
    const result = scan([gate('foo', 'Foo', BLOCKING_BODY)], [control({ id: 'foo' }), control({ id: 'ghost', fn: 'evaluateGhost' })]);
    assert.deepEqual(ruleSet(result), [RULES.ORPHAN_CONTROL]);
    assert.equal(result.violations[0].gate, 'ghost');
  });

  test('controlOnWrongModuleIsFlagged: the module required is another gate', () => {
    const result = scan([gate('foo', 'Foo', BLOCKING_BODY)], [control({ module: '../gsd-core/bin/lib/gate-bar.cjs' })]);
    assert.deepEqual(ruleSet(result), [RULES.WRONG_MODULE]);
  });

  test('controlOnWrongFunctionIsFlagged: fn is not the gate export', () => {
    const result = scan([gate('foo', 'Foo', BLOCKING_BODY)], [control({ fn: 'evaluateOther' })]);
    assert.deepEqual(ruleSet(result), [RULES.WRONG_FN]);
  });

  test('duplicateControlIsFlagged: two controls for one gate', () => {
    const result = scan([gate('foo', 'Foo', BLOCKING_BODY)], [control(), control({ file: 'tests/other.test.cjs' })]);
    assert.deepEqual(ruleSet(result), [RULES.DUPLICATE_CONTROL]);
  });

  test('malformedControlIsFlagged: a non-literal field is not a control, so the gate is also uncontrolled', () => {
    const text = "gateControl({ gate: someVar, module: require('../gsd-core/bin/lib/gate-foo.cjs'), fn: 'evaluateFoo', red: 'block' });\n";
    const result = scan([gate('foo', 'Foo', BLOCKING_BODY)], [{ file: 'tests/x.test.cjs', text }]);
    assert.deepEqual(ruleSet(result), [RULES.MALFORMED_CONTROL, RULES.NO_CONTROL]);
  });

  test('malformedControlIsFlagged: a module that is not require(<literal>)', () => {
    const text = "gateControl({ gate: 'foo', module: loaded, fn: 'evaluateFoo', red: 'block' });\n";
    const result = scan([gate('foo', 'Foo', BLOCKING_BODY)], [{ file: 'tests/x.test.cjs', text }]);
    assert.ok(ruleSet(result).includes(RULES.MALFORMED_CONTROL));
  });

  test('unclassifiedEvaluateIsFlagged: an exported evaluate* with no GateResult return cannot be classified', () => {
    const result = scan([gate('foo', 'Foo', BLOCKING_BODY, ''), gate('bar', 'Bar', BLOCKING_BODY)], [control({ id: 'bar', fn: 'evaluateBar' })]);
    assert.deepEqual(ruleSet(result), [RULES.UNCLASSIFIED_EVALUATE]);
  });
});

describe('lint-gate-positive-control — negative space and fail-closed', () => {
  test('commentMentionIsNotAControl: a gateControl in a comment or string does not count', () => {
    const text = "// gateControl({ gate: 'foo', module: require('../gsd-core/bin/lib/gate-foo.cjs'), fn: 'evaluateFoo', red: 'block' });\nconst s = \"gateControl({})\";\n";
    const result = scan([gate('foo', 'Foo', BLOCKING_BODY)], [{ file: 'tests/x.test.cjs', text }]);
    assert.deepEqual(ruleSet(result), [RULES.NO_CONTROL]);
  });

  test('nonGateEvaluateIsIgnored: not exported, or exported from a file that is not gate-*', () => {
    const helper = { file: 'src/gate-foo.cts', text: `${GATE_IMPORTS}\nfunction evaluateHidden(): GateResult { return gateVerdict('pass', false, {}); }\nexport const x = 1;\n` };
    const notGateFile = { file: 'src/other.cts', text: gateSource('Other', BLOCKING_BODY) };
    const result = scan([helper, notGateFile, gate('bar', 'Bar', BLOCKING_BODY)], [control({ id: 'bar', fn: 'evaluateBar' })]);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.gates.map((g) => g.id), ['bar']);
  });

  test('emptyScanIsAProblem: zero gates must not report a clean tree', () => {
    const result = scan([], []);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /zero gate modules/);
  });

  test('unparseableGateIsAProblem: a gate the parser cannot read is a problem, never skipped silently', () => {
    const result = scan([{ file: 'src/gate-broken.cts', text: 'export function ( {{{' }, gate('foo', 'Foo', BLOCKING_BODY)], [control()]);
    assert.ok(result.problems.some((p) => /gate-broken\.cts could not be parsed/.test(p)));
  });

  test('unparseableControlFileIsAProblem', () => {
    const result = scan([gate('foo', 'Foo', BLOCKING_BODY)], [control(), { file: 'tests/broken.test.cjs', text: 'gateControl( {{{' }]);
    assert.ok(result.problems.some((p) => /broken\.test\.cjs could not be parsed/.test(p)));
  });

  test('onlyUncontrolledGateIsFlagged: two gates, one controlled', () => {
    const result = scan([gate('foo', 'Foo', BLOCKING_BODY), gate('bar', 'Bar', BLOCKING_BODY)], [control({ id: 'bar', fn: 'evaluateBar' })]);
    assert.deepEqual(result.violations.map((v) => [v.rule, v.gate]), [[RULES.NO_CONTROL, 'foo']]);
  });
});

describe('lint-gate-positive-control — the allowlist', () => {
  test('ships empty (ADR-5057 §4: drained to zero, never renewed)', () => {
    assert.deepEqual([...ALLOWLIST], []);
  });

  test('an entry tolerates exactly its (gate, rule) violation', () => {
    const allowlist = [{ gate: 'foo', rule: RULES.NO_CONTROL, reason: 'test' }];
    const result = scan([gate('foo', 'Foo', BLOCKING_BODY), gate('bar', 'Bar', BLOCKING_BODY)], [], { allowlist });
    assert.deepEqual(result.violations.map((v) => v.gate), ['bar']);
    assert.equal(result.allowlisted.length, 1);
    assert.deepEqual(result.problems, []);
  });

  test('staleAllowlistEntryIsAProblem: an entry that matches nothing', () => {
    const allowlist = [{ gate: 'foo', rule: RULES.NO_CONTROL, reason: 'test' }];
    const result = scan([gate('foo', 'Foo', BLOCKING_BODY)], [control()], { allowlist });
    assert.ok(result.problems.some((p) => /matches no violation/.test(p)));
  });
});

describe('lint-gate-positive-control — limit-1, limit, limit+1 (property)', () => {
  test('violationCountTracksUncontrolledGates: over any mix of controlled gates (1..8), violations are exactly the uncontrolled ones', () => {
    fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }), (controlled) => {
      const gates = controlled.map((_, i) => gate(`g${i}`, `G${i}`, BLOCKING_BODY));
      const controls = controlled.flatMap((isControlled, i) => (isControlled ? [control({ id: `g${i}`, fn: `evaluateG${i}` })] : []));
      const result = scan(gates, controls);
      const expected = controlled.flatMap((isControlled, i) => (isControlled ? [] : [`g${i}`]));
      assert.deepEqual(result.violations.map((v) => v.gate), expected);
      assert.ok(result.violations.every((v) => v.rule === RULES.NO_CONTROL));
      assert.deepEqual(result.problems, []);
    }), { seed: 5204, numRuns: 100 });
  });
});

describe('lint-gate-positive-control — the real tree', () => {
  test('realTreeCensusIsZero: 12 gate modules (ADR-5057 census), every count zero', () => {
    const c = census(ROOT, parser);
    assert.equal(c.gates, 12, 'every gate module is discovered (a drop here is an inert scan)');
    assert.equal(c.controls, 12);
    for (const key of ['noControl', 'duplicateControl', 'wrongRed', 'noFailingVerdict', 'wrongModule', 'wrongFn', 'malformedControl', 'orphanControl', 'unclassifiedEvaluate', 'allowlisted', 'total']) {
      assert.equal(c[key], 0, key);
    }
    assert.deepEqual(c.problems, []);
  });
});
