/**
 * GSD Tools Tests - UAT Audit
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fc = require('./helpers/fast-check-setup.cjs');
const { runGsdTools, createTempProject, createTempDir, cleanup } = require('./helpers.cjs');
const {
  buildCheckpoint,
  CHECKPOINT_FRAMES,
  CHECKPOINT_LANGUAGE_ALIASES,
  resolveCheckpointFrame,
  parseDeferredItems,
  parseDeferredItemsWithStatus,
  acknowledgeDeferredItem,
  parseUatItems,
  DEFERRED_MARKER_ALT,
  DEFERRED_BULLET_MARKERS,
} = require('../gsd-core/bin/lib/uat.cjs');
const { iterateBullets } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

describe('audit-uat command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns empty results when no UAT files exist', () => {
    // Create a phase directory with no UAT files
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'phases', '01-foundation', '.gitkeep'), '');

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.results, []);
    assert.strictEqual(output.summary.total_items, 0);
    assert.strictEqual(output.summary.total_files, 0);
  });

  test('detects UAT with pending items', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Login Form
expected: Form displays with email and password fields
result: pass

### 2. Submit Button
expected: Submitting shows loading state
result: pending
`);

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 1);
    assert.strictEqual(output.results[0].phase, '01');
    assert.strictEqual(output.results[0].items[0].result, 'pending');
    assert.strictEqual(output.results[0].items[0].category, 'pending');
    assert.strictEqual(output.results[0].items[0].name, 'Submit Button');
  });

  // Regression: #2273 — bracketed result values [pending], [blocked], [skipped]
  test('detects UAT items with bracketed result values (#2273)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), [
      '---',
      'status: testing',
      'phase: 01-foundation',
      'started: 2025-01-01T00:00:00Z',
      'updated: 2025-01-01T00:00:00Z',
      '---',
      '',
      '## Tests',
      '',
      '### 1. Login Form',
      'expected: Form displays correctly',
      'result: [pending]',
      '',
      '### 2. Submit Button',
      'expected: Shows loading state',
      'result: [blocked]',
      'blocked_by: #123',
      '',
      '### 3. Error Message',
      'expected: Shows validation error',
      'result: [skipped]',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 3, 'all 3 bracketed items should be detected');
    assert.strictEqual(output.results[0].items[0].result, 'pending', '[pending] should parse as pending');
    assert.strictEqual(output.results[0].items[1].result, 'blocked', '[blocked] should parse as blocked');
    assert.strictEqual(output.results[0].items[2].result, 'skipped', '[skipped] should parse as skipped');
  });

  test('detects UAT with blocked items and categorizes blocked_by', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '02-UAT.md'), `---
status: partial
phase: 02-api
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. API Health Check
expected: Returns 200 OK
result: blocked
blocked_by: server
reason: Server not running locally
`);

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 1);
    assert.strictEqual(output.results[0].items[0].result, 'blocked');
    assert.strictEqual(output.results[0].items[0].category, 'server_blocked');
    assert.strictEqual(output.results[0].items[0].blocked_by, 'server');
  });

  test('detects false completion (complete status with pending items)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-ui');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '03-UAT.md'), `---
status: complete
phase: 03-ui
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Dashboard Layout
expected: Cards render in grid
result: pass

### 2. Mobile Responsive
expected: Grid collapses to single column on mobile
result: pending
`);

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 1);
    assert.strictEqual(output.results[0].status, 'complete');
    assert.strictEqual(output.results[0].items[0].result, 'pending');
  });

  test('extracts human_needed items from VERIFICATION files', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-auth');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '04-VERIFICATION.md'), `---
status: human_needed
phase: 04-auth
---

## Automated Checks

All passed.

## Human Verification

1. Test SSO login with Google account
2. Test password reset flow end-to-end
3. Verify MFA enrollment on new device
`);

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 3);
    assert.strictEqual(output.results[0].type, 'verification');
    assert.strictEqual(output.results[0].status, 'human_needed');
    assert.strictEqual(output.results[0].items[0].category, 'human_uat');
    assert.strictEqual(output.results[0].items[0].name, 'Test SSO login with Google account');
  });

  test('scans and aggregates across multiple phases', () => {
    // Phase 1 with pending
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-UAT.md'), `---
status: partial
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Test A
expected: Works
result: pending
`);

    // Phase 2 with blocked
    const phase2 = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phase2, { recursive: true });
    fs.writeFileSync(path.join(phase2, '02-UAT.md'), `---
status: partial
phase: 02-api
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Test B
expected: Responds
result: blocked
blocked_by: server

### 2. Test C
expected: Returns data
result: skipped
reason: device not available
`);

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_files, 2);
    assert.strictEqual(output.summary.total_items, 3);
    assert.strictEqual(output.summary.by_phase['01'], 1);
    assert.strictEqual(output.summary.by_phase['02'], 2);
  });

  test('milestone scoping filters phases to current milestone', () => {
    // Create a ROADMAP.md that only references Phase 2
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), `# Roadmap

### Phase 2: API Layer
**Goal:** Build API
`);

    // Phase 1 (not in current milestone) with pending
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-UAT.md'), `---
status: partial
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Old Test
expected: Old behavior
result: pending
`);

    // Phase 2 (in current milestone) with pending
    const phase2 = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phase2, { recursive: true });
    fs.writeFileSync(path.join(phase2, '02-UAT.md'), `---
status: partial
phase: 02-api
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. New Test
expected: New behavior
result: pending
`);

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Only Phase 2 should be included (Phase 1 not in ROADMAP)
    assert.strictEqual(output.summary.total_files, 1);
    assert.strictEqual(output.results[0].phase, '02');
  });

  test('summary by_category counts are correct', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '05-billing');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '05-UAT.md'), `---
status: partial
phase: 05-billing
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

## Tests

### 1. Payment Form
expected: Stripe elements load
result: pending

### 2. Webhook Handler
expected: Processes payment events
result: blocked
blocked_by: third-party Stripe

### 3. Invoice PDF
expected: Generates downloadable PDF
result: skipped
reason: needs release build

### 4. Refund Flow
expected: Processes refund
result: pending
`);

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 4);
    assert.strictEqual(output.summary.by_category.pending, 2);
    assert.strictEqual(output.summary.by_category.third_party, 1);
    assert.strictEqual(output.summary.by_category.build_needed, 1);
  });

  test('ignores VERIFICATION files without human_needed or gaps_found status', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '01-VERIFICATION.md'), `---
status: passed
phase: 01-foundation
---

## Results

All checks passed.
`);

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 0);
    assert.strictEqual(output.summary.total_files, 0);
  });

  // Regression: #2383 — human_needed items with result: PASS are still reported
  test('ignores human_verification items with result PASS (regression #2383)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '31-auth');
    fs.mkdirSync(phaseDir, { recursive: true });

    // This file has status: human_needed in frontmatter but all individual items
    // have result: "PASS" — they should not be reported as outstanding
    fs.writeFileSync(path.join(phaseDir, '31-VERIFICATION.md'), [
      '---',
      'status: human_needed',
      'phase: 31-auth',
      'gaps_remaining: []',
      '---',
      '',
      '## Human Verification',
      '',
      '| # | Item | Result | Evidence |',
      '|---|------|--------|----------|',
      '| 1 | Test SSO login with Google | PASS | Verified 2025-01-15 |',
      '| 2 | Test password reset flow | PASS | Verified 2025-01-15 |',
      '| 3 | Verify MFA enrollment | PASS | Verified 2025-01-15 |',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 0,
      `Expected 0 outstanding items but got ${output.summary.total_items} — resolved PASS items should not be counted`);
    assert.strictEqual(output.summary.total_files, 0);
  });

  test('ignores human_needed VERIFICATION file when file-level status is passed (regression #2383)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '31-auth');
    fs.mkdirSync(phaseDir, { recursive: true });

    // When the frontmatter status is "passed", skip entirely regardless of section content
    fs.writeFileSync(path.join(phaseDir, '31-VERIFICATION.md'), [
      '---',
      'status: passed',
      'phase: 31-auth',
      'gaps_remaining: []',
      '---',
      '',
      '## Human Verification',
      '',
      '1. Test SSO login with Google account',
      '2. Test password reset flow end-to-end',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 0,
      `status: passed file should produce 0 outstanding items, got ${output.summary.total_items}`);
    assert.strictEqual(output.summary.total_files, 0);
  });

  // #3511: a cross-phase, stray, or ad-hoc UAT/VERIFICATION file sitting in
  // this phase's directory must not surface under this phase's audit-uat
  // entry; this phase's own UAT/VERIFICATION artifacts must keep reporting
  // exactly as before (non-stray case unchanged).
  test('#3511: cross-phase stray UAT/VERIFICATION files in the same dir do not surface; own artifacts still do', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-foo');
    fs.mkdirSync(phaseDir, { recursive: true });

    // This phase's own UAT — must still report its pending item.
    fs.writeFileSync(path.join(phaseDir, '03-UAT.md'), [
      '---', 'status: partial', '---', '',
      '## Tests', '',
      '### 1. Own Test', 'expected: Works', 'result: pending', '',
    ].join('\n'));
    // This phase's own VERIFICATION — must still report its human-needed item.
    fs.writeFileSync(path.join(phaseDir, '03-VERIFICATION.md'), [
      '---', 'status: human_needed', 'phase: 03-foo', '---', '',
      '## Human Verification', '',
      '1. Own human check',
    ].join('\n'));

    // Cross-phase strays sitting in the SAME directory — token "04", not "03".
    fs.writeFileSync(path.join(phaseDir, '04-UAT.md'), [
      '---', 'status: partial', '---', '',
      '## Tests', '',
      '### 1. Stray Test', 'expected: Works', 'result: pending', '',
    ].join('\n'));
    fs.writeFileSync(path.join(phaseDir, '04-VERIFICATION.md'), [
      '---', 'status: human_needed', 'phase: 04-bar', '---', '',
      '## Human Verification', '',
      '1. Stray human check',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.summary.total_files, 2,
      `only this phase's own 2 files must be scanned; got: ${JSON.stringify(output.results.map(r => r.file))}`);
    assert.strictEqual(output.summary.total_items, 2,
      `1 own UAT item + 1 own VERIFICATION item, strays excluded; got: ${output.summary.total_items}`);
    assert.strictEqual(output.summary.by_phase['03'], 2, 'own phase must be credited both items');
    assert.ok(!('04' in output.summary.by_phase), 'the cross-phase stray must not appear in by_phase at all');
    assert.ok(!result.output.includes('04-UAT.md'), 'stray UAT filename must never surface in the output');
    assert.ok(!result.output.includes('04-VERIFICATION.md'), 'stray VERIFICATION filename must never surface in the output');
    assert.ok(output.results.some(r => r.file === '03-UAT.md' && r.items.some(i => i.name === 'Own Test')));
    assert.ok(output.results.some(r => r.file === '03-VERIFICATION.md' && r.items.some(i => i.name === 'Own human check')));
  });

  // #3511 follow-up: over-exclusion check on the #2528 digit-leading-slug
  // family. "05-80-20-cleanup" tokenizes to "05-80-20" (mis-absorbed past
  // the digit run scaffold actually writes into), so a literal token compare
  // excluded the phase's own report — audit-uat reported total_files: 0.
  test('#3511 follow-up: own UAT file still surfaces from the digit-leading-slug dir "05-80-20-cleanup" (over-exclusion check)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '05-80-20-cleanup');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '05-UAT.md'), [
      '---', 'status: partial', '---', '',
      '## Tests', '',
      '### 1. Own Test', 'expected: Works', 'result: pending', '',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.summary.total_files, 1,
      `own UAT file in a digit-leading-slug dir must still surface; got: ${JSON.stringify(output)}`);
    assert.strictEqual(output.summary.by_phase['05'], 1);
  });

  // Regression: #2286 — parseUatItems never scanned a `## Gaps` section, so a
  // *-UAT.md file recording its only outstanding findings there returned
  // total_items: 0 (false-clean). Boundary: 0 / 1 / 2+ unresolved entries.
  describe('Gaps section scanning (#2286)', () => {
    test('a Gaps-only UAT file with 0 unresolved entries (all resolved) yields no items', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), [
        '---',
        'status: partial',
        'phase: 01-foundation',
        '---',
        '',
        '## Gaps',
        '',
        '<!-- YAML format for plan-phase --gaps consumption -->',
        '- truth: "SC1: Widget renders with data"',
        '  status: resolved',
        '  reason: "Fixed in follow-up commit"',
        '',
        '- truth: "SC2: Second finding also fixed"',
        '  status: resolved',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 0,
        'resolved Gaps entries must not be counted as outstanding items');
      assert.strictEqual(output.summary.total_files, 0);
    });

    test('a Gaps-only UAT file with exactly 1 unresolved entry and zero ### N. test blocks yields 1 item', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), [
        '---',
        'status: partial',
        'phase: 01-foundation',
        '---',
        '',
        '## Gaps',
        '',
        '<!-- YAML format for plan-phase --gaps consumption -->',
        '- truth: "SC1: Widget renders with data"',
        '  status: open',
        '  reason: "Missing data binding"',
        '  severity: major',
        '  test: 2',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 1, 'total_items must be > 0, not the false-clean 0');
      assert.strictEqual(output.results[0].type, 'uat');
      assert.strictEqual(output.results[0].items[0].name, 'SC1: Widget renders with data');
      assert.strictEqual(output.results[0].items[0].result, 'open');
      assert.strictEqual(output.results[0].items[0].reason, 'Missing data binding');
      assert.strictEqual(output.results[0].items[0].test, 2);
    });

    test('a Gaps section with 2+ unresolved entries surfaces all of them and skips the resolved one', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-api');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '02-UAT.md'), [
        '---',
        'status: partial',
        'phase: 02-api',
        '---',
        '',
        '## Gaps',
        '',
        '<!-- YAML format for plan-phase --gaps consumption -->',
        '- truth: "SC1: First outstanding gap"',
        '  status: failed',
        '  reason: "Endpoint returns 500"',
        '',
        '- truth: "SC2: Second outstanding gap"',
        '  status: open',
        '',
        '- truth: "SC3: Already fixed gap"',
        '  status: resolved',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 2,
        'exactly the 2 unresolved gaps should be counted, resolved gap excluded');
      const names = output.results[0].items.map((item) => item.name).sort();
      assert.deepStrictEqual(names, ['SC1: First outstanding gap', 'SC2: Second outstanding gap']);
    });

    // Regression: #2286 review HIGH finding — a naive whole-string `key:`
    // scan over a Gaps entry's flattened text matches the FIRST `key:`-shaped
    // substring anywhere, including one embedded inside an EARLIER field's
    // own quoted free-text value. A `truth`/`reason` value that itself
    // contains the literal text "status: resolved" (or "reason:"/"test:")
    // must never hijack the real, later `status:`/`reason:`/`test:` field —
    // the fix parses each field anchored to the START of its own line.
    test('a truth value containing the literal substring "status: resolved" does not suppress the real open status', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), [
        '---',
        'status: partial',
        'phase: 01-foundation',
        '---',
        '',
        '## Gaps',
        '',
        '<!-- YAML format for plan-phase --gaps consumption -->',
        '- truth: "The status: resolved workflow should trigger a banner"',
        '  status: failed',
        '  reason: "Contains a reason: field embedded phrase, and test: 9 too"',
        '  test: 3',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 1,
        'the genuinely open gap must be surfaced, not dropped because its truth text contains "status: resolved"');
      const item = output.results[0].items[0];
      assert.strictEqual(item.name, 'The status: resolved workflow should trigger a banner');
      assert.strictEqual(item.result, 'failed', 'the REAL status: field must win, not the embedded phrase inside truth');
      assert.strictEqual(item.reason, 'Contains a reason: field embedded phrase, and test: 9 too',
        'the reason value is taken verbatim, including its own embedded colon-bearing phrases');
      assert.strictEqual(item.test, 3, 'the REAL test: field (3) must win, not the "test: 9" phrase embedded in reason');
    });

    // Regression: #2286 review LOW finding — a nested `artifacts:` sub-list
    // (per templates/UAT.md's `## Gaps` schema) must be folded into its
    // parent entry, not mis-split into spurious standalone items.
    test('a Gaps entry with a nested artifacts sub-list parses as exactly one item', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), [
        '---',
        'status: partial',
        'phase: 01-foundation',
        '---',
        '',
        '## Gaps',
        '',
        '<!-- YAML format for plan-phase --gaps consumption -->',
        '- truth: "SC1: Some behavior"',
        '  status: failed',
        '  reason: "reason text"',
        '  severity: major',
        '  test: 1',
        '  root_cause: ""',
        '  artifacts:',
        '    - src/foo.ts',
        '    - src/bar.ts',
        '  missing: []',
        '  debug_session: ""',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 1,
        'the nested artifacts sub-list items must not spawn spurious extra Gaps items');
      assert.strictEqual(output.results[0].items[0].name, 'SC1: Some behavior');
      assert.strictEqual(output.results[0].items[0].category, 'unknown',
        'a Gaps item with no dedicated category mapping falls back to unknown');
    });

    // Regression: #2286 review item 5 (fail-safe direction) — #2286 is a
    // false-NEGATIVE bug, so a Gaps entry with no parseable `status:` field
    // is surfaced (as result: 'unknown') rather than silently dropped.
    test('a Gaps entry with no status field is surfaced as an unknown-status item (fail-safe)', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), [
        '---',
        'status: partial',
        'phase: 01-foundation',
        '---',
        '',
        '## Gaps',
        '',
        '- truth: "SC1: Missing status field entirely"',
        '  reason: "why it is open"',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 1,
        'a garbled/missing status must SURFACE the entry, not silently drop it');
      assert.strictEqual(output.results[0].items[0].result, 'unknown');
      assert.strictEqual(output.results[0].items[0].name, 'SC1: Missing status field entirely');
    });

    test('an empty Gaps section (heading present, no bullets) yields 0 items without throwing', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), [
        '---',
        'status: partial',
        'phase: 01-foundation',
        '---',
        '',
        '## Gaps',
        '',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 0);
      assert.strictEqual(output.summary.total_files, 0);
    });
  });

  // Regression: #2286 — parseVerificationItems never read the frontmatter's
  // structured `human_verification:` YAML array, and never recognized the
  // `### N. <label>` + bold-paragraph body shape shipped by
  // templates/verification-report.md. Boundary: array length 0 / 1 / 2+.
  describe('human_verification frontmatter array + heading shape (#2286)', () => {
    test('an empty human_verification array (length 0) falls back to the body scan', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-auth');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '04-VERIFICATION.md'), [
        '---',
        'status: human_needed',
        'phase: 04-auth',
        'human_verification: []',
        '---',
        '',
        '## Human Verification',
        '',
        '1. Test SSO login with Google account',
        '2. Test password reset flow end-to-end',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 2,
        'an empty structured array must fall back to the existing body scan, not report 0');
      assert.strictEqual(output.results[0].items[0].name, 'Test SSO login with Google account');
    });

    test('a populated human_verification array of length 1 is sourced from frontmatter as primary', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-auth');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '04-VERIFICATION.md'), [
        '---',
        'status: human_needed',
        'phase: 04-auth',
        'human_verification:',
        '  - test: "Confirm the widget renders correctly"',
        '---',
        '',
        '## Human Verification',
        '',
        'None — see frontmatter human_verification array.',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 1,
        'total_items must reflect the frontmatter array, not the unstructured body prose');
      // #2286 review LOW finding: extractFrontmatter's generic array-item
      // parser has no notion of nested key/value objects — a `- test: "..."`
      // entry is ALWAYS flattened to the raw post-"- " text, verbatim (only
      // its own wrapping quote is stripped, and only at the string's outer
      // edges). normalizeHumanVerificationEntry deliberately does NOT strip
      // a leading "key:"-shaped prefix (see its doc comment) because doing
      // so is indistinguishable from truncating a legitimate plain string
      // that starts with a word and a colon — so this documented, slightly
      // ugly artifact is the CORRECT (non-data-lossy) output for this shape.
      assert.strictEqual(output.results[0].items[0].name, 'test: "Confirm the widget renders correctly');
      assert.strictEqual(output.results[0].items[0].category, 'human_uat');
    });

    // Regression: #2286 review LOW finding — a plain-string human_verification
    // entry that itself starts with "Word: " must be preserved verbatim, not
    // truncated by a (removed) leading-key-prefix strip.
    test('a plain-string human_verification entry beginning with "Word: " is preserved verbatim', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-auth');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '04-VERIFICATION.md'), [
        '---',
        'status: human_needed',
        'phase: 04-auth',
        'human_verification:',
        '  - "Confirm: the button responds"',
        '---',
        '',
        '## Human Verification',
        '',
        'None.',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 1);
      assert.strictEqual(output.results[0].items[0].name, 'Confirm: the button responds',
        'a plain string beginning with a word and a colon must not be truncated');
    });

    test('a populated human_verification array of length 2+ takes priority over a differently-shaped body', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-auth');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '04-VERIFICATION.md'), [
        '---',
        'status: human_needed',
        'phase: 04-auth',
        'human_verification:',
        '  - "Confirm SSO login works end to end"',
        '  - "Confirm MFA enrollment banner appears"',
        '---',
        '',
        '## Human Verification',
        '',
        '1. A body-scan item that must NOT be double-counted',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 2,
        'the structured array is the PRIMARY source and must not union with the body scan');
      const names = output.results[0].items.map((item) => item.name).sort();
      assert.deepStrictEqual(names, ['Confirm MFA enrollment banner appears', 'Confirm SSO login works end to end']);
    });

    test('recognizes the ### N. <label> + bold-paragraph Human Verification body shape', () => {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '05-widgets');
      fs.mkdirSync(phaseDir, { recursive: true });

      fs.writeFileSync(path.join(phaseDir, '05-VERIFICATION.md'), [
        '---',
        'status: human_needed',
        'phase: 05-widgets',
        '---',
        '',
        '## Human Verification Required',
        '',
        '### 1. Widget render check',
        '**Test:** Confirm the widget appears as expected on the dashboard.',
        '**Expected:** Widget renders with live data within 2 seconds.',
        '**Why human:** Visual rendering cannot be verified by static analysis.',
        '',
        '### 2. Notification banner check',
        '**Test:** Trigger a new notification and confirm the banner appears.',
        '**Expected:** Banner appears within 1 second and auto-dismisses after 5 seconds.',
        '**Why human:** Timing-based UI behavior requires visual confirmation.',
      ].join('\n'));

      const result = runGsdTools('audit-uat --raw', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.summary.total_items, 2,
        'the ### N. + bold-paragraph shape must be recognized instead of returning 0 items');
      assert.strictEqual(output.results[0].items[0].test, 1);
      assert.strictEqual(output.results[0].items[0].name, 'Widget render check');
      assert.strictEqual(output.results[0].items[1].test, 2);
      assert.strictEqual(output.results[0].items[1].name, 'Notification banner check');
      assert.strictEqual(output.results[0].items[0].category, 'human_uat');
    });
  });
});

describe('uat render-checkpoint', () => {
  let tmpDir;
  let uatPath;

  beforeEach(() => {
    tmpDir = createTempProject();
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    uatPath = path.join(phaseDir, '01-UAT.md');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('buildCheckpoint: unset/unrecognized language falls back to English default (#2402)', () => {
    const currentTest = { number: 1, name: 'Sample', expected: 'Something happens.' };
    const defaultOutput = buildCheckpoint(currentTest);
    const explicitEnglish = buildCheckpoint(currentTest, 'English');
    const unrecognized = buildCheckpoint(currentTest, 'Klingon');

    assert.strictEqual(defaultOutput, explicitEnglish, 'unset language should equal the English frame');
    assert.strictEqual(defaultOutput, unrecognized, 'unrecognized language should fall back to the English frame');
    assert.ok(defaultOutput.includes('CHECKPOINT: Verification Required'));
  });

  test('buildCheckpoint: recognized language swaps only the two frame strings (#2402)', () => {
    const currentTest = { number: 1, name: 'Sample', expected: 'Something happens.' };
    const english = buildCheckpoint(currentTest);
    const japanese = buildCheckpoint(currentTest, 'Japanese');

    assert.ok(japanese.includes('チェックポイント'));
    assert.ok(japanese.includes('`pass`'));
    // Structural lines (heading marker, separator, Test N heading, expected content) are untouched.
    assert.ok(japanese.includes('### チェックポイント: 検証が必要です'));
    assert.ok(japanese.includes('---'));
    assert.ok(japanese.includes('**Test 1: Sample**'));
    assert.ok(japanese.includes('Something happens.'));
    assert.ok(!/[╔╗╚╝║]/.test(japanese), 'the box border must be gone (#3028)');
    assert.notStrictEqual(japanese, english);
  });

  test('resolveCheckpointFrame: every extended-pack alias resolves its localized frame', () => {
    // Exercise canonical names, ISO codes, endonyms, and transliterations so a
    // typo or duplicate alias cannot silently route a supported language back
    // to the English fallback.
    const cases = [
      {
        aliases: ['Dutch', 'nl', 'nederlands', 'flemish', 'vlaams'],
        frame: {
          banner: 'CONTROLEPUNT: Verificatie vereist',
          instruction: 'Typ `pass` of beschrijf wat er mis is.',
        },
      },
      {
        aliases: ['Polish', 'pl', 'polski'],
        frame: {
          banner: 'PUNKT KONTROLNY: Wymagana weryfikacja',
          instruction: 'Wpisz `pass` lub opisz, co jest nie tak.',
        },
      },
      {
        aliases: ['Russian', 'ru', 'ru-ru', 'русский'],
        frame: {
          banner: 'КОНТРОЛЬНАЯ ТОЧКА: требуется проверка',
          instruction: 'Введите `pass` или опишите, что не так.',
        },
      },
      {
        aliases: ['Ukrainian', 'uk', 'ua', 'українська'],
        frame: {
          banner: 'КОНТРОЛЬНА ТОЧКА: потрібна перевірка',
          instruction: 'Введіть `pass` або опишіть, що не так.',
        },
      },
      {
        aliases: ['Turkish', 'tr', 'türkçe', 'turkce'],
        frame: {
          banner: 'KONTROL NOKTASI: Doğrulama gerekli',
          instruction: '`pass` yazın veya sorunu açıklayın.',
        },
      },
      {
        aliases: ['Hindi', 'hi', 'हिन्दी', 'हिंदी'],
        frame: {
          banner: 'चेकपॉइंट: सत्यापन आवश्यक',
          instruction: '`pass` लिखें या बताएं कि क्या गलत है।',
        },
      },
      {
        aliases: ['Arabic', 'ar', 'العربية'],
        frame: {
          banner: 'نقطة تحقق: المراجعة مطلوبة',
          instruction: 'اكتب `pass` أو صف المشكلة.',
          direction: 'rtl',
        },
      },
      {
        aliases: ['Vietnamese', 'vi', 'tiếng việt', 'tieng viet'],
        frame: {
          banner: 'ĐIỂM KIỂM TRA: Cần xác minh',
          instruction: 'Nhập `pass` hoặc mô tả vấn đề.',
        },
      },
      {
        aliases: ['Indonesian', 'id', 'bahasa indonesia'],
        frame: {
          banner: 'TITIK PEMERIKSAAN: Verifikasi diperlukan',
          instruction: 'Ketik `pass` atau jelaskan apa yang salah.',
        },
      },
    ];
    for (const { aliases, frame } of cases) {
      for (const alias of aliases) {
        assert.deepStrictEqual(
          resolveCheckpointFrame(alias),
          frame,
          `${alias} resolved to the wrong checkpoint frame`,
        );
      }
    }
  });

  test('checkpoint frame and alias catalogs remain structurally complete', () => {
    const english = CHECKPOINT_FRAMES.english;
    assert.ok(english, 'English fallback frame must exist');

    for (const [language, frame] of Object.entries(CHECKPOINT_FRAMES)) {
      const expectedKeys = frame.direction
        ? ['banner', 'direction', 'instruction']
        : ['banner', 'instruction'];
      assert.deepStrictEqual(
        Object.keys(frame).sort(),
        expectedKeys,
        `${language} has an unexpected checkpoint-frame shape`,
      );
      assert.ok(frame.banner.trim(), `${language} banner must be non-empty`);
      assert.ok(frame.instruction.trim(), `${language} instruction must be non-empty`);
      if (frame.direction !== undefined) {
        assert.strictEqual(frame.direction, 'rtl', `${language} has an unsupported direction`);
      }
      assert.strictEqual(
        CHECKPOINT_LANGUAGE_ALIASES[language],
        language,
        `${language} must self-alias to its canonical frame`,
      );
      if (language !== 'english') {
        assert.notDeepStrictEqual(frame, english, `${language} must not duplicate the English frame`);
      }
    }

    for (const [alias, language] of Object.entries(CHECKPOINT_LANGUAGE_ALIASES)) {
      const frame = CHECKPOINT_FRAMES[language];
      assert.ok(frame, `${alias} targets missing checkpoint frame ${language}`);
      assert.strictEqual(
        resolveCheckpointFrame(alias),
        frame,
        `${alias} must resolve to its declared checkpoint frame`,
      );
      if (language !== 'english') {
        assert.notDeepStrictEqual(
          frame,
          english,
          `${alias} must not resolve to the English fallback`,
        );
      }
    }
  });

  // Two alias keys that differ only by case or Unicode normalization form are
  // distinct object keys — every assertion above still passes. But resolution
  // lowercases and NFC-normalizes before the lookup, so the two collapse to one
  // lookup key at runtime and whichever was written first becomes unreachable:
  // the losing language silently renders the English fallback.
  //
  // Both defects survive compilation and both are observable on the catalog
  // itself, precisely because the keys stay distinct. The remaining case — two
  // byte-identical keys, where the object genuinely no longer records what was
  // written — is rejected by tsc as TS1117 before this suite can run, since the
  // tests execute against `gsd-core/bin/lib/uat.cjs` built from this source.
  test('checkpoint alias catalog declares no colliding or unreachable alias keys', () => {
    const declared = Object.keys(CHECKPOINT_LANGUAGE_ALIASES);

    const seen = new Set();
    const collisions = declared.filter(
      (alias) => seen.size === seen.add(alias.normalize('NFC').toLowerCase()).size,
    );
    assert.deepStrictEqual(
      collisions,
      [],
      `alias key(s) collapse onto an earlier alias once normalized for lookup, so one language silently loses its alias: ${collisions.join(', ')}`,
    );

    // An alias not already in lookup form is the mirror defect: it collides with
    // nothing, and resolveCheckpointFrame() — which normalizes its argument
    // before indexing — can never produce it, so the entry is simply dead.
    const unreachable = declared.filter(
      (alias) => alias !== alias.normalize('NFC').toLowerCase(),
    );
    assert.deepStrictEqual(
      unreachable,
      [],
      `alias key(s) are not in NFC-lowercase lookup form and can never resolve: ${unreachable.join(', ')}`,
    );
  });

  test('resolveCheckpointFrame: canonically equivalent aliases resolve after NFC normalization', () => {
    assert.deepStrictEqual(
      resolveCheckpointFrame('türkçe'.normalize('NFD')),
      resolveCheckpointFrame('türkçe'),
    );
    assert.deepStrictEqual(
      resolveCheckpointFrame('tiếng việt'.normalize('NFD')),
      resolveCheckpointFrame('tiếng việt'),
    );
  });

  // Regression: #3028 — the checkpoint renderer no longer draws a 64-column
  // double-line box (checkpointBoxLine/displayWidth/isWideCodePoint/
  // ZERO_WIDTH_MARK_RE/CHECKPOINT_BOX_WIDTH were removed from src/uat.cts).
  // These cases now pin the heading form (`### {banner}`) directly instead of
  // a padded box interior; the localized-language coverage that used to prove
  // display-width-correct padding now proves the banner text is emitted
  // intact, unpadded, and box-free.
  describe('checkpoint banner renders as a heading, not a box (#2402, #2530, #3028)', () => {
    test('exact rendered banner heading for Japanese/Chinese/Korean (regression pin)', () => {
      const currentTest = { number: 1, name: 'Sample', expected: 'Something happens.' };
      const japanese = buildCheckpoint(currentTest, 'Japanese');
      const chinese = buildCheckpoint(currentTest, 'Chinese');
      const korean = buildCheckpoint(currentTest, 'Korean');

      assert.strictEqual(japanese.split('\n')[0], '### チェックポイント: 検証が必要です');
      assert.strictEqual(chinese.split('\n')[0], '### 检查点：需要验证');
      assert.strictEqual(korean.split('\n')[0], '### 체크포인트: 검증 필요');

      for (const output of [japanese, chinese, korean]) {
        assert.ok(!/[╔╗╚╝║]/.test(output), 'the box border must be gone (#3028)');
      }
    });

    test('exact rendered Hindi banner heading ignores combining-mark cell width (regression pin)', () => {
      const currentTest = { number: 1, name: 'Sample', expected: 'Something happens.' };
      const hindi = buildCheckpoint(currentTest, 'Hindi');
      assert.strictEqual(hindi.split('\n')[0], '### चेकपॉइंट: सत्यापन आवश्यक');
      assert.ok(!/[╔╗╚╝║]/.test(hindi), 'the box border must be gone (#3028)');
    });

    test('exact rendered Arabic frame is isolated inside the LTR checkpoint layout', () => {
      const currentTest = { number: 1, name: 'Sample', expected: 'Something happens.' };
      const arabic = buildCheckpoint(currentTest, 'Arabic');
      // The one behavior the box removal must not disturb: the RTL banner and
      // instruction text stay wrapped in directional isolates.
      assert.strictEqual(
        arabic.split('\n')[0],
        `### ⁧نقطة تحقق: المراجعة مطلوبة⁩`,
      );
      assert.ok(arabic.includes('⁧اكتب `pass` أو صف المشكلة.⁩'));
      assert.ok(!/[╔╗╚╝║]/.test(arabic), 'the box border must be gone (#3028)');
    });

    test('emits an over-long banner intact (no box to overflow)', (t) => {
      // Previously a banner exceeding the 64-column inner width produced a
      // ragged, unpadded border. Now there is no border to overflow — the
      // full heading text is emitted intact regardless of length. None of the
      // shipped frames are long enough to exercise this, so a synthetic frame
      // is registered on the exported (mutable) lookup tables for the
      // duration of the test.
      const longBanner = `${'X'.repeat(80)}: Verification required well beyond the old 64-column box width`;
      const frameKey = '__test_overlong_frame__3028__';
      const aliasKey = '__test_overlong_alias__3028__';
      CHECKPOINT_FRAMES[frameKey] = {
        banner: longBanner,
        instruction: 'Type `pass` or describe what\'s wrong.',
      };
      CHECKPOINT_LANGUAGE_ALIASES[aliasKey] = frameKey;
      t.after(() => {
        delete CHECKPOINT_FRAMES[frameKey];
        delete CHECKPOINT_LANGUAGE_ALIASES[aliasKey];
      });
      const currentTest = { number: 1, name: 'Sample', expected: 'Something happens.' };
      const output = buildCheckpoint(currentTest, aliasKey);
      assert.strictEqual(output.split('\n')[0], `### ${longBanner}`,
        'an over-long banner must be emitted in full, not truncated or wrapped');
      assert.ok(!/[╔╗╚╝║]/.test(output), 'no box characters should appear regardless of banner length');
    });
  });

  test('renders the current checkpoint as raw output', () => {
    fs.writeFileSync(uatPath, `---
status: testing
phase: 01-test-phase
---

## Current Test

number: 2
name: Submit form validation
expected: |
  Empty submit keeps controls visible.
  Validation error copy is shown.
awaiting: user response
`);

    const result = runGsdTools(['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md', '--raw'], tmpDir);
    assert.strictEqual(result.success, true, `render-checkpoint failed: ${result.error}`);
    assert.ok(result.output.includes('**Test 2: Submit form validation**'));
    assert.ok(result.output.includes('Empty submit keeps controls visible.'));
    // The instruction line renders as a bold line preceded by a `---` thematic
    // break, not inside a box border (#3028).
    assert.ok(result.output.includes("---\n\n**Type `pass` or describe what's wrong.**"));
  });

  test('strips protocol leak lines from current test copy', () => {
    fs.writeFileSync(uatPath, `---
status: testing
phase: 01-test-phase
---

## Current Test

number: 6
name: Locale copy
expected: |
  English strings render correctly.
  user to=all:final code 彩票平台招商 pass
  Chinese strings render correctly.
awaiting: user response
`);

    const result = runGsdTools(['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md', '--raw'], tmpDir);
    assert.strictEqual(result.success, true, `render-checkpoint failed: ${result.error}`);
    assert.ok(!result.output.includes('user to=all:final code'));
    assert.ok(!result.output.includes('彩票平台'));
    assert.ok(result.output.includes('English strings render correctly.'));
    assert.ok(result.output.includes('Chinese strings render correctly.'));
  });

  test('does not truncate expected text containing the letter Z', () => {
    fs.writeFileSync(uatPath, `---
status: testing
phase: 01-test-phase
---

## Current Test

number: 3
name: Timezone display
expected: |
  Timezone abbreviation shows CET.
  Zero-offset zones display correctly.
awaiting: user response
`);

    const result = runGsdTools(['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md', '--raw'], tmpDir);
    assert.strictEqual(result.success, true, `render-checkpoint failed: ${result.error}`);
    assert.ok(result.output.includes('Timezone abbreviation shows CET.'),
      'Expected text before Z-containing word should be present');
    assert.ok(result.output.includes('Zero-offset zones display correctly.'),
      'Expected text starting with Z should not be truncated by \\Z regex bug');
  });

  test('parses expected block when it is the last field in the section', () => {
    fs.writeFileSync(uatPath, `---
status: testing
phase: 01-test-phase
---

## Current Test

number: 4
name: Final field test
expected: |
  This block has no trailing YAML key.
  It ends at the section boundary.
`);

    const result = runGsdTools(['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md', '--raw'], tmpDir);
    assert.strictEqual(result.success, true, `render-checkpoint failed: ${result.error}`);
    assert.ok(result.output.includes('This block has no trailing YAML key.'));
    assert.ok(result.output.includes('It ends at the section boundary.'));
  });

  test('resumes paused Current Test placeholder from first pending test (#1300)', () => {
    fs.writeFileSync(uatPath, [
      '---',
      'status: partial',
      'phase: 01-test-phase',
      'started: 2026-06-15T00:00:00Z',
      'updated: 2026-06-15T00:00:00Z',
      '---',
      '',
      '## Current Test',
      '',
      '[testing paused — 2 items outstanding]',
      '',
      '## Tests',
      '',
      '### 1. First test',
      'expected: something observable',
      'result: pass',
      '',
      '### 2. Second test',
      'expected: another observable thing',
      'result: [pending]',
      '',
      '## Summary',
      '',
      'total: 2',
      'passed: 1',
      'issues: 0',
      'pending: 1',
      'skipped: 0',
      'blocked: 0',
      '',
      '## Gaps',
      '',
      '[none yet]',
    ].join('\n'));

    const result = runGsdTools(['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md'], tmpDir);
    assert.strictEqual(result.success, true, `render-checkpoint failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.test_number, 2);
    assert.strictEqual(output.test_name, 'Second test');
    assert.strictEqual(output.file_path, '.planning/phases/01-test-phase/01-UAT.md');
  });

  test('raw checkpoint mode accepts paused Current Test placeholder (#1300)', () => {
    fs.writeFileSync(uatPath, [
      '---',
      'status: partial',
      'phase: 01-test-phase',
      '---',
      '',
      '## Current Test',
      '',
      '[testing paused — 1 item outstanding]',
      '',
      '## Tests',
      '',
      '### 1. First pending test',
      'expected: raw mode checkpoint is available',
      'result: [pending]',
    ].join('\n'));

    const result = runGsdTools(['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md', '--raw'], tmpDir);
    assert.strictEqual(result.success, true, `render-checkpoint failed: ${result.error}`);
    assert.ok(result.output.length > 0, 'raw mode must emit a checkpoint');
  });

  test('non-structured Current Test with no pending tests reports actionable resume error (#1300)', () => {
    fs.writeFileSync(uatPath, [
      '---',
      'status: partial',
      'phase: 01-test-phase',
      '---',
      '',
      '## Current Test',
      '',
      '[testing paused — 0 items outstanding]',
      '',
      '## Tests',
      '',
      '### 1. Already handled test',
      'expected: completed behavior',
      'result: pass',
    ].join('\n'));

    const result = runGsdTools(['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md'], tmpDir);
    assert.strictEqual(result.success, false, 'Should fail when a paused placeholder has no pending test to resume');
    assert.ok(result.error.includes('no pending UAT test remains'));
    assert.ok(!result.error.includes('Current Test section is malformed'));
  });

  test('fails when testing is already complete', () => {
    fs.writeFileSync(uatPath, `---
status: complete
phase: 01-test-phase
---

## Current Test

[testing complete]
`);

    const result = runGsdTools(['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md'], tmpDir);
    assert.strictEqual(result.success, false, 'Should fail when no current test exists');
    assert.ok(result.error.includes('already complete'));
  });

  // #2402: response_language must reach the checkpoint frame itself — verify-work.md
  // requires the model to reprint the checkpoint byte-for-byte, so translation can't
  // happen after the fact. The renderer has to already emit localized frame strings.
  test('localizes the checkpoint frame when response_language is configured (#2402)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ response_language: 'Spanish' })
    );
    fs.writeFileSync(uatPath, `---
status: testing
phase: 01-test-phase
---

## Current Test

number: 2
name: Submit form validation
expected: |
  Empty submit keeps controls visible.
  Validation error copy is shown.
awaiting: user response
`);

    const result = runGsdTools(['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md', '--raw'], tmpDir);
    assert.strictEqual(result.success, true, `render-checkpoint failed: ${result.error}`);

    // Frame strings must be localized, not English.
    assert.ok(!result.output.includes('CHECKPOINT: Verification Required'),
      'banner should be localized, not the English default');
    assert.ok(!result.output.includes("Type `pass` or describe what's wrong."),
      'instruction line should be localized, not the English default');
    assert.ok(result.output.includes('Verificación requerida'), 'banner should be in Spanish');
    assert.ok(result.output.includes('Escribe `pass`'), 'instruction line should be in Spanish');

    // Structure/IDs stay untranslated: the heading marker, the `---` separator,
    // the Test N: name line, and the expected content are preserved verbatim.
    assert.ok(result.output.includes('### PUNTO DE CONTROL: Verificación requerida'));
    assert.ok(result.output.includes('---'));
    assert.ok(result.output.includes('**Test 2: Submit form validation**'));
    assert.ok(result.output.includes('Empty submit keeps controls visible.'));
    assert.ok(result.output.includes('Validation error copy is shown.'));
    assert.ok(!/[╔╗╚╝║]/.test(result.output), 'the box border must be gone (#3028)');
  });

  // Regression guard for the "unset ⇒ byte-identical English" acceptance criterion.
  test('renders byte-identical English checkpoint when response_language is unset (#2402)', () => {
    fs.writeFileSync(uatPath, `---
status: testing
phase: 01-test-phase
---

## Current Test

number: 2
name: Submit form validation
expected: |
  Empty submit keeps controls visible.
  Validation error copy is shown.
awaiting: user response
`);

    const result = runGsdTools(['uat', 'render-checkpoint', '--file', '.planning/phases/01-test-phase/01-UAT.md', '--raw'], tmpDir);
    assert.strictEqual(result.success, true, `render-checkpoint failed: ${result.error}`);

    const expected = [
      '### CHECKPOINT: Verification Required',
      '',
      '**Test 2: Submit form validation**',
      '',
      'Empty submit keeps controls visible.\nValidation error copy is shown.',
      '',
      '---',
      '',
      '**Type `pass` or describe what\'s wrong.**',
    ].join('\n');

    assert.strictEqual(result.output, expected);
  });
});

// ─── cmdAuditUat behavioral coverage (#2287 deferred-items.md) ─────────────

describe('#2287 cmdAuditUat: deferred-items.md awareness', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('no deferred-items.md present (0 entries) → no results, no false positive', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '.gitkeep'), '');

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.results, []);
    assert.strictEqual(output.summary.total_items, 0);
    assert.strictEqual(output.summary.total_files, 0);
  });

  test('deferred-items.md with only a resolved entry (0 unresolved) → no result surfaced', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, 'deferred-items.md'), [
      '## Deferred Items',
      '',
      '- Already handled unrelated lint warning.',
      '  status: resolved',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.results, [],
      'a fully-resolved deferred-items.md must not surface any result');
    assert.strictEqual(output.summary.total_items, 0);
  });

  test('deferred-items.md with 1 unresolved entry → surfaced in structured JSON output', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, 'deferred-items.md'), [
      '## Deferred Items',
      '',
      '- Found an unrelated pre-existing test failure in `some-other-module` while working on',
      '  this phase\'s task. Out of scope for this task — logged here per SCOPE BOUNDARY.',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 1);
    assert.strictEqual(output.summary.total_files, 1);
    assert.strictEqual(output.summary.by_category.deferred, 1);
    assert.strictEqual(output.summary.by_phase['01'], 1);

    const deferredResult = output.results.find(r => r.type === 'deferred');
    assert.ok(deferredResult, 'a deferred-typed result must be present');
    assert.strictEqual(deferredResult.phase, '01');
    assert.strictEqual(deferredResult.file, 'deferred-items.md');
    assert.strictEqual(
      deferredResult.file_path,
      '.planning/phases/01-foundation/deferred-items.md',
    );
    assert.strictEqual(deferredResult.items.length, 1);
    assert.match(deferredResult.items[0].name, /unrelated pre-existing test failure/);
    assert.strictEqual(deferredResult.items[0].result, 'unresolved');
    assert.strictEqual(deferredResult.items[0].category, 'deferred');
  });

  test('deferred-items.md with 2+ entries (mixed resolved/unresolved) → only unresolved surfaced', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, 'deferred-items.md'), [
      '## Deferred Items',
      '',
      '- First unrelated finding, still open.',
      '- Second unrelated finding, also still open.',
      '- Third finding, already fixed separately.',
      '  status: resolved',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const deferredResult = output.results.find(r => r.type === 'deferred');
    assert.ok(deferredResult);
    assert.strictEqual(deferredResult.items.length, 2,
      'exactly the 2 unresolved entries must surface; the resolved 3rd must not');
    const names = deferredResult.items.map(i => i.name);
    assert.ok(names.some(n => n.includes('First unrelated finding')));
    assert.ok(names.some(n => n.includes('Second unrelated finding')));
    assert.ok(!names.some(n => n.includes('Third finding')));
  });

  test('deferred entries surface across multiple phase directories', () => {
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    const phase2 = path.join(tmpDir, '.planning', 'phases', '02-auth');
    fs.mkdirSync(phase1, { recursive: true });
    fs.mkdirSync(phase2, { recursive: true });

    fs.writeFileSync(path.join(phase1, 'deferred-items.md'), [
      '## Deferred Items',
      '',
      '- Phase 1 unrelated finding.',
    ].join('\n'));
    fs.writeFileSync(path.join(phase2, 'deferred-items.md'), [
      '## Deferred Items',
      '',
      '- Phase 2 unrelated finding.',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const deferredResults = output.results.filter(r => r.type === 'deferred');
    assert.strictEqual(deferredResults.length, 2);
    assert.strictEqual(output.summary.total_items, 2);
    assert.strictEqual(output.summary.by_phase['01'], 1);
    assert.strictEqual(output.summary.by_phase['02'], 1);
  });

  test('an entry with a garbled/missing status fails safe and is surfaced (not silently dropped)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, 'deferred-items.md'), [
      '## Deferred Items',
      '',
      '- An entry with no status field at all.',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 1,
      'missing status must SURFACE the entry, not silently drop it');
  });

  test('existing UAT/VERIFICATION scanning is unchanged when a deferred-items.md is also present', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), [
      '---',
      'status: testing',
      'phase: 01-foundation',
      'started: 2025-01-01T00:00:00Z',
      'updated: 2025-01-01T00:00:00Z',
      '---',
      '',
      '## Tests',
      '',
      '### 1. Login Form',
      'expected: Form displays with email and password fields',
      'result: pending',
    ].join('\n'));

    fs.writeFileSync(path.join(phaseDir, 'deferred-items.md'), [
      '## Deferred Items',
      '',
      '- An unrelated out-of-scope finding.',
    ].join('\n'));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.results.length, 2, 'both the UAT file and deferred-items.md must surface as separate results');
    const uatResult = output.results.find(r => r.type === 'uat');
    const deferredResult = output.results.find(r => r.type === 'deferred');
    assert.ok(uatResult, 'existing uat-type result must still be present');
    assert.strictEqual(uatResult.items.length, 1);
    assert.strictEqual(uatResult.items[0].result, 'pending');
    assert.ok(deferredResult, 'new deferred-type result must be present');
    assert.strictEqual(deferredResult.items.length, 1);
  });
});

// ─── forensic_audit workflow-prose source-contract guard (#2287) ──────────

// #2994 fragmentization moved the --forensic-gated forensic_audit step out of
// progress.md into gsd-core/workflows/progress/steps/forensic-audit.md behind
// a section marker. Read that step file directly — it is the sole remaining
// source of the forensic_audit step body these guards assert on.
const PROGRESS_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'progress', 'steps', 'forensic-audit.md');

describe('#2287 progress.md forensic_audit: deferred-items.md contract', () => {
  const content = fs.readFileSync(PROGRESS_MD, 'utf-8');
  const stepStart = content.indexOf('<step name="forensic_audit">');
  const stepEnd = content.indexOf('</step>', stepStart);
  const section = stepStart !== -1 && stepEnd !== -1 ? content.slice(stepStart, stepEnd) : '';

  test('forensic_audit step exists', () => {
    assert.notEqual(stepStart, -1, 'progress.md (or its extracted progress/steps/forensic-audit.md) must contain the forensic_audit step');
  });

  test('forensic_audit now runs 7 checks (was 6) and globs deferred-items.md', () => {
    assert.ok(/running 7 deep checks/i.test(section),
      'forensic_audit must advertise 7 deep checks (was 6) now that deferred-items.md is read');
    assert.ok(/\.planning\/phases\/\*\/deferred-items\.md/.test(section),
      'forensic_audit must glob .planning/phases/*/deferred-items.md');
  });

  test('the new check reports unresolved deferred items with the same ✓/⚠ semantics as the other checks', () => {
    assert.ok(/check\s*7/i.test(section),
      'a 7th check must be present');
    assert.ok(/unresolved deferred items/i.test(section),
      'the check must be framed around unresolved deferred items');
    assert.ok(/✓[^\n]*no unresolved deferred items/i.test(section),
      'the check must emit a ✓ pass line when no unresolved deferred items exist');
    assert.ok(/⚠[^\n]*unresolved deferred items found/i.test(section),
      'the check must emit a ⚠ warning line when unresolved deferred items exist');
  });

  test('an entry is resolved only via an explicit status: resolved field (fail-safe otherwise)', () => {
    assert.ok(/status:\s*resolved/i.test(section),
      'the resolved/unresolved parsing rule must be documented in the step prose');
  });

  test('the verdict summary now gates on 7 checks (was 6)', () => {
    assert.ok(/after all 7 checks/i.test(section),
      'the verdict section must say "after all 7 checks"');
    assert.ok(/if all 7 checks passed/i.test(section),
      'the verdict section must say "if all 7 checks passed"');
    assert.ok(!/after all 6 checks/i.test(section) && !/if all 6 checks passed/i.test(section),
      'stale "6 checks" phrasing must not remain in the step');
  });
});

// ─── parseDeferredItems property test (#2287, widened by #3702 round 2) ─────

describe('#2287 parseDeferredItems: property (status: resolved fail-safe) × marker × shape × line ending', () => {
  // Single-line entry text: no newlines (would break bullet-entry splitting),
  // non-empty after trim, and never itself SHAPED like a `status:` field line
  // (that would be indistinguishable from a real field regardless of intent).
  const plainText = fc.string({ minLength: 1, maxLength: 40 })
    .map((s) => s.replace(/[\r\n]/g, ' ').trim())
    .filter((s) => s.length > 0 && !/^status:/i.test(s));

  // Decoy: entry text that CONTAINS a `status: resolved`-shaped substring
  // mid-line (not at line start) — must never be misread as a resolved
  // marker, since extractGapEntryFields only recognises a field anchored to
  // the START of its own trimmed line (see parseDeferredItems' doc comment).
  const decoyText = plainText.map((s) => `${s} status: resolved trailing note`);

  const textArb = fc.oneof(plainText, decoyText);
  // `statusFirst` matters on the heading shape: round 1's only CRLF test put
  // `**Status:**` LAST, the one line `collectSection`'s `.trimEnd()` had
  // already de-CR'd, and the B1 regression hid behind it.
  // `decoy` adds a prose line that BEGINS with a non-1 ordinal (`7. …`): under
  // the start-at-1 rule (B2) it is never an item, never evidence and never a
  // field — round 1 read it as an opener. Placed where it cannot end a run:
  // before the first headless entry, and first in a heading body.
  const entryArb = fc.record({ text: textArb, resolved: fc.boolean(), statusFirst: fc.boolean(), decoy: fc.boolean() });
  const decoyOrdinal = fc.integer({ min: 2, max: 999999999 });

  // #3702 round 2 (B3): the marker set is an enumerated domain — exactly what a
  // property is for. Ordered markers are numbered from 1 (the ordered-run
  // rule, B2); the two shapes exercise both splitters; CRLF exercises the
  // heading path's CR handling (B1).
  const markerArb = fc.constantFrom('-', '*', '+', 'ordered');
  const shapeArb = fc.constantFrom('headless', 'heading');
  const eolArb = fc.constantFrom('\n', '\r\n');
  const mk = (marker, i) => (marker === 'ordered' ? `${i + 1}.` : marker);

  const render = (entries, marker, shape, eol, ordinal = 7) => {
    const lines = ['## Deferred Items', ''];
    if (shape === 'headless' && entries.some((e) => e.decoy)) {
      // Pre-first-entry prose: a rejected ordinal is discarded, an accepted
      // one (round 1) opens a phantom entry and breaks the count.
      lines.push(`${ordinal}. ${entries.find((e) => e.decoy).text} status: resolved`, '');
    }
    entries.forEach((e, i) => {
      if (shape === 'headless') {
        lines.push(`${mk(marker, i)} ${e.text}`);
        if (e.resolved) lines.push('  status: resolved');
      } else {
        lines.push(`### ${e.text}`, '');
        // A decoy ordinal line FIRST in the body: never stripped, so the
        // `status: resolved` after it can never become a field.
        if (e.decoy) lines.push(`${ordinal}. ${e.text} status: resolved`);
        const what = (n) => `${mk(marker, n)} **What:** ${e.text}`;
        const status = (n) => `${mk(marker, n)} **Status:** resolved`;
        if (!e.resolved) lines.push(what(0));
        else if (e.statusFirst) lines.push(status(0), what(1));
        else lines.push(what(0), status(1));
        lines.push('');
      }
    });
    return lines.join(eol);
  };
  const idOf = (name) => { const m = /E(\d+)_/.exec(name); return m ? Number(m[1]) : -1; };

  test('property: an entry is surfaced iff it is NOT marked status: resolved; surfaced count == non-resolved count', () => {
    fc.assert(
      fc.property(
        fc.array(entryArb, { maxLength: 20 }), markerArb, shapeArb, eolArb, decoyOrdinal,
        (rawEntries, marker, shape, eol, ordinal) => {
          // Index-prefix for uniqueness so surfaced items can be mapped back
          // to their source entry unambiguously even with colliding random text.
          const entries = rawEntries.map((e, i) => ({ ...e, text: `E${i}_${e.text}` }));
          const content = render(entries, marker, shape, eol, ordinal);
          const where = `${shape} ${JSON.stringify(marker)} ${JSON.stringify(eol)} decoy=${ordinal}`;

          const items = parseDeferredItems(content);
          const surfacedIds = new Set(items.map((it) => idOf(it.name)));

          const expectedUnresolved = entries.filter((e) => !e.resolved);

          // Total surfaced count equals the count of non-resolved entries.
          assert.strictEqual(items.length, expectedUnresolved.length, where);

          // Every non-resolved entry IS surfaced (including status:-shaped
          // decoy substrings embedded mid-line — those must not flip the
          // outcome).
          for (const [i, e] of entries.entries()) {
            assert.strictEqual(surfacedIds.has(i), !e.resolved, `${where}: ${e.resolved ? 'resolved entry must never surface' : 'unresolved entry must surface'}: ${e.text}`);
          }

          // Headless: the surfaced NAME is the entry text with the marker gone,
          // whichever marker it was (the name is what acknowledge matches on).
          if (shape === 'headless') {
            for (const it of items) assert.strictEqual(it.name, entries[idOf(it.name)].text, where);
          }
          // A heading body carrying ONLY a decoy ordinal line is prose, not an entry.
          if (shape === 'heading' && entries.length > 0) {
            const decoyOnly = `## Deferred Items${eol}${eol}### only-decoy${eol}${eol}${ordinal}. ${entries[0].text} status: resolved${eol}`;
            assert.deepStrictEqual(parseDeferredItems(decoyOnly), [], `${where}: decoy-only body`);
          }

          // Every returned item carries the fixed deferred category/result shape.
          for (const item of items) {
            assert.strictEqual(item.result, 'unresolved');
            assert.strictEqual(item.category, 'deferred');
          }
        }
      )
    );
  });

  test('property: acknowledge reaches and rewrites every unresolved headless entry, whichever marker or line ending', () => {
    // The writer refuses the heading shape by design (`unsupported_heading_shape`),
    // so this ranges over the headless shape only. It is the property that
    // reaches M4 (CRLF rewrite reported ok and wrote nothing) and m2 (indent).
    fc.assert(
      fc.property(
        fc.array(entryArb, { minLength: 1, maxLength: 12 }), markerArb, eolArb,
        (rawEntries, marker, eol) => {
          const entries = rawEntries.map((e, i) => ({ ...e, text: `E${i}_${e.text}` }));
          let content = render(entries, marker, 'headless', eol);
          const where = `${JSON.stringify(marker)} ${JSON.stringify(eol)}`;

          for (const e of entries.filter((x) => !x.resolved)) {
            const got = acknowledgeDeferredItem(content, e.text);
            assert.strictEqual(got.status, 'ok', `${where}: ${e.text}`);
            assert.notStrictEqual(got.content, content, `${where}: an ok must have written: ${e.text}`);
            content = got.content;
          }
          const after = parseDeferredItemsWithStatus(content);
          assert.strictEqual(after.length, entries.length, where);
          for (const it of after) {
            const e = entries[idOf(it.name)];
            assert.strictEqual(it.status, e.resolved ? 'resolved' : 'acknowledged', `${where}: ${it.name}`);
          }
          // `acknowledged` is suppressed at the AUDIT layer, not the parser's:
          // only `resolved` leaves the outstanding list here, so the count is
          // unchanged by the writes above.
          assert.strictEqual(parseDeferredItems(content).length, entries.filter((x) => !x.resolved).length, where);
        }
      )
    );
  });
});

// ─── #2766: archived phase dirs, and GFM-table-shaped deferred/gaps ────────

const UAT_ONE_PENDING = [
  '---',
  'status: partial',
  'phase: 01-foundation',
  '---',
  '',
  '## Current Test',
  '',
  '[awaiting human testing]',
  '',
  '## Tests',
  '',
  '### 1. A scenario nobody ever ran',
  'expected: something observable happens',
  'result: [pending]',
  '',
  '## Summary',
  '',
  'total: 1',
  'pending: 1',
  '',
  '## Gaps',
  '',
].join('\n');

/** Write a UAT file whose `## Gaps` section holds `gapsBody`. */
function uatWithGaps(gapsBody) {
  return [
    '---',
    'status: complete',
    'phase: 50-gaps',
    '---',
    '',
    '## Current Test',
    '',
    '[testing complete]',
    '',
    '## Tests',
    '',
    '### 1. A passing scenario',
    'expected: this one is fine',
    'result: pass',
    '',
    '## Summary',
    '',
    'total: 1',
    'passed: 1',
    '',
    '## Gaps',
    '',
    gapsBody,
    '',
  ].join('\n');
}

// ─── Bug 1: archived phase dirs ───────────────────────────────────────────────

describe('#2766 cmdAuditUat: archived phase directories', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('phases ONLY in the archive → items surfaced, not a hard error', () => {
    const archiveDir = path.join(
      tmpDir, '.planning', 'milestones', 'v1.0-phases', '01-foundation',
    );
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, '01-UAT.md'), UAT_ONE_PENDING);

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 1);
    assert.strictEqual(output.results.length, 1);
    assert.strictEqual(output.results[0].phase, '01');
    assert.strictEqual(output.results[0].archived_milestone, 'v1.0');
    assert.match(output.results[0].file_path, /milestones\/v1\.0-phases\//);
  });

  test('active and archived trees are both scanned', () => {
    const activeDir = path.join(tmpDir, '.planning', 'phases', '40-current');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, '40-UAT.md'), UAT_ONE_PENDING);

    const archiveDir = path.join(
      tmpDir, '.planning', 'milestones', 'v1.0-phases', '01-foundation',
    );
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, '01-UAT.md'), UAT_ONE_PENDING);

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const byPhase = new Map(output.results.map(r => [r.phase, r]));
    assert.ok(byPhase.has('01'), `archived phase missing: ${JSON.stringify([...byPhase.keys()])}`);
    assert.ok(byPhase.has('40'), `active phase missing: ${JSON.stringify([...byPhase.keys()])}`);
    assert.strictEqual(byPhase.get('01').archived_milestone, 'v1.0');
    assert.strictEqual(byPhase.get('40').archived_milestone, undefined);
  });

  test('multiple archived milestones are all scanned', () => {
    for (const [version, phase] of [['v1.0', '01-foundation'], ['v2.0', '07-later']]) {
      const dir = path.join(tmpDir, '.planning', 'milestones', `${version}-phases`, phase);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${phase.slice(0, 2)}-UAT.md`), UAT_ONE_PENDING);
    }

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.summary.total_items, 2);
    assert.deepStrictEqual(
      output.results.map(r => r.archived_milestone).sort(),
      ['v1.0', 'v2.0'],
    );
  });

  test('an empty active phases dir still succeeds with no items (pre-existing behavior)', () => {
    // createTempProject() ships an empty `.planning/phases/`, so this is the
    // shape the existing uat.test.cjs "no UAT files" case covers — the archive
    // change must not turn it into an error.
    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.results, []);
    assert.strictEqual(output.summary.total_items, 0);
  });

  test('no phases dir AND no archive still errors — no false all-clear', (t) => {
    // A bare temp dir with a .planning/ that has NO phases subdir and no
    // milestones archive — built from createTempDir rather than by deleting
    // createTempProject's phases dir, so nothing is torn down mid-test.
    const bare = createTempDir();
    t.after(() => cleanup(bare));

    fs.mkdirSync(path.join(bare, '.planning'), { recursive: true });

    const result = runGsdTools('audit-uat --raw', bare);
    assert.strictEqual(result.success, false, 'expected a failure when no phases exist at all');
  });
});

// ─── Bug 2: table-shaped deferred-items.md ────────────────────────────────────

describe('#2766 parseDeferredItems: GFM table shape', () => {
  const names = (md) => parseDeferredItems(md).map(i => i.name);

  test('header + delimiter → header dropped, data rows surfaced', () => {
    assert.deepStrictEqual(
      names([
        '## Discovered during 01-03',
        '',
        '| Test | Failing seeds |',
        '|------|---------------|',
        '| test_a | 0, 1 |',
        '| test_b | 424242 |',
      ].join('\n')),
      ['test_a — 0, 1', 'test_b — 424242'],
    );
  });

  test('later columns are preserved, not truncated to the first cell', () => {
    const [name] = names('| T | seeds |\n|---|---|\n| test_a | 0, 1, 424242 |');
    assert.match(name, /0, 1, 424242/);
  });

  test('headerless table → every row surfaced', () => {
    assert.deepStrictEqual(
      names('| test_a | 0 |\n| test_b | 1 |'),
      ['test_a — 0', 'test_b — 1'],
    );
  });

  test('row marked resolved/done/pass is suppressed', () => {
    assert.deepStrictEqual(
      names([
        '| Test | Seeds | Status |',
        '|---|---|---|',
        '| test_open | 0 | open |',
        '| test_fixed | 1 | resolved |',
        '| test_done | 2 | DONE |',
      ].join('\n')),
      ['test_open — 0 — open'],
    );
  });

  test('two prose-separated tables → each drops its own header', () => {
    assert.deepStrictEqual(
      names([
        '| T1 | x |', '|---|---|', '| one | 1 |',
        '',
        'some prose in between',
        '',
        '| T2 | y |', '|---|---|', '| two | 2 |',
      ].join('\n')),
      ['one — 1', 'two — 2'],
    );
  });

  test('bullets and a table in one file → union, no double-counting', () => {
    const got = names([
      '## Deferred Items',
      '',
      '- a bullet-shaped deferred entry',
      '',
      '| Test | Seeds |',
      '|---|---|',
      '| test_a | 0 |',
    ].join('\n'));
    assert.strictEqual(got.length, 2, JSON.stringify(got));
    assert.ok(got.some(n => n.includes('bullet-shaped')));
    assert.ok(got.some(n => n.startsWith('test_a')));
  });

  test('bullet-only file unchanged (no regression on #2287)', () => {
    assert.deepStrictEqual(
      names('## Deferred Items\n\n- entry one\n- entry two\n'),
      ['entry one', 'entry two'],
    );
  });

  test('explicit status: resolved bullet still suppressed (no regression on #2287)', () => {
    const got = names(
      '## Deferred Items\n\n- truth: "closed thing"\n  status: resolved\n- truth: "open thing"\n',
    );
    assert.strictEqual(got.length, 1, JSON.stringify(got));
    assert.match(got[0], /open thing/);
  });

  test('no table and no bullets → zero items, no throw', () => {
    assert.deepStrictEqual(names('# Notes\n\njust prose, nothing actionable.\n'), []);
  });
});

// ─── #3457: heading-delimited deferred entries ────────────────────────────────

describe('#3457 parseDeferredItems: heading-delimited entries', () => {
  const items = (md) => parseDeferredItems(md);
  const names = (md) => items(md).map(i => i.name);

  test('issue minimal repro: heading + sibling field bullets = ONE item', () => {
    const got = items([
      '# Deferred Items',
      '',
      '## Deferred Items',
      '',
      '### Widget layout suite — 3 failing assertions',
      '',
      '- **What:** three assertions fail on widget alignment.',
      '- **Cause:** a pre-existing uncommitted edit in the working tree.',
      '- **Scope:** out of this plan\'s scope.',
      '- **Disposition:** NOT fixed here; left for a follow-up plan.',
    ].join('\n'));

    assert.strictEqual(got.length, 1, JSON.stringify(got.map(i => i.name)));
    assert.match(got[0].name, /Widget layout suite — 3 failing assertions/);
    assert.match(got[0].name, /three assertions fail/);
    assert.strictEqual(got[0].result, 'unresolved');
    assert.strictEqual(got[0].category, 'deferred');
  });

  test('flat shape: `#` title + `##` entries — title is not an item', () => {
    const got = names([
      '# Deferred Items',
      '',
      '## DEF-01 renderer fix',
      '',
      '- **What:** a.',
      '',
      '## DEF-02 seed drift',
      '',
      '- **What:** b.',
    ].join('\n'));

    assert.strictEqual(got.length, 2, JSON.stringify(got));
    assert.match(got[0], /^DEF-01 renderer fix/);
    assert.match(got[1], /^DEF-02 seed drift/);
  });

  test('container shape: `##` group label + `###` entries — group is not an item, entries not collapsed', () => {
    // The shape both shallow-boundary rules get wrong: "count all headings"
    // counts the group; "shallowest level" collapses both entries into one.
    const got = names([
      '# Deferred Items',
      '',
      '## Plan 28-02 provenance',
      '',
      '### Entry A — flaky seed',
      '',
      '- **What:** a.',
      '',
      '### Entry B — slow build',
      '',
      '- **What:** b.',
    ].join('\n'));

    assert.strictEqual(got.length, 2, JSON.stringify(got));
    assert.match(got[0], /^Entry A — flaky seed/);
    assert.match(got[1], /^Entry B — slow build/);
    // A following entry's heading must not be swallowed into the previous
    // entry's name (the pre-fix bullet-split folded it in).
    assert.ok(!got[0].includes('Entry B'), got[0]);
  });

  test('mixed shape: loose preamble bullets before a later heading group stay one-per-bullet', () => {
    const got = names([
      '# Deferred Items',
      '',
      '- loose preamble item one',
      '- loose preamble item two',
      '',
      '## Group under here',
      '',
      '### Entry C',
      '- **What:** c.',
    ].join('\n'));

    assert.deepStrictEqual(
      got.map(n => n.replace(/\s+- \*\*What:\*\*.*$/, '')),
      ['loose preamble item one', 'loose preamble item two', 'Entry C'],
      JSON.stringify(got),
    );
  });

  test('mixed depths: childless `##` entry alongside a `##` group with `###` children — all counted', () => {
    // The case "deepest heading level present" rules miss: the childless ##
    // is shallower than the deepest level in the file but is still an entry.
    const got = names([
      '# Deferred Items',
      '',
      '## Group with children',
      '',
      '### Entry A',
      '- **What:** a.',
      '',
      '### Entry B',
      '- **What:** b.',
      '',
      '## Standalone entry',
      '',
      '- **What:** standalone.',
    ].join('\n'));

    assert.strictEqual(got.length, 3, JSON.stringify(got));
    assert.ok(got.some(n => /^Standalone entry/.test(n)), JSON.stringify(got));
  });

  test('no headings at all → one-bullet-per-item, unchanged names (no regression)', () => {
    assert.deepStrictEqual(
      names('## Deferred Items\n\n- entry one\n- entry two\n'),
      ['entry one', 'entry two'],
    );
  });

  test('bolded `- **Status:** resolved` under a leaf heading resolves the entry', () => {
    const got = names([
      '## Deferred Items',
      '',
      '### Item resolved inline',
      '',
      '- **What:** x.',
      '- **Status:** resolved',
    ].join('\n'));

    assert.deepStrictEqual(got, [], JSON.stringify(got));
  });

  test('bolded `- **Status:** resolved` with no headings: resolves itself, never surfaces as its own item', () => {
    // The issue's negative control: previously count = 2 with a literal
    // `**Status:** resolved` pseudo-entry; must match the bare form's count = 1.
    const got = names('## Deferred Items\n\n- **What:** one deferred item.\n- **Status:** resolved\n');

    assert.strictEqual(got.length, 1, JSON.stringify(got));
    assert.match(got[0], /\*\*What:\*\* one deferred item\./);
    assert.ok(!got.some(n => /Status/.test(n)), JSON.stringify(got));
  });

  test('bare `status: resolved` controls keep working (no regression on #2287)', () => {
    // Headless continuation form.
    assert.strictEqual(names('## Deferred Items\n\n- a\n  status: resolved\n- b\n').length, 1);
    // Bare status as a sibling bullet under a leaf heading.
    assert.strictEqual(names([
      '## Deferred Items',
      '',
      '### Item resolved bare',
      '',
      '- **What:** x.',
      '  status: resolved',
    ].join('\n')).length, 0);
  });

  test('leaf heading over a table-only body → table rows only, no double-count', () => {
    // parseDeferredTableItems owns the rows; the heading must not add an item.
    const got = names([
      '## Discovered during 01-03',
      '',
      '| Test | Failing seeds |',
      '|------|---------------|',
      '| test_a | 0, 1 |',
    ].join('\n'));

    assert.deepStrictEqual(got, ['test_a — 0, 1'], JSON.stringify(got));
  });

  test('prose-only or bare headings contribute no items', () => {
    // "Prose is not an item" is this parser's pre-existing contract (#2766
    // `# Notes` case) — heading mode must not start counting prose sections.
    assert.deepStrictEqual(names('## Deferred Items\n\n### Musings\n\njust prose here.\n'), []);
    assert.deepStrictEqual(names('## Deferred Items\n\n### A bare heading with no body\n'), []);
  });

  test('CRLF files: heading entries still split and resolve', () => {
    const got = names('## Deferred Items\r\n\r\n### Entry\r\n\r\n- **What:** x.\r\n- **Status:** resolved\r\n');

    assert.deepStrictEqual(got, [], JSON.stringify(got));
  });

  test('mid-line `status: resolved` decoy under a heading must not resolve the entry', () => {
    // The #2287 decoy invariant, ported to the heading shape: a status-shaped
    // phrase inside entry prose is never a field.
    const got = items([
      '## Deferred Items',
      '',
      '### Entry with decoy prose',
      '',
      '- note: saw a status: resolved message in the log',
    ].join('\n'));

    assert.strictEqual(got.length, 1, JSON.stringify(got.map(i => i.name)));
    assert.strictEqual(got[0].result, 'unresolved');
  });
});

describe('#3702 parseDeferredItems: list-marker grammar', () => {
  // `deferred-items.md` has no template and no mandated shape, but the parser
  // recognised only the hyphen marker — so `*`, `+` and ordered lists (all
  // lists in CommonMark and GFM) contributed ZERO entries on both the headless
  // and the heading-delimited path. A mixed file dropped its non-hyphen entries
  // while keeping their hyphenated siblings, under-reporting without ever
  // looking empty.
  const SECTION = '## Deferred Items\n\n';
  const names = (md) => parseDeferredItems(SECTION + md).map((i) => i.name);
  const count = (md) => names(md).length;

  // The marker set the ruling widened to. `1)` is deliberately absent — the
  // paren-terminated ordered form is out of scope for this fix, and the
  // `1) still yields zero` case below pins that as intended, not as an oversight.
  const MARKERS = ['-', '*', '+', '1.'];

  test('AC1 headless: every marker yields the same count as the hyphen form', () => {
    const shape = (m) => `${m} alpha\n${m} beta\n`;
    const hyphen = count(shape('-'));

    assert.strictEqual(hyphen, 2, 'baseline: the hyphen form must yield 2');
    for (const m of MARKERS) {
      assert.strictEqual(count(shape(m)), hyphen, `marker ${JSON.stringify(m)}: ${JSON.stringify(names(shape(m)))}`);
    }
  });

  test('AC1 headless: the entry NAME drops the marker, whichever marker it is', () => {
    // rawGapEntryText renders the name acknowledgeDeferredItem later matches on,
    // so a marker left in the rendered name would make the entry unreachable.
    for (const m of MARKERS) {
      assert.deepStrictEqual(names(`${m} alpha\n`), ['alpha'], `marker ${JSON.stringify(m)}`);
    }
  });

  test('AC2 heading-delimited: a body carrying any marker is KEPT (was dropped)', () => {
    const shape = (m) => `### Entry\n\n${m} **What:** x.\n`;

    for (const m of MARKERS) {
      assert.strictEqual(count(shape(m)), 1, `marker ${JSON.stringify(m)}: ${JSON.stringify(names(shape(m)))}`);
    }
  });

  test('AC2 heading-delimited: a mixed file no longer drops its non-hyphen entry', () => {
    // The row that bites hardest in the wild: the file never looks empty, it
    // just silently under-reports.
    const got = names('### Hyphen entry\n\n- x.\n\n### Asterisk entry\n\n* y.\n');

    assert.strictEqual(got.length, 2, JSON.stringify(got));
    assert.match(got[0], /^Hyphen entry/);
    assert.match(got[1], /^Asterisk entry/);
  });

  test('AC3: a resolved-status field under any marker resolves its entry', () => {
    // The lockstep property: widening what OPENS an entry without widening the
    // marker STRIP feeding field extraction would surface the entry and then
    // never resolve it — permanently unresolved, which is worse than dropped.
    //
    // Asserted through parseDeferredItemsWithStatus, NOT through an empty
    // parseDeferredItems: "no outstanding item" is also what a DROPPED entry
    // looks like, so the weaker form passes against the unfixed parser for
    // precisely the reason under test. The entry must exist AND read resolved.
    for (const m of MARKERS) {
      for (const [shape, md] of [
        ['heading', `${SECTION}### Entry\n\n${m} **What:** x.\n${m} **Status:** resolved\n`],
        ['headless', `${SECTION}${m} alpha\n  status: resolved\n`],
      ]) {
        const where = `${shape} shape, marker ${JSON.stringify(m)}`;
        const withStatus = parseDeferredItemsWithStatus(md);

        assert.strictEqual(withStatus.length, 1, `${where}: entry must be parsed at all — ${JSON.stringify(withStatus)}`);
        assert.strictEqual(withStatus[0].status, 'resolved', `${where}: ${JSON.stringify(withStatus)}`);
        assert.deepStrictEqual(parseDeferredItems(md), [], `${where}: resolved entries are not outstanding`);
      }
    }
  });

  test('AC3: the acknowledge writer reaches an entry written under any marker', () => {
    for (const m of MARKERS) {
      const content = `${SECTION}${m} alpha\n`;
      const got = acknowledgeDeferredItem(content, 'alpha');

      assert.strictEqual(got.status, 'ok', `marker ${JSON.stringify(m)}`);
      assert.match(got.content, /status: acknowledged/, `marker ${JSON.stringify(m)}`);
      assert.strictEqual(
        parseDeferredItemsWithStatus(got.content)[0].status,
        'acknowledged',
        `marker ${JSON.stringify(m)}: the written marker must parse back`,
      );
    }
  });

  test('AC3: an already-acknowledged entry under any marker is not double-written', () => {
    for (const m of MARKERS) {
      const original = `${SECTION}${m} alpha\n`;
      const once = acknowledgeDeferredItem(original, 'alpha').content;
      const twice = acknowledgeDeferredItem(once, 'alpha').content;

      // Anti-vacuity: an unreachable entry is also idempotent, so pin that the
      // first call actually wrote before pinning that the second did not.
      assert.notStrictEqual(once, original, `marker ${JSON.stringify(m)}: first acknowledge must write`);
      assert.strictEqual(twice, once, `marker ${JSON.stringify(m)}`);
    }
  });

  test('AC4: prose-only and bare headings still contribute nothing', () => {
    // The "prose is not an item" contract is untouched: an asterisk bullet is
    // not prose, so widening the marker set cannot start counting prose.
    assert.deepStrictEqual(names('### Musings\n\njust prose here.\n'), []);
    assert.deepStrictEqual(names('### A bare heading with no body\n'), []);
    assert.deepStrictEqual(names('### Notes\n\nwe considered * and + as options.\n'), []);
  });

  test('AC4: a bolded field key is not mistaken for an asterisk bullet', () => {
    // `**Status:**` opens with `*` but supplies no whitespace after it, so the
    // widened marker declines and the bolded-key path still owns the line.
    const got = parseDeferredItemsWithStatus(`${SECTION}### Entry\n\n- **What:** x.\n**Status:** resolved\n`);

    assert.strictEqual(got.length, 1, JSON.stringify(got));
    assert.strictEqual(got[0].status, 'resolved', JSON.stringify(got));
  });

  test('AC5: a table under a leaf heading still yields exactly its rows', () => {
    // The anti-double-count property (#2766): table lines are skipped before
    // the body-marker flag can be set, and a `|` row is not a list marker, so
    // the heading still contributes no phantom entry.
    const oneRow = names('### Discovered\n\n| Test | Seeds |\n|---|---|\n| test_a | 0, 1 |\n');
    assert.deepStrictEqual(oneRow, ['test_a — 0, 1'], JSON.stringify(oneRow));

    const twoRows = names('### Discovered\n\n| Test | Seeds |\n|---|---|\n| test_a | 0 |\n| test_b | 1 |\n');
    assert.strictEqual(twoRows.length, 2, JSON.stringify(twoRows));
  });

  test('the paren-terminated ordered marker `1)` remains out of scope', () => {
    // Pinned so a later reader sees this as the ruling's scope, not a miss.
    assert.deepStrictEqual(names('1) alpha\n2) beta\n'), []);
  });

  test('CRLF files: widened markers split and resolve identically', () => {
    for (const m of MARKERS) {
      const crlf = `## Deferred Items\r\n\r\n### Entry\r\n\r\n${m} **What:** x.\r\n${m} **Status:** resolved\r\n`;
      const withStatus = parseDeferredItemsWithStatus(crlf);

      // Same anti-vacuity as AC3: an empty outstanding list would also be
      // satisfied by the entry never being parsed.
      assert.strictEqual(withStatus.length, 1, `marker ${JSON.stringify(m)}: ${JSON.stringify(withStatus)}`);
      assert.strictEqual(withStatus[0].status, 'resolved', `marker ${JSON.stringify(m)}`);
      assert.deepStrictEqual(parseDeferredItems(crlf), [], `marker ${JSON.stringify(m)}`);
    }
  });

  test('nested sub-lists under any marker stay folded into their parent entry', () => {
    // splitGapsEntries' indent rule (#2286) is marker-agnostic: only a marker at
    // or shallower than the first one seen opens a new entry.
    for (const m of MARKERS) {
      const got = names(`${m} alpha\n    ${m} nested one\n    ${m} nested two\n${m} beta\n`);
      assert.strictEqual(got.length, 2, `marker ${JSON.stringify(m)}: ${JSON.stringify(got)}`);
    }
  });
});

describe('#3702 round 2: CRLF on the heading path and in the acknowledge writer', () => {
  const MARKERS = ['-', '*', '+', '1.'];
  const CRLF_SECTION = '## Deferred Items\r\n\r\n';

  test('B1: a CRLF heading entry resolves when **Status:** is NOT the last line', () => {
    // Round-1's CRLF test put `**Status:**` on the fixture's LAST line, where
    // `collectSection`'s `.trimEnd()` had already removed the one `\r` that
    // mattered — a false green. Every other line of a CRLF body still carries
    // its `\r`, and a `$`-anchored marker strip fails on it, so the marker
    // survived into field extraction and the field was silently lost.
    for (const m of MARKERS) {
      const statusFirst = `${CRLF_SECTION}### Entry\r\n\r\n${m} **Status:** resolved\r\n${m} **What:** x.\r\n`;
      const withStatus = parseDeferredItemsWithStatus(statusFirst);

      assert.strictEqual(withStatus.length, 1, `marker ${JSON.stringify(m)}: ${JSON.stringify(withStatus)}`);
      assert.strictEqual(withStatus[0].status, 'resolved', `marker ${JSON.stringify(m)}: status-first CRLF must resolve`);
      assert.deepStrictEqual(parseDeferredItems(statusFirst), [], `marker ${JSON.stringify(m)}`);

      // And the mirror: a field ABOVE a trailing status line is not lost either.
      const whatFirst = `${CRLF_SECTION}### Entry\r\n\r\n${m} **What:** x.\r\n${m} **Status:** resolved\r\n${m} **Why:** y.\r\n`;
      assert.strictEqual(parseDeferredItemsWithStatus(whatFirst)[0].status, 'resolved', `marker ${JSON.stringify(m)}: mid-body status`);
    }
  });

  test('B1: a CRLF heading entry parses byte-for-byte like its LF twin', () => {
    for (const m of MARKERS) {
      const body = `### Entry\n\n${m} **Status:** resolved\n${m} **What:** x.\n`;
      const lf = parseDeferredItemsWithStatus(`## Deferred Items\n\n${body}`);
      const crlf = parseDeferredItemsWithStatus(`${CRLF_SECTION}${body.replace(/\n/g, '\r\n')}`);
      assert.deepStrictEqual(crlf, lf, `marker ${JSON.stringify(m)}`);
    }
  });

  test('M4: acknowledge REWRITES an existing status line on a CRLF file (was: ok + no write)', () => {
    // Pre-existing on `next`: the finder tested a CR-stripped copy, the rewrite
    // ran on the raw `\r`-terminated line with a `$`-anchored regex, `replace`
    // returned the input unchanged, and the writer reported `ok` over content
    // that was byte-identical — the item then resurfaced on every audit.
    for (const m of MARKERS) {
      const content = `${CRLF_SECTION}${m} alpha\r\n  status: pending\r\n${m} beta\r\n`;
      const target = parseDeferredItemsWithStatus(content)[0].name;
      const got = acknowledgeDeferredItem(content, target);

      assert.strictEqual(got.status, 'ok', `marker ${JSON.stringify(m)}`);
      assert.notStrictEqual(got.content, content, `marker ${JSON.stringify(m)}: an ok must have written`);
      assert.strictEqual(parseDeferredItemsWithStatus(got.content)[0].status, 'acknowledged', `marker ${JSON.stringify(m)}`);
    }
  });

  test('m2: the inserted status line takes the entry indent on a CRLF file', () => {
    for (const m of MARKERS) {
      const content = `${CRLF_SECTION}    ${m} alpha\r\n    ${m} beta\r\n`;
      const got = acknowledgeDeferredItem(content, 'alpha');

      assert.strictEqual(got.status, 'ok', `marker ${JSON.stringify(m)}`);
      assert.match(got.content, /\n {6}status: acknowledged/, `marker ${JSON.stringify(m)}: indent 4 + 2, not the indent-0 fallback`);
    }
  });
});

describe('#3702 round 3: detect/strip symmetry on the acknowledge path (B1, B2)', () => {
  // The round-3 blocker. Round 2 widened the WRITER's status-line finder to
  // the deferred marker set while the reader still de-bulleted line 0 only, so
  // a nested `  * status:` was selectable by the writer and invisible to the
  // reader: acknowledge rewrote it, returned `ok`, and the item stayed
  // outstanding on every later audit. Measured against a `next` build, `*`,
  // `+` and `1.` all resolved on base and stopped resolving at round 2's head
  // — a regression, not a gap in new behaviour.
  for (const marker of ['-', '*', '+', '1.']) {
    test(`a nested "${marker} status:" line acknowledges and READS BACK`, () => {
      const doc = `## Deferred Items\n\n- alpha thing\n  ${marker} status: pending\n`;
      const items = parseDeferredItemsWithStatus(doc);
      assert.strictEqual(items.length, 1);
      const got = acknowledgeDeferredItem(doc, items[0].name);
      assert.strictEqual(got.status, 'ok', `${marker}: acknowledge reported`);
      assert.notStrictEqual(got.content, doc, `${marker}: content actually changed`);
      const after = parseDeferredItemsWithStatus(got.content);
      assert.strictEqual(
        after[0].status, 'acknowledged',
        `${marker}: the entry must read back as acknowledged — reporting ok over a line the reader skips is the defect`,
      );
    });
  }

  // The hyphen row above is NOT a widened marker: it was already broken on
  // `next`, for the same reason. One classifier cannot be right for three
  // markers and wrong for the fourth, so it is fixed here rather than left as
  // a pre-existing defect found while working.
  test('a bare capitalised "Status:" resolves rather than reporting a write nothing reads', () => {
    // The reader stores a bare key case-sensitively, so `Status:` is not
    // `status:`. The writer must therefore NOT select it — it falls to the
    // insert branch, which writes a line the reader does read.
    const doc = '## Deferred Items\n\n- alpha\n  Status: pending\n';
    const items = parseDeferredItemsWithStatus(doc);
    const got = acknowledgeDeferredItem(doc, items[0].name);
    assert.strictEqual(got.status, 'ok');
    assert.strictEqual(parseDeferredItemsWithStatus(got.content)[0].status, 'acknowledged');
  });

  test('a fenced "status:" line does not make the entry un-acknowledgeable', () => {
    // Found by the pre-push review, and a regression THIS round introduced:
    // the reader applied the fence gate before classifying and the writer did
    // not, so the writer selected a fenced `status:` line the reader skips.
    // The read-back guard then refused the write and the entry could not be
    // acknowledged at all — `audit acknowledge` raised an internal error and
    // `complete-milestone` halted. It acknowledged cleanly on `next`.
    const F = '`'.repeat(3);
    const doc = `## Deferred Items\n\n- alpha\n  ${F}\n  status: pending\n  ${F}\n`;
    const items = parseDeferredItemsWithStatus(doc);
    assert.strictEqual(items.length, 1);
    const got = acknowledgeDeferredItem(doc, items[0].name);
    assert.strictEqual(got.status, 'ok', 'a fenced status line must not refuse the write');
    assert.strictEqual(
      parseDeferredItemsWithStatus(got.content)[0].status, 'acknowledged',
      'the insert branch must write a line the reader reads, rather than rewriting one it skips',
    );
  });

  test('CONTROL: a bolded line-0 key keeps its ** wrapper and spelling through the rewrite', () => {
    // Held before this round too — it is a control on the NEW offset-based
    // rewrite, not a regression test for a reported defect. The rewrite
    // replaces the VALUE at the offset the classifier reported, so the key is
    // untouched by construction; a key-matching regex would have to reproduce
    // the wrapper to preserve it, which is the thing that could regress.
    const doc = '## Deferred Items\n\n- **Status:** pending alpha\n';
    const items = parseDeferredItemsWithStatus(doc);
    const got = acknowledgeDeferredItem(doc, items[0].name);
    assert.strictEqual(got.status, 'ok');
    assert.match(got.content, /- \*\*Status:\*\* acknowledged/);
  });

  test('acknowledge is idempotent across a re-read', () => {
    // The failure this guards is the one the defect actually produced: the
    // item resurfaces, gets acknowledged again, and never settles.
    const doc = '## Deferred Items\n\n- alpha\n  * status: pending\n';
    const first = acknowledgeDeferredItem(doc, parseDeferredItemsWithStatus(doc)[0].name);
    const reread = parseDeferredItemsWithStatus(first.content);
    assert.strictEqual(reread[0].status, 'acknowledged');
    const second = acknowledgeDeferredItem(first.content, reread[0].name);
    assert.strictEqual(second.status, 'ok');
    assert.strictEqual(parseDeferredItemsWithStatus(second.content)[0].status, 'acknowledged');
  });
});

describe('#3702 round 3: heading-path reader/namer inputs (m7, m8)', () => {
  test('a bullet whose CONTENT is a fence opener does not suppress the entry\'s fields', () => {
    // m7: the fence re-scan used to run on already-marker-stripped lines, so
    // `- ```sh` — an ordinary bullet to the splitter — stripped to a fence
    // opener that existed in no other pass, and the `**Status:** resolved`
    // after it was suppressed as fence content. A RESOLVED entry resurfaced.
    const doc = '## Deferred Items\n\n### Entry\n\n- ```sh\n- **Status:** resolved\n- ```\n';
    // The status field must be READ (the round-2 fence suppression is for a
    // fence the SPLITTER saw, which this is not) ...
    assert.strictEqual(parseDeferredItemsWithStatus(doc)[0].status, 'resolved');
    // ... and a resolved entry must therefore not surface as outstanding.
    assert.deepStrictEqual(parseDeferredItems(doc), []);
  });

  test('a heading that begins with a list marker keeps it in the entry name', () => {
    // m8: line 0 of a heading entry is the heading TEXT, not a bullet.
    // Stripping a marker off it silently renamed the entry — and the name is
    // the key acknowledge matches on.
    for (const [heading, expected] of [
      ['### 1. Race in the writer', '1. Race in the writer'],
      ['### * starred title', '* starred title'],
      ['### Race in the writer', 'Race in the writer'],
    ]) {
      const doc = `## Deferred Items\n\n${heading}\n\n- **What:** x\n`;
      const items = parseDeferredItemsWithStatus(doc);
      assert.strictEqual(items.length, 1, heading);
      assert.ok(items[0].name.startsWith(expected), `${heading} -> ${items[0].name}`);
    }
  });

  test('CONTROL: a body bullet keeps its marker in the entry name', () => {
    // Held before this round too — a control on the opener-flag threading, not
    // a reported defect. The flags say which lines CARRY a marker, but only
    // line 0's is part of the entry's identity; wiring the flags into the namer
    // wholesale strips the body lines too, which is a rename of the key
    // acknowledge matches on. This pins that it did not happen.
    const doc = '## Deferred Items\n\n### Entry\n\n- **What:** x\n';
    assert.strictEqual(parseDeferredItemsWithStatus(doc)[0].name, 'Entry  - **What:** x');
  });
});

describe('#3702 round 2: marker-grammar parity (M3, N1, N2)', () => {
  test('every deferred-items marker regex derives from the one alternation source', () => {
    // Structural, not behavioural: both splitter regexes embed the SAME
    // source string, so a marker added to one cannot be absent from the other.
    // Round 2 ran this over four regexes; the two writer-side ones are gone.
    for (const [name, re] of [
      ['open', DEFERRED_BULLET_MARKERS.open],
      ['strip', DEFERRED_BULLET_MARKERS.strip],
    ]) {
      assert.ok(re.source.includes(DEFERRED_MARKER_ALT), `${name}: ${re.source}`);
    }
  });

  // #3702 round 3 (M6): the structural assertion above is kept for the two
  // SPLITTER regexes, which really are two copies of one alternation. It is no
  // longer asked to stand in for the writer/reader agreement — it never could.
  // Sharing a source string says nothing about whether the line the writer
  // selects is a line the reader reads, which is precisely the asymmetry that
  // shipped. The replacement is BEHAVIOURAL and drives the real seam.
  test('every marker that OPENS an entry also resolves it through acknowledge', () => {
    for (const m of ['-', '*', '+', '1.']) {
      assert.ok(DEFERRED_BULLET_MARKERS.open.test(`${m} x`), `open: ${m}`);
      // The marker goes on BOTH the opener and the nested status line. Round
      // 2's structural test could not reach B1; a replacement that only marks
      // the opener cannot either — it is green on the defective build.
      const doc = `## Deferred Items\n\n${m} alpha\n  ${m} status: pending\n`;
      const items = parseDeferredItemsWithStatus(doc);
      assert.strictEqual(items.length, 1, `entry surfaced: ${m}`);
      const got = acknowledgeDeferredItem(doc, items[0].name);
      assert.strictEqual(got.status, 'ok', `ack ok: ${m}`);
      const after = parseDeferredItemsWithStatus(got.content);
      assert.strictEqual(
        after[0].status, 'acknowledged',
        `${m}: acknowledge must be READ BACK, not merely written — a status line the reader skips leaves the item outstanding forever`,
      );
    }
  });

  test('parity with markdown-sectionizer iterateBullets on the shared vocabulary', () => {
    // `iterateBullets` is the repo's other list-marker grammar. On everything
    // both grammars are meant to agree on, they do — including the negatives.
    const opens = (line) => DEFERRED_BULLET_MARKERS.open.test(line);
    const sectionizerOpens = (line) => iterateBullets(line).length === 1;
    const shared = [
      ['- x', true], ['* x', true], ['+ x', true], ['1. x', true], ['12. x', true], ['01. x', true],
      ['  - x', true], ['- [ ] x', true], ['- [x] x', true],
      ['**Status:** x', false], ['1) x', false], ['-x', false], ['*x', false], ['1.x', false],
      ['prose', false], ['| a | b |', false], ['2026 was a year', false],
    ];
    for (const [line, expected] of shared) {
      assert.strictEqual(opens(line), expected, `deferred: ${JSON.stringify(line)}`);
      assert.strictEqual(sectionizerOpens(line), expected, `sectionizer: ${JSON.stringify(line)}`);
    }
  });

  test('the two deliberate divergences from iterateBullets are exactly these', () => {
    // N2 — a tab after the marker is CommonMark-legal; `iterateBullets`
    // requires a literal space. Kept, and pinned so the difference is visible.
    assert.strictEqual(DEFERRED_BULLET_MARKERS.open.test('-\tx'), true);
    assert.strictEqual(iterateBullets('-\tx').length, 0);
    // N1 — CommonMark caps an ordered start at 9 digits; `iterateBullets` is
    // `\d+`. Ten digits is not a list marker here.
    assert.strictEqual(DEFERRED_BULLET_MARKERS.open.test('1234567890. x'), false);
    assert.strictEqual(iterateBullets('1234567890. x').length, 1);
    // And `\r` is no longer whitespace after a marker (round 1's `\s` was) —
    // nor are NBSP, form-feed or vertical-tab, which `\s` also accepted and
    // CommonMark does not: only a space or a tab follows a marker. This is
    // the assertion that fails on a `[ \t]` → `\s` revert on its own.
    assert.strictEqual(DEFERRED_BULLET_MARKERS.open.test('-\r'), false);
    for (const ws of ['\u00a0', '\f', '\v']) {
      assert.strictEqual(DEFERRED_BULLET_MARKERS.open.test(`-${ws}x`), false, JSON.stringify(ws));
    }
  });
});

describe('#3702 round 2: the ordered marker and the prose contract (B2, m1)', () => {
  const SECTION = '## Deferred Items\n\n';
  const names = (md) => parseDeferredItems(SECTION + md).map((i) => i.name);

  test('B2: a sentence that happens to open with `<number>.` is prose, not an item', () => {
    // Both were items on round 1 — `\d+\.` accepted any digit run. CommonMark
    // §5.3's own prose/list discriminator is that an ordered list interrupting
    // a paragraph must START AT 1; this parser applies that rule everywhere
    // an ordered marker is seen (see `matchListOpener`).
    assert.deepStrictEqual(names('2026. was a bad year for this module\n'), []);
    assert.deepStrictEqual(names('### Notes\n\n3. is the number of retries we settled on.\n'), []);
    // And the mixed heading case: prose under one heading, a list under another.
    const got = names('### Notes\n\n3. is the number of retries.\n\n### Steps\n\n1. do this\n2. then this\n');
    assert.strictEqual(got.length, 1, JSON.stringify(got));
    assert.match(got[0], /^Steps/);
  });

  test('B2: an ordered list that starts at 1. counts, at any later number in the run', () => {
    assert.deepStrictEqual(names('1. alpha\n2. beta\n3. gamma\n'), ['alpha', 'beta', 'gamma']);
    // CommonMark ignores the numbers after the first — so does the run.
    assert.deepStrictEqual(names('1. alpha\n3. gamma\n7. delta\n'), ['alpha', 'gamma', 'delta']);
    assert.deepStrictEqual(names('01. alpha\n02. beta\n'), ['alpha', 'beta']);
    // Heading shape: the run is per entry body.
    assert.strictEqual(names('### Steps\n\n1. do\n2. then\n').length, 1);
    // Status fields under an ordered run still resolve their entry.
    assert.deepStrictEqual(names('1. alpha\n   status: resolved\n2. beta\n'), ['beta']);
  });

  test('B2: the rule\'s stated cost — a run that does not start at 1 is prose', () => {
    // Pinned so the trade is visible: a hand-numbered list starting at 2 is
    // read as prose, the same way CommonMark refuses it as a paragraph
    // interruption. The wild records (#3702) all start at 1.
    assert.deepStrictEqual(names('2. alpha\n3. beta\n'), []);
    // A non-ordered opener ends the run; a following non-1 ordered line is prose
    // folded into the open entry rather than a new item.
    assert.deepStrictEqual(names('1. alpha\n- beta\n2. gamma\n'), ['alpha', 'beta 2. gamma']);
  });

  test('m1: the 9-digit boundary of an ordered start', () => {
    // `999999999.` is a legal CommonMark ordered marker; ten digits is not.
    assert.deepStrictEqual(names('1. a\n999999999. b\n'), ['a', 'b']);
    // Ten digits: not a marker at all — a lazy continuation of the open item.
    assert.deepStrictEqual(names('1. a\n1234567890. b\n'), ['a 1234567890. b']);
    // And a ten-digit line cannot open a run on its own.
    assert.deepStrictEqual(names('1234567890. b\n'), []);
  });

  test('m1: the indentation cliff is deliberately NOT applied — indent-lenient by design', () => {
    // CommonMark reads a 4-space-indented line outside a list as indented
    // code. This parser does not: `deferred-items.md` is hand-written with no
    // mandated shape, and surfacing a questionable entry beats dropping a real
    // one (the #2766 stance). Pinned as a decision, with the 3-space twin that
    // both readings agree on.
    assert.deepStrictEqual(names('   - x\n'), ['x']);
    assert.deepStrictEqual(names('    - x\n'), ['x']);
    // Nesting still folds by the indent rule at the 2-space depth executors
    // actually write, not only at the 4-space depth round 1 tested.
    assert.deepStrictEqual(names('- alpha\n  - nested\n- beta\n'), ['alpha - nested', 'beta']);
  });
});

describe('#3702 round 2: thematic breaks and fenced code are not list items (M1, M2)', () => {
  const SECTION = '## Deferred Items\n\n';
  const names = (md) => parseDeferredItems(SECTION + md).map((i) => i.name);

  test('M1: a thematic break opens no entry, whichever character it is drawn with', () => {
    // `- - -` was a phantom `"- -"` entry on base already; round 1 added
    // `* * *` and `+ + +` to the class — and `* * *` is the separator an
    // author writing in the `*` style is most likely to use.
    for (const hr of ['* * *', '+ + +', '- - -', '***', '---', '___', ' * * *', '*  *  *  ', '- - - - -']) {
      assert.deepStrictEqual(names(`${hr}\n`), [], JSON.stringify(hr));
      assert.deepStrictEqual(names(`### Entry\n\n${hr}\n`), [], `heading: ${JSON.stringify(hr)}`);
    }
  });

  test('M1: a thematic break ENDS the open entry rather than joining it', () => {
    // CommonMark: a thematic break closes the list. The separator is neither a
    // phantom item nor a continuation line of the item above it.
    assert.deepStrictEqual(names('- alpha\n\n* * *\n\n- beta\n'), ['alpha', 'beta']);
    assert.deepStrictEqual(names('* alpha\n* * *\n* beta\n'), ['alpha', 'beta']);
    // Under a heading, the break is dropped from the entry body.
    assert.deepStrictEqual(names('### Entry\n\n- **What:** x.\n\n* * *\n'), ['Entry  - **What:** x.']);
    // `- - - x` is NOT a break (trailing text); it is a `- ` item whose text is `- - x`.
    assert.deepStrictEqual(names('- - - x\n'), ['- - x']);
  });

  test('M2: lines inside a fenced code block never open an entry', () => {
    // #3702's wild records carry reproduction blocks — `+`-prefixed diff lines
    // and `1.`-numbered repro steps are the NORMAL content of such a file.
    assert.deepStrictEqual(names('### Entry\n\n```sh\n1. run this\n2. then this\n```\n'), []);
    assert.deepStrictEqual(names('```diff\n+ added\n- removed\n```\n'), []);
    assert.deepStrictEqual(names('~~~\n* not an item\n~~~\n'), []);
    // An unterminated fence runs to the end of the section.
    assert.deepStrictEqual(names('```\n- still fenced\n'), []);
  });

  test('M2: a fence inside an entry is continuation, and the entry still parses around it', () => {
    const md = '- alpha\n  ```sh\n  1. step\n  + diff\n  ```\n  status: resolved\n- beta\n';
    const withStatus = parseDeferredItemsWithStatus(SECTION + md);
    assert.strictEqual(withStatus.length, 2, JSON.stringify(withStatus));
    assert.strictEqual(withStatus[0].status, 'resolved');
    assert.deepStrictEqual(names(md), ['beta']);
    // Heading shape: the fenced lines are body text, not evidence — the `-`
    // line outside the fence is what keeps the entry.
    assert.strictEqual(names('### Entry\n\n- **What:** x.\n\n```\n1. repro\n```\n').length, 1);
    // And the acknowledge writer's span survives a fenced continuation.
    const ack = acknowledgeDeferredItem(SECTION + '- alpha\n  ```\n  + diff\n  ```\n- beta\n', 'alpha ``` + diff ```');
    assert.strictEqual(ack.status, 'ok');
    assert.strictEqual(parseDeferredItemsWithStatus(ack.content)[0].status, 'acknowledged');
  });
});

describe('#3702 round 2: indent measure is grammar-scoped (review round 6)', () => {
  // The deferred grammar measures CommonMark columns (a tab is a jump to the
  // next multiple of 4); the Gaps grammar keeps `next`'s raw character count.
  // Sharing one measure silently changed Gaps entry boundaries in BOTH
  // directions on tab-indented input, breaking the `blockStructure: false`
  // opt-out's byte-for-byte promise.
  const gapsNames = (body) => parseUatItems(['# UAT', '', '## Gaps', '', body, ''].join('\n')).map((i) => i.name);
  const deferredNames = (body) => parseDeferredItems('## Deferred Items\n\n' + body + '\n').map((i) => i.name);

  test('Gaps: a tab-indented item followed by a two-space one stays ONE entry, as on `next`', () => {
    assert.deepEqual(gapsNames('\t- first item\n  - second item'), ['first item - second item']);
  });

  test('Gaps: a two-space item followed by a tab-indented one stays TWO entries, as on `next`', () => {
    assert.deepEqual(gapsNames('  - first item\n\t- second item'), ['first item', 'second item']);
  });

  test('Gaps: four spaces then two spaces splits, and a tab pair splits — unchanged either way', () => {
    assert.deepEqual(gapsNames('    - first item\n  - second item'), ['first item', 'second item']);
    assert.deepEqual(gapsNames('\t- first item\n\t- second item'), ['first item', 'second item']);
  });

  test('deferred: the SAME tab/space pairs measure in columns — the opposite verdict, by design', () => {
    assert.deepEqual(deferredNames('\t- first\n  - second'), ['first', 'second']);
    assert.deepEqual(deferredNames('  - first\n\t- second'), ['first - second']);
  });
});

describe('#3702 round 2: round-review refinements (ordered run, rejected ordinals, breaks, fenced fields, Gaps scope)', () => {
  const SECTION = '## Deferred Items\n\n';
  const names = (md) => parseDeferredItems(SECTION + md).map((i) => i.name);
  const statuses = (md) => parseDeferredItemsWithStatus(SECTION + md).map((i) => i.status);

  test('an ordered run ENDS at a paragraph that follows a blank line (CommonMark §5.3), but survives lazy continuation', () => {
    // A blank line then a non-indented, non-list line is a paragraph: the list
    // is over, and `5. x` after it is prose folded into the open entry.
    const got = names('1. a\n\nparagraph\n\n5. x\n');
    assert.strictEqual(got.length, 1, JSON.stringify(got));
    assert.match(got[0], /^a/);
    // No blank line → lazy continuation → the list is still open and `2. b` is an item.
    assert.deepStrictEqual(names('1. a\nlazy continuation\n2. b\n'), ['a lazy continuation', 'b']);
    // Heading shape carries the same rule per body.
    assert.strictEqual(names('### Steps\n\n1. do\n\nsome prose.\n\n4. not an item\n').length, 1);
  });

  test('an accepted opener clears the blank-line memory — lazy continuation right after it keeps the run', () => {
    // Round-review continuation: `blankSeen` survived the opener branch, so
    // `2. b` + a lazy line ended the run and `3. c` folded into `b`.
    assert.deepStrictEqual(names('1. a\n\n2. b\nlazy continuation\n3. c\n'), ['a', 'b lazy continuation', 'c']);
  });

  test('a headless region of a heading-shaped file applies the SAME paragraph reset — opener flags come from the splitter, not a re-derivation', () => {
    // Round-review continuation: a re-derived flag set re-accepted `3.` under a
    // stale run after the paragraph had ended it, and stripped it into a field.
    const md = '1. alpha\n\nparagraph\n\n3. status: resolved\n\n### Entry\n\n- **What:** x\n';
    assert.deepStrictEqual(statuses(md), ['', '']);
    assert.strictEqual(names(md).length, 2);
  });

  test('an ordered run is per INDENT: a nested `1. / 2.` run resolves (round-1 parity), a nested ordinal under a nested bullet is prose', () => {
    // Round-review continuation 2: nested openers read the top-level run and
    // never wrote their own.
    for (const eol of ['\n', '\r\n']) {
      const nestedRun = '- alpha\n  1. what: detail\n  2. status: resolved\n\n### Entry\n\n- **What:** x\n'.replace(/\n/g, eol);
      assert.deepStrictEqual(statuses(nestedRun), ['resolved', ''], JSON.stringify(eol));
      const leak = '1. alpha\n  - nested prose\n  3. status: resolved\n\n### Entry\n\n- **What:** x\n'.replace(/\n/g, eol);
      assert.deepStrictEqual(statuses(leak), ['', ''], JSON.stringify(eol));
    }
    // A new top-level item resets the nested levels: `2.` under beta does not continue alpha's nested run.
    assert.deepStrictEqual(statuses('- alpha\n  1. a\n- beta\n  2. status: resolved\n'), ['', '']);
    // Under a heading the same per-indent rule applies.
    assert.deepStrictEqual(statuses('### Entry\n\n- **What:** x\n  1. step\n  2. **Status:** resolved\n'), ['resolved']);
  });

  test('a DEDENTING top-level list keeps its entry boundaries — every indent at or above the base is one level', () => {
    // Round-review continuation 3: the exact-indent run lookup rejected the
    // shallower ordinals, collapsing three entries into one.
    assert.deepStrictEqual(names('    1. alpha\n  2. beta\n3. gamma\n'), ['alpha', 'beta', 'gamma']);
    assert.deepStrictEqual(names('  - alpha\n- beta\n    - gamma\n'), ['alpha', 'beta - gamma']);
  });

  test('indent is measured in CommonMark COLUMNS (a tab advances to the next multiple of 4), so a tab and a space are different levels', () => {
    // Round-review continuation 3: character counting aliased `\t` and ` `.
    // Heading shape, where every ACCEPTED nested opener is marker-stripped
    // before field extraction (the headless path strips line 0 only — #3740).
    for (const eol of ['\n', '\r\n']) {
      const body = (nested) => `### Entry\n\n- **What:** x\n${nested}`.replace(/\n/g, eol);
      assert.deepStrictEqual(statuses(body('\t1. nested\n 2. **Status:** resolved\n')), [''], JSON.stringify(eol));
      assert.deepStrictEqual(statuses(body('\t1. nested\n\t2. **Status:** resolved\n')), ['resolved'], JSON.stringify(eol));
      assert.deepStrictEqual(statuses(body('    1. nested\n\t2. **Status:** resolved\n')), ['resolved'], JSON.stringify(eol));
    }
  });

  test('a fenced block ends the runs at its indent and deeper, like a paragraph does', () => {
    // Round-review continuation 3: a nested run stayed open across a fence,
    // so a post-fence `2. status: resolved` resolved the entry. Heading shape,
    // for the reason the columns test states.
    const body = (nested) => `### Entry\n\n- **What:** x\n${nested}`;
    assert.deepStrictEqual(statuses(body('  1. a\n  ```\n  code\n  ```\n  2. **Status:** resolved\n')), ['']);
    // A deeper fence (3 spaces — the sectionizer's CommonMark `{0,3}` limit) leaves the shallower run alone.
    assert.deepStrictEqual(statuses(body('  1. a\n   ```\n   code\n   ```\n  2. **Status:** resolved\n')), ['resolved']);
    // Control: without the fence the run continues and resolves.
    assert.deepStrictEqual(statuses(body('  1. a\n  2. **Status:** resolved\n')), ['resolved']);
  });

  test('a REJECTED ordinal line under a heading is not marker-stripped, so it cannot manufacture a field', () => {
    // `3. status: resolved` is prose by the start-at-1 rule; before this fix the
    // heading path stripped its marker anyway and read a resolved field off it.
    assert.deepStrictEqual(statuses('### Entry\n\n- **What:** x\n3. status: resolved\n'), ['']);
    assert.strictEqual(names('### Entry\n\n- **What:** x\n3. status: resolved\n').length, 1);
    // An ACCEPTED ordered status line still resolves, as `- status: resolved` does.
    assert.deepStrictEqual(statuses('### Entry\n\n1. **What:** x\n2. **Status:** resolved\n'), ['resolved']);
    // Same rule in a headless region of a heading-shaped file.
    assert.deepStrictEqual(statuses('- alpha\n  3. status: resolved\n\n### Entry\n\n- **What:** x\n'), ['', '']);
  });

  test('a thematic break is recognised at any indent — the parser is indent-lenient for breaks as it is for items', () => {
    assert.deepStrictEqual(names('    * * *\n'), []);
    assert.deepStrictEqual(names('- alpha\n\n      - - -\n\n- beta\n'), ['alpha', 'beta']);
  });

  test('a status line orphaned after a break leaves its entry OPEN — the fail-safe polarity, pinned', () => {
    // `- alpha\n---` is a list then a thematic break in CommonMark; the indented
    // line after it belongs to nothing. Surfacing alpha is the safe direction.
    assert.deepStrictEqual(names('- alpha\n---\n  status: resolved\n'), ['alpha']);
  });

  test('fenced lines carry no FIELDS either — a fenced `status: resolved` does not resolve the entry', () => {
    assert.deepStrictEqual(statuses('- alpha\n```\nstatus: resolved\n```\n'), ['']);
    assert.deepStrictEqual(statuses('### Entry\n\n- **What:** x\n```\n- **Status:** resolved\n```\n'), ['']);
    assert.deepStrictEqual(statuses('- alpha\n  ```yaml\n  status: resolved\n  ```\n  status: acknowledged\n'), ['acknowledged']);
  });

  test('`## Gaps` keeps its round-1 grammar byte-for-byte: no fence or break awareness there', () => {
    // Block structure (M1/M2) is scoped to the deferred grammar via
    // `BulletMarkers.blockStructure`; the Gaps section is template-mandated and
    // out of #3702's blast radius, so a fenced hyphen line still counts there,
    // and a fenced field is still read — exactly as on `next`.
    const uat = ['---', 'status: partial', 'phase: 01-x', '---', '', '## Gaps', '', '```', '- truth: phantom', '  status: open', '```', ''].join('\n');
    const got = parseUatItems(uat);
    assert.deepStrictEqual(got.map((i) => i.name), ['phantom'], JSON.stringify(got));
    const withBreak = ['---', 'status: partial', 'phase: 01-x', '---', '', '## Gaps', '', '- - -', '- truth: real', '  status: open', ''].join('\n');
    assert.deepStrictEqual(parseUatItems(withBreak).map((i) => i.name), ['- -', 'real']);
  });
});

// ─── Bug 3: table-shaped ## Gaps section ──────────────────────────────────────

describe('#2766 parseGapsItems: GFM table shape', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  /** Run audit-uat over a phase whose UAT file has `gapsBody` as its Gaps section. */
  function gapsItems(gapsBody) {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '50-gaps');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '50-UAT.md'), uatWithGaps(gapsBody));

    const result = runGsdTools('audit-uat --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    const uat = output.results.find(r => r.type === 'uat');
    return uat ? uat.items : [];
  }

  test('header-mapped table → truth/status/reason/test extracted', () => {
    const items = gapsItems([
      '| Truth | Status | Reason | Test |',
      '|-------|--------|--------|------|',
      '| Login should redirect | failed | User reported a 500 | 1 |',
    ].join('\n'));

    assert.strictEqual(items.length, 1, JSON.stringify(items));
    assert.strictEqual(items[0].name, 'Login should redirect');
    assert.strictEqual(items[0].result, 'failed');
    assert.strictEqual(items[0].reason, 'User reported a 500');
    assert.strictEqual(items[0].test, 1);
  });

  test('status: resolved row suppressed, open row kept', () => {
    const items = gapsItems([
      '| Truth | Status |',
      '|-------|--------|',
      '| closed thing | resolved |',
      '| open thing | failed |',
    ].join('\n'));

    assert.strictEqual(items.length, 1, JSON.stringify(items.map(i => i.name)));
    assert.strictEqual(items[0].name, 'open thing');
  });

  test('no status column → surfaced as unknown, not dropped', () => {
    const items = gapsItems('| Truth | Note |\n|---|---|\n| something is off | see logs |');

    assert.strictEqual(items.length, 1, JSON.stringify(items));
    assert.strictEqual(items[0].result, 'unknown');
    assert.strictEqual(items[0].name, 'something is off');
  });

  test('unrecognizable header → joined cells + unknown status', () => {
    const items = gapsItems('| Alpha | Beta |\n|---|---|\n| xxx | yyy |');

    assert.strictEqual(items.length, 1, JSON.stringify(items));
    assert.strictEqual(items[0].result, 'unknown');
    assert.match(items[0].name, /xxx/);
    assert.match(items[0].name, /yyy/);
  });

  test('headerless table → explicit resolved cell still suppressed', () => {
    const items = gapsItems('| open thing | failed |\n| closed thing | resolved |');

    assert.strictEqual(items.length, 1, JSON.stringify(items.map(i => i.name)));
    assert.match(items[0].name, /open thing/);
  });

  test('bullets and a table in one Gaps section → union, no double-counting', () => {
    const items = gapsItems([
      '- truth: "a bullet gap"',
      '  status: failed',
      '',
      '| Truth | Status |',
      '|---|---|',
      '| a table gap | failed |',
    ].join('\n'));

    assert.strictEqual(items.length, 2, JSON.stringify(items.map(i => i.name)));
    assert.ok(items.some(i => i.name === 'a bullet gap'));
    assert.ok(items.some(i => i.name === 'a table gap'));
  });

  test('bullet-only Gaps unchanged (no regression on #2286)', () => {
    const items = gapsItems('- truth: "only a bullet"\n  status: failed\n  reason: "because"\n');

    assert.strictEqual(items.length, 1, JSON.stringify(items));
    assert.strictEqual(items[0].name, 'only a bullet');
    assert.strictEqual(items[0].reason, 'because');
  });
});
