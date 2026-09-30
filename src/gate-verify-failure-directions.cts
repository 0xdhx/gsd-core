/**
 * `check verify-failure-directions` as a gate module (#5139, epic #5056, ADR-5057 §4 first bullet,
 * #3172): it returns a `GateResult`; the command router formats it. Never imports `./io.cjs`,
 * never writes to stdout/stderr.
 *
 * Probes every `<automated>` verify command declared in a phase's `-PLAN.md` files for a stated
 * `<fails_when>` failing direction — see `verify-command-grounding.cts` for the recognizer
 * contract.
 *
 * Argv after the verb: `<phase>`. When the phase is missing or cannot be resolved to a directory
 * the gate returns a non-throwing degraded payload (status/commands/counts zeroed, `readError`
 * populated) rather than a usage failure — the plan-checker parses this result and must be able to
 * tell "nothing to report" from "could not look".
 */

import { gateVerdict } from './gate-verdict.cjs';
import type { GateResult } from './gate-verdict.cjs';
import { resolvePhaseDirOrEmpty } from './gate-phase-context.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import verifyCommandGroundingMod = require('./verify-command-grounding.cjs');
const { probePhaseFailingDirections } = verifyCommandGroundingMod;

function unresolvable(readError: string): GateResult {
  return gateVerdict('skip', false, {
    status: 'unresolvable',
    commands: [],
    counts: { blocker: 0, warning: 0, total: 0 },
    readError,
  });
}

export function evaluateVerifyFailureDirections(input: { projectDir: string; args: readonly string[] }): GateResult {
  const phase = input.args[0] || '';
  if (!phase) {
    return unresolvable('verify-failure-directions requires a phase argument: check verify-failure-directions <phase>');
  }

  const phaseDir = resolvePhaseDirOrEmpty(input.projectDir, phase);
  if (!phaseDir) {
    return unresolvable(`could not resolve phase directory for phase ${phase}`);
  }

  const probed = probePhaseFailingDirections({ phaseDir });
  const blocked = probed.counts.blocker > 0;
  const outcome = blocked ? 'block' : probed.status === 'unresolvable' ? 'skip' : 'pass';
  return gateVerdict(outcome, blocked, { ...probed });
}
