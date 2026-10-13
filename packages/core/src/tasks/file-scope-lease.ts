import { createHash } from "node:crypto";
import type { Task } from "../types.js";
import { compareTasksByQueueOrder } from "./task-queue-order.js";

export type FileScopeLeaseKind = "none" | "active" | "dormant";

/*
FNXC:OverlapScheduling 2026-09-08-19:50 (RUFU-200):
The lease classifier needs to distinguish "this card retained a checkout" from "this card retains a
checkout that still has something to preserve". Path presence alone was never proof of unmerged work:
a task branch cut from the base that never committed anything is byte-identical to the base, so the
checkout it retains protects nothing while it serializes every overlapping peer forever (RUFU-198
deadlocked RUFU-199 exactly this way while sitting `todo` and dependency-blocked, and no dispatch-time
recovery could ever reach it).
The verdict is computed OUTSIDE core (git I/O) and arrives as a downgrade-only input. `empty` means
clean worktree AND zero commits ahead of the resolved base, per repository. `occupied` is positive
evidence of work to preserve. `unknown` means the proof could not be obtained — a failed or timed-out
git call, an unresolvable base ref, a missing map entry — and MUST behave exactly like `occupied`,
because the failure mode of guessing wrong is destroying someone's uncommitted work. Absent the whole
argument the predicate is byte-for-byte its pre-RUFU-200 self, which is what keeps every legacy
caller and fixture on today's behavior.
*/
export type CheckoutEmptinessVerdict = "empty" | "occupied" | "unknown";

/**
 * Proof map keyed by repository entry: `""` is the singular {@link Task.worktree} checkout, every
 * other key is a `task.workspaceWorktrees` repository key. A key that is simply absent from the map
 * is classified as `unknown` — fail-closed, never as `empty`.
 */
export type CheckoutEmptinessProofMap = ReadonlyMap<string, CheckoutEmptinessVerdict>;

export interface FileScopeLeaseClassification {
  kind: FileScopeLeaseKind;
  waivedForTaskIds: readonly string[];
}

/**
 * FNXC:FileScopeRecovery 2026-10-12-17:09:
 * A release receipt binds its follower waiver to the normalized holder scope, so every
 * admission surface can reject a receipt after the declaration changes out-of-band.
 */
export function fileScopeLeaseScopeFingerprint(scope: readonly string[]): string {
  return createHash("sha256").update(scope.join("\n")).digest("hex");
}

/*
FNXC:WorkspaceFileOverlap 2026-08-30-19:14:
Workspace tasks deliberately clear the singular `task.worktree` through
`normalizeWorkspaceTaskWorktreeMetadata({ clearSingularWorktree: true })`, so overlap lifetime must also
recognize their per-repository checkouts. A retained entry is the unfinished-work proof; executor and archive
cleanup delete those entries when the checkout is removed, preserving checkout clearing as the early-release hatch.

FNXC:OverlapScheduling 2026-09-01-14:49:
A planning-only card owns neither checkout form and therefore owns no file-scope lease; planning never
serializes planning. A hold-lane card retaining a real checkout after execution still owns unmerged work
and deliberately keeps its dormant lease. Checkout evidence, not a column exception, decides the outcome.
*/
/*
FNXC:OverlapScheduling 2026-10-04-15:40 (upstream merge 59524b0457):
Kept at this fork's shape. Upstream added a `task.mergeDetails?.mergeConfirmed === true` early return here,
but that guard belongs to the post-merge-recovery refactor this merge deliberately declines, and no declined
caller exists to set it. A guard whose producer is absent is a silent lease drop, so it is NOT ported.
*/
export function taskHoldsUnmergedCheckout(
  task: Pick<Task, "worktree" | "workspaceWorktrees">,
  checkoutEmptiness?: CheckoutEmptinessProofMap,
): boolean {
  const retainedKeys: string[] = [];
  if (typeof task.worktree === "string" && task.worktree.trim()) retainedKeys.push("");
  for (const [repoKey, entry] of Object.entries(task.workspaceWorktrees ?? {})) {
    if (typeof entry?.worktreePath === "string" && entry.worktreePath.trim().length > 0) {
      retainedKeys.push(repoKey);
    }
  }
  if (retainedKeys.length === 0) return false;
  if (!checkoutEmptiness) return true;

  /*
  FNXC:WorkspaceFileOverlap 2026-09-08-19:50 (RUFU-200):
  The emptiness test is per repository, never all-or-nothing: a workspace card whose `packages/cli`
  checkout is clean-and-behind but whose `packages/engine` checkout is one commit ahead still owns
  unmerged work and keeps its lease. Downgrade requires EVERY retained entry to be proven `empty`.
  */
  return retainedKeys.some((key) => checkoutEmptiness.get(key) !== "empty");
}

function normalizeWorkspaceScopePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

/*
FNXC:OverlapScheduling 2026-09-11-22:49:
A canonical package barrel export file (`packages/<pkg>/src/index.ts` and its trimmed gate sibling
`index.gate.ts`) is append-only shared traffic: every card that publishes a new symbol adds one export
line there, so the path is a shared meeting point, not contested work. When such a barrel is the ONLY
entry two file scopes share, the cards do not collide and must not serialize — measured on the live
board, one parked review card head-blocked five unrelated cards for hours over a single shared barrel
line (`overlapBlockedBy=RUFU-204`).

The exemption is deliberately narrow and per matched pair, never whole-scope or project-wide, and
requires no settings change: both raw entries must name the same concrete canonical barrel, and neither
side may be a directory/glob pattern (`packages/core/*` vs a barrel still serializes). A genuine
non-barrel collision in the same scopes keeps serializing — the exemption is evaluated per pair, so
scope-wide waivers (`isCoordinationOnlyTask`) and project-wide `overlapIgnorePaths` stay untouched.
Breadth is the risk here: this suppresses a safety mechanism, so a bare `src/index.ts`,
`repo-a/src/index.ts`, `packages/core/src/routes/index.ts`, or `index.tsx`/`index.d.ts` never matches.
A workspace repo-key prefix (`<repoKey>/packages/<pkg>/src/index.ts`) is recognized because
`normalizeOverlapScopeForTask` qualifies scope entries before comparison.

The review-lane lease lifetime is intentionally unchanged: a review-lane holder keeps its lease while
its checkout is unmerged, and pausing must not release it; only the pairwise path comparison waives the
barrel entry. Both matcher copies (engine `findFileScopeOverlaps` and core `repairScopesOverlap`) call
`isSharedBarrelOnlyMatch` so scheduler admission, the dispatch gate, gridlock detection, self-healing,
the overlap report, and store repair cannot drift.
*/
const SHARED_BARREL_EXPORT_PATTERN = /^(?:.*\/)?packages\/[^/]+\/src\/(?:index|index\.gate)\.ts$/;

/**
 * True only for a concrete canonical package barrel export path:
 * `packages/<one-segment>/src/index.ts` or `packages/<one-segment>/src/index.gate.ts`, optionally
 * workspace-prefixed with a repo key. Normalizes internally (trim, backslash→`/`, strip leading `./`)
 * for pattern recognition only — callers keep their own scope normalization semantics.
 */
export function isSharedBarrelExportPath(path: string): boolean {
  return SHARED_BARREL_EXPORT_PATTERN.test(normalizeWorkspaceScopePath(path));
}

/**
 * Pairwise overlap-exemption test: true when two raw scope entries name the SAME concrete shared
 * barrel export. False whenever either side is a directory/prefix pattern (`x/` or `x/*`) or the
 * normalized entries differ — glob-vs-barrel coverage must stay serialized.
 */
export function isSharedBarrelOnlyMatch(rawA: string, rawB: string): boolean {
  const asPatternCandidate = (raw: string) => {
    const slashed = raw.trim().replaceAll("\\", "/");
    return slashed.endsWith("/") || slashed.endsWith("/*");
  };
  if (asPatternCandidate(rawA) || asPatternCandidate(rawB)) return false;
  const normalizedA = normalizeWorkspaceScopePath(rawA);
  return normalizedA === normalizeWorkspaceScopePath(rawB) && isSharedBarrelExportPath(normalizedA);
}

/*
FNXC:WorkspaceFileOverlap 2026-08-30-19:14:
Workspace repository scope treats an unprefixed declaration as applying inside every configured repository,
matching `resolveRepoDeclaredScope`'s `unprefixed-fallback` behavior. Expand overlap scope in the safe direction:
more serialization is acceptable, while missing a qualified peer would admit conflicting edits. Explicit repository
paths remain untouched, and tasks without repository checkouts retain the exact single-repository scope behavior.
*/
export function normalizeOverlapScopeForTask(
  task: Pick<Task, "workspaceWorktrees">,
  scope: readonly string[],
): string[] {
  const repoKeys = [...new Set(
    Object.keys(task.workspaceWorktrees ?? {})
      .map(normalizeWorkspaceScopePath)
      .filter(Boolean),
  )].sort();
  if (repoKeys.length === 0) return [...scope];

  const normalizedScope = new Set<string>();
  for (const rawEntry of scope) {
    const entry = normalizeWorkspaceScopePath(rawEntry);
    if (!entry) continue;
    normalizedScope.add(entry);
    if (repoKeys.some((repoKey) => entry === repoKey || entry.startsWith(`${repoKey}/`))) continue;
    for (const repoKey of repoKeys) normalizedScope.add(`${repoKey}/${entry}`);
  }
  return [...normalizedScope].sort();
}

/*
FNXC:OverlapScheduling 2026-08-29-05:47:
A file-scope claim lasts until the blocking task's work has landed rather than only while it occupies a
particular board column. Active claims always serialize overlapping work; dormant claims use the shared
queue order so two waiting holders choose one deterministic winner instead of freezing each other.

FNXC:TaskQueueOrder 2026-09-17-12:07:
FN-509 replaced the priority/age/id tiebreak with the Boost/FIFO queue order. An ACTIVE claim is
untouched: Boost never moves a waiting card ahead of a holder that is already working. Only the
dormant-vs-dormant tiebreak changed, so the two waiters still agree on one winner and cannot both
yield (which is what would deadlock the pair).
*/
export function fileScopeLeaseBlocksCandidate(
  blocker: Pick<Task, "id" | "createdAt" | "column" | "columnMovedAt" | "queueBoost">,
  candidate: Pick<Task, "id" | "createdAt" | "column" | "columnMovedAt" | "queueBoost">,
  classification: FileScopeLeaseClassification,
): boolean {
  if (blocker.id === candidate.id) return false;
  if (classification.waivedForTaskIds.includes(candidate.id)) return false;
  if (classification.kind === "active") return true;
  if (classification.kind === "dormant") {
    return compareTasksByQueueOrder(blocker, candidate) < 0;
  }
  return false;
}
