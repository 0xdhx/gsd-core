/**
 * Check subcommand router — auto-mode, decision-coverage-plan, decision-coverage-verify.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/check-command-router.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
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
import { evaluateUiPlanGate, computeUiPlanGate } from './gate-ui-plan.cjs';
import { evaluateUiSafetyGate, computeUiSafetyGate } from './gate-ui-safety.cjs';
import { evaluateTddReviewCheckpoint } from './gate-tdd-review-checkpoint.cjs';
import { evaluateTddRedEvidence } from './gate-tdd-red-evidence.cjs';
import { evaluateVerifyCommandPaths } from './gate-verify-command-paths.cjs';
import { evaluateVerifyFailureDirections } from './gate-verify-failure-directions.cjs';
import { decisionMentioned, extractPlanDesignatedSections } from './decision-coverage-support.cjs';
import { readAutoModeState } from './check-auto-mode.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterMod = require('./frontmatter.cjs');
const { extractFrontmatter } = frontmatterMod;
import { tryWithinRoot, tryWithinRootLexical } from './security.cjs';
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

// ─── ui-plan-gate / ui-safety-gate ────────────────────────────────────────────

/**
 * `check ui-plan-gate <phase>` / `check ui-safety-gate <phase>` — the decisions live in
 * `gate-ui-plan.cts` / `gate-ui-safety.cts`; this only formats their result.
 */
function cmdUiPlanGate(projectDir: string, args: string[], raw: boolean): void {
  emitGateResult(evaluateUiPlanGate({ projectDir, args: args.slice(2) }), raw);
}

function cmdUiSafetyGate(projectDir: string, args: string[], raw: boolean): void {
  emitGateResult(evaluateUiSafetyGate({ projectDir, args: args.slice(2) }), raw);
}

// ─── tdd-review-checkpoint / tdd-red-evidence ─────────────────────────────────

/**
 * `check tdd-review-checkpoint <phase>` (advisory RED/GREEN/REFACTOR review table) and
 * `check tdd-red-evidence <record.json>` (#3770, intentional-RED evidence) — the decisions live in
 * `gate-tdd-review-checkpoint.cts` / `gate-tdd-red-evidence.cts`; this only formats their result.
 * `--raw` emits JSON, not plain text (the human-readable report is in the payload's `message`).
 */
function cmdTddReviewCheckpoint(projectDir: string, args: string[], raw: boolean): void {
  emitGateResult(evaluateTddReviewCheckpoint({ projectDir, args: args.slice(2) }), raw);
}

function cmdTddRedEvidence(projectDir: string, args: string[], raw: boolean): void {
  emitGateResult(evaluateTddRedEvidence({ projectDir, args: args.slice(2) }), raw);
}

// ─── verify-command-paths (#2401) / verify-failure-directions (#3172) ─────────

/**
 * `check verify-command-paths <phase> | --dir <plan-dir>` and
 * `check verify-failure-directions <phase>` — filesystem probes of the phase's `<automated>` verify
 * commands; never executes anything. The decisions live in `gate-verify-command-paths.cts` /
 * `gate-verify-failure-directions.cts`; this only formats their result (a degraded, non-throwing
 * payload when the phase cannot be resolved — never `error()`).
 */
function cmdVerifyCommandPaths(projectDir: string, args: string[], raw: boolean): void {
  emitGateResult(evaluateVerifyCommandPaths({ projectDir, args: args.slice(2) }), raw);
}

function cmdVerifyFailureDirections(projectDir: string, args: string[], raw: boolean): void {
  emitGateResult(evaluateVerifyFailureDirections({ projectDir, args: args.slice(2) }), raw);
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
