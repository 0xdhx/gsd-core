/**
 * Check subcommand router — auto-mode, decision-coverage-plan, decision-coverage-verify.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/check-command-router.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
const { output, ERROR_REASON } = io;
// Explicitly annotated so TypeScript applies never-return control-flow narrowing.
// A destructured `const { error } = io` is a const WITHOUT a type annotation, and TS
// only narrows after a never-returning call when the callee is a function declaration
// or an annotated const. Without the annotation every `error(...)` guard below would
// need a dead `throw` after it to convince the checker that the value is non-null.
const error: typeof io.error = io.error;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceMod = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspaceMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorMod = require('./phase-locator.cjs');
const { findPhaseInternal } = phaseLocatorMod;
import { isGateUsageFailure } from './gate-verdict.cjs';
import type { GateResult, GateUsageFailure } from './gate-verdict.cjs';
import { resolveContainedPath } from './gate-phase-context.cjs';
import { partitionPredicateArgs } from './gate-args.cjs';
import { evaluateDecisionCoveragePlan } from './gate-decision-coverage-plan.cjs';
import { evaluateDecisionCoverageVerify } from './gate-decision-coverage-verify.cjs';
import { decisionMentioned, extractPlanDesignatedSections, readIfExists } from './decision-coverage-support.cjs';
import { readAutoModeState } from './check-auto-mode.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterMod = require('./frontmatter.cjs');
const { extractFrontmatter, frontmatterRegion } = frontmatterMod;
import { tryWithinRoot, tryWithinRootLexical, PathAcceptance } from './security.cjs';
import { checkUiPresence } from './ui-safety-gate.cjs';
import { hasStaticFrontendEvidence } from './ui-frontend-evidence.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import verifyModule = require('./verify.cjs');
const { cmdVerifySchemaDrift, cmdVerifyCodebaseDrift, cmdVerifyContextDrift } = verifyModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapModule = require('./roadmap.cjs');
const { getRoadmapPhaseWithFallback } = roadmapModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import gapCheckerModule = require('./gap-checker.cjs');
const { runGapAnalysis } = gapCheckerModule;
import { routeProhibitionEnforcement } from './prohibition-enforcement.cjs';
import { classifyRedEvidence, buildRedEvidenceRecord } from './tdd-red-evidence.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import gatePredicateEval = require('./gate-predicate-evaluator.cjs');
const { evaluatePredicate } = gatePredicateEval;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import apiCoverageMod = require('./api-coverage.cjs');
const { detectApiIntegration, validateCoverageMatrix } = apiCoverageMod;
import { execTool, platformReadSync, posixNormalize } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planScanMod = require('./plan-scan.cjs');
const { scanPhasePlans } = planScanMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import verifyCommandGroundingMod = require('./verify-command-grounding.cjs');
const { probePhaseVerifyCommands, probePhaseFailingDirections } = verifyCommandGroundingMod;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve a caller-supplied path against `projectDir`, failing through `error()` on an escape.
 * The containment decision is the gate-phase-context helper's; only the failure formatting is here.
 */
function resolvePath(inputPath: string, projectDir: string): string {
  const resolved = resolveContainedPath(inputPath, projectDir);
  if (isGateUsageFailure(resolved)) {
    return failGate(resolved);
  }
  return resolved;
}

type ErrorReason = (typeof ERROR_REASON)[keyof typeof ERROR_REASON];

/** A gate's usage failure as `error()`: the gate's own message, and its code when it is a known reason. */
function failGate(failed: GateUsageFailure): never {
  const reason: ErrorReason | undefined = Object.values(ERROR_REASON).find((value) => value === failed.failure.code);
  return error(failed.failure.message, reason);
}

/**
 * The router's single output site for a gate: a verdict prints its payload; a usage failure
 * fails through `error()` with the gate's own message and code (design D2).
 */
function emitGateResult(result: GateResult, raw: boolean): void {
  if (isGateUsageFailure(result)) {
    failGate(result);
  }
  output(result.payload, raw, undefined);
}

function cmdAutoMode(projectDir: string, raw: boolean): void {
  output(readAutoModeState(projectDir), raw, undefined);
}

/**
 * `check decision-coverage-plan` — blocking plan-phase decision-coverage gate
 * (#2492, #1365 fail-loud, #2770 empty-arg fail-closed).
 *
 * Invocation (the context path may be supplied EITHER way; #4130 follow-up):
 *   gsd_run check decision-coverage-plan <phase-dir> <context-path>   (positional, the workflow caller's form)
 *   gsd_run check decision-coverage-plan --context <path> [<phase-dir>]
 *
 * `--context <path>` follows the sibling flag convention (`check predicate`,
 * #2008): `--flag value` pairs parsed by the shared partitionPredicateArgs
 * pass, the flag WINNING over a same-purpose positional when both appear,
 * and a valueless `--context` counting as no context at all (it falls
 * through to the #2770 caller-error branch, not to the "CONTEXT.md missing"
 * green skip). The positional form keeps working unchanged — no sibling
 * check verb deprecates positionals and the plan-phase workflow passes them.
 */
function cmdDecisionCoveragePlan(projectDir: string, args: string[], raw: boolean): void {
  // args[0]='check', args[1]=subcommand — the gate takes the argv AFTER the verb.
  emitGateResult(evaluateDecisionCoveragePlan({ projectDir, args: args.slice(2) }), raw);
}

/**
 * `check decision-coverage-verify` — advisory verify-phase decision-coverage gate. The decision
 * lives in `gate-decision-coverage-verify.cts`; this only formats its result.
 */
function cmdDecisionCoverageVerify(projectDir: string, args: string[], raw: boolean): void {
  emitGateResult(evaluateDecisionCoverageVerify({ projectDir, args: args.slice(2) }), raw);
}

// ─── ui-plan-gate ─────────────────────────────────────────────────────────────

/**
 * ui-plan-gate: given a phase number, checks whether the phase has frontend
 * indicators and whether a *-UI-SPEC.md already exists in the phase directory.
 *
 * Returns JSON: { frontend, hasFrontendEvidence, hasUiSpec, block, uiSpecPath, matchedToken, matchedLine }
 *   block = frontend && hasFrontendEvidence && !hasUiSpec (#3312: gate fires when
 *   UI work is detected AND the repo has static frontend evidence but no spec exists)
 *
 * Invocable as: gsd_run check ui-plan-gate <phase>
 *
 * Uses checkUiPresence from ui-safety-gate.cjs — does NOT reimplement frontend detection.
 * Uses getRoadmapPhaseWithFallback + findPhaseInternal from leaf modules for phase data.
 */
function findUiSpecInDir(phaseDir: string): string {
  if (!phaseDir || !fs.existsSync(phaseDir)) return '';
  try {
    const files = fs.readdirSync(phaseDir);
    const found = files.find((f) => /-UI-SPEC\.md$/.test(f));
    return found ? path.join(phaseDir, found) : '';
  } catch {
    return '';
  }
}

/**
 * Pure logic for ui-plan-gate — exposed for direct behavioral testing.
 *
 * Given a projectDir and phase number:
 *   (a) Reads the phase section from ROADMAP.md via getRoadmapPhaseWithFallback —
 *       same two-pass lookup (current milestone → full roadmap) as `roadmap.get-phase`
 *       (cmdRoadmapGetPhase). Cross-milestone / older frontend phases resolve correctly.
 *       If ROADMAP.md is missing, phaseSection is '' (ROADMAP.md not present = project
 *       has no roadmap = cannot be frontend). If the phase truly can't be found after
 *       both passes, phaseSection is '' and phaseLookupFailed is set so callers can
 *       surface the miss — we do NOT silently degrade to frontend:false if the roadmap
 *       exists but the phase header is absent.
 *   (b) Runs checkUiPresence (frontend detection) — no reimplementation.
 *   (c) Resolves the phase directory via findPhaseInternal (phase-locator.cjs); checks for *-UI-SPEC.md.
 *
 * Returns: { frontend, hasFrontendEvidence, hasUiSpec, block, uiSpecPath, matchedToken, matchedLine, phaseLookupFailed }
 *   block = frontend && hasFrontendEvidence && !hasUiSpec   (#3312)
 *   phaseLookupFailed = ROADMAP.md present but phase header not found (surfaced for
 *                       onError:halt gates so a missing phase doesn't silently bypass)
 *
 * #3312 — structural corroboration: `frontend` is a vocabulary signal only. A
 * hyphen is a word boundary, so a phase naming the repo `dashboard-financeiro`
 * matches the token `dashboard` exactly like the real compound `micro-frontend`
 * (the boundary rule of #3718 is intentional and untouched). The gate therefore
 * blocks only when the token match is corroborated by static frontend evidence
 * in the repo tree (hasStaticFrontendEvidence: package.json UI-framework dep, a
 * component-framework file, or native UI evidence — a `.xaml` file or a
 * `.swift`/`.kt`/`.dart` file carrying its ecosystem's UI import marker,
 * #4658). This mirrors the sibling post-wave gate
 * computeUiSafetyGate, which requires `hasUiFiles` (git diff) before blocking.
 * matchedToken/matchedLine surface what tripped the sniffer so an operator can
 * judge the flag in one second instead of reaching for --skip-ui.
 */
function computeUiPlanGate(projectDir: string, phase: string): {
  frontend: boolean;
  hasFrontendEvidence: boolean;
  hasUiSpec: boolean;
  block: boolean;
  uiSpecPath: string | null;
  matchedToken: string | null;
  matchedLine: string | null;
  phaseLookupFailed?: boolean;
} {
  // (a) Read the phase section text using the same two-pass lookup as roadmap.get-phase.
  // getRoadmapPhaseWithFallback: current-milestone first, then stripShippedMilestones
  // fallback — mirrors cmdRoadmapGetPhase exactly.
  let phaseSection = '';
  let phaseLookupFailed: boolean | undefined;
  try {
    const section = getRoadmapPhaseWithFallback(projectDir, phase);
    if (section === null) {
      // Distinguish: ROADMAP.md missing (no-roadmap project) vs phase not found in ROADMAP.
      // planningDir(cwd) resolves the .planning/ root for workstream-aware paths.
      const planDir: string = planningDir(projectDir);
      const roadmapPath = path.join(planDir, 'ROADMAP.md');
      if (fs.existsSync(roadmapPath)) {
        // ROADMAP.md exists but phase was not found → surface the miss
        phaseLookupFailed = true;
      }
      // phaseSection stays ''
    } else {
      phaseSection = section;
    }
  } catch { /* roadmap read failure → treat as empty (non-frontend) */ }

  // (b) Run checkUiPresence (frontend detection) — reuse existing helper; no reimplementation
  const presenceResult = checkUiPresence(phaseSection);
  const frontend = presenceResult.hasUI;

  // (b') #3312 — static structural corroboration. Only probed when the sniffer
  // matched (evidence is irrelevant otherwise); failures degrade to false.
  const hasFrontendEvidence = frontend ? hasStaticFrontendEvidence(projectDir) : false;

  // (c) Resolve phase directory via findPhaseInternal and check for *-UI-SPEC.md
  let phaseDir = '';
  try {
    const result = findPhaseInternal(projectDir, phase);
    if (result && typeof result === 'object') {
      // findPhaseInternal returns { directory: '<relative-posix-path>', ... }
      // directory is relative to cwd — resolve it to absolute.
      const relDir = typeof result['directory'] === 'string' ? result['directory'] : '';
      if (relDir) {
        phaseDir = path.resolve(projectDir, relDir);
      }
    } else if (typeof result === 'string') {
      phaseDir = result;
    }
  } catch { /* phase dir lookup failure → hasUiSpec=false */ }

  const uiSpecPath = findUiSpecInDir(phaseDir);
  const hasUiSpec = uiSpecPath !== '';

  // block = frontend phase with structural frontend evidence and no UI-SPEC (#3312)
  const block = frontend && hasFrontendEvidence && !hasUiSpec;

  const result: {
    frontend: boolean;
    hasFrontendEvidence: boolean;
    hasUiSpec: boolean;
    block: boolean;
    uiSpecPath: string | null;
    matchedToken: string | null;
    matchedLine: string | null;
    phaseLookupFailed?: boolean;
  } = {
    frontend, hasFrontendEvidence, hasUiSpec, block,
    uiSpecPath: hasUiSpec ? uiSpecPath : null,
    matchedToken: presenceResult.matchedToken,
    matchedLine: presenceResult.matchedLine,
  };
  if (phaseLookupFailed) result.phaseLookupFailed = true;
  return result;
}

function cmdUiPlanGate(projectDir: string, args: string[], raw: boolean): void {
  // args[0] = 'check', args[1] = 'ui-plan-gate', args[2] = phase
  const phase = args[2] || '';
  if (!phase) {
    error('ui-plan-gate requires a phase argument: check ui-plan-gate <phase>', ERROR_REASON.SDK_MISSING_ARG);
    return;
  }
  output(computeUiPlanGate(projectDir, phase), raw, undefined);
}

// ─── ui-safety-gate ───────────────────────────────────────────────────────────

/**
 * ui-safety-gate: post-wave check that verifies UI-changed files conform to
 * the active UI-SPEC for the phase. Called after each wave by execute:wave:post.
 *
 * Returns JSON: { frontend: boolean, hasUiFiles: boolean, hasUiSpec: boolean, block: boolean, message?: string }
 *   block = frontend && hasUiFiles && !hasUiSpec
 *
 * Args: check ui-safety-gate <phase>
 * Invocable as: gsd_run check ui-safety-gate <phase>
 *             or gsd_run check ui.safety-gate <phase> (dots normalized to hyphens)
 *
 * Uses checkUiPresence from ui-safety-gate.cjs — does NOT reimplement frontend detection.
 * Checks whether any files changed in recent git history match frontend file patterns.
 * Also checks whether a *-UI-SPEC.md exists in the phase directory (same as ui-plan-gate).
 *
 * Limitation: uses git diff HEAD~1..HEAD which covers only the last commit; in a
 * multi-plan wave the wave-start commit would be more accurate but is not yet stored
 * in the wave manifest. This is tracked as a known limitation.
 */
const UI_FILE_EXTENSIONS_RE = /\.(tsx|jsx|css|scss|sass|less|vue|svelte|html)$/i;
const UI_PATH_PATTERNS_RE = /\/(components|pages|views|screens|layouts|ui|frontend)\//i;

/**
 * Pure logic for ui-safety-gate — exposed for direct behavioral testing.
 *
 * Given a projectDir and phase number:
 *   (a) Reads the phase section from ROADMAP.md via getRoadmapPhaseWithFallback —
 *       same lookup as computeUiPlanGate — to determine if this is a frontend phase.
 *   (b) Runs checkUiPresence (frontend detection) — no reimplementation.
 *   (c) Checks git diff HEAD~1..HEAD for UI file changes in the current worktree.
 *   (d) Resolves the phase directory via findPhaseInternal (phase-locator.cjs); checks for *-UI-SPEC.md.
 *
 * Returns: { frontend, hasUiFiles, hasUiSpec, block, message?, phaseLookupFailed? }
 *   block = frontend && hasUiFiles && !hasUiSpec
 *   phaseLookupFailed = ROADMAP.md present but phase header not found
 */
function computeUiSafetyGate(projectDir: string, phase: string): {
  frontend: boolean;
  hasUiFiles: boolean;
  hasUiSpec: boolean;
  block: boolean;
  message?: string;
  phaseLookupFailed?: boolean;
} {
  // (a) Read the phase section text (same two-pass lookup as computeUiPlanGate)
  let phaseSection = '';
  let phaseLookupFailed: boolean | undefined;
  try {
    const section = getRoadmapPhaseWithFallback(projectDir, phase);
    if (section === null) {
      const planDir: string = planningDir(projectDir);
      const roadmapPath = path.join(planDir, 'ROADMAP.md');
      if (fs.existsSync(roadmapPath)) {
        phaseLookupFailed = true;
      }
    } else {
      phaseSection = section;
    }
  } catch { /* roadmap read failure → treat as empty (non-frontend) */ }

  // (b) Run checkUiPresence (frontend detection) — reuse existing helper; no reimplementation
  const presenceResult = checkUiPresence(phaseSection);
  const frontend = presenceResult.hasUI;

  // (c) Check whether any UI files were changed in recent git commits
  // Uses git diff HEAD~1..HEAD to detect frontend file changes since last commit.
  // Known limitation: multi-plan waves may need the wave-start commit for full coverage.
  let hasUiFiles = false;
  try {
    const changed = execFileSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], {
      cwd: projectDir,
      encoding: 'utf-8',
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      timeout: 10_000,
    });
    hasUiFiles = changed.split('\n').some((f) =>
      f.trim() && (UI_FILE_EXTENSIONS_RE.test(f) || UI_PATH_PATTERNS_RE.test(f)),
    );
  } catch { /* git unavailable or no prior commit — treat as no UI files changed */ }

  // (d) Resolve phase directory and check for *-UI-SPEC.md (same as computeUiPlanGate)
  let phaseDir = '';
  try {
    const result = findPhaseInternal(projectDir, phase);
    if (result && typeof result === 'object') {
      const relDir = typeof result['directory'] === 'string' ? result['directory'] : '';
      if (relDir) {
        phaseDir = path.resolve(projectDir, relDir);
      }
    } else if (typeof result === 'string') {
      phaseDir = result;
    }
  } catch { /* phase dir lookup failure → hasUiSpec=false */ }

  const uiSpecPath = findUiSpecInDir(phaseDir);
  const hasUiSpec = uiSpecPath !== '';

  // block only when: this is a frontend phase AND UI files were changed AND no UI-SPEC exists
  const block = frontend && hasUiFiles && !hasUiSpec;

  const result: {
    frontend: boolean;
    hasUiFiles: boolean;
    hasUiSpec: boolean;
    block: boolean;
    message?: string;
    phaseLookupFailed?: boolean;
  } = { frontend, hasUiFiles, hasUiSpec, block };

  if (block) {
    result.message = `UI files changed in this wave but no UI-SPEC.md exists for Phase ${phase}. ` +
      `Run /gsd:ui-phase ${phase} to generate the design contract before continuing.`;
  }
  if (phaseLookupFailed) result.phaseLookupFailed = true;
  return result;
}

function cmdUiSafetyGate(projectDir: string, args: string[], raw: boolean): void {
  // args[0] = 'check', args[1] = 'ui-safety-gate', args[2] = phase
  const phase = args[2] || '';
  if (!phase) {
    error('ui-safety-gate requires a phase argument: check ui-safety-gate <phase>', ERROR_REASON.SDK_MISSING_ARG);
    return;
  }
  output(computeUiSafetyGate(projectDir, phase), raw, undefined);
}

// ─── tdd-review-checkpoint ────────────────────────────────────────────────────

/**
 * tdd-review-checkpoint: end-of-phase advisory check that scans type:tdd plans
 * for RED/GREEN/REFACTOR gate-sequence compliance and surfaces a review table.
 *
 * Logic from gsd-core/references/tdd.md <end_of_phase_review> and
 * execute-phase.md <step name="tdd_review_checkpoint"> (now removed).
 *
 * Returns JSON:
 *   { passed: true, tddPlans: N, violations: N, table: string, rows: PlanRow[] }
 * where passed is always true (advisory gate — never blocks).
 *
 * Args: check tdd.review-checkpoint <phase>
 *   Phase can be a number or phase-dir path; if not resolvable the check
 *   returns passed:true with tddPlans:0 (no plans to review).
 */
interface TddPlanRow {
  planId: string;
  red: boolean;
  green: boolean;
  refactor: boolean;
  status: 'Pass' | 'FAIL';
  missing: string[];
}

function cmdTddReviewCheckpoint(projectDir: string, args: string[], raw: boolean): void {
  // args[0] = 'check', args[1] = 'tdd-review-checkpoint' (normalized), args[2] = phase
  const phase = args[2] || '';
  if (!phase) {
    error('tdd.review-checkpoint requires a phase argument: check tdd.review-checkpoint <phase>', ERROR_REASON.SDK_MISSING_ARG);
    return;
  }

  // Resolve phase directory
  let phaseDir = '';
  try {
    const result = findPhaseInternal(projectDir, phase);
    if (result && typeof result === 'object') {
      const relDir = typeof result['directory'] === 'string' ? result['directory'] : '';
      if (relDir) phaseDir = path.resolve(projectDir, relDir);
    } else if (typeof result === 'string') {
      phaseDir = result;
    }
  } catch { /* phase dir lookup failure */ }

  // Find all PLAN.md files with type: tdd in frontmatter
  const tddPlanFiles: string[] = [];
  if (phaseDir) {
    try {
      // #3183: canonical plan set (root+nested, superseded-excluded) from the
      // single owner, rather than a root-only hand-rolled readdirSync filter.
      const files = scanPhasePlans(phaseDir).planFiles;
      for (const file of files) {
        const planPath = path.join(phaseDir, file);
        const content = readIfExists(planPath);
        // Check frontmatter for type: tdd. The block is the one the one fence owner
        // finds (`frontmatterRegion`), CRLF included (#2449: a PLAN.md written with
        // Windows line endings must still match).
        const found = frontmatterRegion(content);
        if (found?.terminated && /^type:\s*tdd\s*$/m.test(found.region)) {
          tddPlanFiles.push(planPath);
        }
      }
    } catch { /* directory read failure */ }
  }

  if (tddPlanFiles.length === 0) {
    const result = {
      // Uniform gate contract: block = violations > 0 (advisory; never truly blocks).
      block: false,
      passed: true,
      tddPlans: 0,
      violations: 0,
      table: '',
      rows: [] as TddPlanRow[],
      message: `No type:tdd plans found in phase ${phase}. TDD review skipped.`,
    };
    // Pass undefined as rawValue so --raw emits JSON (not plain text).
    // The human-readable report is carried in `result.message` for the
    // dispatch's advisory branch to surface.
    output(result, raw, undefined);
    return;
  }

  // For each TDD plan, extract the plan ID (padded plan number) and check git log
  const rows: TddPlanRow[] = [];
  for (const planPath of tddPlanFiles) {
    // Extract plan ID from filename (e.g. "01-02-PLAN.md" → "01-02", or "03-PLAN.md" → "03")
    const basename = path.basename(planPath, '-PLAN.md');
    // planId for commit grep: phase-plan format, e.g. "01-02"
    const planId = basename;

    // Check for RED gate commit: test({planId}):
    let red = false;
    let green = false;
    let refactor = false;
    try {
      const redCommit = execFileSync(
        'git', ['log', '--oneline', `--grep=^test(${planId}):`, '--', '.'],
        { cwd: projectDir, encoding: 'utf-8', maxBuffer: 1024 * 1024, windowsHide: true, timeout: 10_000 },
      );
      red = redCommit.trim().length > 0;
    } catch { /* git unavailable or no match */ }

    try {
      const greenCommit = execFileSync(
        'git', ['log', '--oneline', `--grep=^feat(${planId}):`, '--', '.'],
        { cwd: projectDir, encoding: 'utf-8', maxBuffer: 1024 * 1024, windowsHide: true, timeout: 10_000 },
      );
      green = greenCommit.trim().length > 0;
    } catch { /* git unavailable or no match */ }

    try {
      const refactorCommit = execFileSync(
        'git', ['log', '--oneline', `--grep=^refactor(${planId}):`, '--', '.'],
        { cwd: projectDir, encoding: 'utf-8', maxBuffer: 1024 * 1024, windowsHide: true, timeout: 10_000 },
      );
      refactor = refactorCommit.trim().length > 0;
    } catch { /* git unavailable or no match */ }

    const missing: string[] = [];
    if (!red) missing.push('RED');
    if (!green) missing.push('GREEN');
    const status: 'Pass' | 'FAIL' = missing.length === 0 ? 'Pass' : 'FAIL';

    rows.push({ planId, red, green, refactor, status, missing });
  }

  const violations = rows.filter(r => r.status === 'FAIL').length;

  // Build review table
  const tableHeader = '| Plan | RED | GREEN | REFACTOR | Status |';
  const tableDivider = '|------|-----|-------|----------|--------|';
  const tableRows = rows.map(r =>
    `| ${r.planId.padEnd(4)} | ${r.red ? ' ✓ ' : ' ✗ '} | ${r.green ? '  ✓  ' : '  ✗  '} | ${r.refactor ? '   ✓    ' : '   —    '} | ${r.status.padEnd(6)} |`,
  );

  let table = [
    `### TDD REVIEW — Phase ${phase}`,
    '',
    `TDD Plans: ${tddPlanFiles.length} | Gate violations: ${violations}`,
    '',
    tableHeader,
    tableDivider,
    ...tableRows,
  ].join('\n');

  if (violations > 0) {
    table += '\n\n⚠ Gate violations are advisory — review before advancing.';
    for (const r of rows.filter(row => row.status === 'FAIL')) {
      table += `\n  Plan ${r.planId} missing: ${r.missing.join(', ')} gate commit(s).`;
      table += `\n  Expected commit pattern: test(${r.planId}): ... → feat(${r.planId}): ...`;
    }
  }

  const result = {
    // Uniform gate contract: block = violations > 0.
    // This gate is advisory (blocking: false in capability.json) so block:true
    // only surfaces as a warning, never halts. Kept here so the host-loop
    // dispatch can read a single consistent `block` field.
    block: violations > 0,
    passed: true,
    tddPlans: tddPlanFiles.length,
    violations,
    table,
    rows,
    // Human-readable report in `message` so the dispatch's advisory branch
    // can surface it. --raw emits JSON (rawValue=undefined), not plain text.
    message: table,
  };
  // Pass undefined as rawValue so --raw emits JSON (not the raw table text).
  // The review table is carried in `result.message` and `result.table` so
  // the host-loop dispatch's advisory branch can surface it.
  output(result, raw, undefined);
}

// ─── tdd-red-evidence (#3770) ──────────────────────────────────────────────────

/**
 * tdd-red-evidence: validates a persisted RED-phase test-run record for a
 * `type: tdd` plan (#3770). Only an INTENTIONAL failure of the target test
 * (verdict RED_EVIDENCE_OK) may authorize GREEN; zero-test discovery, fixture/
 * load crashes, nonzero exits without a failing test, unrelated failures, and
 * unexpected greens are INVALID_RED and block GREEN.
 *
 * The record is the JSON the executor persists after running the RED command:
 *   { command, exitCode, output, targetTest, targetFile?, expected?, actual? }
 * Fail-closed: a missing/unreadable/unparseable record is INVALID_RED
 * (reason unreadable_record), never a pass.
 *
 * Args: check tdd-red-evidence <record.json>
 */
function cmdTddRedEvidence(_projectDir: string, args: string[], raw: boolean): void {
  const recordPath = typeof args[2] === 'string' ? args[2] : '';
  if (!recordPath) {
    error('tdd-red-evidence requires a record path: check tdd-red-evidence <record.json>', ERROR_REASON.SDK_MISSING_ARG);
    return;
  }
  const resolved = path.resolve(recordPath);
  const text = readIfExists(resolved);
  const input = ((): Record<string, unknown> | null => {
    if (!text) return null;
    try {
      return (JSON.parse(text) ?? {}) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  if (!input) {
    output(
      {
        passed: false,
        block: true,
        verdict: 'INVALID_RED',
        reason: 'unreadable_record',
        record: resolved,
        readError: text ? `record is not valid JSON: ${resolved}` : `record not found or unreadable: ${resolved}`,
      },
      raw,
      undefined,
    );
    return;
  }
  const evidenceInput = {
    command: input['command'],
    exitCode: input['exitCode'],
    output: input['output'],
    targetTest: input['targetTest'],
    targetFile: input['targetFile'],
    expected: input['expected'],
    actual: input['actual'],
  };
  const result = classifyRedEvidence(evidenceInput);
  const record = buildRedEvidenceRecord(evidenceInput, result);
  output(
    {
      // Uniform gate contract: block = !passed. INVALID_RED blocks GREEN.
      passed: result.verdict === 'RED_EVIDENCE_OK',
      block: result.verdict !== 'RED_EVIDENCE_OK',
      verdict: result.verdict,
      reason: result.reason,
      evidence: result.evidence,
      record,
      message:
        result.verdict === 'RED_EVIDENCE_OK'
          ? `RED evidence verified: target test "${result.evidence.target_test}" failed as expected (exit ${result.evidence.exit_code}). GREEN authorized.`
          : `INVALID_RED (${result.reason}): GREEN blocked. Fix the RED phase — only an intentional failure of target test "${result.evidence.target_test}" authorizes production edits.`,
    },
    raw,
    undefined,
  );
}

/**
 * Resolve a phase argument to an absolute phase directory, or '' when it
 * cannot be resolved. Shared by every `check` arm that probes a phase's
 * PLAN.md files, so the two never drift (DEFECT.GENERATIVE-FIX-DIVERGENCE).
 * Never throws — the callers emit a degraded JSON payload instead, because
 * a consumer must be able to tell "nothing to report" from "could not look".
 */
function resolvePhaseDirOrEmpty(projectDir: string, phase: string): string {
  try {
    const result = findPhaseInternal(projectDir, phase);
    if (result && typeof result === 'object') {
      // findPhaseInternal returns { directory: '<relative-posix-path>', ... }
      // directory is relative to cwd — resolve it to absolute.
      const relDir = typeof result['directory'] === 'string' ? result['directory'] : '';
      if (relDir) {
        return path.resolve(projectDir, relDir);
      }
    } else if (typeof result === 'string') {
      return result;
    }
  } catch { /* phase dir lookup failure → caller emits degraded payload */ }
  return '';
}

// ─── verify-command-paths (#2401) ──────────────────────────────────────────────

/**
 * verify-command-paths: probes every `<automated>` verify command declared in a
 * phase's `-PLAN.md` files against the filesystem WITHOUT executing anything —
 * see verify-command-grounding.cjs for the recognizer contract.
 *
 * Args: check verify-command-paths <phase> | check verify-command-paths --dir <plan-dir>
 * Invocable as: gsd_run check verify-command-paths <phase>
 *               gsd_run check verify-command-paths --dir <plan-dir>
 *
 * `--dir` (#4767) names a directory holding `-PLAN.md` files directly, for
 * plans that live outside `.planning/phases/` — quick mode's
 * `.planning/quick/<id>/` is the motivating caller, which until #4767 never ran
 * this probe at all. The directory is resolved against the project root AND
 * CONTAINED WITHIN IT — an absolute or climbing `--dir` that lands outside the
 * root is `unresolvable`, never read — then probed exactly as a phase directory
 * is; `projectRoot` stays the project root in both forms. `--dir <value>` is the
 * only accepted spelling: `--dir=<value>` yields no `dir` flag and falls through to
 * the no-argument arm, as does an empty value. Both are `partitionPredicateArgs`
 * behaviour, inherited and unchanged. (How that parser resolves a REPEATED `--dir`
 * is deliberately not characterised here — a malformed later occurrence does not
 * displace an earlier valid one, so the obvious "last one wins" gloss is wrong.)
 *
 * When the phase cannot be resolved to a directory, this emits a non-throwing
 * degraded JSON payload (status/commands/counts all zeroed, `readError`
 * populated) rather than calling `error()` — the plan-checker parses this
 * result and must be able to distinguish "nothing to report" from "could not
 * look", which a non-zero exit / thrown error would collapse.
 */
function cmdVerifyCommandPaths(projectDir: string, args: string[], raw: boolean): void {
  // args[0] = 'check', args[1] = 'verify-command-paths', then either a phase
  // positional or `--dir <plan-dir>` (#4767).
  const { flags, positionals } = partitionPredicateArgs(args.slice(2));
  const dirFlag = typeof flags['dir'] === 'string' ? flags['dir'] : '';
  // First non-flag positional: `--raw` (valueless) lands in positionals too, and its position
  // relative to the phase argument is the caller's choice.
  const phase = positionals.find(p => !p.startsWith('--')) ?? '';
  if (!phase && !dirFlag) {
    output(
      {
        status: 'unresolvable',
        commands: [],
        counts: { blocker: 0, warning: 0, total: 0 },
        readError: 'verify-command-paths requires a phase argument or --dir: check verify-command-paths <phase> | --dir <plan-dir>',
      },
      raw,
      undefined,
    );
    return;
  }

  // `--dir` is CALLER-SUPPLIED, so it is contained before it reaches the
  // `readdirSync`/`readFileSync` calls in probePhaseVerifyCommands (#4785 review).
  // Same predicate and policy as `resolvePath` above, and for the reason ADR-4650
  // gives at the other read site: the reads below FOLLOW SYMLINKS, so containment
  // must be decided on the resolved target, not a lexical prefix — a link inside
  // the root pointing outside it passes `tryWithinRootLexical` and is then read.
  // Read the value the predicate RETURNED; never re-derive the path. An escape
  // degrades to the same non-throwing payload the unresolvable-phase arm emits,
  // because a consumer must be able to tell "could not look" from "nothing to
  // report" (and `error()` would collapse them).
  //
  // RESIDUAL, stated rather than left to be rediscovered: this is check-then-use, so
  // a symlink planted at the resolved path BETWEEN this call and the reads inside
  // probePhaseVerifyCommands would be followed. A link already in place when the
  // command runs IS refused — the predicate resolves it and returns null (driven) —
  // so the window is the in-process gap, not the ordinary case. It is a property of
  // every `tryWithinRoot` call site in this repo, including `resolvePath` above and
  // the artifact scan below, not of this arm; closing it needs O_NOFOLLOW/dirfd
  // semantics inside the ADR-4650 predicate, which is a wider change than the bug
  // this fixes.
  let phaseDir: string;
  if (dirFlag) {
    const candidate = path.isAbsolute(dirFlag) ? dirFlag : path.join(projectDir, dirFlag);
    const contained = tryWithinRoot(candidate, projectDir, PathAcceptance.AbsoluteInsideRoot);
    if (contained === null) {
      output(
        {
          status: 'unresolvable',
          commands: [],
          counts: { blocker: 0, warning: 0, total: 0 },
          readError: `--dir resolves outside the project root: ${dirFlag}`,
        },
        raw,
        undefined,
      );
      return;
    }
    phaseDir = contained;
  } else {
    phaseDir = resolvePhaseDirOrEmpty(projectDir, phase);
  }

  if (!phaseDir) {
    output(
      {
        status: 'unresolvable',
        commands: [],
        counts: { blocker: 0, warning: 0, total: 0 },
        readError: `could not resolve phase directory for phase ${phase}`,
      },
      raw,
      undefined,
    );
    return;
  }

  const probed = probePhaseVerifyCommands({ phaseDir, projectRoot: projectDir });
  output(probed, raw, undefined);
}

// ─── verify-failure-directions (#3172) ─────────────────────────────────────────

/**
 * verify-failure-directions: probes every `<automated>` verify command
 * declared in a phase's `-PLAN.md` files for a stated `<fails_when>` failing
 * direction — see verify-command-grounding.cjs for the recognizer contract.
 *
 * Args: check verify-failure-directions <phase>
 * Invocable as: gsd_run check verify-failure-directions <phase>
 *
 * When the phase cannot be resolved to a directory, this emits a non-throwing
 * degraded JSON payload (status/commands/counts all zeroed, `readError`
 * populated) rather than calling `error()` — the plan-checker parses this
 * result and must be able to distinguish "nothing to report" from "could not
 * look", which a non-zero exit / thrown error would collapse.
 */
function cmdVerifyFailureDirections(projectDir: string, args: string[], raw: boolean): void {
  // args[0] = 'check', args[1] = 'verify-failure-directions', args[2] = phase
  const phase = args[2] || '';
  if (!phase) {
    output(
      {
        status: 'unresolvable',
        commands: [],
        counts: { blocker: 0, warning: 0, total: 0 },
        readError: 'verify-failure-directions requires a phase argument: check verify-failure-directions <phase>',
      },
      raw,
      undefined,
    );
    return;
  }

  const phaseDir = resolvePhaseDirOrEmpty(projectDir, phase);

  if (!phaseDir) {
    output(
      {
        status: 'unresolvable',
        commands: [],
        counts: { blocker: 0, warning: 0, total: 0 },
        readError: `could not resolve phase directory for phase ${phase}`,
      },
      raw,
      undefined,
    );
    return;
  }

  const result = probePhaseFailingDirections({ phaseDir });
  output(result, raw, undefined);
}

// ─── gap-analysis-plan-post ───────────────────────────────────────────────────

/**
 * gap-analysis-plan-post: non-blocking advisory check that runs the post-planning
 * gap analysis after all PLAN.md files are generated for a phase.
 *
 * Cross-references every REQ-ID and D-ID from REQUIREMENTS.md and CONTEXT.md
 * against the concatenated text of all *-PLAN.md files, emitting a coverage table.
 *
 * This gate is always advisory (passed: true) — it never blocks phase advancement.
 *
 * Args: check gap-analysis.plan-post <phase-dir> [phase-req-ids]
 * Invocable as: gsd_run check gap-analysis.plan-post <phase-dir> [phase-req-ids]
 */
function cmdGapAnalysisPlanPost(projectDir: string, args: string[], raw: boolean): void {
  // args[0] = 'check', args[1] = 'gap-analysis-plan-post' (normalized), args[2] = phaseDir, args[3] = phaseReqIds
  const phaseDir = args[2] || '';
  if (!phaseDir) {
    error('gap-analysis.plan-post requires a phase-dir argument: check gap-analysis.plan-post <phase-dir> [phase-req-ids]', ERROR_REASON.SDK_MISSING_ARG);
    return;
  }
  const resolvedPhaseDir = resolvePath(phaseDir, projectDir);
  const phaseReqIds = args[3] ?? undefined;
  const result = runGapAnalysis(projectDir, resolvedPhaseDir, { phaseReqIds });
  // Uniform gate contract: block = false (gap-analysis is always advisory, never blocks).
  // `message` carries the human-readable gap analysis report so the dispatch's
  // advisory branch can surface it. --raw emits JSON (rawValue=undefined), not
  // plain markdown text.
  output(
    {
      block: false,
      passed: true,
      enabled: result.enabled,
      table: result.table,
      summary: result.summary,
      counts: result.counts,
      // Human-readable report in `message` for the host-loop advisory branch.
      message: result.table || result.summary || '',
    },
    raw,
    undefined,
  );
}

interface RouteCheckCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
}

// ─── predicate (generic gate-predicate evaluator, #2008) ──────────────────────

/**
 * Production subprocess binding for the gate-predicate evaluator. Wraps the
 * bounded `execTool` seam (shell-command-projection) as a `runBoundedShell`
 * the pure evaluator consumes. `sh -c` runs the interpolated command; the
 * subprocess inherits the process env and is killed (SIGTERM) on timeout.
 *
 * `timedOut` is derived from the kill signal: spawnSync sets `signal: 'SIGTERM'`
 * when the `timeout` fires, distinct from a normal non-zero exit code. A command
 * that self-terminates with SIGTERM is indistinguishable at this seam and is
 * reported as a timeout — either way the gate blocks (non-zero), so the outcome
 * is fail-closed and correct. See ADR-2008.
 */
function buildPredicateDeps() {
  return {
    runBoundedShell(opts: { command: string; cwd: string; timeoutMs: number }): {
      exitCode: number | null;
      stdout: string;
      stderr: string;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
    } {
      const r = execTool('sh', ['-c', opts.command], { cwd: opts.cwd, timeout: opts.timeoutMs });
      return {
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        signal: r.signal,
        timedOut: r.timedOut,
      };
    },
    findPhaseArtifact(phaseDir: string, artifactSuffix: string): string | null {
      if (!fs.existsSync(phaseDir)) return null;
      if (
        artifactSuffix === '.' ||
        artifactSuffix === '..' ||
        artifactSuffix.includes('\0') ||
        path.basename(artifactSuffix) !== artifactSuffix ||
        path.win32.basename(artifactSuffix) !== artifactSuffix
      ) {
        return null;
      }
      const directContained = tryWithinRoot(artifactSuffix, phaseDir);
      if (directContained !== null && fs.existsSync(directContained) && fs.statSync(directContained).isFile()) {
        return directContained;
      }
      const planningContained = tryWithinRoot(path.join('.planning', artifactSuffix), phaseDir);
      if (planningContained !== null && fs.existsSync(planningContained) && fs.statSync(planningContained).isFile()) {
        return planningContained;
      }
      try {
        const files = fs.readdirSync(phaseDir);
        for (const f of files) {
          if (f.endsWith('-' + artifactSuffix) || f === artifactSuffix) {
            const candidateContained = tryWithinRoot(f, phaseDir);
            if (candidateContained !== null && fs.statSync(candidateContained).isFile()) return candidateContained;
          }
        }
      } catch { /* ignore */ }
      return null;
    },
    readFrontmatter(filePath: string): Record<string, unknown> {
      const content = platformReadSync(filePath);
      if (content === null) throw new Error(`predicate artifact disappeared before it could be read: ${filePath}`);
      const parsed = extractFrontmatter(content, filePath) as Record<string, unknown>;
      return parsed;
    }
  };
}

/** Parse `--flag value` pairs from an args array into a map (last write wins). */
function parsePredicateFlags(args: string[]): Record<string, string> {
  return partitionPredicateArgs(args).flags;
}

/**
 * `check predicate` — generic evaluator for capability gate `check.predicate`
 * blocks (#2008). The workflow gate-dispatch invokes this for any gate whose
 * `check` carries a `predicate` (instead of a `query`); the predicate object is
 * passed as `--predicate '<json>'`. Emits the standard `{ block, message,
 * details? }` gate contract on success. A malformed predicate / unknown kind
 * THROWS inside the evaluator and is mapped here to `error()` (non-zero exit),
 * which the workflow's two-step gate contract treats as a step-1 command failure
 * routed per the gate's `onError`.
 *
 * Invocation:
 *   gsd_run check predicate --predicate '<json>' \
 *     [--phase-dir <dir>] [--phase-number <n>] [--phase-req-ids <ids>] --raw
 *
 * The subprocess runs at the runtime project root (the `cwd` passed to this
 * router), inheriting the process env. Interpolation placeholders
 * ${PHASE_NUMBER}/${PHASE_DIR}/${PHASE_REQ_IDS} are substituted from the flags.
 */
function cmdCheckPredicate(projectDir: string, args: string[], raw: boolean): void {
  const flags = parsePredicateFlags(args);
  const predicateJson = flags['predicate'];
  if (!predicateJson) {
    error('predicate requires --predicate <json> (the gate hook check.predicate object)', ERROR_REASON.SDK_MISSING_ARG);
    return;
  }
  let predicate: unknown;
  try {
    predicate = JSON.parse(predicateJson);
  } catch {
    error('predicate --predicate value must be valid JSON', ERROR_REASON.USAGE);
    return;
  }
  const rawPhaseDir = flags['phase-dir'];
  let resolvedPhaseDir: string | undefined = rawPhaseDir;
  if (typeof rawPhaseDir === 'string' && rawPhaseDir !== '') {
    resolvedPhaseDir = resolvePath(rawPhaseDir, projectDir);
  }
  const ctx = {
    cwd: projectDir,
    phaseNumber: flags['phase-number'],
    phaseDir: resolvedPhaseDir,
    phaseReqIds: flags['phase-req-ids'],
  };
  let result;
  try {
    result = evaluatePredicate(predicate, ctx, buildPredicateDeps());
  } catch (e) {
    error(`gate predicate evaluation failed: ${(e as Error).message}`, ERROR_REASON.USAGE);
    return;
  }
  output(result, raw, undefined);
}

// ─── api-coverage-verify-pre ──────────────────────────────────────────────────

/**
 * api-coverage.verify-pre: BLOCKING seal-time gate for the ai-integration
 * capability (#1562). Enforces "Full API Coverage by Default — Opt Out, Never
 * Opt In." A phase that integrates an external API/SDK/service may not seal
 * until a COVERAGE.md matrix enumerates the surface and every non-integrated
 * capability is an explicit, reasoned opt-out.
 *
 * Contract (two touch points composed into one check):
 *   1. If COVERAGE.md exists in the phase dir → validate it (acceptance #2).
 *      Block on any validation error (empty matrix, OPT-OUT without reason,
 *      duplicate/empty capability).
 *   2. If COVERAGE.md is absent → run detectApiIntegration over the phase scope
 *      (PLAN.md body, then ROADMAP phase section as fallback). If a strong
 *      external-API-integration signal is detected → BLOCK ("integration
 *      detected without coverage matrix"). If no signal → PASS (treat as a
 *      non-API phase; acceptance #4 — low false positives).
 *
 * The detector is the FALLBACK for the "nobody decided / forgot the matrix"
 * case; the primary path is the plan:pre contribution prompting COVERAGE.md.
 *
 * Args: check api-coverage.verify-pre <phase-dir>
 * Emits the uniform gate contract: { block, passed, message, ...details }.
 */
function cmdApiCoverageVerifyPre(projectDir: string, args: string[], raw: boolean): void {
  const phaseArg = typeof args[2] === 'string' ? args[2] : '';
  if (!phaseArg) {
    error(
      'api-coverage.verify-pre requires a phase argument: check api-coverage.verify-pre <phase-dir-or-token>',
      ERROR_REASON.SDK_MISSING_ARG,
    );
    return;
  }

  const pDir = planningDir(projectDir);
  const phasesRoot = path.join(pDir, 'phases');

  // SECURITY (path traversal): the phase argument is taken ONLY as a phase
  // token — its basename — and resolved by findPhaseInternal strictly under
  // .planning/phases/ (or a milestone archive). The raw arg is never used as a
  // path, so `..`, absolute paths, and arbitrary directories cannot reach a
  // file read. Mirrors cmdVerifySchemaDrift's token-match approach.
  let token = posixNormalize(phaseArg).split('/').filter(Boolean).pop() || '';
  // A token like ".." or "." carries no phase identity → unresolvable.
  if (token === '.' || token === '..') token = '';

  // Not a GSD project (no phases tree at all) → fail-open: nothing to gate.
  if (!fs.existsSync(phasesRoot)) {
    output(
      {
        block: false,
        passed: true,
        coverage_present: false,
        detected: false,
        message: 'api-coverage: no .planning/phases directory; gate skipped (not a GSD project layout)',
      },
      raw,
      undefined,
    );
    return;
  }

  // Resolve the phase dir under the contained phases root.
  let resolvedDir: string | null = null;
  let phaseNumber = '';
  if (token) {
    const found = findPhaseInternal(projectDir, token);
    if (found && found.directory) {
      resolvedDir = found.directory;
      phaseNumber = found.phase_number || '';
    }
  }

  if (!resolvedDir) {
    // The phases tree EXISTS but THIS phase could not be resolved. For a
    // BLOCKING gate, fail-closed: a missing phase dir must not silently bypass
    // the coverage requirement. (Distinguished from "no .planning at all"
    // above, which is a genuine non-GSD-project → pass.)
    output(
      {
        block: true,
        passed: false,
        coverage_present: false,
        detected: false,
        phase_lookup_failed: true,
        message:
          `api-coverage: could not resolve phase "${phaseArg}" under .planning/phases/. ` +
          'Resolve the phase directory (or produce COVERAGE.md) before sealing.',
      },
      raw,
      undefined,
    );
    return;
  }

  // Defense-in-depth: the resolved dir must be inside the phases root (or a
  // milestone archive under .planning/milestones).
  const milestonesRoot = path.join(pDir, 'milestones');
  // Lexical containment (ADR-4650): resolvedDir is a directory path, not read
  // through here — mirrors the prior path.resolve(root, candidate)-based check
  // without introducing a filesystem/realpath dependency this defense-in-depth
  // recheck never had.
  if (
    tryWithinRootLexical(resolvedDir, phasesRoot) === null &&
    tryWithinRootLexical(resolvedDir, milestonesRoot) === null
  ) {
    output(
      {
        block: true,
        passed: false,
        coverage_present: false,
        detected: false,
        message: 'api-coverage: resolved phase dir escapes .planning/ — refusing to evaluate',
      },
      raw,
      undefined,
    );
    return;
  }

  // (1) locate COVERAGE.md — prefer the exact name, then a single *-COVERAGE.md.
  let coverageFile = '';
  let suffixed: string[] = [];
  try {
    const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    const exact = files.find((f) => /^COVERAGE\.md$/i.test(f));
    if (exact) {
      coverageFile = exact;
    } else {
      suffixed = files.filter((f) => /-COVERAGE\.md$/i.test(f)).sort();
      if (suffixed.length === 1) coverageFile = suffixed[0];
    }
  } catch {
    // readdir failure → treat as no matrix readable; fall through to detection.
  }

  if (coverageFile) {
    let matrixText: string;
    try {
      matrixText = fs.readFileSync(path.join(resolvedDir, coverageFile), 'utf8');
    } catch {
      // COVERAGE.md exists but is unreadable (EACCES/EIO/encoding). Fail-closed
      // with a useful message rather than a raw throw.
      output(
        {
          block: true,
          passed: false,
          coverage_present: true,
          message: `api-coverage: COVERAGE.md exists but is unreadable — fix file permissions/encoding before sealing`,
        },
        raw,
        undefined,
      );
      return;
    }
    const v = validateCoverageMatrix(matrixText);
    if (v.valid) {
      if (v.none_declared) {
        // The declaration is the human override for the detector — it PASSES
        // even when detection fires (that is acceptance #5's point: the
        // detector is fallible and the declaration is the reasoned overrule).
        // But a contradiction must be VISIBLE, not silent: re-run detection
        // over the phase scope and surface any signals it still finds
        // (#2365 review S-1).
        const declScope = readPhaseScope(projectDir, resolvedDir, phaseNumber);
        const declDetection = detectApiIntegration(declScope.text);
        const declSignals = declDetection.signals.map((s) => ({ verb: s.verb, noun: s.noun }));
        // The declaration legitimately wins even over a read error (it is the
        // human overrule), but if scope was incomplete we say so — the contract
        // is that contradictions stay visible, not silent (#2365 review).
        const baseMsg = declDetection.detected
          ? `api-coverage: COVERAGE.md declares no external API integration, overriding ${declSignals.length} detected signal(s) — confirm the declaration is accurate`
          : 'api-coverage: COVERAGE.md declares no external API integration — matrix not required';
        output(
          {
            block: false,
            passed: true,
            coverage_present: true,
            matrix: coverageFile,
            counts: v.counts,
            none_declared: true,
            detected: declDetection.detected,
            ...(declDetection.detected ? { signals: declSignals } : {}),
            ...(declScope.readError ? { scope_read_error: declScope.readError } : {}),
            message: declScope.readError
              ? `${baseMsg} (note: phase scope was incompletely read — ${declScope.readError})`
              : baseMsg,
          },
          raw,
          undefined,
        );
        return;
      }
      output(
        {
          block: false,
          passed: true,
          coverage_present: true,
          matrix: coverageFile,
          counts: v.counts,
          message: `api-coverage: matrix present (${v.counts.surface} capabilities, ${v.counts.optout} opt-out)`,
        },
        raw,
        undefined,
      );
      return;
    }
    // Fixed-template message (no raw cell content echoed into the LLM-facing
    // message). The structured `errors` array is safe (row-indexed, no cell
    // values) and travels as data for tooling that wants detail.
    output(
      {
        block: true,
        passed: false,
        coverage_present: true,
        matrix: coverageFile,
        error_count: v.errors.length,
        errors: v.errors,
        message: `api-coverage: COVERAGE.md has ${v.errors.length} problem(s) — fix the matrix (every capability INTEGRATE or OPT-OUT with a reason) before sealing`,
      },
      raw,
      undefined,
    );
    return;
  }
  if (suffixed.length > 1) {
    output(
      {
        block: true,
        passed: false,
        coverage_present: false,
        message: `api-coverage: multiple *-COVERAGE.md files found (${suffixed.length}) — consolidate into one COVERAGE.md before sealing`,
      },
      raw,
      undefined,
    );
    return;
  }

  // (2) no matrix — detect whether this phase integrates an external API.
  const scope = readPhaseScope(projectDir, resolvedDir, phaseNumber);
  if (scope.readError) {
    // Fail-closed: an unreadable plan could be the one describing the
    // integration, so we cannot certify "no integration" — block and surface it.
    output(
      {
        block: true,
        passed: false,
        coverage_present: false,
        detected: false,
        message:
          `api-coverage: could not read the phase scope (${scope.readError}); ` +
          'refusing to certify no external-API integration from incomplete scope. ' +
          'Fix the unreadable plan file, or add a COVERAGE.md declaration.',
      },
      raw,
      undefined,
    );
    return;
  }
  // An EMPTY scope is not a negative verdict. This gate's neighbouring arms
  // already fail closed (unresolvable phase → block; unreadable plan → block),
  // but a phase with no plan body AND no roadmap section fell through to
  // detection over zero bytes and CERTIFIED "no external-API integration" —
  // clearing a blocking seal gate on a probe that examined nothing
  // (ADR-3889 failure class (c), #3909). The discriminator is BYTES EXAMINED,
  // never SIGNALS FOUND: a phase with real plans and no API vocabulary still
  // reaches the pass below unchanged.
  if (scope.text.trim() === '') {
    output(
      {
        block: true,
        passed: false,
        coverage_present: false,
        detected: false,
        scope_unavailable: true,
        message:
          'api-coverage: the phase scope is empty — no plan body and no roadmap section were ' +
          'found, so nothing was examined. Refusing to certify no external-API integration ' +
          'from an unestablished scope. Add the phase plan, or add a COVERAGE.md declaration.',
      },
      raw,
      undefined,
    );
    return;
  }

  const detection = detectApiIntegration(scope.text);
  if (detection.detected) {
    // Surface only verb/noun (typed, bounded) — NOT raw prose snippets — so the
    // gate output cannot relay injected PLAN.md instructions to the orchestrator.
    const signals = detection.signals.map((s) => ({ verb: s.verb, noun: s.noun }));
    output(
      {
        block: true,
        passed: false,
        coverage_present: false,
        detected: true,
        signals,
        message:
          'api-coverage: external-API integration detected without a coverage matrix. ' +
          'Produce COVERAGE.md enumerating the API surface (every capability INTEGRATE or ' +
          'OPT-OUT with a reason) before sealing. Full coverage is the default.',
      },
      raw,
      undefined,
    );
    return;
  }

  output(
    {
      block: false,
      passed: true,
      coverage_present: false,
      detected: false,
      message: 'api-coverage: no external-API integration detected; coverage matrix not required',
    },
    raw,
    undefined,
  );
}

/**
 * Read the phase-scope text used for API-integration detection. Uses the
 * resolved plan files (PLAN.md bodies — the planner's own words about what the
 * phase does) and, as a fallback, ONLY THIS PHASE'S ROADMAP section (not the
 * whole roadmap, which would cross-contaminate sibling phases). Strips nothing
 * here — detectApiIntegration strips fenced code itself.
 */
interface PhaseScopeRead {
  text: string;
  /** Non-null when a plan file EXISTED but could not be read. The gate must not
   *  conclude "no external API integration" from provably incomplete scope — an
   *  unreadable plan could be the one describing the integration (#2365 review:
   *  the blocking consumer silently passed partially-read scope). A missing plan
   *  directory is NOT a read error (a phase may legitimately have no plans yet). */
  readError: string | null;
}

/** A filesystem error that is NOT "does not exist" — i.e. a real read failure
 *  (EACCES/EIO/…) the gate must not swallow. `ENOENT` is a legitimate "not
 *  there yet" and is treated as absence, not error. */
function isRealReadFailure(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return err != null && code !== 'ENOENT';
}

function readPhaseScope(projectDir: string, phaseDir: string, phaseNumber: string): PhaseScopeRead {
  const chunks: string[] = [];
  let readError: string | null = null;
  // A MISSING phase directory is fine (no plans yet → fall through to the
  // roadmap). Checked up front (rather than via a readdirSync catch) because
  // #3183 (lint-plan-count-drift) now sources the plan-file list from the
  // single owner (scanPhasePlans) instead of a local `-PLAN\.md$` readdirSync
  // filter — picks up bare PLAN.md and nested plans/, and excludes
  // superseded plans, none of which the prior root-only exact-suffix filter
  // did.
  if (fs.existsSync(phaseDir)) {
    const scan = scanPhasePlans(phaseDir);
    if (scan.scope === SCOPE.UNREADABLE) {
      // Directory exists but scanPhasePlans's own readdirSync(phaseDir) call
      // failed (EACCES/EIO race) — a real read failure the gate must not
      // silently pass (#2365 review), mirroring the prior isRealReadFailure
      // branch below for the readdirSync-throws case.
      return {
        text: '',
        readError: 'could not read the phase directory: scanPhasePlans reported scope UNREADABLE',
      };
    }
    const plans = [...scan.planFiles].sort();
    for (const p of plans) {
      try {
        chunks.push(fs.readFileSync(path.join(phaseDir, p), 'utf8'));
      } catch (err) {
        // A plan file that exists but cannot be read — record it and keep
        // reading the rest so the message names the first failure.
        if (!readError) {
          readError = `could not read ${p}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
  }
  if (readError) return { text: chunks.join('\n\n'), readError };
  if (chunks.join('').trim().length > 0) return { text: chunks.join('\n\n'), readError: null };

  // Fallback: ONLY this phase's ROADMAP section (not the whole file, which
  // would pollute detection with sibling-phase prose). A MISSING roadmap/section
  // is non-fatal; a roadmap that exists but cannot be read is a real failure.
  if (phaseNumber) {
    try {
      const section = getRoadmapPhaseWithFallback(projectDir, phaseNumber);
      if (section) return { text: section, readError: null };
    } catch (err) {
      if (isRealReadFailure(err)) {
        return {
          text: '',
          readError: `could not read the roadmap fallback: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  }
  return { text: '', readError: null };
}

function routeCheckCommand({ args, cwd, raw }: RouteCheckCommandOptions): void {
  // Normalize dots to hyphens in the subcommand so both forms are accepted.
  // This makes `check.query = "ui.plan-gate"` (dotted form in capability.json gates)
  // directly runnable as `gsd_run check ui.plan-gate` — the dot is normalized to
  // `ui-plan-gate` before routing. The generic gate-dispatch in §5.6 reads
  // `check.query` from the active gate hook and runs `gsd_run check ${hook.check.query}`,
  // so the declared query must be dispatchable exactly as declared.
  const rawSubcommand = args[1];
  const subcommand = typeof rawSubcommand === 'string' ? rawSubcommand.replace(/\./g, '-') : rawSubcommand;
  if (subcommand === 'auto-mode') {
    cmdAutoMode(cwd, raw);
    return;
  }
  if (subcommand === 'decision-coverage-plan') {
    cmdDecisionCoveragePlan(cwd, args, raw);
    return;
  }
  if (subcommand === 'decision-coverage-verify') {
    cmdDecisionCoverageVerify(cwd, args, raw);
    return;
  }
  if (subcommand === 'ui-plan-gate') {
    cmdUiPlanGate(cwd, args, raw);
    return;
  }
  if (subcommand === 'gap-analysis-plan-post') {
    cmdGapAnalysisPlanPost(cwd, args, raw);
    return;
  }
  if (subcommand === 'verify-command-paths') {
    // Deterministic filesystem probe for <automated> verify commands (#2401) —
    // never executes anything; see verify-command-grounding.cjs.
    cmdVerifyCommandPaths(cwd, args, raw);
    return;
  }
  if (subcommand === 'verify-failure-directions') {
    // Presence probe for a stated <fails_when> per <automated> command
    // (#3172) — never executes anything; see verify-command-grounding.cjs.
    cmdVerifyFailureDirections(cwd, args, raw);
    return;
  }
  if (subcommand === 'api-coverage-verify-pre') {
    // ai-integration capability blocking gate at verify:pre (#1562). Dot-to-
    // hyphen normalization means query "api-coverage.verify-pre" routes here.
    cmdApiCoverageVerifyPre(cwd, args, raw);
    return;
  }
  if (subcommand === 'tdd-review-checkpoint') {
    cmdTddReviewCheckpoint(cwd, args, raw);
    return;
  }
  if (subcommand === 'tdd-red-evidence') {
    // #3770: intentional-RED evidence gate — only a target-test failure may
    // authorize GREEN. Validates the persisted record; never executes anything.
    cmdTddRedEvidence(cwd, args, raw);
    return;
  }
  if (subcommand === 'ui-safety-gate') {
    cmdUiSafetyGate(cwd, args, raw);
    return;
  }
  if (subcommand === 'verify-schema-drift') {
    // Delegates to verify.schema-drift — drift capability gate at execute:wave:post (blocking).
    // Dot-to-hyphen normalization means query "verify.schema-drift" routes here.
    // Honor GSD_SKIP_SCHEMA_CHECK=true to bypass the gate (preserves the original inline gate behavior).
    const phaseArg = typeof args[2] === 'string' ? args[2] : '';
    const skipSchemaCheck = process.env['GSD_SKIP_SCHEMA_CHECK'] === 'true';
    cmdVerifySchemaDrift(cwd, phaseArg, skipSchemaCheck, raw);
    return;
  }
  if (subcommand === 'verify-codebase-drift') {
    // Delegates to verify.codebase-drift — drift capability gate at execute:wave:post (non-blocking).
    // Dot-to-hyphen normalization means query "verify.codebase-drift" routes here.
    cmdVerifyCodebaseDrift(cwd, raw);
    return;
  }
  if (subcommand === 'verify-context-drift') {
    // Delegates to verify.context-drift — drift capability gate at plan:pre (non-blocking).
    // Dot-to-hyphen normalization means query "verify.context-drift" routes here.
    const phaseArg = typeof args[2] === 'string' ? args[2] : '';
    cmdVerifyContextDrift(cwd, phaseArg, raw);
    return;
  }
  if (subcommand === 'predicate') {
    // Generic gate-predicate evaluator (#2008). The workflow gate-dispatch calls
    // this for any gate whose `check` carries a `predicate` (instead of a `query`),
    // passing the predicate object as --predicate '<json>'. NOTE: unlike the
    // `check.query` subcommands above (which take positional phase args), this
    // subcommand is flag-driven. `decision-coverage-plan` above now ALSO accepts
    // `--context <path>` (its positionals still work) — both share
    // partitionPredicateArgs, the one flag parser.
    cmdCheckPredicate(cwd, args, raw);
    return;
  }
  if (subcommand === 'prohibition-enforcement') {
    // The deterministic test-tier prohibition PRODUCER/gate (#1259, ADR-550 D5d). Locates the
    // wired mechanical check (node-test or lint-rule), confirms fail-first, runs it, builds
    // enforcementEvidence, and emits the dispositionForProhibition verdict. Invocable as
    // `gsd_run check prohibition-enforcement <request.json>`.
    routeProhibitionEnforcement(args, raw);
    return;
  }
  error('Unknown check subcommand. Available: api-coverage-verify-pre, auto-mode, decision-coverage-plan, decision-coverage-verify, gap-analysis-plan-post, predicate, prohibition-enforcement, tdd-red-evidence, tdd-review-checkpoint, ui-plan-gate, ui-safety-gate, verify-command-paths, verify-failure-directions, verify-schema-drift, verify-codebase-drift, verify-context-drift', ERROR_REASON.SDK_UNKNOWN_COMMAND);
}

export = {
  routeCheckCommand,
  decisionMentioned,
  extractPlanDesignatedSections,
  computeUiPlanGate,
  computeUiSafetyGate,
  cmdGapAnalysisPlanPost,
  cmdVerifyCommandPaths,
  cmdVerifyFailureDirections,
  cmdTddReviewCheckpoint,
  cmdTddRedEvidence,
  cmdCheckPredicate,
  buildPredicateDeps,
  parsePredicateFlags,
  partitionPredicateArgs,
  // Fail-closed phase-scope reader for the api-coverage gate — exported for
  // in-process failure-injection tests (#2365 review).
  readPhaseScope,
};
