/**
 * Gate phase context — path/phase resolution shared by the gate modules (#5139, epic #5056,
 * ADR-5057 §4 first bullet, design D3).
 *
 * Round 1 owns the containment helper only: a caller-supplied path argument is resolved against
 * the project directory and must stay inside it. The helper RETURNS a `GateUsageFailure` on an
 * escape — a gate module never calls `error()` — and the router turns that failure into the same
 * `error(message, 'usage')` the pre-move router raised.
 */

import path from 'node:path';
import { tryWithinRoot, PathAcceptance } from './security.cjs';
import { gateUsageFailure, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateUsageFailure } from './gate-verdict.cjs';

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
