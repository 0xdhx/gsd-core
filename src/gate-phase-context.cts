/**
 * Gate phase context — path/phase resolution shared by the gate modules (#5139, epic #5056,
 * ADR-5057 §4 first bullet, design D3).
 *
 * Owns the containment helper (a caller-supplied path argument is resolved against the project
 * directory and must stay inside it; it RETURNS a `GateUsageFailure` on an escape — a gate module
 * never calls `error()` — and the router turns that failure into the same `error(message,
 * 'usage')` the pre-move router raised), the phase-directory / ROADMAP lookups, the tolerant file
 * read (`readIfExists`) and the degraded verdict of the two verify probes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { tryWithinRoot, PathAcceptance } from './security.cjs';
import { gateVerdict, gateUsageFailure, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateResult, GateUsageFailure } from './gate-verdict.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceMod = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspaceMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorMod = require('./phase-locator.cjs');
const { findPhaseInternal } = phaseLocatorMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapModule = require('./roadmap.cjs');
const { getRoadmapPhaseWithFallback } = roadmapModule;

/**
 * Resolve a caller-supplied path (absolute, or relative to `projectDir`) and require the result to
 * stay inside `projectDir` (realpath containment, ADR-4650). Returns the contained path the
 * predicate produced, or a `GateUsageFailure` (`usage`, `path escapes its allowed directory: <arg>`).
 */
export function resolveContainedPath(inputPath: string, projectDir: string): string | GateUsageFailure {
  const candidate = path.isAbsolute(inputPath) ? inputPath : path.join(projectDir, inputPath);
  const contained = tryWithinRoot(candidate, projectDir, PathAcceptance.AbsoluteInsideRoot);
  if (contained === null) {
    return gateUsageFailure(GATE_FAILURE_CODE.USAGE, `path escapes its allowed directory: ${inputPath}`);
  }
  return contained;
}

/** The file's UTF-8 text, or '' when it is absent or unreadable (a gate never throws on a read). */
export function readIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * The degraded payload the two verify probes (`verify-command-paths`, `verify-failure-directions`)
 * return when they cannot look: status/commands/counts zeroed, `readError` naming why. A skip, not
 * a usage failure — the plan-checker parses it and must tell "nothing to report" from "could not
 * look".
 */
export function unresolvableProbeVerdict(readError: string): GateResult {
  return gateVerdict('skip', false, {
    status: 'unresolvable',
    commands: [],
    counts: { blocker: 0, warning: 0, total: 0 },
    readError,
  });
}

/**
 * Resolve a phase argument to an absolute phase directory, or '' when it cannot be resolved.
 * The ONE owner of what three gates (`ui-plan-gate`, `ui-safety-gate`, `tdd-review-checkpoint`)
 * and the two verify probes each inlined before #5139 (the copies were character-identical).
 * Never throws — a caller emits a degraded payload instead, because a consumer must be able to
 * tell "nothing to report" from "could not look".
 */
export function resolvePhaseDirOrEmpty(projectDir: string, phase: string): string {
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

/** The `*-UI-SPEC.md` inside `phaseDir` (absolute path), or '' when there is none / it is unreadable. */
export function findUiSpecInDir(phaseDir: string): string {
  if (!phaseDir || !fs.existsSync(phaseDir)) return '';
  try {
    const files = fs.readdirSync(phaseDir);
    const found = files.find((f) => /-UI-SPEC\.md$/.test(f));
    return found ? path.join(phaseDir, found) : '';
  } catch {
    return '';
  }
}

/** The ROADMAP phase lookup both UI gates share. */
export interface RoadmapPhaseLookup {
  /** The phase's ROADMAP section text; '' when there is no ROADMAP.md, the phase is absent, or the read failed. */
  phaseSection: string;
  /** True only when ROADMAP.md exists but no phase header matched (surfaced so a missing phase cannot silently bypass). */
  phaseLookupFailed: boolean;
}

/**
 * The ROADMAP phase section for `phase`, through the same two-pass lookup as `roadmap.get-phase`
 * (current milestone, then the full roadmap). A missing ROADMAP.md means "no roadmap, cannot be
 * frontend" (`phaseLookupFailed` stays false); a present ROADMAP.md without the phase sets it. A
 * read failure is treated as empty and does not set it. Shared by `ui-plan-gate` and
 * `ui-safety-gate`, whose two inline copies were character-identical.
 */
export function lookupRoadmapPhase(projectDir: string, phase: string): RoadmapPhaseLookup {
  let phaseSection = '';
  let phaseLookupFailed = false;
  try {
    const section = getRoadmapPhaseWithFallback(projectDir, phase);
    if (section === null) {
      // Distinguish: ROADMAP.md missing (no-roadmap project) vs phase not found in ROADMAP.
      const planDir: string = planningDir(projectDir);
      const roadmapPath = path.join(planDir, 'ROADMAP.md');
      if (fs.existsSync(roadmapPath)) {
        phaseLookupFailed = true;
      }
    } else {
      phaseSection = section;
    }
  } catch { /* roadmap read failure → treat as empty (non-frontend) */ }
  return { phaseSection, phaseLookupFailed };
}
