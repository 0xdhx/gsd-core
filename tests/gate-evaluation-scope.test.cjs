'use strict';

/**
 * Evaluation-scope resolver (#5164, epic #5056, ADR-5057 §4 second bullet).
 *
 * Behavioral tests against real git fixtures: the scope is the UNION of the unit's own commits'
 * file sets (never a range), only branch-reachable commits count, an empty union degrades loudly,
 * and everything the union drops is named by path. Git failure is injected through the resolver's
 * `execGit` seam (never a mode-bit trick).
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');

const { cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const {
  resolveEvaluationScope,
  evaluateEvaluationScope,
  extractTaskCommitRefs,
  planSubjectPattern,
  isSafeRefArgument,
  SCOPE_EXCLUSION_PATHSPECS,
} = require('../gsd-core/bin/lib/gate-evaluation-scope.cjs');

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.io',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.io',
};
const PHASE_DIR = '.planning/phases/03-scope';

const dirs = [];
afterEach(() => { while (dirs.length > 0) cleanup(dirs.pop()); });

function write(dir, rel, content) {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-scope-'));
  dirs.push(dir);
  const git = (...args) => gitOrThrow(args, { cwd: dir, env: { ...process.env, ...IDENTITY } }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@test.io');
  git('config', 'user.name', 'Test');
  write(dir, '.planning/config.json', '{}');
  write(dir, `${PHASE_DIR}/03-CONTEXT.md`, 'context\n');
  git('add', '.');
  git('commit', '-m', 'docs(03): scaffold phase');
  return { dir, git };
}

/** Commit one real file; returns the full sha. */
function commit(repo, rel, message, content = `${rel}\n`) {
  write(repo.dir, rel, content);
  repo.git('add', rel);
  repo.git('commit', '-m', message);
  return repo.git('rev-parse', 'HEAD');
}

/** Write a SUMMARY whose `## Task Commits` rows name `shas`, and commit it. */
function summarize(repo, shas, name = '03-01-SUMMARY.md') {
  const rows = shas.map((sha, i) => `${i + 1}. **Task ${i + 1}: work** - \`${sha}\``).join('\n');
  commit(repo, `${PHASE_DIR}/${name}`, 'docs(03-01): summary', `# Summary\n\n## Task Commits\n\n${rows}\n\n## Next\n`);
}

describe('resolveEvaluationScope — phase unit', () => {
  test('[happy] scope is the union of the task commits\' own file sets', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    const b = commit(repo, 'src/b.js', 'feat(03-01): b');
    summarize(repo, [a, b]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.equal(scope.status, 'resolved');
    assert.equal(scope.source, 'task-commits');
    assert.equal(scope.reason, null);
    assert.deepEqual(scope.files, ['src/a.js', 'src/b.js']);
    assert.deepEqual(scope.commits.map((c) => c.sha), [a, b]);
    assert.deepEqual(scope.commits[0].files, ['src/a.js']);
    assert.deepEqual(scope.unreachable, []);
  });

  test('[regression #3926] interleaved non-phase commits stay out of scope and are named', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    commit(repo, 'other/quick-task.js', 'fix(quick): unrelated work');
    const b = commit(repo, 'src/b.js', 'feat(03-01): b');
    summarize(repo, [a, b]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.deepEqual(scope.files, ['src/a.js', 'src/b.js']);
    assert.deepEqual(scope.outsideUnion, ['other/quick-task.js']);
  });

  test('[regression #3926] post-phase work landed after the last task commit is not in scope', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    summarize(repo, [a]);
    commit(repo, 'src/later-phase.js', 'feat(04-01): next phase');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.deepEqual(scope.files, ['src/a.js']);
  });

  test('[hostile] a task commit that lives only on another branch is named and excluded', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    repo.git('checkout', '-b', 'side');
    const side = commit(repo, 'src/side.js', 'feat(03-01): side only');
    repo.git('checkout', 'main');
    summarize(repo, [a, side]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.deepEqual(scope.files, ['src/a.js']);
    assert.deepEqual(scope.unreachable, [side]);
  });

  test('[negative] no SUMMARY degrades to the phase range and says why', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.equal(scope.status, 'degraded');
    assert.equal(scope.reason, 'no-summary');
    assert.equal(scope.source, 'phase-range');
    assert.deepEqual(scope.files, ['src/a.js']);
    assert.notEqual(scope.rangeBase, null);
  });

  test('[negative] a SUMMARY with no task rows degrades', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    commit(repo, `${PHASE_DIR}/03-01-SUMMARY.md`, 'docs(03-01): summary', '# Summary\n\n## Task Commits\n\nnone\n\n## Next\n');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.equal(scope.status, 'degraded');
    assert.equal(scope.reason, 'no-task-commit-rows');
    assert.deepEqual(scope.files, ['src/a.js']);
  });

  test('[negative] ids no object answers to degrade, named, never an empty resolved scope', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    const ghost = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    summarize(repo, [ghost]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.equal(scope.status, 'degraded');
    assert.equal(scope.reason, 'no-reachable-task-commits');
    assert.deepEqual(scope.unreachable, [ghost]);
    assert.deepEqual(scope.files, ['src/a.js']);
  });

  test('[negative] a planning-only phase never becomes an empty scope that reviews nothing', () => {
    const repo = makeRepo();
    const planning = commit(repo, `${PHASE_DIR}/03-01-NOTES.md`, 'docs(03-01): notes');
    summarize(repo, [planning]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.equal(scope.status, 'degraded');
    assert.equal(scope.reason, 'empty-after-exclusions');
    assert.equal(scope.source, 'phase-range');
  });

  test('[negative] a phase directory git never saw has no anchor: unresolvable, not empty', () => {
    const repo = makeRepo();
    write(repo.dir, '.planning/phases/04-fresh/04-CONTEXT.md', 'untracked\n');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '4' });
    assert.equal(scope.status, 'unresolvable');
    assert.match(scope.reason, /no-phase-start-anchor$/);
    assert.deepEqual(scope.files, []);
  });

  test('[negative] an unknown phase is unresolvable', () => {
    const repo = makeRepo();
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '9' });
    assert.equal(scope.status, 'unresolvable');
    assert.equal(scope.reason, 'phase-dir-not-found');
  });

  test('[negative] scoped paths deleted later are named, not silently counted', () => {
    const repo = makeRepo();
    const keep = commit(repo, 'src/keep.js', 'feat(03-01): keep');
    const gone = commit(repo, 'src/gone.js', 'feat(03-01): gone');
    repo.git('rm', 'src/gone.js');
    repo.git('commit', '-m', 'chore: later removal');
    summarize(repo, [keep, gone]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.deepEqual(scope.changedFiles, ['src/gone.js', 'src/keep.js']);
    assert.deepEqual(scope.files, ['src/keep.js']);
    assert.deepEqual(scope.missingOnDisk, ['src/gone.js']);
  });

  test('[boundary] a merge commit contributes its diff against the first parent', () => {
    const repo = makeRepo();
    repo.git('checkout', '-b', 'side');
    commit(repo, 'src/merged.js', 'feat(03-01): on side');
    repo.git('checkout', 'main');
    commit(repo, 'src/main-only.js', 'feat(03-01): on main');
    repo.git('merge', '--no-ff', 'side', '-m', 'feat(03-01): merge side');
    const merge = repo.git('rev-parse', 'HEAD');
    summarize(repo, [merge]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.deepEqual(scope.files, ['src/merged.js']);
  });

  test('[boundary] `since` drops that commit and its ancestors (wave scoping)', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    const b = commit(repo, 'src/b.js', 'feat(03-01): b');
    summarize(repo, [a, b]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' }, { since: a });
    assert.deepEqual(scope.files, ['src/b.js']);
    assert.equal(scope.rangeBase, a);
  });

  test('[independence] exclusions never reach the scope', () => {
    const repo = makeRepo();
    write(repo.dir, 'package-lock.json', '{}\n');
    repo.git('add', 'package-lock.json');
    write(repo.dir, 'src/a.js', 'a\n');
    repo.git('add', 'src/a.js');
    repo.git('commit', '-m', 'feat(03-01): a and lockfile');
    summarize(repo, [repo.git('rev-parse', 'HEAD')]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.deepEqual(scope.files, ['src/a.js']);
    assert.ok(SCOPE_EXCLUSION_PATHSPECS.includes(':!package-lock.json'));
  });
});

describe('extractTaskCommitRefs', () => {
  test('[hostile] a sha in prose, on the metadata line or outside the section is not a task commit', () => {
    const doc = [
      '`1111111` quoted before the section',
      '## Task Commits',
      '',
      'Prose quoting `2222222` is not a row.',
      '**Plan metadata:** `3333333`',
      '1. **Task 1: real** - `4444444`',
      '- **Task 2: two commits** - `5555555` `6666666`',
      '## Next',
      '1. **Task 3: after the section** - `7777777`',
    ].join('\n');
    assert.deepEqual(extractTaskCommitRefs(doc), ['4444444', '5555555', '6666666']);
  });

  test('[property] only hex tokens on task rows inside the section contribute', () => {
    const hex = fc.stringMatching(/^[0-9a-f]{7,40}$/);
    const line = fc.oneof(
      fc.record({ kind: fc.constant('row'), hashes: fc.array(hex, { minLength: 1, maxLength: 3 }) }),
      fc.record({ kind: fc.constant('prose'), hashes: fc.array(hex, { minLength: 1, maxLength: 2 }) }),
      fc.record({ kind: fc.constant('meta'), hashes: fc.array(hex, { minLength: 1, maxLength: 1 }) }),
    );
    fc.assert(fc.property(fc.array(line, { maxLength: 12 }), fc.array(hex, { maxLength: 3 }), (lines, outside) => {
      const body = lines.map((entry, i) => {
        const ticks = entry.hashes.map((h) => `\`${h}\``).join(' ');
        if (entry.kind === 'row') return `${i + 1}. **Task ${i + 1}: t** - ${ticks}`;
        if (entry.kind === 'prose') return `see ${ticks}`;
        return `**Plan metadata:** ${ticks}`;
      });
      const before = outside.map((h, i) => `${i + 1}. **Task ${i + 1}: before** - \`${h}\``);
      const doc = [...before, '## Task Commits', ...body, '## End'].join('\n');
      const expected = lines.filter((e) => e.kind === 'row').flatMap((e) => e.hashes);
      assert.deepEqual(extractTaskCommitRefs(doc), expected);
    }), { seed: 5164, numRuns: 100 });
  });

  test('[property positive control] a document with only prose shas yields none', () => {
    assert.deepEqual(extractTaskCommitRefs('## Task Commits\nsee `abcdef1`\n## End\n'), []);
  });
});

describe('resolveEvaluationScope — plan and quick units', () => {
  test('[happy] subjects match anchored, tolerant of zero padding, `!` and any type', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    commit(repo, 'tests/a.test.js', 'test(3-1): red');
    commit(repo, 'src/c.js', 'fix(03-01)!: breaking');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' });
    assert.equal(scope.status, 'resolved');
    assert.equal(scope.source, 'plan-subjects');
    assert.deepEqual(scope.commits.map((c) => c.subject).sort(), ['feat(03-01): a', 'fix(03-01)!: breaking', 'test(3-1): red']);
  });

  test('[boundary] the id boundary: 03-010 and 03-02 and a body line do not match 03-01', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    commit(repo, 'src/b.js', 'feat(03-010): not this plan');
    commit(repo, 'src/c.js', 'feat(03-02): not this plan');
    commit(repo, 'src/d.js', 'chore: body mention\n\nfeat(03-01): quoted in a body line');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' });
    assert.deepEqual(scope.commits.map((c) => c.subject), ['feat(03-01): a']);
  });

  test('[hostile] ERE metacharacters in a plan id cannot widen the pattern', () => {
    assert.equal(planSubjectPattern('.*-PLAN'), null);
    assert.equal(planSubjectPattern('03'), null);
    const dotted = new RegExp(planSubjectPattern('3.1-2'));
    assert.ok(dotted.test('feat(3.1-2): x'));
    assert.ok(!dotted.test('feat(3x1-2): x'));
    const repo = makeRepo();
    const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '.*-1' });
    assert.equal(scope.status, 'unresolvable');
    assert.equal(scope.reason, 'invalid-plan-id');
  });

  test('[regression] a plan commit that lives only on another branch is not returned', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): green');
    repo.git('checkout', '-b', 'side');
    commit(repo, 'tests/red.test.js', 'test(03-01): red on a side branch');
    repo.git('checkout', 'main');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' });
    assert.deepEqual(scope.commits.map((c) => c.subject), ['feat(03-01): green']);
  });

  test('[boundary] maxCommits at limit-1, limit and limit+1', () => {
    const repo = makeRepo();
    for (const n of ['a', 'b', 'c']) commit(repo, `src/${n}.js`, `feat(03-01): ${n}`);
    const count = (maxCommits) => resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' }, { maxCommits }).commits.length;
    assert.deepEqual([count(2), count(3), count(4)], [2, 3, 3]);
  });

  test('[happy] pathspecs restrict to commits touching them (the RED-commit lookup)', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): impl');
    commit(repo, 'tests/a.test.js', 'test(03-01): red');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' }, { pathspecs: ['tests/'] });
    assert.deepEqual(scope.commits.map((c) => c.subject), ['test(03-01): red']);
  });

  test('[boundary] milestoneBound drops commits older than the latest tag', () => {
    const repo = makeRepo();
    commit(repo, 'src/old.js', 'feat(03-01): before the tag');
    repo.git('tag', 'v1.0.0');
    commit(repo, 'src/new.js', 'feat(03-01): after the tag');
    const unbounded = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' });
    const bounded = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' }, { milestoneBound: true });
    assert.equal(unbounded.commits.length, 2);
    assert.deepEqual(bounded.commits.map((c) => c.subject), ['feat(03-01): after the tag']);
  });

  test('[happy] a quick unit is the union of the commits naming its id', () => {
    const repo = makeRepo();
    commit(repo, 'src/q1.js', 'fix(quick-260101-abc): one');
    commit(repo, 'other/n.js', 'fix: unrelated');
    commit(repo, 'src/q2.js', 'docs(quick-260101-abc): two');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'quick', id: '260101-abc' });
    assert.equal(scope.source, 'quick-subjects');
    assert.deepEqual(scope.files, ['src/q1.js', 'src/q2.js']);
  });
});

describe('resolveEvaluationScope — failure is never an empty scope', () => {
  const fail = (result) => () => result;

  test('[negative] git missing is unresolvable, with the reason', () => {
    const scope = resolveEvaluationScope('/nonexistent', { kind: 'plan', planId: '03-01' },
      { execGit: fail({ exitCode: 127, stdout: '', stderr: 'git: not found', signal: null, error: null, timedOut: false }) });
    assert.equal(scope.status, 'unresolvable');
    assert.equal(scope.reason, 'git-unavailable');
    assert.deepEqual(scope.files, []);
  });

  test('[negative] a git timeout is unresolvable, not a throw', () => {
    const scope = resolveEvaluationScope('/nonexistent', { kind: 'plan', planId: '03-01' },
      { execGit: fail({ exitCode: 1, stdout: '', stderr: '', signal: 'SIGTERM', error: null, timedOut: true }) });
    assert.equal(scope.reason, 'git-timeout');
  });

  test('[negative] a directory that is not a repository is unresolvable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-scope-nogit-'));
    dirs.push(dir);
    const scope = resolveEvaluationScope(dir, { kind: 'plan', planId: '03-01' });
    assert.equal(scope.status, 'unresolvable');
    assert.match(scope.reason, /^git-failed:/);
  });

  test('[hostile] option-shaped or whitespace refs are refused before any git call', () => {
    const calls = [];
    const spy = (args) => { calls.push(args); return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null, timedOut: false }; };
    assert.equal(resolveEvaluationScope('/x', { kind: 'plan', planId: '03-01' }, { ref: '--output=x', execGit: spy }).reason, 'unsafe-ref');
    assert.equal(resolveEvaluationScope('/x', { kind: 'plan', planId: '03-01' }, { since: 'a b', execGit: spy }).reason, 'unsafe-since');
    assert.deepEqual(calls, []);
    assert.ok(!isSafeRefArgument('-x'));
    assert.ok(isSafeRefArgument('HEAD~2'));
  });
});

describe('evaluateEvaluationScope — the check verb', () => {
  test('[negative] argv validation returns a usage failure naming the problem', () => {
    const messageOf = (args) => evaluateEvaluationScope({ projectDir: '/x', args }).failure.message;
    assert.match(messageOf([]), /exactly one of --phase/);
    assert.match(messageOf(['--phase', '3', '--plan', '03-01']), /exactly one of --phase/);
    assert.match(messageOf(['--bogus']), /unknown argument: --bogus/);
    assert.match(messageOf(['--phase']), /--phase requires a value/);
  });

  test('[happy] a verdict carries the scope payload in a pinned key order; outcome follows status', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    summarize(repo, [a]);
    const resolved = evaluateEvaluationScope({ projectDir: repo.dir, args: ['--phase', '3'] });
    assert.deepEqual(Object.keys(resolved.payload), [
      'unit', 'status', 'source', 'reason', 'commits', 'changedFiles', 'files',
      'missingOnDisk', 'outsideUnion', 'unreachable', 'rangeBase',
    ]);
    assert.equal(resolved.outcome, 'pass');
    assert.equal(resolved.block, false);
    assert.equal(evaluateEvaluationScope({ projectDir: repo.dir, args: ['--phase', '9'] }).outcome, 'skip');
    const bare = makeRepo();
    commit(bare, 'src/z.js', 'feat(03-01): z');
    assert.equal(evaluateEvaluationScope({ projectDir: bare.dir, args: ['--phase', '3'] }).outcome, 'advisory');
  });
});
