/**
 * `check ui-safety-gate` as a gate module (#5139, epic #5056, ADR-5057 §4 first bullet): it returns
 * a `GateResult`; the command router formats it. Imports no io module and performs no direct
 * console/stdout/stderr write (ESLint-enforced).
 *
 * Post-wave check that verifies UI-changed files conform to the active UI-SPEC for the phase.
 * Uses `checkUiPresence` from `ui-safety-gate.cjs` (frontend detection is not reimplemented) and
 * looks for frontend file changes in `git diff --name-only HEAD~1 HEAD`.
 *
 * Limitation: `HEAD~1..HEAD` covers only the last commit; in a multi-plan wave the wave-start
 * commit would be more accurate but is not yet stored in the wave manifest.
 *
 * Argv after the verb: `<phase>`.
 */

import { execFileSync } from 'node:child_process';
import { gateVerdict, gateUsageFailure, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateResult } from './gate-verdict.cjs';
import { findUiSpecInDir, lookupRoadmapPhase, resolvePhaseDirOrEmpty } from './gate-phase-context.cjs';
import { checkUiPresence } from './ui-safety-gate.cjs';

const UI_FILE_EXTENSIONS_RE = /\.(tsx|jsx|css|scss|sass|less|vue|svelte|html)$/i;
const UI_PATH_PATTERNS_RE = /\/(components|pages|views|screens|layouts|ui|frontend)\//i;

export interface UiSafetyGateResult {
  frontend: boolean;
  hasUiFiles: boolean;
  hasUiSpec: boolean;
  block: boolean;
  message?: string;
  phaseLookupFailed?: boolean;
}

/**
 * Pure logic for ui-safety-gate — exposed for direct behavioral testing.
 *
 *   (a) ROADMAP phase section via the shared lookup (same as ui-plan-gate) → is this a frontend phase.
 *   (b) checkUiPresence (frontend detection).
 *   (c) `git diff HEAD~1..HEAD` for UI file changes in the current worktree (10 s bound; a git
 *       failure is "no UI files changed").
 *   (d) Phase directory → `*-UI-SPEC.md`.
 *
 * `block = frontend && hasUiFiles && !hasUiSpec`.
 */
export function computeUiSafetyGate(projectDir: string, phase: string): UiSafetyGateResult {
  // (a) phase section text (same two-pass lookup as computeUiPlanGate)
  const { phaseSection, phaseLookupFailed } = lookupRoadmapPhase(projectDir, phase);

  // (b) frontend detection — reuse the existing helper; no reimplementation
  const presenceResult = checkUiPresence(phaseSection);
  const frontend = presenceResult.hasUI;

  // (c) any UI files changed in recent git commits?
  let hasUiFiles = false;
  try {
    const changed = execFileSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], {
      cwd: projectDir,
      encoding: 'utf-8',
      // stderr is piped (and dropped), never inherited: a gate module writes nothing to the
      // process's stderr, and a git failure here already means "no UI files changed".
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      timeout: 10_000,
    });
    hasUiFiles = changed.split('\n').some((f) =>
      f.trim() && (UI_FILE_EXTENSIONS_RE.test(f) || UI_PATH_PATTERNS_RE.test(f)),
    );
  } catch { /* git unavailable or no prior commit — treat as no UI files changed */ }

  // (d) phase directory and *-UI-SPEC.md
  const uiSpecPath = findUiSpecInDir(resolvePhaseDirOrEmpty(projectDir, phase));
  const hasUiSpec = uiSpecPath !== '';

  // block only when: this is a frontend phase AND UI files were changed AND no UI-SPEC exists
  const block = frontend && hasUiFiles && !hasUiSpec;

  const result: UiSafetyGateResult = { frontend, hasUiFiles, hasUiSpec, block };
  if (block) {
    result.message = `UI files changed in this wave but no UI-SPEC.md exists for Phase ${phase}. ` +
      `Run /gsd:ui-phase ${phase} to generate the design contract before continuing.`;
  }
  if (phaseLookupFailed) result.phaseLookupFailed = true;
  return result;
}

export function evaluateUiSafetyGate(input: { projectDir: string; args: readonly string[] }): GateResult {
  const phase = input.args[0] || '';
  if (!phase) {
    return gateUsageFailure(GATE_FAILURE_CODE.SDK_MISSING_ARG, 'ui-safety-gate requires a phase argument: check ui-safety-gate <phase>');
  }
  const result = computeUiSafetyGate(input.projectDir, phase);
  return gateVerdict(result.block ? 'block' : 'pass', result.block, { ...result });
}
