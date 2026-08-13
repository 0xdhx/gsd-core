/**
 * Health Diagnostic — ROADMAP/disk consistency rules (Phase 11, #3309,
 * ADR-3180 §8.2/§8.3/§8.5).
 *
 * Group: "ROADMAP/disk consistency" (design doc, "Rule table organization"
 * table) — W006, W007.
 *
 * Ported behavior-preserving from `cmdValidateHealth`
 * (`src/verify.cts:2029-2101`, the exact call sites for W006/W007).
 *
 * Both rules share ONE matcher — `matchPhaseDirs` + `normalizePhaseName`
 * (`src/phase-id.cts`), the same canonical directory-resolution owner
 * `verify.cts:2060/2073` already calls (its own #2528 comment explains why:
 * pairing roadmap phases against disk by intersecting independently-derived
 * TOKEN SETS mislabels digit-leading slugs like `05-80-20-cleanup` in BOTH
 * directions at once — phase 5 reads as missing a directory (W006) AND that
 * directory reads as not in the roadmap (W007) — so both rules here resolve
 * through `matchPhaseDirs`, never a hand-rolled string/token comparison, and
 * `dirsForPhase` below is the single call site both go through, so they
 * cannot independently drift on what "matches" means (#2528's own bug
 * class).
 *
 * DISK-SIDE SOURCE — `allPhaseDirNames`, NOT `phaseDirs` (found while
 * implementing this file, fixed inline rather than deferred).
 * `snapshot.phaseDirs` (Phase 10, `listMilestonePhaseDirs`) is WINDOWED: its
 * `inWindow` filter (`getMilestonePhaseFilter`, `src/roadmap-parser.cts:1220`)
 * admits a directory only when its phase id is a MEMBER of the roadmap's
 * current-milestone-declared phase set (`isDirInMilestone`). That makes
 * `phaseDirs.value` a subset that, by construction, can never contain a
 * directory the roadmap does NOT declare — exactly the directory W007 exists
 * to find. Sourced from `phaseDirs`, W007 would be structurally inert: every
 * member of the set is already provably claimable. Verified empirically
 * (`node -e` trace against a real `buildPlanningSnapshot`): a genuine orphan
 * directory (`04-extra`, no roadmap entry) was silently absent from
 * `phaseDirs.value` and W007 fired zero diagnostics. `phaseDirs`'s windowing
 * also risks a W006 false positive for a phase declared in a NON-current
 * milestone section (`roadmapDeclaredPhases` is built from the FULL raw
 * ROADMAP, all milestones — `src/planning-snapshot.cts:398-436` — while
 * `phaseDirs` is scoped to the current milestone only), so both rules here
 * use the new, additive `allPhaseDirNames` field
 * (`src/planning-snapshot.cts`) instead: every directory actually present
 * under the active `phases/` root, unfiltered by roadmap declaration.
 * Archived-milestone directory names (`verify.cts:2050`,
 * `collectArchivedPhaseDirNames`) are still not part of `PlanningSnapshot`
 * and remain a disclosed fidelity reduction (a phase whose only directory
 * lives in a shipped-milestone archive can read as W006-missing; a shipped
 * archived dir is never scanned so it cannot spuriously read as
 * W007-orphaned either) — unchanged by this fix.
 *
 * Not-started exclusion (verify.cts:2065/2075-2076,
 * `buildNotStartedPhaseVariants`, `src/validate.cts:160`): the design doc's
 * field table assigns this group only `roadmapDeclaredPhases`/`phaseDirs`,
 * and `roadmapDeclaredPhases` (`src/planning-snapshot.cts:398-436`) does
 * NOT filter not-started phases out — it returns every heading- and
 * checklist-declared phase id regardless of checked state (confirmed by
 * direct read: its `buildRoadmapPhaseVariants` call includes BOTH `[x]` and
 * `[ ]` checklist entries). Omitting the exclusion here would regress a
 * COMMON case: `gsd-core/templates/roadmap.md`'s "Initial Roadmap" shape
 * declares every phase as an unchecked `- [ ] **Phase N: [Name]**` checklist
 * item before any phase directory exists, so a freshly created ROADMAP.md
 * would immediately spam one W006 per phase. `snapshot.roadmapPhaseCheckboxes`
 * (`src/planning-snapshot.cts:457-480`, backs W011 in the STATE.md-consistency
 * group) already parses exactly this `[x]`/`[ ]` state — `check(snapshot)`'s
 * signature grants the full snapshot, not just this group's assigned column,
 * so `isPhaseNotStarted` below reads it directly rather than re-deriving a
 * third independent regex over raw ROADMAP text (forbidden by §8.1 rule 2).
 * KNOWN GAP, disclosed rather than silently dropped: `roadmapPhaseCheckboxes`
 * is keyed by `PHASE_NUMBER_TOKEN_SOURCE` (`phase-id.cts:54`, no dash), so a
 * milestone-dash-prefixed phase id ("2-01") can never match a checkbox key —
 * unlike the original `buildNotStartedPhaseVariants`, which captures the
 * fuller `[\w][\w.-]*` grammar (dashes included). For that id shape only,
 * this rule's not-started exclusion silently no-ops (never excludes), which
 * is the conservative direction (a possible false W006, not a suppressed
 * true one).
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 *
 * ADR-457 build-at-publish: source in
 * src/health-diagnostic-rules/roadmap-disk-consistency.cts, compiled to
 * gsd-core/bin/lib/health-diagnostic-rules/roadmap-disk-consistency.cjs
 * (gitignored).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- type-only; erased at compile time, no runtime require emitted
import type planningSnapshotMod = require('../planning-snapshot.cjs');

type PlanningSnapshot = ReturnType<typeof planningSnapshotMod.buildPlanningSnapshot>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import healthDiagnosticMod = require('../health-diagnostic.cjs');
const { SEVERITY, REMEDY_ACTION, REMEDY_RISK } = healthDiagnosticMod;
type Diagnostic = healthDiagnosticMod.Diagnostic;
type Rule = healthDiagnosticMod.Rule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('../planning-scope.cjs');
const { SCOPE } = planningScopeMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('../phase-id.cjs');
const { matchPhaseDirs, normalizePhaseName, extractPhaseToken, isSentinelPhaseId } = phaseIdMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import validateMod = require('../validate.cjs');
const { phaseVariants } = validateMod;

// ─── Shared matcher — the single call site both W006 and W007 go through ───

/**
 * Every on-disk directory (from `allPhaseDirNames.value`) that `phaseId`
 * resolves to via the canonical `matchPhaseDirs` selection. Both `checkW006`
 * (does ANY directory resolve) and `computeClaimedDirs` (which directories
 * does the roadmap claim, for W007) call this — one matcher, reused, per the
 * file-level comment.
 */
function dirsForPhase(dirs: string[], phaseId: string): string[] {
  return matchPhaseDirs(dirs, normalizePhaseName(phaseId)).matches;
}

/**
 * True when `phaseId` has an unchecked (`[ ]`) checklist entry in
 * `roadmapPhaseCheckboxes` under any of its padding/case variants
 * (`phaseVariants`, `src/validate.cts:101` — the same variant-expansion
 * owner `verify.cts:2071/2075` uses for this exact exclusion). See the
 * file-level comment for the KNOWN GAP on dash-shaped ids.
 */
function isPhaseNotStarted(phaseId: string, checkboxes: Record<string, boolean>): boolean {
  for (const variant of phaseVariants(phaseId)) {
    if (Object.prototype.hasOwnProperty.call(checkboxes, variant) && checkboxes[variant] === false) {
      return true;
    }
  }
  return false;
}

// ─── W006 — ROADMAP.md declares a phase with no directory on disk ─────────
// (verify.cts:2067-2084)

function checkW006(snapshot: PlanningSnapshot): Diagnostic[] {
  // Mirrors verify.cts:2029's `if (fs.existsSync(roadmapPath))` guard: ROADMAP.md
  // absent or unreadable means the field degrades to `{value: [], scope:
  // UNREADABLE}` (`src/planning-snapshot.cts:401-403/407-409`) and NEITHER
  // W006 nor W007 evaluates — an empty declared-phase list must not be
  // mistaken for "the roadmap legitimately declares zero phases" here.
  if (snapshot.roadmapDeclaredPhases.scope !== SCOPE.COMPLETE) return [];

  const dirs = snapshot.allPhaseDirNames.value;
  const checkboxes = snapshot.roadmapPhaseCheckboxes.value;
  const diagnostics: Diagnostic[] = [];

  for (const { phaseId } of snapshot.roadmapDeclaredPhases.value) {
    // #3225: sentinel phase ids (999.x/0.x) are never-on-roadmap by
    // convention; a sentinel heading shouldn't demand a directory.
    if (isSentinelPhaseId(phaseId)) continue;
    if (dirsForPhase(dirs, phaseId).length > 0) continue;
    if (isPhaseNotStarted(phaseId, checkboxes)) continue;
    diagnostics.push({
      code: 'W006',
      severity: SEVERITY.WARNING,
      message: `Phase ${phaseId} in ROADMAP.md but no directory on disk`,
      remedy: {
        action: REMEDY_ACTION.ADVISE,
        risk: REMEDY_RISK.NONE,
        args: { command: 'Create phase directory or remove from roadmap' },
      },
    });
  }
  return diagnostics;
}

// ─── W007 — an on-disk phase directory has no matching ROADMAP entry ──────
// (verify.cts:2086-2101)

/** Every directory in `dirs` that ANY declared roadmap phase resolves to. */
function computeClaimedDirs(
  dirs: string[],
  declaredPhases: { phaseId: string; milestone: string | null }[],
): Set<string> {
  const claimed = new Set<string>();
  for (const { phaseId } of declaredPhases) {
    for (const dir of dirsForPhase(dirs, phaseId)) claimed.add(dir);
  }
  return claimed;
}

function checkW007(snapshot: PlanningSnapshot): Diagnostic[] {
  // Same guard as W006 — see its comment.
  if (snapshot.roadmapDeclaredPhases.scope !== SCOPE.COMPLETE) return [];

  const dirs = snapshot.allPhaseDirNames.value;
  const claimedDirs = computeClaimedDirs(dirs, snapshot.roadmapDeclaredPhases.value);
  const diagnostics: Diagnostic[] = [];

  for (const dirName of dirs) {
    // `extractPhaseToken` is the phase-id.cts owner `PHASE_TOKEN_FROM_DIR_RE`
    // (`src/validate.cts:73-76`) is documented to match exactly
    // (verify.cts's original `p` key from `collectDiskPhaseEntries`,
    // `verify.cts:1373-1397`) — same token, relocated read, not reinvented.
    const token = extractPhaseToken(dirName);
    // #3225: a sentinel dir on disk (999-interim, 0-drafts) is defined as
    // never-on-roadmap; it must not trigger W007.
    if (isSentinelPhaseId(token)) continue;
    if (claimedDirs.has(dirName)) continue;
    diagnostics.push({
      code: 'W007',
      severity: SEVERITY.WARNING,
      message: `Phase ${token} exists on disk but not in ROADMAP.md`,
      remedy: {
        action: REMEDY_ACTION.ADVISE,
        risk: REMEDY_RISK.NONE,
        args: { command: 'Add to roadmap or remove directory' },
      },
    });
  }
  return diagnostics;
}

// ─── Exports ────────────────────────────────────────────────────────────────

const RULES: Rule[] = [
  { code: 'W006', severity: SEVERITY.WARNING, check: checkW006 },
  { code: 'W007', severity: SEVERITY.WARNING, check: checkW007 },
];

export = { RULES };
