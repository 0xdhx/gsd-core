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
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { PHASE_NUMBER_TOKEN_SOURCE, OPTIONAL_PHASE_TAG_SOURCE } = phaseIdMod;
import { buildRoadmapPhaseVariants } from './validate.cjs';

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
  // ─── Phase 11 (#3309) "Rule table organization" additions ─────────────────
  // The design doc's own "Rule table organization" table and prose disagree
  // on the count: the table lists EIGHT rows (through `planningRootFiles`,
  // W019) but the prose says "7 more fields" / "14 fields after this batch".
  // This implementation follows the table (and the task brief, which
  // separately enumerates all eight) — every field a reused owner or a
  // small, relocated (not new-algorithm) derivation. `PlanningSnapshot`
  // therefore totals 15 fields after this batch, not 14; flagged here rather
  // than silently reconciled, since correcting the design doc's prose is
  // outside this diff's scope.
  projectSections: { value: string[] | null; scope: Scope; exists: boolean };
  statePhaseTokens: { value: string[]; scope: Scope };
  stateStatus: { value: string | null; scope: Scope };
  roadmapDeclaredPhases: { value: { phaseId: string; milestone: string | null }[]; scope: Scope };
  roadmapPhaseCheckboxes: { value: Record<string, boolean>; scope: Scope };
  researchValidationStatus: {
    value: { dir: string; hasValidationArchitecture: boolean; hasValidationMd: boolean }[];
    scope: Scope;
  };
  milestoneArchiveStatus: {
    value: { archivedVersions: string[]; documentedVersions: string[] };
    scope: Scope;
  };
  planningRootFiles: { value: string[]; scope: Scope };
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

interface StateFields {
  currentPhaseLabel: { value: string | null; scope: Scope };
  statePhaseTokens: { value: string[]; scope: Scope };
  stateStatus: { value: string | null; scope: Scope };
}

/**
 * Resolve every STATE.md-sourced field in one place: `currentPhaseLabel` (the
 * raw `Phase:` field under `## Current Position`, e.g. `"3 of 8 (User
 * Auth)"`, not a normalized phase-directory id — see the design doc's Known
 * limits), `statePhaseTokens` (Phase 11, #3309 — every phase-number-shaped
 * token found anywhere in STATE.md's raw text, backs W002), and `stateStatus`
 * (Phase 11, #3309 — the `status`/`Status` field, backs W011).
 *
 * Phase 10 shipped `currentPhaseLabel` as its own single-purpose reader
 * (`buildCurrentPhaseLabel(statePath)`); this phase folds two more STATE.md
 * derivations in rather than reading and parsing the same file three times
 * per `buildPlanningSnapshot` call — the read, `extractFrontmatter`, and
 * `stripFrontmatter` are genuinely shared inputs for all three, and sharing
 * them means `warnUnusableInput(STATE_UNREADABLE)` also stays a single call
 * site instead of a risk of tripling on one degraded read.
 *
 * This module performs the one STATE.md read no §7 owner does, mirroring
 * every existing STATE.md caller (`cmdStateSnapshot`, `cmdStatePrune`):
 * `platformReadSync` + `extractFrontmatter` + `stripFrontmatter`.
 *
 * - STATE.md absent (ENOENT, `platformReadSync` returns `null`) is a real
 *   non-answer, NOT corruption — a project that never ran `state.init`
 *   legitimately has no STATE.md yet. `warnUnusableInput` is NOT called.
 * - STATE.md present but unreadable (any other read error, e.g. EISDIR) is
 *   corruption — `warnUnusableInput(STATE_UNREADABLE)` fires exactly once,
 *   and all three fields degrade to their UNREADABLE non-answer together.
 * - An unterminated frontmatter fence is reported by `extractFrontmatter`
 *   itself (`FRONTMATTER_UNTERMINATED`) — this function does not duplicate
 *   that diagnostic; it still attempts a body-only field read on whatever
 *   `stripFrontmatter` leaves behind.
 * - `currentPhaseLabel`/`stateStatus` both live under `## Current Position`
 *   (`gsd-core/templates/state.md`) and both use `stateFieldValue`
 *   (`state-document.cts:296`) the exact way `smart-entry.cts:448`/
 *   `state.cts:1561,3273` already call it for `'status'`/`'Status'` — so a
 *   missing `## Current Position` section degrades BOTH to `TRUNCATED` with
 *   a whole-body fallback, together.
 * - `statePhaseTokens` scans the WHOLE document (`verify.cts`'s exact
 *   `PHASE_NUMBER_TOKEN_SOURCE` regex, relocated verbatim from
 *   `verify.cts:1731-1735`), not just the Current Position section, so it is
 *   NOT degraded to `TRUNCATED` by a missing section header — it stays
 *   `COMPLETE` whenever the file itself was read successfully.
 */
function buildStateFields(statePath: string): StateFields {
  let content: string | null;
  try {
    content = platformReadSync(statePath);
  } catch {
    warnUnusableInput({ reason: UNUSABLE_REASON.STATE_UNREADABLE, source: statePath });
    return {
      currentPhaseLabel: { value: null, scope: SCOPE.UNREADABLE },
      statePhaseTokens: { value: [], scope: SCOPE.UNREADABLE },
      stateStatus: { value: null, scope: SCOPE.UNREADABLE },
    };
  }
  if (content === null) {
    return {
      currentPhaseLabel: { value: null, scope: SCOPE.UNREADABLE },
      statePhaseTokens: { value: [], scope: SCOPE.UNREADABLE },
      stateStatus: { value: null, scope: SCOPE.UNREADABLE },
    };
  }

  const frontmatter = extractFrontmatter(content, statePath);
  const body = stripFrontmatter(content);
  const section = stateCurrentPositionSlice(body);
  const currentPositionScope = section === null ? SCOPE.TRUNCATED : SCOPE.COMPLETE;

  const currentPhaseLabel = stateFieldValue(frontmatter, section ?? body, null, 'Phase', {
    scope: currentPositionScope,
  });
  const stateStatus = stateFieldValue(frontmatter, section ?? body, 'status', 'Status', {
    scope: currentPositionScope,
  });
  const statePhaseTokens = {
    value: [...content.matchAll(new RegExp(`[Pp]hase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})`, 'g'))].map(
      (m) => m[1],
    ),
    scope: SCOPE.COMPLETE,
  };

  return { currentPhaseLabel, statePhaseTokens, stateStatus };
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

// ─── Phase 11 (#3309) "Rule table organization" builders ────────────────────
// Each relocates (not reinvents) an existing `verify.cts` derivation. See the
// design doc's "Rule table organization" table for the exact source lines.

/**
 * Resolve `projectSections` — the `##`-level section headings actually
 * present in `.planning/PROJECT.md`, as a plain list (NOT filtered against a
 * required-sections list — the caller, the future W001/E002 rules, do that
 * comparison). Relocates the read+parse half of `verify.cts:1681-1691`
 * (E002/W001), generalized from "does the file include these three fixed
 * strings" to "what headings does the file actually have."
 *
 * PROJECT.md is root-scoped (`planningRoot(cwd)`), NOT workstream-scoped —
 * mirrors `cmdValidateHealth`'s own `projectPath = path.join(rootBase,
 * 'PROJECT.md')` (`verify.cts:1649`), the same root-vs-workstream split
 * `buildConfigField` already documents for config.json.
 *
 * Same `exists`-discriminator shape as `config`: absent file is a real
 * non-answer (`{value: null, scope: UNREADABLE, exists: false}`, no
 * `warnUnusableInput`); present but unreadable IS corruption —
 * `{value: null, scope: UNREADABLE, exists: true}`,
 * `warnUnusableInput(PROJECT_UNREADABLE)` fires exactly once, mirroring
 * `buildConfigField`'s treatment of a present-but-unparseable config.json.
 */
function buildProjectSectionsField(cwd: string): { value: string[] | null; scope: Scope; exists: boolean } {
  const projectPath = path.join(planningRoot(cwd), 'PROJECT.md');
  if (!fs.existsSync(projectPath)) {
    return { value: null, scope: SCOPE.UNREADABLE, exists: false };
  }
  let content: string;
  try {
    content = fs.readFileSync(projectPath, 'utf-8');
  } catch {
    warnUnusableInput({ reason: UNUSABLE_REASON.PROJECT_UNREADABLE, source: projectPath });
    return { value: null, scope: SCOPE.UNREADABLE, exists: true };
  }
  const value = [...content.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
  return { value, scope: SCOPE.COMPLETE, exists: true };
}

/**
 * Resolve `roadmapDeclaredPhases` — every phase id ROADMAP.md declares
 * (heading-style AND checklist-style, not filtered to disk presence), each
 * paired with the milestone-version section it was found under (`null` when
 * found outside any versioned section). Backs W006/W007 (declared-phase
 * half) and W021(2288)/W026(2392) (milestone-attribution half).
 *
 * The declared-phase-id half reuses `buildRoadmapPhaseVariants`
 * (`validate.cts:136`, already imported by `verify.cts:12` — genuine existing
 * reuse). The milestone-attribution half relocates
 * `checkMilestonePrefixMismatches`'s `sectionRx`-based section walk
 * (`verify.cts:1429-1459`, local/unexported there), generalized from "record
 * only the mismatches" to "record every attribution" — this field exposes
 * the parsed fact; the future W021/W026 rules make the mismatch judgment.
 */
function buildRoadmapDeclaredPhasesField(
  roadmapPath: string,
): { value: { phaseId: string; milestone: string | null }[]; scope: Scope } {
  if (!fs.existsSync(roadmapPath)) {
    return { value: [], scope: SCOPE.UNREADABLE };
  }
  let content: string;
  try {
    content = fs.readFileSync(roadmapPath, 'utf-8');
  } catch {
    return { value: [], scope: SCOPE.UNREADABLE };
  }

  const { roadmapPhases } = buildRoadmapPhaseVariants(content);

  const milestoneByPhase = new Map<string, string>();
  const sectionRx = /^#{1,3}\s+(?:\[[^\]]{1,200}\]\s*)?.*v(\d+\.\d+)/gim;
  const sections: { version: string; start: number; end: number }[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = sectionRx.exec(content)) !== null) {
    if (sections.length > 0) sections[sections.length - 1].end = sm.index;
    sections.push({ version: `v${sm[1]}`, start: sm.index, end: content.length });
  }
  const phaseRx = /#{2,4}\s*(?:\[[^\]]{1,200}\]\s*)?Phase\s+([\w][\w.-]*)(?:\s*\([^)\n]{0,200}\))?\s*:/gi;
  for (const section of sections) {
    const sectionContent = content.slice(section.start, section.end);
    phaseRx.lastIndex = 0;
    let pm: RegExpExecArray | null;
    while ((pm = phaseRx.exec(sectionContent)) !== null) {
      if (!milestoneByPhase.has(pm[1])) milestoneByPhase.set(pm[1], section.version);
    }
  }

  const value = [...roadmapPhases].map((phaseId) => ({
    phaseId,
    milestone: milestoneByPhase.get(phaseId) ?? null,
  }));
  return { value, scope: SCOPE.COMPLETE };
}

/**
 * Resolve `roadmapPhaseCheckboxes` — parsed `[x]`/`[ ]` checkbox state per
 * phase from ROADMAP.md's progress-table region, keyed by phase id. Backs
 * W011.
 *
 * Relocates and generalizes `verify.cts`'s W011 block (`verify.cts:2104-
 * 2134`): that call site builds ONE hardcoded `phaseCheckboxRe` testing a
 * single target phase id (STATE's current phase) for a `[x]` match. This
 * builder is the same regex shape, generalized to CAPTURE both the check
 * character and the phase id instead of interpolating one fixed target, so
 * every declared checkbox is recorded, not just one.
 *
 * NOT a re-derivation of `isPhaseComplete` (`verification.cts:557`, ADR-3180
 * §7.4, disk-strict): that owner explicitly refuses to consult the ROADMAP
 * checkbox at all when DECIDING phase completion (`verification.cts:536-
 * 537`). This field only exposes what the checkbox literally says, for a
 * diagnostic (W011) whose entire purpose is flagging when the two DISAGREE —
 * reading the data is not re-litigating who is authoritative.
 */
function buildRoadmapPhaseCheckboxesField(
  roadmapPath: string,
): { value: Record<string, boolean>; scope: Scope } {
  if (!fs.existsSync(roadmapPath)) {
    return { value: {}, scope: SCOPE.UNREADABLE };
  }
  let content: string;
  try {
    content = fs.readFileSync(roadmapPath, 'utf-8');
  } catch {
    return { value: {}, scope: SCOPE.UNREADABLE };
  }

  const checkboxRe = new RegExp(
    `-\\s*\\[([xX ])\\].*?Phase\\s+0*(${PHASE_NUMBER_TOKEN_SOURCE})${OPTIONAL_PHASE_TAG_SOURCE}[:\\s]`,
    'gi',
  );
  const value: Record<string, boolean> = {};
  let m: RegExpExecArray | null;
  while ((m = checkboxRe.exec(content)) !== null) {
    value[m[2]] = m[1].toLowerCase() === 'x';
  }
  return { value, scope: SCOPE.COMPLETE };
}

/**
 * Resolve `researchValidationStatus` — per phase directory, whether its
 * `*-RESEARCH.md` contains the literal heading `## Validation Architecture`,
 * and whether a `*-VALIDATION.md` file exists in the same directory. Backs
 * W009.
 *
 * Relocates the file-naming convention `verify.cts:1967-1990` (W009) uses to
 * find "the" RESEARCH.md / VALIDATION.md in a phase dir: a flat,
 * non-recursive `readdirSync` of the phase dir, then the first entry whose
 * name ends `-RESEARCH.md` / any entry ending `-VALIDATION.md`. Computed for
 * EVERY phase dir unconditionally (verify.cts's W009 only reads RESEARCH.md
 * when `hasResearch && !hasValidation`; this field exposes both booleans
 * regardless, so the future W009 rule does its own `hasResearch &&
 * hasValidationArchitecture && !hasValidationMd` check against parsed data,
 * not raw text).
 *
 * `scope` mirrors `phaseDirs.scope` (the caller-supplied enumeration): a
 * per-directory read failure degrades that single entry's booleans to
 * `false` and is silently skipped, mirroring `verify.cts`'s own
 * `catch { intentionally empty }` around this exact read — this is a
 * deliberate fail-open match to the pre-migration behavior, not a scope
 * degradation, since the original never surfaced these failures either.
 */
function buildResearchValidationStatusField(
  phasesDir: string,
  phaseDirNames: string[],
  enumerationScope: Scope,
): {
  value: { dir: string; hasValidationArchitecture: boolean; hasValidationMd: boolean }[];
  scope: Scope;
} {
  const value = phaseDirNames.map((dir) => {
    const fullPhaseDir = path.join(phasesDir, dir);
    let files: string[];
    try {
      files = fs.readdirSync(fullPhaseDir);
    } catch {
      return { dir, hasValidationArchitecture: false, hasValidationMd: false };
    }
    const researchFile = files.find((f) => f.endsWith('-RESEARCH.md'));
    const hasValidationMd = files.some((f) => f.endsWith('-VALIDATION.md'));
    let hasValidationArchitecture = false;
    if (researchFile) {
      try {
        const researchContent = fs.readFileSync(path.join(fullPhaseDir, researchFile), 'utf-8');
        hasValidationArchitecture = researchContent.includes('## Validation Architecture');
      } catch {
        /* intentionally empty — mirrors verify.cts:1986-1988's own silent skip */
      }
    }
    return { dir, hasValidationArchitecture, hasValidationMd };
  });
  return { value, scope: enumerationScope };
}

/**
 * Resolve `milestoneArchiveStatus` — `archivedVersions` (versions with a
 * `milestones/<ver>-ROADMAP.md` snapshot file present) and `documentedVersions`
 * (`## <version>` headings already present in MILESTONES.md). Backs W018.
 *
 * Relocates `verify.cts:2301-2335` (W018)'s directory-scan glob
 * (`^(v\d+\.\d+(?:\.\d+)?)-ROADMAP\.md$` against a flat, non-recursive
 * `readdirSync` of `.planning/milestones/`) and its MILESTONES.md
 * heading-membership check, generalized from "is THIS archived version's
 * heading present" to "list every `## <version>` heading MILESTONES.md has."
 *
 * Confirmed NOT a fit for `listArchiveVersionDirs`
 * (`phase-locator.cts:127`): that function scans `milestones/*-phases/`
 * DIRECTORIES, a different target than this field's `milestones/*-ROADMAP.md`
 * FILES — reusing it here would silently answer the wrong question.
 *
 * Root-scoped (`planningRoot(cwd)`), matching `verify.cts`'s own
 * `rootBase`-based `milestonesPath`/`milestonesArchiveDir`.
 */
function buildMilestoneArchiveStatusField(
  cwd: string,
): { value: { archivedVersions: string[]; documentedVersions: string[] }; scope: Scope } {
  const rootBase = planningRoot(cwd);
  const milestonesArchiveDir = path.join(rootBase, 'milestones');
  const milestonesPath = path.join(rootBase, 'MILESTONES.md');

  let archivedVersions: string[] = [];
  let scope: Scope = SCOPE.COMPLETE;
  if (fs.existsSync(milestonesArchiveDir)) {
    try {
      const archiveFiles = fs.readdirSync(milestonesArchiveDir);
      archivedVersions = archiveFiles
        .map((f) => f.match(/^(v\d+\.\d+(?:\.\d+)?)-ROADMAP\.md$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => m[1]);
    } catch {
      scope = SCOPE.UNREADABLE;
    }
  }

  let documentedVersions: string[] = [];
  if (fs.existsSync(milestonesPath)) {
    try {
      const registryContent = fs.readFileSync(milestonesPath, 'utf-8');
      documentedVersions = [...registryContent.matchAll(/^##\s+(v\d+\.\d+(?:\.\d+)?)/gm)].map(
        (m) => m[1],
      );
    } catch {
      scope = worstScope(scope, SCOPE.UNREADABLE);
    }
  }

  return { value: { archivedVersions, documentedVersions }, scope };
}

/**
 * Resolve `planningRootFiles` — plain listing of file (not directory) names
 * directly under `.planning/` root. Backs W019.
 *
 * Pairs with the existing exported `isCanonicalPlanningFile` predicate
 * (`artifacts.cts:43`) — but per the design doc, that predicate is called by
 * the future W019 RULE per filename, not by this builder; this field only
 * needs to BE the raw filename list.
 */
function buildPlanningRootFilesField(cwd: string): { value: string[]; scope: Scope } {
  try {
    const entries = fs.readdirSync(planningRoot(cwd), { withFileTypes: true });
    return { value: entries.filter((e) => e.isFile()).map((e) => e.name), scope: SCOPE.COMPLETE };
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
  const stateFields = buildStateFields(paths.state);

  return {
    milestone,
    phaseDirs,
    phases: {
      value: phasesValue,
      scope: worstScope(phaseDirs.scope, ...phasesValue.map((p) => p.scope)),
    },
    currentPhaseLabel: stateFields.currentPhaseLabel,
    config: buildConfigField(cwd),
    agentInstall: buildAgentInstallField(cwd),
    worktreeHealth: buildWorktreeHealthField(cwd),
    projectSections: buildProjectSectionsField(cwd),
    statePhaseTokens: stateFields.statePhaseTokens,
    stateStatus: stateFields.stateStatus,
    roadmapDeclaredPhases: buildRoadmapDeclaredPhasesField(paths.roadmap),
    roadmapPhaseCheckboxes: buildRoadmapPhaseCheckboxesField(paths.roadmap),
    researchValidationStatus: buildResearchValidationStatusField(paths.phases, phaseDirs.value, phaseDirs.scope),
    milestoneArchiveStatus: buildMilestoneArchiveStatusField(cwd),
    planningRootFiles: buildPlanningRootFilesField(cwd),
  };
}

export = {
  buildPlanningSnapshot,
  worstScope,
};
