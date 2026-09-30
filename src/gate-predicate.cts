/**
 * `check predicate` as a gate module (#5139, epic #5056, ADR-5057 §4 first bullet): generic
 * evaluator for capability gate `check.predicate` blocks (#2008). It returns a `GateResult`; the
 * command router formats it. Imports no io module and performs no direct console/stdout/stderr
 * write (ESLint-enforced).
 *
 * The workflow gate-dispatch invokes this for any gate whose `check` carries a `predicate` (instead
 * of a `query`); the predicate object is passed as `--predicate '<json>'`. The standard `{ block,
 * message, details? }` gate contract is the payload. A malformed predicate / unknown kind THROWS
 * inside the evaluator and is mapped here to a `usage` failure (non-zero exit at the router), which
 * the workflow's two-step gate contract treats as a step-1 command failure routed per the gate's
 * `onError`.
 *
 * Invocation (argv after the verb):
 *   --predicate '<json>' [--phase-dir <dir>] [--phase-number <n>] [--phase-req-ids <ids>]
 *
 * The subprocess runs at the runtime project root (`projectDir`), inheriting the process env.
 * Interpolation placeholders ${PHASE_NUMBER}/${PHASE_DIR}/${PHASE_REQ_IDS} are substituted from the
 * flags.
 */

import fs from 'node:fs';
import path from 'node:path';
import { gateVerdict, gateUsageFailure, isGateUsageFailure, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateResult } from './gate-verdict.cjs';
import { resolveContainedPath } from './gate-phase-context.cjs';
import { parsePredicateFlags } from './gate-args.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterMod = require('./frontmatter.cjs');
const { extractFrontmatter } = frontmatterMod;
import { tryWithinRoot } from './security.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import gatePredicateEval = require('./gate-predicate-evaluator.cjs');
const { evaluatePredicate } = gatePredicateEval;
import { execTool, platformReadSync } from './shell-command-projection.cjs';

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
export function buildPredicateDeps() {
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
    },
  };
}

export function evaluateCheckPredicate(input: { projectDir: string; args: readonly string[] }): GateResult {
  const { projectDir } = input;
  const flags = parsePredicateFlags(input.args);
  const predicateJson = flags['predicate'];
  if (!predicateJson) {
    return gateUsageFailure(
      GATE_FAILURE_CODE.SDK_MISSING_ARG,
      'predicate requires --predicate <json> (the gate hook check.predicate object)',
    );
  }
  let predicate: unknown;
  try {
    predicate = JSON.parse(predicateJson);
  } catch {
    return gateUsageFailure(GATE_FAILURE_CODE.USAGE, 'predicate --predicate value must be valid JSON');
  }
  const rawPhaseDir = flags['phase-dir'];
  let resolvedPhaseDir: string | undefined = rawPhaseDir;
  if (typeof rawPhaseDir === 'string' && rawPhaseDir !== '') {
    const resolved = resolveContainedPath(rawPhaseDir, projectDir);
    if (isGateUsageFailure(resolved)) return resolved;
    resolvedPhaseDir = resolved;
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
    return gateUsageFailure(GATE_FAILURE_CODE.USAGE, `gate predicate evaluation failed: ${(e as Error).message}`);
  }
  return gateVerdict(result.block ? 'block' : 'pass', result.block === true, { ...result });
}
