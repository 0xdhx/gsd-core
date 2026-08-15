'use strict';

/**
 * install-cross-scope-shadowing.test.cjs — failing-first regression suite for
 * issue #2218 ("cross-scope shadowing"), phase issue #2873 (epic #2866,
 * ADR-2866).
 *
 * Implements the coexistence gate (`C1`) and the 4b behavioral pair
 * (`E13`/`E14`) from
 * `.gsd/phase/feat-2873-cross-scope-shadowing/50-test-matrix.md`. Per that
 * matrix's "Red-first order": C1 must go RED against `next` (no
 * `install-shadow-report.cjs` report exists today), E14 must go RED today
 * (the global skill's spec-root include points at the global tree even when
 * a local install exists), and E13 must stay GREEN both before and after —
 * it is the guard that phase 4b does not break today's global-only case.
 *
 * This suite does NOT implement any production code. It is deliberately
 * failing against the current tree.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const {
  INSTALL_SCRIPT,
  MANIFEST_NAME,
  installerEnv,
} = require('./helpers/install-shared.cjs');

/**
 * Extract the `@`-include lines from an emitted markdown body — structural
 * parsing, never substring/regex matching on the whole body (CONTRIBUTING.md
 * "Prohibited: Raw Text Matching on Test Outputs"). Splits on newlines
 * (CRLF-tolerant) and keeps only lines whose first character is `@`.
 *
 * @param {string} content
 * @returns {string[]}
 */
function extractAtIncludeLines(content) {
  return content.split(/\r?\n/).filter((line) => line.startsWith('@'));
}

describe('#2218 cross-scope shadowing', () => {
  let root;
  let projectDir;
  let globalInstallResult;
  let localInstallResult;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2218-shadow-'));
    projectDir = path.join(root, 'myrepo');
    fs.mkdirSync(projectDir, { recursive: true });

    // Global half: cannot use runMinimalInstall here — its scope:'global'
    // path pushes `--config-dir <root>`, which pins the install AT `<root>`
    // itself (manifest at `<root>/gsd-file-manifest.json`), not at
    // `<root>/.claude`. That is not the shape #2218 describes: the reporter's
    // configuration is a HOME-resolved global install (no --config-dir)
    // sitting alongside a project-local one. Spawn the installer directly,
    // with HOME=root and no --config-dir, so it resolves its own config home
    // the way a real global install does. Must run BEFORE the local half —
    // order matters for this fixture (a separate test covers order-independence).
    globalInstallResult = runNode([INSTALL_SCRIPT, '--claude', '--global'], {
      cwd: root,
      env: installerEnv({ HOME: root, USERPROFILE: root }),
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    assert.strictEqual(globalInstallResult.exitCode, 0,
      `global install exited with status ${globalInstallResult.exitCode} ` +
      `(outcome=${globalInstallResult.outcome})\n` +
      `stdout: ${globalInstallResult.stdout}\nstderr: ${globalInstallResult.stderr}`);

    // Local half: runMinimalInstall cannot be reused for this either — for
    // scope:'local' it sets cwd=root, which would install into
    // `<root>/.claude` and collide with the global install above. Spawn the
    // installer directly instead, with cwd pinned at the project dir.
    localInstallResult = runNode([INSTALL_SCRIPT, '--claude', '--local'], {
      cwd: projectDir,
      env: installerEnv({ HOME: root, USERPROFILE: root }),
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    assert.strictEqual(localInstallResult.exitCode, 0,
      `local install exited with status ${localInstallResult.exitCode} ` +
      `(outcome=${localInstallResult.outcome})\n` +
      `stdout: ${localInstallResult.stdout}\nstderr: ${localInstallResult.stderr}`);
  });

  after(() => {
    cleanup(root);
  });

  test('both installs land their own manifest', () => {
    const globalManifestPath = path.join(root, '.claude', MANIFEST_NAME);
    const localManifestPath = path.join(projectDir, '.claude', MANIFEST_NAME);

    assert.ok(fs.existsSync(globalManifestPath), 'global manifest should exist');
    assert.ok(fs.statSync(globalManifestPath).isFile(), 'global manifest should be a file');
    assert.ok(fs.existsSync(localManifestPath), 'local manifest should exist');
    assert.ok(fs.statSync(localManifestPath).isFile(), 'local manifest should be a file');

    const globalManifest = JSON.parse(fs.readFileSync(globalManifestPath, 'utf8'));
    const localManifest = JSON.parse(fs.readFileSync(localManifestPath, 'utf8'));

    assert.strictEqual(globalManifest.scope, 'global');
    assert.strictEqual(localManifest.scope, 'local');
  });

  test('the local install reports the shadowing it causes', () => {
    // #2218/#2873: install-shadow-report.cjs does not exist yet — this
    // require is the intended RED. buildShadowReport is the pure IR builder
    // described in .gsd/phase/feat-2873-cross-scope-shadowing/40-design.md
    // (row 3): claude installed at both G and L reports N triggers shadowed,
    // winner skills@global, loser commands@local.
    const { buildShadowReport } = require('../gsd-core/bin/lib/install-shadow-report.cjs');
    const report = buildShadowReport('claude', { home: root, cwd: projectDir });

    assert.strictEqual(report.shadowed, true);
    assert.strictEqual(report.winner.kind, 'skills');
    assert.strictEqual(report.winner.scope, 'global');
    assert.strictEqual(report.shadowedSide.kind, 'commands');
    assert.strictEqual(report.shadowedSide.scope, 'local');
    assert.ok(report.triggers.length > 0, 'expected at least one shadowed trigger');
  });

  test('global-only install resolves the same spec file it does today', () => {
    const skillPath = path.join(root, '.claude', 'skills', 'gsd-plan-phase', 'SKILL.md');
    const content = fs.readFileSync(skillPath, 'utf8');
    const atLines = extractAtIncludeLines(content);

    assert.ok(
      atLines.includes('@~/.claude/gsd-core/references/ui-brand.md'),
      `expected the ui-brand reference @-line among: ${JSON.stringify(atLines)}`,
    );
  });

  // #2218 / phase #2873: today the global SKILL.md's spec-root include is a
  // static `@~/.claude/gsd-core/workflows/plan-phase.md` reference, which
  // always resolves against the GLOBAL tree even when a coexisting local
  // install has its own project-local copy of that workflow file. Phase 4b
  // replaces that static include with a two-step imperative form that names
  // both candidate paths and lets the runtime prefer the local one when it
  // exists — this test pins today's (broken) behavior as the RED case that
  // 4b must flip.
  test('the winning global skill points at the project-local spec tree', () => {
    const skillPath = path.join(root, '.claude', 'skills', 'gsd-plan-phase', 'SKILL.md');
    const content = fs.readFileSync(skillPath, 'utf8');
    const atLines = extractAtIncludeLines(content);

    assert.ok(
      !atLines.includes('@~/.claude/gsd-core/workflows/plan-phase.md'),
      `expected the static global workflow @-line to be replaced, but found it among: ${JSON.stringify(atLines)}`,
    );

    const localSpecPath = path.join(projectDir, '.claude', 'gsd-core', 'workflows', 'plan-phase.md');
    assert.ok(fs.existsSync(localSpecPath), 'local spec-root workflow file should exist on disk');
  });
});
