/**
 * Planning Snapshot — a parsed projection of `.planning/` (Phase 10, #3308,
 * ADR-3180 §8.1).
 *
 * Composed EXCLUSIVELY from the already-consolidated §7 owners
 * (`getMilestoneInfo`, `listMilestonePhaseDirs`, `isPhaseComplete`,
 * `scanPhasePlans`, `stateFieldValue`, `planningPaths`) plus the frozen
 * `SCOPE` enum. This module introduces no new semantic derivation — it
 * introduces exactly one new thing: `worstScope`, a way to combine several
 * independently-scoped owner answers into one composite record without
 * letting a caller treat a non-answer as data.
 *
 * `buildPlanningSnapshot(cwd)` is the sole export consumers reach for;
 * `worstScope` is exported alongside it for direct unit coverage.
 *
 * Design: .gsd/phase/refactor-3308-planning-snapshot-parsed-projection/40-design.md
 *
 * ADR-457 build-at-publish: source in src/planning-snapshot.cts, compiled to
 * gsd-core/bin/lib/planning-snapshot.cjs (gitignored).
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserMod = require('./roadmap-parser.cjs');
const { getMilestoneInfo } = roadmapParserMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorMod = require('./phase-locator.cjs');
const { listMilestonePhaseDirs } = phaseLocatorMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import verificationMod = require('./verification.cjs');
const { isPhaseComplete } = verificationMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import scanPhasePlans = require('./plan-scan.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningPaths, planningRoot } = planningWorkspace;
import { platformReadSync, execGit } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterMod = require('./frontmatter.cjs');
const { extractFrontmatter, stripFrontmatter } = frontmatterMod;
import { stateFieldValue, stateCurrentPositionSlice } from './state-document.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import unusableInputMod = require('./unusable-input.cjs');
const { UNUSABLE_REASON, warnUnusableInput } = unusableInputMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;
type Scope = planningScopeMod.Scope;
import { resolveRuntime } from './runtime-slash.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- agent-install-check.cjs is an export= CommonJS module
import agentInstallCheckMod = require('./agent-install-check.cjs');
const { checkAgentsInstalled } = agentInstallCheckMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- worktree-safety.cjs is an export= CommonJS module
import worktreeSafetyMod = require('./worktree-safety.cjs');
const { inspectWorktreeHealth } = worktreeSafetyMod;

// ─── worstScope — the one new piece of coordination logic ───────────────────

/**
 * Severity ordering (`UNREADABLE` worst, `COMPLETE` best) is a genuine design
 * choice, not inherited from anywhere — see the design doc's "Scope
 * combination" section. `TRUNCATED` vs `UNSCOPED` are not ranked against each
 * other by any upstream decision; this ordering exists only so a future
 * diagnostic rule can name which failure was worse when several compound.
 */
const SCOPE_SEVERITY: Record<Scope, number> = {
  [SCOPE.COMPLETE]: 0,
  [SCOPE.TRUNCATED]: 1,
  [SCOPE.UNSCOPED]: 2,
  [SCOPE.UNREADABLE]: 3,
};

/**
 * Combine several independently-scoped owner answers into the single worst
 * (most severe) `Scope` among them. Pure, no I/O. Not a re-derivation of any
 * §7 owner — it folds together already-final `scope` outputs, which is new
 * coordination logic no single owner has visibility to express itself.
 */
function worstScope(...scopes: Scope[]): Scope {
  return scopes.reduce((worst, s) => (SCOPE_SEVERITY[s] > SCOPE_SEVERITY[worst] ? s : worst));
}

// ─── Snapshot shape ───────────────────────────────────────────────────────────

interface PhaseSnapshot {
  dir: string;
  complete: boolean;
  verificationStatus: string;
  planCount: number;
  summaryCount: number;
  scope: Scope;
}

interface PlanningSnapshot {
  milestone: ReturnType<typeof getMilestoneInfo>;
  phaseDirs: ReturnType<typeof listMilestonePhaseDirs>;
  phases: { value: PhaseSnapshot[]; scope: Scope };
  currentPhaseLabel: { value: string | null; scope: Scope };
  // ─── Phase 11 (#3309, ADR-3180 §8.2/§8.3/§8.5) additions ───────────────────
  // Additive-only — see the design doc's "The subject-surface gap" section.
  // `config` genuinely lives under `.planning/`; `agentInstall` and
  // `worktreeHealth` do not (named as such so a future reader does not
  // mistake them for §7 derivations) but are exposed here anyway so every
  // rule's `check(snapshot)` signature stays the single object §8.1 rule 1
  // names, "the snapshot".
  config: { value: Record<string, unknown> | null; scope: Scope; exists: boolean };
  agentInstall: { value: ReturnType<typeof checkAgentsInstalled>; scope: Scope };
  worktreeHealth: { value: ReturnType<typeof inspectWorktreeHealth>['findings']; scope: Scope };
}

/**
 * Build one `PhaseSnapshot` for a single already-enumerated phase directory
 * name. `isPhaseComplete` and `scanPhasePlans` each perform their own raw
 * `readdirSync` against `fullPhaseDir` and can independently degrade — see
 * the design doc's "Scope combination" section for why the two are genuinely
 * uncorrelated (isPhaseComplete's readability check never re-derives or
 * requires scanPhasePlans, and vice versa).
 */
function buildPhaseSnapshot(phasesDir: string, dir: string): PhaseSnapshot {
  const fullPhaseDir = path.join(phasesDir, dir);
  const completionResult = isPhaseComplete(fullPhaseDir);
  const scanResult = scanPhasePlans(fullPhaseDir);
  return {
    dir,
    complete: completionResult.value.complete,
    verificationStatus: completionResult.value.verification.status,
    planCount: scanResult.planCount,
    summaryCount: scanResult.summaryCount,
    scope: worstScope(completionResult.scope, scanResult.scope),
  };
}

/**
 * Resolve `currentPhaseLabel` — the raw `Phase:` field STATE.md records under
 * `## Current Position` (e.g. `"3 of 8 (User Auth)"`), not a normalized
 * phase-directory id (see the design doc's Known limits).
 *
 * This module performs the one STATE.md read no §7 owner does, mirroring
 * every existing STATE.md caller (`cmdStateSnapshot`, `cmdStatePrune`):
 * `platformReadSync` + `extractFrontmatter` + `stripFrontmatter`.
 *
 * - STATE.md absent (ENOENT, `platformReadSync` returns `null`) is a real
 *   non-answer, NOT corruption — a project that never ran `state.init`
 *   legitimately has no STATE.md yet. `warnUnusableInput` is NOT called.
 * - STATE.md present but unreadable (any other read error, e.g. EISDIR) is
 *   corruption — `warnUnusableInput(STATE_UNREADABLE)` fires exactly once.
 * - An unterminated frontmatter fence is reported by `extractFrontmatter`
 *   itself (`FRONTMATTER_UNTERMINATED`) — this function does not duplicate
 *   that diagnostic; it still attempts a body-only field read on whatever
 *   `stripFrontmatter` leaves behind.
 */
function buildCurrentPhaseLabel(statePath: string): { value: string | null; scope: Scope } {
  let content: string | null;
  try {
    content = platformReadSync(statePath);
  } catch {
    warnUnusableInput({ reason: UNUSABLE_REASON.STATE_UNREADABLE, source: statePath });
    return { value: null, scope: SCOPE.UNREADABLE };
  }
  if (content === null) {
    return { value: null, scope: SCOPE.UNREADABLE };
  }

  const frontmatter = extractFrontmatter(content, statePath);
  const body = stripFrontmatter(content);
  const section = stateCurrentPositionSlice(body);
  return stateFieldValue(frontmatter, section ?? body, null, 'Phase', {
    scope: section === null ? SCOPE.TRUNCATED : SCOPE.COMPLETE,
  });
}

/**
 * Resolve `config` — the parsed `.planning/config.json`, preserving the same
 * three-way distinction `cmdValidateHealth` (`src/verify.cts` W003/E005)
 * already makes without going through `loadConfig` (which collapses that
 * distinction): absent is a real non-answer — `{value: null, scope:
 * UNREADABLE, exists: false}`, no `warnUnusableInput` call, mirrors
 * `buildCurrentPhaseLabel`'s treatment of an absent STATE.md; present but
 * unparseable JSON IS corruption — `{value: null, scope: UNREADABLE, exists:
 * true}`, `warnUnusableInput(CONFIG_UNREADABLE)` fires exactly once, so a
 * later health-diagnostic rule can tell "config.json not found" (W003,
 * repairable via `createConfig`) apart from "config.json: JSON parse error"
 * (E005, repairable via `resetConfig`) — the `exists` flag is exactly that
 * discriminator. `config.json` is root-scoped (`planningRoot`), NOT
 * workstream-scoped (`planningPaths(cwd).config` would resolve under
 * `.planning/workstreams/<ws>/` instead) — see verify.cts's own
 * rootBase-vs-wsBase split at cmdValidateHealth's top.
 */
function buildConfigField(cwd: string): { value: Record<string, unknown> | null; scope: Scope; exists: boolean } {
  const configPath = path.join(planningRoot(cwd), 'config.json');
  if (!fs.existsSync(configPath)) {
    return { value: null, scope: SCOPE.UNREADABLE, exists: false };
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { value: parsed, scope: SCOPE.COMPLETE, exists: true };
  } catch {
    warnUnusableInput({ reason: UNUSABLE_REASON.CONFIG_UNREADABLE, source: configPath });
    return { value: null, scope: SCOPE.UNREADABLE, exists: true };
  }
}

/**
 * Resolve `agentInstall` — wraps `checkAgentsInstalled(runtime, cwd)` with
 * the same `runtime` `cmdValidateHealth` resolves (`resolveRuntime(cwd)`,
 * its `_slashRuntime`). Not `.planning/`-sourced (see design doc). `scope`
 * is `COMPLETE` whenever the scan itself ran, even when it reports missing
 * or incomplete agents — that is a real answer, not a non-answer.
 * `UNREADABLE` only if the scan itself throws, mirroring cmdValidateHealth's
 * own try/catch around this same call (there, the exception is swallowed as
 * "non-blocking"; here it is surfaced via `scope` instead of silently
 * dropped, since a snapshot field has nowhere else to carry that fact).
 */
function buildAgentInstallField(cwd: string): { value: ReturnType<typeof checkAgentsInstalled>; scope: Scope } {
  const runtime = resolveRuntime(cwd);
  try {
    return { value: checkAgentsInstalled(runtime, cwd), scope: SCOPE.COMPLETE };
  } catch {
    return {
      value: {
        agents_installed: false,
        missing_agents: [],
        installed_agents: [],
        incomplete_agents: [],
        agents_dir: '',
        agent_runtime: runtime,
      },
      scope: SCOPE.UNREADABLE,
    };
  }
}

/**
 * Resolve `worktreeHealth` — wraps `inspectWorktreeHealth(cwd, { staleAfterMs
 * }, deps)` with the exact same arguments `cmdValidateHealth` passes
 * (`src/verify.cts` W017/W020/W027 call sites): a 1-hour staleness window,
 * and the raw `execGit`/`fs.existsSync`/`fs.statSync` seam (not
 * `worktree-safety.cts`'s own `execGitDefault` wrapper). Not
 * `.planning/`-sourced (see design doc). `scope` is `COMPLETE` only when the
 * underlying `git worktree list` scan itself succeeded (`ok: true`) — a
 * timed-out or failed scan (`ok: false`, mirroring W020's degraded-check
 * report) or a thrown exception (mirrors cmdValidateHealth's own
 * "git worktree not available or not a git repo — skip silently" catch)
 * both degrade to `UNREADABLE` with an empty findings array, since neither
 * case has real per-worktree data to report.
 */
function buildWorktreeHealthField(cwd: string): { value: ReturnType<typeof inspectWorktreeHealth>['findings']; scope: Scope } {
  try {
    const result = inspectWorktreeHealth(
      cwd,
      { staleAfterMs: 60 * 60 * 1000 },
      { execGit, existsSync: fs.existsSync, statSync: fs.statSync },
    );
    if (!result.ok) {
      return { value: [], scope: SCOPE.UNREADABLE };
    }
    return { value: result.findings, scope: SCOPE.COMPLETE };
  } catch {
    return { value: [], scope: SCOPE.UNREADABLE };
  }
}

/**
 * Build the full `.planning/` projection for `cwd`. Composes the six §7
 * owners named in the design doc's "Owners consumed" table, plus (Phase 11,
 * #3309) the three additive subject-surface fields `config`/`agentInstall`/
 * `worktreeHealth` — no re-derivation, no new semantic answer beyond what
 * their respective owners already compute. See the design doc for the
 * behavior table and rejected alternatives.
 */
function buildPlanningSnapshot(cwd: string): PlanningSnapshot {
  const paths = planningPaths(cwd);
  const milestone = getMilestoneInfo(cwd);
  const phaseDirs = listMilestonePhaseDirs(paths.phases, { cwd });

  const phasesValue = phaseDirs.value.map((dir) => buildPhaseSnapshot(paths.phases, dir));

  return {
    milestone,
    phaseDirs,
    phases: {
      value: phasesValue,
      scope: worstScope(phaseDirs.scope, ...phasesValue.map((p) => p.scope)),
    },
    currentPhaseLabel: buildCurrentPhaseLabel(paths.state),
    config: buildConfigField(cwd),
    agentInstall: buildAgentInstallField(cwd),
    worktreeHealth: buildWorktreeHealthField(cwd),
  };
}

export = {
  buildPlanningSnapshot,
  worstScope,
};
