/**
 * `check ui-safety-gate` as a gate module (#5139, epic #5056, ADR-5057 §4 first bullet): it returns
 * a `GateResult`; the command router formats it. Imports no io module and performs no direct
 * console/stdout/stderr write (ESLint-enforced).
 *
 * Post-wave check that verifies UI-changed files conform to the active UI-SPEC for the phase.
 * Uses `checkUiPresence` from `ui-safety-gate.cjs` (frontend detection is not reimplemented) and
 * looks for frontend files in the phase's evaluation scope (#5164, ADR-5057 §4): the union of the
 * phase's own commits' file sets from `gate-evaluation-scope`, not the last commit. A scope the
 * resolver could not read, or had to widen, is reported (`scopeStatus` / `scopeReason`), never
 * silently treated as "no UI files".
 *
 * Argv after the verb: `<phase>`.
 */

import { gateVerdict, gateUsageFailure, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateResult } from './gate-verdict.cjs';
import { findUiSpecInDir, lookupRoadmapPhase, resolvePhaseDirOrEmpty } from './gate-phase-context.cjs';
import { resolveEvaluationScope } from './gate-evaluation-scope.cjs';
import type { ScopeStatus } from './gate-evaluation-scope.cjs';
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
  /** Present only when the scope was widened (`degraded`) or unreadable (`unresolvable`). */
  scopeStatus?: Exclude<ScopeStatus, 'resolved'>;
  scopeReason?: string;
}

/**
 * Pure logic for ui-safety-gate — exposed for direct behavioral testing.
 *
 *   (a) ROADMAP phase section via the shared lookup (same as ui-plan-gate) → is this a frontend phase.
 *   (b) checkUiPresence (frontend detection).
 *   (c) UI files among the phase's evaluation scope (`resolveEvaluationScope`, phase unit; every
 *       git call is bounded by the resolver's seam; an unreadable scope is reported, not "clean").
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

  // (c) any UI files in the phase's own commits? (deleted paths count: a removed component is a UI change)
  const scope = resolveEvaluationScope(projectDir, { kind: 'phase', phase });
  const hasUiFiles = scope.changedFiles.some((f) =>
    f.trim() && (UI_FILE_EXTENSIONS_RE.test(f) || UI_PATH_PATTERNS_RE.test(f)),
  );

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
  if (scope.status !== 'resolved') {
    result.scopeStatus = scope.status;
    result.scopeReason = scope.reason ?? '';
  }
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
