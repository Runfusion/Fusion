import type { Task } from "@fusion/core";

/*
FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-20:45 (RUFU-451):
`obligationRepositories` on the `no-op` arm names the checkouts the card HOLDS when its confirmed scope
named no repository at all. It is not a landing list — `repositories` stays empty because no repository may
be landed by an obligation-free close — it is the set the closing lane must PROVE empty before the close is
allowed, and it exists so the merge door cannot answer a different obligation set from the reconcile door
(`workspaceObligationRepositories` is the one rule both read). Omitted when the card holds nothing, which
keeps the shipped zero-obligation shape byte-identical.
*/
export type WorkspaceMergeReadiness =
  | { kind: "ready"; repositories: string[]; preservedFiles: string[]; absentRepositories?: string[] }
  | { kind: "no-op"; repositories: []; preservedFiles: []; absentRepositories?: string[]; obligationRepositories?: string[] }
  | { kind: "blocked"; reason: string };

/*
FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-20:45 (RUFU-451):
ONE obligation-set rule for every door that decides delivery. A card's CONFIRMED declaration is its
statement of what it owes; when it declared nothing but nevertheless holds member checkouts, the checkouts
it holds are what it owes proof about — a confirmed scope of zero repositories is not a licence to skip
measurement of a tree this card is standing in. Measured SANE-509 is exactly that row: three acquired member
entries against a confirmed scope that named no repository, two of them carrying member branches.

The rule is deliberately asymmetric: the substitution to the acquired set happens ONLY for a card that made
the zero-commit declaration (`noCommitsExpected`), because for every other card an empty declaration is an
unreconciled scope — an operator-repair condition — and silently renaming it "nothing owed" is how undelivered
work gets certified. Order is preserved (declared order, else acquisition order) so a door that reports
repositories in obligation order keeps reporting the same list.
*/
export function workspaceObligationRepositories(
  task: Pick<Task, "noCommitsExpected" | "repositoryScope" | "workspaceWorktrees">,
): string[] {
  /*
  Names are returned VERBATIM — each door normalises them its own way (`resolveWorkspaceMergeReadiness` trims
  and de-duplicates its declared list; `reconcileLandedReviewTask` compares them raw against `workspaceWorktrees`
  keys), and silently normalising here would make one of them compare a different string than it does today.

  An UNCONFIRMED scope has no obligation set: the repositories a card owes proof about are not decided yet, so the
  answer is empty rather than a substitution built from whatever checkouts happen to exist. Both consumers refuse
  on that state BEFORE consulting this rule (`resolveWorkspaceMergeReadiness` answers `blocked` with the operator
  -confirmation sentence; `reconcileLandedReviewTask` returns `workspace-scope-unresolved`), and this function
  never authorises a close on its own — it only says what a card that reaches a door owes proof about.
  */
  if (task.repositoryScope?.state !== "confirmed") return [];
  const declared = [...task.repositoryScope.repositories];
  if (declared.length > 0) return declared;
  return task.noCommitsExpected === true ? Object.keys(task.workspaceWorktrees ?? {}) : [];
}

/*
FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-18:45 (RUFU-451):
`absentRepositories` is carried OPTIONAL and omitted when empty, because RUFU-504's shipped assertion on
the acquired-repositories arm is an exact `toEqual` on `{kind, repositories, preservedFiles}` — an always-
present empty key would have "regressed" a green contract over a shape this task must not touch. It is
never a second obligation list: it names declared repositories the caller PROVED hold no artifact of this
card (no acquired checkout, no recorded branch, no landing record, and git confirms the canonical task ref
is absent there), so the terminal delivery decision counts them instead of silently dropping them.
*/

/**
 * FNXC:WorkspaceFinalization 2026-08-21-08:46:
 * A workspace's confirmed repository intent survives a first successful land. A subsequent
 * finalization pass may have no fresh diff because the task branch was already integrated, but its
 * landed repository is still an obligation that must contribute durable aggregate merge proof.
 * Empty evidence is therefore a no-op only for an explicitly commit-free task; every other empty
 * workspace boundary remains visible for operator repair instead of succeeding by vacuous truth.
 */
export function resolveWorkspaceMergeReadiness(
  task: Pick<Task, "id" | "noCommitsExpected" | "repositoryScope" | "workspaceWorktrees" | "modifiedFiles">,
  freshModifiedRepositories: ReadonlySet<string>,
  netZeroBranchRepositories: ReadonlySet<string>,
  /**
   * RUFU-451: declared repositories the caller proved hold no artifact of this card. Supplied by the
   * lane that can ask git (`evaluateCommitFreeRepositoryAbsence`); the default empty set keeps every
   * pre-existing classification byte-identical for a caller that has not looked.
   */
  provablyAbsent: ReadonlySet<string> = new Set<string>(),
): WorkspaceMergeReadiness {
  const scope = task.repositoryScope;
  if (scope?.state !== "confirmed") {
    return { kind: "blocked", reason: `Workspace repository scope is unresolved for ${task.id}; operator confirmation is required before landing` };
  }

  const entries = task.workspaceWorktrees ?? {};
  const declaredRepositories = scope.repositories.map((repository) => repository.trim());
  if (declaredRepositories.some((repository) => !repository) || new Set(declaredRepositories).size !== declaredRepositories.length) {
    /*
    FNXC:WorkspaceFinalization 2026-08-21-09:50:
    Persisted scope is an integration authority, so malformed duplicate declarations cannot be
    normalized into a smaller obligation set. Stop before dispatch or Git writes for operator repair.
    */
    return { kind: "blocked", reason: `Workspace repository scope has duplicate or invalid declarations for ${task.id}; operator repair is required` };
  }
  const worktreePaths = Object.values(entries)
    .map((entry) => entry.worktreePath?.trim())
    .filter((path): path is string => Boolean(path));
  if (new Set(worktreePaths).size !== worktreePaths.length) {
    return { kind: "blocked", reason: `Workspace merge has duplicate worktree paths for ${task.id}; operator repair is required` };
  }
  const repositories = declaredRepositories
    .filter((repo) => Boolean(entries[repo]))
    .filter((repo) => freshModifiedRepositories.has(repo) || netZeroBranchRepositories.has(repo) || Boolean(entries[repo]?.landedSha))
    .sort();
  const preservedFiles = [...new Set(task.modifiedFiles ?? [])].sort();

  if (repositories.length > 0) {
    // RUFU-451: the absence carry-forward is a zero-commit-contract concept. An unauthorized card's
    // classification must stay byte-identical to what it was before this parameter existed, so the
    // declaration gates the key — a card that owes commits gets no evidence-shaped courtesy here.
    const carried = task.noCommitsExpected === true
      ? declaredRepositories.filter((repo) => !entries[repo] && provablyAbsent.has(repo)).sort()
      : [];
    return {
      kind: "ready",
      repositories,
      preservedFiles,
      ...(carried.length > 0 ? { absentRepositories: carried } : {}),
    };
  }
  if (task.noCommitsExpected === true && scope.repositories.length === 0) {
    /*
    FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-20:45 (RUFU-451) — the `no-op` arm must name what it discharges:
    Declaring no repository is NOT the same as holding nothing. A card that acquired member checkouts under an
    empty confirmed scope still stands inside those trees, so the classification carries the acquired set as the
    obligation set the closing lane must prove empty, exactly as `reconcileLandedReviewTask` already computes it.
    Classifying it as an obligation-free close without that list is what let the merge door certify a delivery
    while measuring no member at all — RUFU-262's class (an ahead-with-net-zero-diff branch, or uncommitted work
    inside a member tree, is invisible to the card-level door). The resolver itself cannot ask git which of those
    trees is empty, so it names the set and the lane that can run git does the measuring.
    */
    const obligationRepositories = workspaceObligationRepositories(task);
    return {
      kind: "no-op",
      repositories: [],
      preservedFiles: [],
      ...(obligationRepositories.length > 0 ? { obligationRepositories } : {}),
    };
  }

  /*
  FNXC:WorkspaceFinalization 2026-10-02-19:51 (RUFU-504):
  A commit-free workspace that DECLARED and ACQUIRED its repositories owes a landing obligation per
  repository, and until now it matched none of the three disjuncts above. `freshModifiedRepositories`
  needs a file, `netZeroBranchRepositories` needs commits whose content cancels out
  (`workspace-review-evidence.ts:96` computes `ahead` as a BOOLEAN, so a branch sitting exactly on its
  merge-base is `ahead: false`), and `landedSha` needs a prior land. The declared-commit-free case fell
  through to the same operator-repair refusal as unexplained emptiness, because the no-op arm above only
  covers the degenerate workspace with zero declared repositories.

  Measured on the saneca workspace 2026-10-02: 16 of 17 parked review-lane cards already carried
  `no_commits_expected = 1` with `repositoryScope.state = confirmed` and acquired member entries, so the
  pipeline HAD declared the contract; only readiness disagreed with it. Each of those cards then repeated
  one blocker sentence until the stall classifier parked it (`in-review-stall-deadlock`), which is how a
  delivered zero-diff card becomes indistinguishable from a frozen one.

  Returning `ready` rather than a new terminal kind is deliberate: `landOneRepo` already short-circuits a
  confidently-zero branch to `outcome: "empty"` with a durable `merge:ai-empty` row
  (`merger-ai.ts:1164`), so per-repository delivery proof is written by code that already handles this
  shape. No new probe primitive and no fabricated sha.

  Two conditions keep the vacuous-truth fence this function exists for:
  1. `noCommitsExpected` must be the pipeline's own declaration, so an acquisition that silently produced
     nothing stays unexplained emptiness and keeps its refusal.
  2. EVERY declared repository must have an acquired entry. A workspace that declared two members and
     acquired one is a partial acquisition, not a commit-free delivery, and must still reach the
     no-acquired-repositories refusal below.
  */
  if (task.noCommitsExpected === true && declaredRepositories.length > 0) {
    const acquired = declaredRepositories.filter((repo) => entries[repo] !== undefined);
    /*
    FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-18:45 (RUFU-451) — the widening, and its exact bound:
    A declared repository the card never acquired is refused by RUFU-504's completeness rule, which is
    correct for a card that owed commits and self-defeating for one that owed none. SANE-509's measured
    blocker is that second case: `sub-repo(s) saneca have no branch (fusion/sane-509) and no landedSha`.
    The refusal was therefore generated FROM the absence, while absence is the whole delivery contract of
    a source-free card. So the completeness rule is not relaxed, it is completed: the obligation set is
    now (acquired ∪ proven-absent) and any repository that is neither still falls through to the byte-
    identical operator-repair refusals below.

    What may NOT be inferred here is stated once, for the next reader who is tempted to help:
      • an acquired repository whose branch the ancestry probe cannot resolve is NEVER absence. It is
        `unproven` (RUFU-504: a deleted branch is never folded into a delivery) and stays a refusal.
      • a repository with a recorded branch or a recorded landing is NEVER absence, even if git says the
        branch is gone now — a named-and-vanished branch is the RUFU-262 lost-work suspicion.
      • `provablyAbsent` only ever contains what `evaluateCommitFreeRepositoryAbsence` certified from a
        ref read that answered "no such ref". An unasked probe is not in the set, by construction.
    */
    const unacquired = declaredRepositories.filter((repo) => entries[repo] === undefined);
    const absent = unacquired.filter((repo) => provablyAbsent.has(repo)).sort();
    if (acquired.length + absent.length === declaredRepositories.length) {
      // Every declared repository is either an obligation or a proven absence. Zero obligations means
      // there is nothing for the per-repository land path to land: that is the commit-free no-op, whose
      // exit the merge door owns (`landWorkspaceTask`'s proof-gated zero-obligation finalization).
      if (acquired.length === 0) {
        return { kind: "no-op", repositories: [], preservedFiles: [], absentRepositories: absent };
      }
      return {
        kind: "ready",
        repositories: acquired.sort(),
        preservedFiles,
        ...(absent.length > 0 ? { absentRepositories: absent } : {}),
      };
    }
  }

  const declared = [...declaredRepositories].sort();
  const knownEntries = declared.filter((repo) => entries[repo] !== undefined);
  if (knownEntries.length === 0) {
    return { kind: "blocked", reason: `Workspace merge has no acquired repositories matching confirmed scope for ${task.id}; operator repair is required` };
  }
  return { kind: "blocked", reason: `Workspace merge has no evidenced landing obligations for ${task.id}; operator repair is required` };
}

/** Exposed for focused tests without coupling readiness to Git acquisition. */
export function isWorkspaceLandedObligation(entry: NonNullable<Task["workspaceWorktrees"]>[string] | undefined): boolean {
  return Boolean(entry?.landedSha);
}
