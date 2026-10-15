/**
 * #5287 — `/gsd:phase --insert <X>` takes the phase to insert AFTER and creates a new
 * decimal phase (5 → 5.1, or 5.2 when 5.1 exists). A printed chain that then
 * runs `/gsd:discuss-phase`, `/gsd:plan-phase` or `/gsd:execute-phase` with the
 * same `<X>` targets the existing phase, which resolves cleanly, so nothing
 * warns and the inserted phase stays empty.
 *
 * Every shipped markdown chain that inserts a phase and then addresses one
 * must address it by a different argument. When that argument is a
 * placeholder, the paragraph after the chain must say where the number comes
 * from; a worked example with literal numbers shows it already.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const SCAN_ROOTS = ['gsd-core', 'commands', 'agents'].map((d) => path.join(REPO_ROOT, d));
const AUDIT_MILESTONE = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'audit-milestone.md');

const INSERT_RE = /\/gsd[:-]phase\s+--insert\s+(\S+)/;
const FOLLOW_UP_RE = /\/gsd[:-](discuss|plan|execute)-phase\s+(\S+)/;

function collectMarkdownFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      results.push(...collectMarkdownFiles(full));
    } else if (entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Find each insert chain: an insert line followed, in the same block of
 * consecutive non-blank lines, by at least one discuss/plan/execute line.
 * Returns the insert argument, the follow-up arguments, and the text of the
 * paragraph right after the block.
 */
function findInsertChains(text) {
  const lines = text.split(/\r?\n/);
  const chains = [];
  for (let i = 0; i < lines.length; i++) {
    const insert = lines[i].match(INSERT_RE);
    if (!insert) continue;
    const followUps = [];
    let j = i + 1;
    for (; j < lines.length && lines[j].trim() !== ''; j++) {
      const m = lines[j].match(FOLLOW_UP_RE);
      if (m) followUps.push({ command: m[1], arg: m[2], line: j + 1 });
    }
    if (followUps.length === 0) continue;
    while (j < lines.length && lines[j].trim() === '') j++;
    const after = [];
    for (; j < lines.length && lines[j].trim() !== ''; j++) after.push(lines[j]);
    chains.push({ line: i + 1, insertArg: insert[1], followUps, nextParagraph: after.join(' ') });
  }
  return chains;
}

function chainProblems(chain) {
  const problems = [];
  for (const f of chain.followUps) {
    if (f.arg === chain.insertArg) {
      problems.push(`L${f.line}: /gsd:${f.command}-phase ${f.arg} reuses the insert's after-phase argument`);
    }
  }
  const followArgs = [...new Set(chain.followUps.map((f) => f.arg))];
  for (const arg of followArgs) {
    // A literal number (`--insert 5` then `5.1`) shows its own derivation; a
    // placeholder does not, so only a placeholder needs the explanation.
    if (arg === chain.insertArg || !/^[<{]/.test(arg)) continue;
    if (!(chain.nextParagraph.includes(arg) && /\binsert\b/i.test(chain.nextParagraph))) {
      problems.push(`L${chain.line}: the paragraph after the chain does not say ${arg} comes from the insert's output`);
    }
  }
  return problems;
}

describe('phase-insert chains address the inserted phase, not the after-phase (#5287)', () => {
  test('the detector flags the pre-fix audit-milestone block', () => {
    const preFix = [
      '/gsd:phase --insert <N> "Close gap: <REQ-ID> — <description>"',
      '/gsd:discuss-phase <N>',
      '/gsd:plan-phase <N>',
      '/gsd:execute-phase <N>',
      '',
      'For Nyquist-coverage gaps flagged in the table above, prefer running',
    ].join('\n');
    const chains = findInsertChains(preFix);
    assert.equal(chains.length, 1);
    assert.equal(chainProblems(chains[0]).length, 3);
  });

  test('the detector flags a distinct placeholder that is never explained', () => {
    const unexplained = [
      '/gsd:phase --insert <after-phase> "x"',
      '/gsd:plan-phase <new-phase>',
      '',
      'Some unrelated paragraph.',
    ].join('\n');
    const chains = findInsertChains(unexplained);
    assert.equal(chains.length, 1);
    assert.equal(chainProblems(chains[0]).length, 1);
  });

  test('a worked example with literal numbers passes', () => {
    const example = ['/gsd:phase --insert 5 "Critical security fix"', '/gsd:plan-phase 5.1', ''].join('\n');
    const chains = findInsertChains(example);
    assert.equal(chains.length, 1);
    assert.deepEqual(chainProblems(chains[0]), []);
  });

  test('audit-milestone.md carries both closure chains (positive control)', () => {
    const chains = findInsertChains(fs.readFileSync(AUDIT_MILESTONE, 'utf-8'));
    assert.equal(chains.length, 2, 'expected the gaps_found and tech_debt chains');
  });

  test('no shipped chain reuses the insert argument or leaves the new number unexplained', () => {
    const files = SCAN_ROOTS.flatMap(collectMarkdownFiles);
    assert.ok(files.length > 0, 'expected markdown files to scan');
    const failures = [];
    for (const file of files) {
      for (const chain of findInsertChains(fs.readFileSync(file, 'utf-8'))) {
        for (const p of chainProblems(chain)) failures.push(`${path.relative(REPO_ROOT, file)} ${p}`);
      }
    }
    assert.deepEqual(failures, []);
  });
});
