'use strict';

/**
 * B1, B2, B3 — the router/gate boundary is enforced by the repo's ESLint config
 * (#5139, epic #5056, ADR-5057 §4 bullet 1, design D6.1).
 *
 * Design D6.1: `no-restricted-imports` overrides in eslint.config.mjs (no custom rule)
 *   - scoped to `src/gate-*.cts` and `src/decision-coverage-support.cts`: `./io.cjs` is forbidden
 *     (a gate module returns a GateVerdict; only the router formats output);
 *   - scoped to `src/check-command-router.cts`: `node:fs`, `node:child_process` and the
 *     `./shell-command-projection.cjs` exec/git helpers are forbidden (the router only parses
 *     argv and formats).
 *
 * FAILING-FIRST (RED): eslint.config.mjs carries no such override on origin/next, so no
 * `no-restricted-imports` setting exists for those paths and the positive controls below fail.
 *
 * Mechanism: the config the repo lints with is read through the ESLint API
 * (`calculateConfigForFile`, the way tests/eslint-no-verification-status-literal.test.cjs does),
 * and ONLY its `no-restricted-imports` rule entries (core or @typescript-eslint variant) are
 * replayed in a Linter over a violating snippet. A type-aware parse of a not-yet-existing
 * `src/gate-x.cts` is impossible (the file is not in the TS project), so the snippet is parsed
 * without project information; the rule options are exactly the repo's for that path.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ESLint, Linter } = require('eslint');

const ROOT = path.join(__dirname, '..');
const RESTRICTED_RE = /(^|\/)no-restricted-imports$/;

const GATE_MODULES = [
  'gate-decision-coverage-plan',
  'gate-decision-coverage-verify',
  'gate-ui-plan',
  'gate-ui-safety',
  'gate-tdd-review-checkpoint',
  'gate-tdd-red-evidence',
  'gate-verify-command-paths',
  'gate-verify-failure-directions',
  'gate-gap-analysis-plan-post',
  'gate-predicate',
  'gate-api-coverage-verify-pre',
  'gate-verdict',
  'gate-phase-context',
  'decision-coverage-support',
];
const ROUTER = 'src/check-command-router.cts';

let eslintInstance;
function eslint() {
  if (!eslintInstance) eslintInstance = new ESLint({ cwd: ROOT });
  return eslintInstance;
}

/** The repo's `no-restricted-imports` rule entries for a path, or null when the path is ignored. */
async function restrictedImportConfig(relPath) {
  const calc = await eslint().calculateConfigForFile(path.join(ROOT, relPath));
  if (!calc) return null;
  const entries = Object.entries(calc.rules || {}).filter(([id, setting]) => {
    if (!RESTRICTED_RE.test(id)) return false;
    const severity = Array.isArray(setting) ? setting[0] : setting;
    return severity === 2 || severity === 'error' || severity === 1 || severity === 'warn';
  });
  return { calc, entries };
}

/** Lint `code` as if it lived at `relPath`, running only the repo's restricted-imports rules for that path. */
async function restrictedImportMessages(relPath, code) {
  const config = await restrictedImportConfig(relPath);
  assert.notEqual(config, null, `${relPath} must not be ignored by the ESLint config`);
  if (config.entries.length === 0) return [];
  const linter = new Linter({ cwd: ROOT, configType: 'flat' });
  const messages = linter.verify(
    code,
    [
      {
        files: ['**/*.cts'],
        languageOptions: {
          parser: config.calc.languageOptions.parser,
          ecmaVersion: 'latest',
          sourceType: 'module',
        },
        plugins: config.calc.plugins,
        rules: Object.fromEntries(config.entries),
      },
    ],
    { filename: relPath },
  );
  const fatal = messages.filter((m) => m.fatal);
  assert.deepStrictEqual(fatal, [], `snippet must parse: ${JSON.stringify(fatal)}`);
  return messages.filter((m) => m.ruleId && RESTRICTED_RE.test(m.ruleId));
}

const IO_REQUIRE = "import ioMod = require('./io.cjs');\nexport = { ioMod };\n";
const IO_ESM = "import { output } from './io.cjs';\nexport = { output };\n";

describe('B1 gate modules may not import ./io.cjs', () => {
  for (const relPath of ['src/gate-x.cts', 'src/decision-coverage-support.cts']) {
    test(`B1: ${relPath} is reported for a require-style ./io.cjs import`, async () => {
      const messages = await restrictedImportMessages(relPath, IO_REQUIRE);
      assert.equal(messages.length, 1, JSON.stringify(messages));
      assert.equal(messages[0].severity, 2);
    });

    test(`B1: ${relPath} is reported for an ES-style ./io.cjs import`, async () => {
      const messages = await restrictedImportMessages(relPath, IO_ESM);
      assert.equal(messages.length, 1, JSON.stringify(messages));
      assert.equal(messages[0].severity, 2);
    });
  }

  test('B1: the same ./io.cjs import in an unrelated src file is not reported', async () => {
    assert.deepStrictEqual(await restrictedImportMessages('src/other.cts', IO_REQUIRE), []);
    assert.deepStrictEqual(await restrictedImportMessages('src/other.cts', IO_ESM), []);
  });

  test('B1: an unrelated import in a gate module is not reported (the restriction is specific)', async () => {
    const code = "import pathMod = require('node:path');\nexport = { pathMod };\n";
    assert.deepStrictEqual(await restrictedImportMessages('src/gate-x.cts', code), []);
  });
});

describe('B2 the router may not import fs, child_process or the exec helpers', () => {
  const cases = [
    ['node:fs (require style)', "import fs = require('node:fs');\nexport = { fs };\n"],
    ['node:fs (ES style)', "import { readFileSync } from 'node:fs';\nexport = { readFileSync };\n"],
    ['node:child_process (require style)', "import cp = require('node:child_process');\nexport = { cp };\n"],
    ['node:child_process (ES style)', "import { execFileSync } from 'node:child_process';\nexport = { execFileSync };\n"],
    ['shell-command-projection execTool', "import { execTool } from './shell-command-projection.cjs';\nexport = { execTool };\n"],
  ];
  for (const [label, code] of cases) {
    test(`B2: ${label} is reported in ${ROUTER}`, async () => {
      const messages = await restrictedImportMessages(ROUTER, code);
      assert.equal(messages.length, 1, JSON.stringify(messages));
      assert.equal(messages[0].severity, 2);
    });
  }

  test('B2: the same imports in an unrelated src file are not reported', async () => {
    for (const [, code] of cases) {
      assert.deepStrictEqual(await restrictedImportMessages('src/other.cts', code), []);
    }
  });

  test('B2: an unrelated import in the router is not reported (the restriction is specific)', async () => {
    const code = "import pathMod = require('node:path');\nexport = { pathMod };\n";
    assert.deepStrictEqual(await restrictedImportMessages(ROUTER, code), []);
  });
});

describe('B3 the real files carry the boundary and honour it', () => {
  const realFiles = [...GATE_MODULES.map((m) => `src/${m}.cts`), ROUTER];

  test('B3: every gate module, the shared support modules and the router exist', () => {
    const missing = realFiles.filter((f) => !fs.existsSync(path.join(ROOT, f)));
    assert.deepStrictEqual(missing, []);
  });

  test('B3: every real file has a restricted-imports setting (the boundary is not vacuous)', async () => {
    const unguarded = [];
    for (const f of realFiles) {
      const config = await restrictedImportConfig(f);
      if (config === null || config.entries.length === 0) unguarded.push(f);
    }
    assert.deepStrictEqual(unguarded, []);
  });

  test('B3: linting the real files reports zero restricted-import violations', async () => {
    const existing = realFiles.filter((f) => fs.existsSync(path.join(ROOT, f)));
    const results = await eslint().lintFiles(existing.map((f) => path.join(ROOT, f)));
    const violations = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId && RESTRICTED_RE.test(m.ruleId))
        .map((m) => `${path.relative(ROOT, r.filePath)}:${m.line} ${m.ruleId} ${m.message}`),
    );
    assert.deepStrictEqual(violations, []);
  });
});
