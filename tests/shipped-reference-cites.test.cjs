// docs-guard-exempt: this file's own header comment states docs/ is deliberately OUT of scope for its citation scan.
'use strict';

// allow-test-rule: source-text-is-the-product (#3576) — this gate reads shipped
// runtime-loaded .md files and asserts on their literal citation text; the text IS
// the deployed contract, so reading it is the behavior under test.

/**
 * #3576 — dead-citation gate for the shipped trees.
 *
 * A backticked bare `references/<name>.md` cite resolves from NO install location:
 * agents install to ~/.claude/agents/, workflows to ~/.claude/gsd-core/workflows/,
 * references to a sibling of workflows — a bare relative `references/` path is dead
 * from every one of them. The canonical form (what every <required_reading> block
 * and @~/ include already uses) is `gsd-core/references/<file>.md`.
 *
 * #3206 fixed one file; PR #3435 swept agents/gsd-verifier.md and stopped at its
 * scope. This gate ends the class (epic #3473's B6 shape; #3518's drift guard is
 * the precedent). Scope: the runtime-loaded trees the issue prescribes — agents/,
 * gsd-core/{workflows,references,templates,contexts}, commands/, capabilities/.
 * docs/ (incl. translations) is deliberately OUT: human-facing, per-locale drift,
 * ranked lower severity by the issue — the recorded remainder.
 *
 * The trap the issue names: a guard that skips whole LINES containing `@~/` misses
 * a bare cite sharing a line with an include — strip only the `@~/…` token.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

const SCAN_ROOTS = [
  'agents',
  'gsd-core/workflows',
  'gsd-core/references',
  'gsd-core/templates',
  'gsd-core/contexts',
  'commands',
  'capabilities',
];

// A bare cite is BACKTICK-ANCHORED: `` `references/x.md` ``. The anchor is what
// excludes the genuinely relative href (`../references/…` — its backtick precedes
// `..`, not `references/`) and non-backticked prose mentions.
const BARE_CITE_RE = /`references\/([a-z0-9-]*\.md)`/g;
// The @~/ include token, stripped PER-TOKEN (never line-wise) before scanning.
const INCLUDE_TOKEN_RE = /@~\/[^\s`]+/g;

function walkShippedMarkdown() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    const rootDir = path.join(REPO_ROOT, root);
    if (!fs.existsSync(rootDir)) continue;
    // readdirSync returns platform-separated relative paths; normalize
    // unconditionally (repo convention) so diagnostics read identically on Windows.
    for (const f of fs.readdirSync(rootDir, { recursive: true })) {
      const normalized = String(f).split(path.sep).join('/');
      if (normalized.endsWith('.md')) files.push({ rel: `${root}/${normalized}`, abs: path.join(rootDir, f) });
    }
  }
  return files;
}

/** Find bare cites in one document, after per-token @~/ stripping. */
function findBareCites(text) {
  const stripped = text.replace(INCLUDE_TOKEN_RE, '');
  const offenders = [];
  let m;
  while ((m = BARE_CITE_RE.exec(stripped)) !== null) {
    offenders.push(`references/${m[1]}`);
  }
  return offenders;
}

/** Canonical `gsd-core/references/<name>` cites (backticked) — targets must exist. */
function findCanonicalCites(text) {
  const re = /`gsd-core\/references\/([a-z0-9-]*\.md)`/g;
  const found = [];
  let m;
  while ((m = re.exec(text)) !== null) found.push(m[1]);
  return found;
}

describe('#3576 gate: shipped reference citations resolve', () => {
  test('#3576 gate: no bare references/ cites across shipped trees', () => {
    const offenders = [];
    for (const { rel, abs } of walkShippedMarkdown()) {
      // allow-test-rule: source-text-is-the-product (#3576) — shipped text is the runtime contract
      const text = fs.readFileSync(abs, 'utf-8');
      for (const cite of findBareCites(text)) {
        offenders.push(`${rel}: \`${cite}\` — bare cite resolves from no install location; use \`gsd-core/${cite}\``);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'Bare `references/<name>.md` cites are dead pointers at runtime (#3576). '
        + 'Rewrite to the canonical `gsd-core/references/<file>.md` form:\n'
        + offenders.join('\n'),
    );
  });

  test('#3576 gate: every canonical reference cite target exists on disk', () => {
    const missing = [];
    for (const { rel, abs } of walkShippedMarkdown()) {
      // allow-test-rule: source-text-is-the-product (#3576) — shipped text is the runtime contract
      const text = fs.readFileSync(abs, 'utf-8');
      for (const name of findCanonicalCites(text)) {
        if (!fs.existsSync(path.join(REPO_ROOT, 'gsd-core', 'references', name))) {
          missing.push(`${rel}: \`gsd-core/references/${name}\` — target does not exist`);
        }
      }
    }
    assert.deepEqual(missing, [], 'Canonical cites must name files that exist:\n' + missing.join('\n'));
  });

  test('#3576 gate unit: @~/ token stripped per-token, never line-skipped; relative and canonical forms pass', () => {
    const includePlusBare = 'Read @~/gsd-core/references/tdd.md and `references/tdd.md` too';
    assert.deepEqual(
      findBareCites(includePlusBare),
      ['references/tdd.md'],
      'a bare cite sharing a line with an @~/ include must still be flagged (the issue-named trap)',
    );
    assert.deepEqual(findBareCites('see `../references/mvp-concepts.md`'), [], 'genuinely relative href is not a bare cite');
    assert.deepEqual(findBareCites('see `gsd-core/references/tdd.md`'), [], 'canonical cite is not a bare cite');
    assert.deepEqual(findBareCites('the references/ directory'), [], 'non-backticked prose mention is not a cite');
    assert.deepEqual(findBareCites('Read @~/gsd-core/references/tdd.md now'), [], 'a lone @~/ include line is clean after stripping');
  });
});

// ─── #4841: bare `@gsd-core/references/…` includes in agents/ ─────────────────
//
// The @-include twin of the #3576 bare cite. `@gsd-core/references/<x>.md` is
// repo-relative to the SOURCE tree: the installer's agent path rewrite
// (`applyAgentPathRewritesInner`) is anchored on `~/.claude` / `$HOME/.claude`
// and never touches it, so after install it addresses
// `<project>/gsd-core/references/<x>.md` — a directory no consuming project has —
// while the file it means sits at `~/.claude/gsd-core/references/<x>.md`, where
// the corpus's other 137 pointers already point. Eleven of these accumulated
// across four agents over three months because `check-contract-drift.cjs`'s
// reference-follower was equally blind to the spelling.
//
// Scope is agents/ ONLY, and the remainder is TWO trees rather than one: gsd-core/workflows
// carries the same spelling widely, and gsd-core/references carries it once —
// nyquist-compliance.md's pointer at failing-direction.md, the lone bare form among that
// directory's installed-path siblings. This gate takes no position on either, because
// whether an @-path OUTSIDE an agent body is client-resolved at all is unmeasured (#4841
// § Evidence 5): refusing the spelling there would assert a resolution semantics this
// issue never established. Naming both is what keeps the recorded remainder complete —
// a scope note that names only the workflow tree reads as an exhaustive one.

// A reference name is one or more path segments, each starting with a non-dot character, so
// a `.` or `..` segment is never a name and no include can resolve outside gsd-core/references/.
const BARE_INCLUDE_RE = /@gsd-core\/references\/((?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.md)/g;
const INSTALLED_INCLUDE_RE = /@~\/\.claude\/gsd-core\/references\/((?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.md)/g;

/** Bare `@gsd-core/references/<name>` includes — the form no installer rewrite reaches. */
function findBareIncludes(text) {
  const found = [];
  let m;
  while ((m = BARE_INCLUDE_RE.exec(text)) !== null) found.push(m[0]);
  return found;
}

/** Installed-path `@~/.claude/gsd-core/references/<name>` includes — target names. */
function findInstalledIncludes(text) {
  const found = [];
  let m;
  while ((m = INSTALLED_INCLUDE_RE.exec(text)) !== null) found.push(m[1]);
  return found;
}

function walkAgentMarkdown() {
  return walkShippedMarkdown().filter(({ rel }) => rel.startsWith('agents/'));
}

describe('#4841 gate: agent @-includes use the installed-path form', () => {
  test('#4841 gate: no bare @gsd-core/references/ includes in agents/', () => {
    const offenders = [];
    for (const { rel, abs } of walkAgentMarkdown()) {
      // allow-test-rule: source-text-is-the-product (#3576) — shipped text is the runtime contract
      const text = fs.readFileSync(abs, 'utf-8');
      for (const inc of findBareIncludes(text)) {
        offenders.push(
          `${rel}: ${inc} — no installer rewrite reaches this spelling on any profile; `
            + `use @~/.claude/${inc.slice(1)}`,
        );
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'Bare `@gsd-core/references/<name>.md` includes address a path no consuming project has (#4841). '
        + 'Rewrite to the installed-path `@~/.claude/gsd-core/references/<name>.md` form:\n'
        + offenders.join('\n'),
    );
  });

  test('#4841 gate: every installed-path @-include in agents/ names a reference that exists', () => {
    const missing = [];
    for (const { rel, abs } of walkAgentMarkdown()) {
      // allow-test-rule: source-text-is-the-product (#3576) — shipped text is the runtime contract
      const text = fs.readFileSync(abs, 'utf-8');
      for (const name of findInstalledIncludes(text)) {
        if (!fs.existsSync(path.join(REPO_ROOT, 'gsd-core', 'references', name))) {
          missing.push(`${rel}: @~/.claude/gsd-core/references/${name} — target does not exist`);
        }
      }
    }
    assert.deepEqual(missing, [], 'Installed-path includes must name files that exist:\n' + missing.join('\n'));
  });

  test('#4841 gate: the agents/ scan is not vacuous — it reaches the four agents the defect lived in', () => {
    const rels = new Set(walkAgentMarkdown().map(({ rel }) => rel));
    for (const agent of ['gsd-debugger', 'gsd-planner', 'gsd-plan-checker', 'gsd-verifier']) {
      assert.ok(rels.has(`agents/${agent}.md`), `agents/${agent}.md must be in the scanned set`);
    }
  });

  test('#4841 gate unit: the matcher flags the bare form only', () => {
    assert.deepEqual(
      findBareIncludes('recipes: @gsd-core/references/verifier-wiring-patterns.md'),
      ['@gsd-core/references/verifier-wiring-patterns.md'],
      'the bare include is flagged',
    );
    assert.deepEqual(
      findBareIncludes('recipes: @~/.claude/gsd-core/references/verifier-wiring-patterns.md'),
      [],
      'the installed-path include is not flagged (the slash before gsd-core is not an @)',
    );
    assert.deepEqual(findBareIncludes('see `gsd-core/references/tdd.md`'), [], 'a backticked cite is not an @-include');
    assert.deepEqual(
      findBareIncludes('@gsd-core/references/a.md then @gsd-core/references/b.md.'),
      ['@gsd-core/references/a.md', '@gsd-core/references/b.md'],
      'every occurrence on a line is reported, and a trailing period is not part of the name',
    );
    assert.deepEqual(findInstalledIncludes('x @~/.claude/gsd-core/references/tdd.md y'), ['tdd.md']);
    assert.deepEqual(
      findBareIncludes('@gsd-core/references/few-shot-examples/verifier.md'),
      ['@gsd-core/references/few-shot-examples/verifier.md'],
      'a nested bare include is flagged too (the corpus carries nested installed-path includes)',
    );
    assert.deepEqual(
      findInstalledIncludes('@~/.claude/gsd-core/references/few-shot-examples/verifier.md'),
      ['few-shot-examples/verifier.md'],
      'a nested installed-path include is existence-checked by its nested name',
    );
    assert.deepEqual(
      findInstalledIncludes('@~/.claude/gsd-core/references/../../README.md'),
      [],
      'a traversal segment is not a reference name — it must never resolve outside gsd-core/references/',
    );
    assert.deepEqual(findBareIncludes('@gsd-core/references/./x.md'), [], 'a dot segment is not a reference name');
  });
});
