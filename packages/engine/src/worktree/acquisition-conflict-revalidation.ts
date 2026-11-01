/*
FNXC:AcquisitionConflictRevalidation 2026-11-01-13:12 (RUFU-356):
The invariant this module exists to hold: a card is never kept terminalized by an acquisition error
whose live-git conflict premise is provably gone.

Worktree acquisition already re-inspects live git on EVERY attempt — `inspectBareBranchCollision`
runs `git worktree prune`, the branch-registration lookup, and tip-commit attribution fresh. The
hole was the state AFTER terminalization: once the three-strike heartbeat park lands, the only
remaining record of the conflict is the sentence stored in `task.error`, and nothing re-examined it.
A card whose path, worktree registration, and `.git/worktrees/` admin directory had all since
disappeared kept being refused by prose git no longer agreed with (RUFU-278: three-way absence
verified at 09:09Z and again at 10:20Z while the card stayed parked and undispatchable).

So the decision to keep a card blocked must stay re-derivable from git. This module is that
re-derivation, and it deliberately answers in fixed vocabulary only:

- A probe returns an outcome enum, never the refusal sentence, a branch name, a path, or a SHA. The
  caller therefore cannot decide from prose even by accident, and the same enum feeds the run-audit
  row, whose metadata contract forbids exactly those shapes.
- The envelope recognizer matches the OUTER park sentence and nothing else. The inner conflict text
  is RUFU-376's business — it reworded that sentence once already — so a recognizer keyed on inner
  wording would silently stop recognizing the park the first time the wording moves again. The
  envelope is composed at exactly one site (`agent-heartbeat.ts`, the
  `MAX_HEARTBEAT_WORKTREE_ACQUISITION_RETRIES` cap), which makes it the stable identifier.

FNXC:AcquisitionConflictRevalidation 2026-11-01-13:12 (RUFU-356, the executor envelope is ruled OUT):
`worktree-create-outer.ts` reports a failed create as the task-log title
`Worktree creation failed after <N> attempts` and then THROWS
`Failed to create worktree after <N> attempts: <inner>` (or the original `BranchConflictError` when
the failure was a branch conflict). Neither string is ever written to `task.error` by that module:
the throw reaches the task row only through graph-node failure routing, which happens while the card
is EXECUTING in the WIP lane, so the recovery sweep's rebound-lane gate already excludes it and its
remedy is the executor's own node-retry budget, not a git-premise re-derivation. Recognizing it here
would give one error string two owners.

FNXC:AcquisitionConflictRevalidation 2026-11-01-13:12 (RUFU-356, what stays fail-closed):
This module never weakens a guard. A branch still registered on a live checkout answers
`live-foreign`, and a surviving unregistered tip whose unique commits are foreign or unattributed
answers `foreign-unmerged` — RUFU-292's preservation boundary is untouched. Three-way absence is not
proven here either: `inspectBareBranchCollision` prunes stale registrations before consulting the
map, so a registration-only leftover cannot masquerade as a live checkout, while a directory that
still exists keeps its live classification.
*/
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { promisify } from "node:util";
import type { Settings, Task } from "@fusion/core";
import { inspectBareBranchCollision } from "../execution/branch-conflicts.js";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";
import { resolveTaskWorkingBranchWithOrigin } from "./worktree-names.js";
import { resolveTaskWorktreePath } from "./worktree-paths.js";

const execFileAsync = promisify(execFile);
/** Same 30s bound the sibling git-evidence helpers use for a per-repository plumbing read. */
const GIT_TIMEOUT_MS = 30_000;

/**
 * One git argv invocation, no shell, so a branch name or path can never be re-read as shell syntax.
 * Any non-zero exit rejects and the caller turns that into `probe-unknown`.
 */
async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoDir,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

/**
 * Parse `git worktree list --porcelain` into a branch -> path map.
 *
 * FNXC:AcquisitionConflictRevalidation 2026-11-01-13:12 (RUFU-356):
 * Reads the `worktree`/`branch` pair the same way `branch-conflicts.ts` does for this command rather
 * than importing its private parser, and keeps the pair one-way: a detached worktree emits no
 * `branch` line, so its path must never be attributed to a branch at all.
 */
function parseWorktreeBranchMap(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  let pendingPath: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      pendingPath = line.slice("worktree ".length).trim();
      continue;
    }
    if (line.startsWith("branch ") && pendingPath) {
      const branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      if (branch) map.set(branch, pendingPath);
      pendingPath = null;
    }
  }
  return map;
}

/**
 * Whether a path would still stop `git worktree add`: it is present and holds anything at all.
 *
 * FNXC:AcquisitionConflictRevalidation 2026-11-01-13:12 (RUFU-356):
 * Emptiness, not registration, is the question. An existing but empty directory is where
 * `git worktree add` succeeds, so the premise really is gone; a directory holding anything — a
 * checkout marker, or only git-ignored build output — still stops the create. Refusing the
 * ignored-only shape is faithful to the guard that actually refused, even while RUFU-298 argues
 * separately that the review-time guard should stop over-refusing it. A recovery sweep has to match
 * the refusal the card received, not the refusal an operator wishes it had received.
 */
function pathStopsWorktreeCreate(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readdirSync(path).length > 0;
  } catch {
    // Present but unreadable: refuse rather than assume the create would succeed.
    return true;
  }
}

/**
 * The heartbeat retry-cap park sentence, composed once at the
 * `MAX_HEARTBEAT_WORKTREE_ACQUISITION_RETRIES` cap in `agent-heartbeat.ts`:
 *
 * `Worktree acquisition failed after 3 heartbeat attempts for branch "<branch>": <detail>`
 *
 * The attempt count matches as a number rather than the literal `3`, so raising the cap constant
 * cannot silently un-recognize the parks already stored on the board. The `<detail>` half stays
 * outside the match: it is the git refusal, and per RUFU-376 its wording is not stable.
 */
const ACQUISITION_EXHAUSTION_ENVELOPE =
  /^Worktree acquisition failed after \d+ heartbeat attempts for branch "([^"]+)":/;

/**
 * The branch named by the acquisition-exhaustion park envelope, or `undefined` when the error is not
 * that park.
 *
 * FNXC:AcquisitionConflictRevalidation 2026-11-01-13:12 (RUFU-356):
 * These must NOT match, and the sweep's tests pin each: the base-diverged park
 * (`TASK_BASE_DIVERGED: …` — a different premise with an operator-only remedy), the review-lane
 * sentence (`Worktree acquisition failed before the review produced a verdict…`), and the executor's
 * create-failure wording ruled out in the header note. The returned branch is diagnostic only: every
 * re-derivation resolves the branch from the TASK row, because a stored message is precisely the
 * evidence this recovery is forbidden to trust.
 */
export function isAcquisitionExhaustionError(error: string | undefined): string | undefined {
  if (!error) return undefined;
  return ACQUISITION_EXHAUSTION_ENVELOPE.exec(error)?.[1];
}

/**
 * Every outcome of a fresh collision inspection in the fixed vocabulary the recovery decision uses.
 * The first six are `inspectBareBranchCollision`'s own `kind` values; `probe-unknown` is the
 * transport failure that leaves the probe uninformative.
 */
export type AcquisitionConflictOutcome =
  | "missing"
  | "tip-already-merged"
  | "fully-subsumed"
  | "reclaimable"
  | "live-foreign"
  | "foreign-unmerged"
  | "probe-unknown";

/** Outcomes whose premise is gone — acquisition itself would proceed on every one of these. */
const PREMISE_CLEARED_OUTCOMES: readonly AcquisitionConflictOutcome[] = [
  "missing",
  "tip-already-merged",
  "fully-subsumed",
  "reclaimable",
];

/** Outcomes that still refuse: a live registration, or foreign/unattributed work to preserve. */
const REFUSING_OUTCOMES: readonly AcquisitionConflictOutcome[] = ["live-foreign", "foreign-unmerged"];

/** The fixed run-audit `code` vocabulary a probe verdict contributes (lane/pause codes live in the sweep). */
export type AcquisitionConflictAuditCode =
  | "premise-cleared"
  | "live-registration"
  | "foreign-unmerged"
  | "probe-unknown";

/**
 * Map a probe outcome onto its fixed run-audit code.
 *
 * FNXC:AcquisitionConflictRevalidation 2026-11-01-13:12 (RUFU-356):
 * A total function over the enum, so a new inspection `kind` is a compile error here rather than a
 * metadata value improvised at the emit site. `live-foreign` reports as `live-registration`
 * deliberately: what an operator needs from the row is "a live checkout still holds this branch",
 * not the internal name of the classifier's arm.
 */
export function acquisitionConflictAuditCode(
  outcome: AcquisitionConflictOutcome,
): AcquisitionConflictAuditCode {
  if (PREMISE_CLEARED_OUTCOMES.includes(outcome)) return "premise-cleared";
  if (outcome === "live-foreign") return "live-registration";
  if (outcome === "foreign-unmerged") return "foreign-unmerged";
  return "probe-unknown";
}

/**
 * The closed `code` vocabulary the recovery sweep records, spanning both halves of its decision.
 *
 * FNXC:AcquisitionConflictRevalidation 2026-11-01-13:38 (RUFU-356):
 * The first four members are what a PROBE said; the rest are what a CANDIDATE GATE said, so one query
 * over `task:reconcile-stale-acquisition-conflict-no-action` answers "why is this card still parked"
 * without reading the row. Two of them are deliberate additions to the vocabulary planning enumerated:
 * - `workspace-task`: a workspace card's branches live across several repositories, so a single
 *   root-directory probe cannot prove anything about it and it is excluded by contract. Folding that
 *   refusal into `wrong-lane` would make the row say "wrong column" about a card sitting in exactly
 *   the right column, which is the indistinguishable-refusal defect RUFU-372 had to fix elsewhere.
 * - `probe-threw`: an unexpected fault inside the probe rather than git answering "no". It is reported
 *   rather than swallowed because a sweep that never clears anything and says nothing is what an
 *   operator cannot debug.
 */
export type AcquisitionConflictSweepCode =
  | AcquisitionConflictAuditCode
  | "wrong-lane"
  | "paused"
  | "workspace-task"
  | "probe-threw";

/** True only for the four outcomes whose premise git now proves absent. `probe-unknown` never clears. */
export function isAcquisitionPremiseCleared(outcome: AcquisitionConflictOutcome): boolean {
  return PREMISE_CLEARED_OUTCOMES.includes(outcome);
}

/** True for the outcomes that must keep the card parked — fail-closed, exactly as before this change. */
export function isAcquisitionPremiseRefusing(outcome: AcquisitionConflictOutcome): boolean {
  return REFUSING_OUTCOMES.includes(outcome);
}

/**
 * Whether the checkout the acquisition wanted is still there, read from git rather than inferred.
 *
 * - `absent` — the branch is registered on no live checkout and the pinned destination is free, so
 *   the conflict premise has no surviving physical side. Only now is the tip worth classifying.
 * - `live-registration` — the branch is registered on a path that exists. This is the live foreign
 *   worktree (RUFU-292's shape) and acquisition would refuse it again.
 * - `path-present` — the pinned destination still holds content, so the create would still fail.
 * - `probe-unknown` — git could not answer.
 */
export type AcquisitionConflictLaneState =
  | "absent"
  | "live-registration"
  | "path-present"
  | "probe-unknown";

/**
 * Prove three-way worktree absence (path, `git worktree list` registration, admin directory) for one
 * card before any tip-level classification is allowed to clear it.
 *
 * FNXC:AcquisitionConflictRevalidation 2026-11-01-13:12 (RUFU-356):
 * Why absence is gated *before* the tip probe instead of being folded into its `reclaimable` answer:
 * a branch that is unregistered but still checked out somewhere, or a pinned path that still holds a
 * stale checkout, is a conflict acquisition would raise again — clearing on a tip that merely reads
 * as own-attributed would hand the card straight back to the same refusal. Each state is read, never
 * assumed:
 * - `git worktree prune` runs first, so a registration whose working tree is gone is healed rather
 *   than read as liveness. That is the whole difference between a registration-only leftover (the
 *   premise is gone) and a live checkout (it is not), and RUFU-376's phantom-worktree lesson says a
 *   sweep must not collapse it.
 * - the registration is then looked up in git's OWN map and confirmed against the filesystem, so a
 *   surviving worktree path cannot be classified as gone however its admin entry is disposed of: the
 *   registration surviving alone reports absent-after-prune, the path surviving alone reports
 *   `path-present`, and both surviving reports `live-registration`.
 * - the admin directory needs no separate probe: it is derived from the registration git itself
 *   reports, and `git worktree prune` is the only tool that knows its layout. Hand-guessing
 *   `.git/worktrees/<name>` would be a second source of truth that disagrees on linked worktrees,
 *   `gitdir:` files, and relocated common dirs — and an absence claim built on a guessed path is
 *   exactly the evidence class that must never clear a card.
 */
export async function readAcquisitionConflictLaneState(
  input: AcquisitionConflictProbeInput,
): Promise<AcquisitionConflictLaneState> {
  try {
    const { branch } = resolveTaskWorkingBranchWithOrigin(input.task);
    const pinnedWorktreePath = resolveTaskWorktreePath(input.rootDir, input.settings, input.task.id.toLowerCase());
    // A failed prune is a transport failure, not an absence claim: it must not fall through to `absent`.
    await git(input.rootDir, ["worktree", "prune"]);
    const registeredPath = parseWorktreeBranchMap(await git(input.rootDir, ["worktree", "list", "--porcelain"])).get(branch);
    if (registeredPath && existsSync(registeredPath)) return "live-registration";
    return pathStopsWorktreeCreate(pinnedWorktreePath) ? "path-present" : "absent";
  } catch {
    return "probe-unknown";
  }
}

export interface AcquisitionConflictProbeInput {
  /** Repository whose git metadata owns the branch — the project root checkout. */
  rootDir: string;
  /**
   * Settings shape the destination and base branch are resolved from.
   *
   * FNXC:AcquisitionConflictRevalidation 2026-11-01-18:40 (RUFU-356):
   * `baseBranch` is deliberately an optional `unknown`, not part of the `Pick`. `store.getSettings()` does
   * not always carry it, so a required pick would make this probe un-callable from the sweep that exists to
   * call it, while `resolveIntegrationBranch` already treats it only as a cast-checked fallback behind
   * `integrationBranch` (`IntegrationBranchSettings` allows exactly this shape). Naming the field is still
   * required: silently accepting an object that lacked it would let a card's destination resolve to the
   * origin/HEAD inference instead of the configured base, and the destination is the premise being probed.
   */
  settings: (Pick<Settings, "worktreesDir" | "integrationBranch"> & { baseBranch?: unknown }) | undefined;
  task: Pick<Task, "id" | "branch" | "branchContext">;
  /** Silences the integration-branch resolver's console warning on a repo with no resolvable base. */
  logger?: Pick<Console, "warn">;
}

/**
 * Re-derive the acquisition conflict for one card from live git.
 *
 * FNXC:AcquisitionConflictRevalidation 2026-11-01-13:12 (RUFU-356):
 * The identity inputs resolve the same way acquisition resolves them, and the answer is one enum:
 * - the branch comes from `resolveTaskWorkingBranchWithOrigin`, the resolver the acquisition path
 *   uses, so a shared-branch-group member is probed on the canonical branch its envelope named;
 * - the destination comes from `resolveTaskWorktreePath(rootDir, settings, taskId.toLowerCase())`,
 *   the default-layout pinned path native acquisition derives (FN-258 task-id pinning). Under a
 *   worktrunk backend the live checkout lives in worktrunk's own layout, so this path can differ
 *   from the one acquisition refused; that degrades to the registration verdict, which stays
 *   fail-closed, because `inspectBareBranchCollision` answers `live-foreign` from git's own worktree
 *   map whenever the branch is registered on a checkout that exists and never infers liveness from
 *   this path. Reading a desired path as liveness is the RUFU-376 phantom this probe must not repeat.
 * - the comparison base is the LIVE integration branch, not the card's recorded start point:
 *   `inspectBareBranchCollision` re-resolves the comparison ref itself (FN-9434), because a stored
 *   start point can predate commits already upstream and would make inherited commits look stranded.
 *
 * A probe that cannot run (unreadable repository, git failure) answers `probe-unknown`, which is
 * never grounds to clear: an inspection that did not run is not proof a conflict disappeared.
 *
 * FNXC:AcquisitionConflictRevalidation 2026-11-01-13:12 (RUFU-356):
 * The repository-health read below is not decoration. `inspectBareBranchCollision` treats a ref read
 * that throws as `{ kind: "missing" }` — a reasonable answer for "this card's branch does not exist",
 * but on an unreadable repository it is the same answer, and `missing` sits in the cleared set. So
 * this module proves the repository can answer at all before it is allowed to report absence, and
 * keeps that proof inside the module rather than relying on every caller to sequence a health check
 * of its own. (The sweep does gate on worktree absence first, and that gate independently refuses a
 * broken repository — but a probe whose safety depends on a caller's ordering is not safe.)
 */
export async function rederiveAcquisitionConflictPremise(
  input: AcquisitionConflictProbeInput,
): Promise<AcquisitionConflictOutcome> {
  try {
    await git(input.rootDir, ["rev-parse", "--git-dir"]);
    const { branch } = resolveTaskWorkingBranchWithOrigin(input.task);
    const pinnedWorktreePath = resolveTaskWorktreePath(input.rootDir, input.settings, input.task.id.toLowerCase());
    const integrationRef = await resolveIntegrationBranch(input.rootDir, input.settings, {
      logger: input.logger ?? { warn: () => undefined },
    });
    const inspection = await inspectBareBranchCollision({
      repoDir: input.rootDir,
      branchName: branch,
      conflictingWorktreePath: pinnedWorktreePath,
      requestingTaskId: input.task.id,
      integrationRef,
    });
    return inspection.kind;
  } catch {
    return "probe-unknown";
  }
}
