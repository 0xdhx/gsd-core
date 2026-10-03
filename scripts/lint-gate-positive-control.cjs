#!/usr/bin/env node
'use strict';

/**
 * #5204 (epic #5056, ADR-5057 §4 ratchet) — every gate module has a positive control.
 *
 * "A gate module with no test that drives it to its failing verdict is a lint failure." A gate is a
 * module under `src/gate-*.cts` that exports an `evaluate*` function returning `GateResult`. It is
 * DISCOVERED, never listed by name, so a new gate is covered without editing this guard. Each gate
 * needs exactly one `gateControl({ gate, module, fn, red, redScenario, greenScenario })` call
 * (tests/helpers/gate-positive-control.cjs), which at run time drives the gate to its failing verdict
 * and to a different one. This guard parses the sources with `@typescript-eslint/parser` (a real AST,
 * no regex over source) and reports:
 *
 *   no-control          a gate with no `gateControl` call
 *   duplicate-control   a gate with more than one (which one proves it is ambiguous)
 *   wrong-red           the control's `red` is not the failing verdict the gate can reach. Derived
 *                       from the gate's own source: `block` when some `gateVerdict`/`gateUnreadable`
 *                       call's block argument is not the literal `false`, else `unreadable`. A
 *                       control cannot declare `unreadable` to dodge a blocking arm
 *   no-failing-verdict  a gate that can neither block nor reach `unreadable`: nothing to drive red
 *   wrong-module        the control's `module` is not the `gate-<id>.cjs` it names
 *   wrong-fn            the control's `fn` is not the gate's exported `evaluate*`
 *   malformed-control   a `gateControl` call whose `gate`/`fn`/`red`/`module` is not a literal the
 *                       guard can read (an unreadable control must not count as a control)
 *   orphan-control      a control naming a gate that does not exist
 *   unclassified-evaluate  an exported `evaluate*` in a gate file that does not declare a `GateResult`
 *                       return, so the guard cannot tell whether it is a gate
 *
 * The allowlist (`ALLOWLIST`) is EMPTY and stays that way (ADR-5057 §4: "drained to zero, never
 * renewed"); an entry that matches nothing is itself a problem. Fail-closed: scanning zero gates, or
 * a gate source the parser cannot read, is a violation — an inert scan must not report a clean tree.
 * `census(root)` re-measures the tree and is asserted zero by tests/lint-gate-positive-control.test.cjs,
 * which also holds the positive controls for this guard (an inline gate/control pair per rule).
 */

const fs = require('node:fs');
const path = require('node:path');
const { runMain } = require('./lib/cli-exit.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const CONTROL_CALL = 'gateControl';

/** Empty by decision (ADR-5057 §4): a gate without a control is fixed, never listed. */
const ALLOWLIST = Object.freeze([]);

const RULES = Object.freeze({
  NO_CONTROL: 'no-control',
  DUPLICATE_CONTROL: 'duplicate-control',
  WRONG_RED: 'wrong-red',
  NO_FAILING_VERDICT: 'no-failing-verdict',
  WRONG_MODULE: 'wrong-module',
  WRONG_FN: 'wrong-fn',
  MALFORMED_CONTROL: 'malformed-control',
  ORPHAN_CONTROL: 'orphan-control',
  UNCLASSIFIED_EVALUATE: 'unclassified-evaluate',
});

function loadParser(root) {
  return require(require.resolve('@typescript-eslint/parser', { paths: [root] }));
}

function isNode(value) {
  return value !== null && typeof value === 'object' && typeof value.type === 'string';
}

/** Depth-first walk; `visit(node, ancestors)`. */
function walk(node, visit, ancestors = []) {
  visit(node, ancestors);
  const next = ancestors.concat(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range' || key === 'tokens' || key === 'comments') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, visit, next);
    } else if (isNode(value)) {
      walk(value, visit, next);
    }
  }
}

function calleeName(call) {
  const callee = call.callee;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') return callee.property.name;
  return null;
}

function stringLiteral(node) {
  return node !== undefined && node !== null && node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
}

function parse(parser, text, file) {
  return parser.parse(text, { range: true, loc: true, sourceType: 'module', filePath: file });
}

// ─── gate discovery ──────────────────────────────────────────────────────────────────────────────

/** The `gate-<id>.cts` basename id, or null for a file that is not a gate file. */
function gateIdOf(file) {
  const match = /(?:^|\/)gate-([a-z0-9-]+)\.cts$/.exec(file.replace(/\\/g, '/'));
  return match === null ? null : match[1];
}

/** Does a function node declare `: GateResult` as its return type? */
function returnsGateResult(fn) {
  const annotation = fn.returnType?.typeAnnotation;
  return annotation?.type === 'TSTypeReference' && annotation.typeName?.type === 'Identifier' && annotation.typeName.name === 'GateResult';
}

/**
 * The exported `evaluate*` functions of a parsed gate file: `{ name, node, classified }`, where
 * `classified` means it declares a `GateResult` return.
 */
function exportedEvaluates(ast) {
  const found = [];
  for (const statement of ast.body) {
    if (statement.type !== 'ExportNamedDeclaration' || statement.declaration === null) continue;
    const declaration = statement.declaration;
    if (declaration.type === 'FunctionDeclaration' && declaration.id !== null && declaration.id.name.startsWith('evaluate')) {
      found.push({ name: declaration.id.name, node: declaration, classified: returnsGateResult(declaration) });
    }
  }
  return found;
}

/**
 * The failing verdict a gate's source can reach. `block` when some `gateVerdict(outcome, block, …)` /
 * `gateUnreadable(block, …)` call's block argument is anything but the literal `false`; `unreadable`
 * when it only reaches the typed unreadable outcome; null when it can reach neither.
 */
function deriveRed(ast) {
  let blocking = false;
  let unreadable = false;
  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const name = calleeName(node);
    if (name !== 'gateVerdict' && name !== 'gateUnreadable') return;
    if (name === 'gateUnreadable') unreadable = true;
    const blockArg = node.arguments[name === 'gateVerdict' ? 1 : 0];
    if (blockArg !== undefined && !(blockArg.type === 'Literal' && blockArg.value === false)) blocking = true;
  });
  if (blocking) return 'block';
  return unreadable ? 'unreadable' : null;
}

// ─── control discovery ───────────────────────────────────────────────────────────────────────────

/** The literal property values of a `gateControl({...})` argument; a non-literal value reads as undefined. */
function readControl(call, file) {
  const spec = call.arguments[0];
  const control = { file, line: call.loc.start.line, gate: undefined, fn: undefined, red: undefined, modulePath: undefined, malformed: [] };
  if (spec === undefined || spec.type !== 'ObjectExpression') {
    control.malformed.push('argument is not an object literal');
    return control;
  }
  const property = (name) => spec.properties.find((p) => p.type === 'Property' && !p.computed
    && ((p.key.type === 'Identifier' && p.key.name === name) || stringLiteral(p.key) === name));
  for (const key of ['gate', 'fn', 'red']) {
    const prop = property(key);
    const value = prop === undefined ? null : stringLiteral(prop.value);
    if (value === null) control.malformed.push(`${key} is not a string literal`);
    else control[key] = value;
  }
  const moduleProp = property('module');
  const requireCall = moduleProp === undefined ? null : moduleProp.value;
  if (requireCall === null || requireCall.type !== 'CallExpression' || requireCall.callee.type !== 'Identifier'
    || requireCall.callee.name !== 'require' || stringLiteral(requireCall.arguments[0]) === null) {
    control.malformed.push('module is not require(<string literal>)');
  } else {
    control.modulePath = stringLiteral(requireCall.arguments[0]);
  }
  return control;
}

/** Every `gateControl(...)` call in one test source. */
function scanControls(text, file, parser) {
  const ast = parse(parser, text, file);
  const controls = [];
  walk(ast, (node) => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === CONTROL_CALL) {
      controls.push(readControl(node, file));
    }
  });
  return controls;
}

// ─── scan ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Scan in-memory sources. `gates`: `[{ file, text }]` for each `src/gate-*.cts`; `controls`:
 * `[{ file, text }]` for each test source that calls `gateControl`. Returns
 * `{ gates, controls, violations, allowlisted, problems }`.
 */
function scanSources({ gates: gateSources, controls: controlSources }, parser, { allowlist = ALLOWLIST } = {}) {
  const problems = [];
  const violations = [];
  const gates = [];

  for (const source of gateSources) {
    const id = gateIdOf(source.file);
    if (id === null) continue;
    let ast;
    try {
      ast = parse(parser, source.text, source.file);
    } catch (error) {
      problems.push(`${source.file} could not be parsed (${error.message}): an unreadable gate host must not report a clean tree`);
      continue;
    }
    const evaluates = exportedEvaluates(ast);
    for (const e of evaluates.filter((x) => !x.classified)) {
      violations.push({ file: source.file, line: e.node.loc.start.line, rule: RULES.UNCLASSIFIED_EVALUATE, gate: id });
    }
    const classified = evaluates.filter((x) => x.classified);
    if (classified.length === 0) continue;
    const red = deriveRed(ast);
    gates.push({ id, file: source.file, fn: classified[0].name, line: classified[0].node.loc.start.line, red });
  }

  const controls = [];
  for (const source of controlSources) {
    try {
      controls.push(...scanControls(source.text, source.file, parser));
    } catch (error) {
      problems.push(`${source.file} could not be parsed (${error.message}): an unreadable control file must not report a clean tree`);
    }
  }

  if (gates.length === 0) problems.push('discovered zero gate modules (src/gate-*.cts exporting an evaluate* that returns GateResult): an inert scan must not report a clean tree');

  for (const control of controls) {
    for (const reason of control.malformed) {
      violations.push({ file: control.file, line: control.line, rule: RULES.MALFORMED_CONTROL, gate: control.gate ?? null, detail: reason });
    }
  }
  const wellFormed = controls.filter((c) => c.malformed.length === 0);

  for (const gate of gates) {
    const mine = wellFormed.filter((c) => c.gate === gate.id);
    if (gate.red === null) {
      violations.push({ file: gate.file, line: gate.line, rule: RULES.NO_FAILING_VERDICT, gate: gate.id });
    }
    if (mine.length === 0) {
      violations.push({ file: gate.file, line: gate.line, rule: RULES.NO_CONTROL, gate: gate.id });
      continue;
    }
    if (mine.length > 1) violations.push({ file: gate.file, line: gate.line, rule: RULES.DUPLICATE_CONTROL, gate: gate.id });
    for (const control of mine) {
      if (gate.red !== null && control.red !== gate.red) {
        violations.push({ file: control.file, line: control.line, rule: RULES.WRONG_RED, gate: gate.id, detail: `declares ${control.red}, the gate reaches ${gate.red}` });
      }
      const expectedModule = `gate-${gate.id}.cjs`;
      if (path.posix.basename(control.modulePath.replace(/\\/g, '/')) !== expectedModule) {
        violations.push({ file: control.file, line: control.line, rule: RULES.WRONG_MODULE, gate: gate.id, detail: `requires ${control.modulePath}, expected ${expectedModule}` });
      }
      if (control.fn !== gate.fn) {
        violations.push({ file: control.file, line: control.line, rule: RULES.WRONG_FN, gate: gate.id, detail: `drives ${control.fn}, the gate exports ${gate.fn}` });
      }
    }
  }
  const known = new Set(gates.map((g) => g.id));
  for (const control of wellFormed) {
    if (!known.has(control.gate)) violations.push({ file: control.file, line: control.line, rule: RULES.ORPHAN_CONTROL, gate: control.gate });
  }

  // The allowlist: a violation matching an entry on (gate, rule) is tolerated; an entry that matches
  // nothing is stale and is itself a problem.
  const kept = [];
  const allowlisted = [];
  const used = new Set();
  for (const v of violations) {
    const index = allowlist.findIndex((e) => e.gate === v.gate && e.rule === v.rule);
    if (index === -1) {
      kept.push(v);
    } else {
      used.add(index);
      allowlisted.push(v);
    }
  }
  allowlist.forEach((e, index) => {
    if (!used.has(index)) problems.push(`allowlist entry ${e.gate} [${e.rule}] matches no violation: remove the stale entry`);
  });

  return { gates, controls, violations: kept, allowlisted, problems };
}

// ─── repository walk ─────────────────────────────────────────────────────────────────────────────

function listGateFiles(root) {
  const dir = path.join(root, 'src');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => /^gate-.*\.cts$/.test(name)).sort().map((name) => `src/${name}`);
}

/** Every `.cjs` under tests/ (not fixtures or node_modules) whose text mentions `gateControl(`. */
function listControlFiles(root) {
  const out = [];
  const walkDir = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'fixtures' || entry.name === 'node_modules') continue;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walkDir(path.join(dir, entry.name), childRel);
      else if (entry.name.endsWith('.cjs')) out.push(childRel);
    }
  };
  const testsDir = path.join(root, 'tests');
  if (fs.existsSync(testsDir)) walkDir(testsDir, 'tests');
  return out.sort();
}

function scanRepo(root, parser = loadParser(root), options = {}) {
  const gates = listGateFiles(root).map((file) => ({ file, text: fs.readFileSync(path.join(root, file), 'utf8') }));
  const controls = [];
  for (const file of listControlFiles(root)) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    // A cheap prefilter only: the AST decides what is a control.
    if (text.includes(`${CONTROL_CALL}(`)) controls.push({ file, text });
  }
  return scanSources({ gates, controls }, parser, options);
}

/** The census the phase publishes: every class of site this guard forbids, counted over the tree. */
function census(root = REPO_ROOT, parser = loadParser(root), options = {}) {
  const { gates, controls, violations, allowlisted, problems } = scanRepo(root, parser, options);
  const count = (rule) => violations.filter((v) => v.rule === rule).length;
  return {
    gates: gates.length,
    controls: controls.length,
    noControl: count(RULES.NO_CONTROL),
    duplicateControl: count(RULES.DUPLICATE_CONTROL),
    wrongRed: count(RULES.WRONG_RED),
    noFailingVerdict: count(RULES.NO_FAILING_VERDICT),
    wrongModule: count(RULES.WRONG_MODULE),
    wrongFn: count(RULES.WRONG_FN),
    malformedControl: count(RULES.MALFORMED_CONTROL),
    orphanControl: count(RULES.ORPHAN_CONTROL),
    unclassifiedEvaluate: count(RULES.UNCLASSIFIED_EVALUATE),
    allowlisted: allowlisted.length,
    total: violations.length,
    problems,
  };
}

function main() {
  const { gates, violations, problems } = scanRepo(REPO_ROOT);
  if (violations.length === 0 && problems.length === 0) {
    process.stdout.write(`ok gate-positive-control: ${gates.length} gate modules, each with a positive control\n`);
    return 0;
  }
  process.stderr.write('ERROR gate-positive-control: a gate module has no positive control that drives it to its failing verdict (ADR-5057 §4, #5204)\n');
  for (const v of violations) process.stderr.write(`  - ${v.file}:${v.line} [${v.rule}]${v.gate ? ` ${v.gate}` : ''}${v.detail ? `: ${v.detail}` : ''}\n`);
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.stderr.write('Add a gateControl({ gate, module, fn, red, redScenario, greenScenario }) for it (tests/helpers/gate-positive-control.cjs, tests/gate-positive-control.test.cjs).\n');
  return 1;
}

if (require.main === module) runMain(main);

module.exports = { scanSources, scanRepo, census, loadParser, RULES, ALLOWLIST, gateIdOf, deriveRed };
