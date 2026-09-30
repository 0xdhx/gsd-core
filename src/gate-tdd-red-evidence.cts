/**
 * `check tdd-red-evidence` as a gate module (#5139, epic #5056, ADR-5057 §4 first bullet, #3770):
 * it returns a `GateResult`; the command router formats it. Never imports `./io.cjs`, never
 * writes to stdout/stderr.
 *
 * Validates a persisted RED-phase test-run record for a `type: tdd` plan. Only an INTENTIONAL
 * failure of the target test (verdict RED_EVIDENCE_OK) may authorize GREEN; zero-test discovery,
 * fixture/load crashes, nonzero exits without a failing test, unrelated failures, and unexpected
 * greens are INVALID_RED and block GREEN. The record is the JSON the executor persists after
 * running the RED command: `{ command, exitCode, output, targetTest, targetFile?, expected?,
 * actual? }`. Fail-closed: a missing/unreadable/unparseable record is INVALID_RED (reason
 * `unreadable_record`), never a pass.
 *
 * Argv after the verb: `<record.json>`. The record path resolves against the PROCESS cwd
 * (`path.resolve`), exactly as before the move — it is not contained to the project directory.
 */

import path from 'node:path';
import { gateVerdict, gateUsageFailure, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateResult } from './gate-verdict.cjs';
import { readIfExists } from './decision-coverage-support.cjs';
import { classifyRedEvidence, buildRedEvidenceRecord } from './tdd-red-evidence.cjs';

export function evaluateTddRedEvidence(input: { projectDir: string; args: readonly string[] }): GateResult {
  const recordPath = typeof input.args[0] === 'string' ? input.args[0] : '';
  if (!recordPath) {
    return gateUsageFailure(
      GATE_FAILURE_CODE.SDK_MISSING_ARG,
      'tdd-red-evidence requires a record path: check tdd-red-evidence <record.json>',
    );
  }
  const resolved = path.resolve(recordPath);
  const text = readIfExists(resolved);
  const record = ((): Record<string, unknown> | null => {
    if (!text) return null;
    try {
      return (JSON.parse(text) ?? {}) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  if (!record) {
    return gateVerdict('block', true, {
      passed: false,
      block: true,
      verdict: 'INVALID_RED',
      reason: 'unreadable_record',
      record: resolved,
      readError: text ? `record is not valid JSON: ${resolved}` : `record not found or unreadable: ${resolved}`,
    });
  }
  const evidenceInput = {
    command: record['command'],
    exitCode: record['exitCode'],
    output: record['output'],
    targetTest: record['targetTest'],
    targetFile: record['targetFile'],
    expected: record['expected'],
    actual: record['actual'],
  };
  const result = classifyRedEvidence(evidenceInput);
  const built = buildRedEvidenceRecord(evidenceInput, result);
  const ok = result.verdict === 'RED_EVIDENCE_OK';
  // Uniform gate contract: block = !passed. INVALID_RED blocks GREEN.
  return gateVerdict(ok ? 'pass' : 'block', !ok, {
    passed: ok,
    block: !ok,
    verdict: result.verdict,
    reason: result.reason,
    evidence: result.evidence,
    record: built,
    message: ok
      ? `RED evidence verified: target test "${result.evidence.target_test}" failed as expected (exit ${result.evidence.exit_code}). GREEN authorized.`
      : `INVALID_RED (${result.reason}): GREEN blocked. Fix the RED phase — only an intentional failure of target test "${result.evidence.target_test}" authorizes production edits.`,
  });
}
