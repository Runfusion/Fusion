import * as childProcess from "node:child_process";
import { promisify } from "node:util";

import type { BranchGroup, BranchGroupPrState, MergeTargetResolution, Settings, Task, TaskStore } from "@fusion/core";
import { isBranchGroupMemberLanded, resolveEffectiveGroupAutoMerge, resolveTaskMergeTarget } from "@fusion/core";
import { resolveIntegrationBranch } from "./integration-branch.js";

// argv-based git invocation: arguments are passed as an array (no shell), so
// branch names like `foo$(touch /tmp/x)` can never trigger command substitution.
// Defense-in-depth alongside store-level validateBranchGroupBranchName.
// `execFile` is resolved lazily through the namespace import so test mocks that
// only stub `exec`/`execSync` (the repo's established node:child_process mock
// convention) can still load this module; `execFile` is only required when a
// code path actually shells out.
const execFileAsync: (file: string, args: string[], opts?: import("node:child_process").ExecFileOptions) => Promise<{ stdout: string; stderr: string }> = (file, args, opts) =>
  (promisify(childProcess.execFile) as (f: string, a: string[], o?: object) => Promise<{ stdout: string; stderr: string }>)(file, args, opts);

export interface BranchGroupMergeRouting {
  branchGroup: BranchGroup;
  mergeTarget: MergeTargetResolution;
}

/**
 * Injected callback (KTD7) that creates — or reuses — the single managed GitHub
 * PR for a branch group. Closes over a dashboard-built `GitHubClient` at the CLI
 * construction sites so the engine never statically imports `@fusion/dashboard`
 * (avoids the engine ↔ dashboard import cycle). Mirrors the `processPullRequestMerge`
 * injection seam.
 *
 * Returns the GitHub PR number/url and the persisted-state mapping. Idempotency is
 * enforced both here (reuse an existing open PR for the head branch) and by the
 * coordinator (skip the call entirely when a `prNumber` is already persisted).
 */
export type CreateGroupPrFn = (input: {
  /** Project working directory — needed to push the head branch to origin. */
  cwd: string;
  group: BranchGroup;
  members: Task[];
  /** Head branch — the group integration branch. */
  headBranch: string;
  /** Base branch — the integration/default target. */
  baseBranch: string;
}) => Promise<{ prNumber: number; prUrl: string; prState: BranchGroupPrState }>;

/** Result shape shared by group-PR sync/close callbacks. */
export interface GroupPrReconcileResult {
  prNumber: number;
  prUrl: string;
  prState: BranchGroupPrState;
}

/**
 * Injected callback (KTD7) that PUSHES an updated body/title onto the single
 * managed group PR (member checklist + x/N completion) as members land (U6, R6).
 * Mirrors {@link CreateGroupPrFn}'s injection seam; closes over a dashboard-built
 * `GitHubClient` at the CLI sites so the engine never imports the dashboard.
 *
 * The body always reflects the full current member state, so repeated calls are
 * idempotent body rewrites that naturally coalesce — no queue is needed.
 *
 * Out-of-band reconciliation: when the persisted PR is closed/merged on GitHub,
 * this returns the reconciled `prState` (closed/merged) rather than re-opening or
 * erroring, so the caller can persist the corrected state.
 *
 * The group passed in carries the persisted `prNumber`; callers must only invoke
 * this when `prNumber` is set.
 */
export type SyncGroupPrFn = (input: {
  /**
   * Project working directory — used to resolve the owner/repo identity for the
   * GitHub call. In a multi-project daemon the PROCESS cwd is not the project
   * dir, so the repo MUST be resolved from this `cwd` rather than `process.cwd()`.
   * Mirrors {@link CreateGroupPrFn}'s `cwd`.
   */
  cwd: string;
  group: BranchGroup;
  members: Task[];
}) => Promise<GroupPrReconcileResult>;

/**
 * Injected callback (KTD7) that closes the single managed group PR (best-effort)
 * during terminal reconciliation when a group is abandoned (U6, R7). If the PR is
 * already closed/merged out-of-band, it returns the reconciled state instead of
 * erroring. Callers must only invoke this when a `prNumber` is persisted.
 */
export type CloseGroupPrFn = (input: {
  group: BranchGroup;
}) => Promise<GroupPrReconcileResult>;

export interface BranchGroupCompletionStatus {
  complete: boolean;
  totalMembers: number;
  landedMemberIds: string[];
  pendingMemberIds: string[];
}

export interface BranchGroupPromotionResult {
  groupId: string;
  promoted: boolean;
  alreadyFinalized: boolean;
  reason: "promoted" | "incomplete" | "gated" | "already-finalized" | "group-not-found";
  status: BranchGroup["status"];
  prState: BranchGroupPrState;
  prNumber?: number;
  prUrl?: string;
}

export interface BranchGroupPromotionDecision {
  eligible: boolean;
  groupAutoMerge: boolean;
  reason:
    | "group-automerge-disabled"
    | "settings-automerge-disabled"
    | "global-pause"
    | "engine-paused"
    | "eligible";
}

/**
 * Evaluates branch-group completion using the canonical `@fusion/core`
 * `isBranchGroupMemberLanded` predicate so the engine gate can never diverge
 * from the dashboard route gate. A member is landed iff it was merge-confirmed
 * onto THIS group's branch via the branch-group-integration path; the group is
 * complete iff it has at least one member and every member is landed.
 *
 * `group` (its `branchName`) is required: landing is branch-anchored, so a
 * member done against a sibling/mismatched branch must NOT count as landed.
 */
export function evaluateBranchGroupCompletion(input: {
  members: Pick<Task, "id" | "column" | "branchContext" | "mergeDetails">[];
  group: Pick<BranchGroup, "branchName">;
}): BranchGroupCompletionStatus {
  const landedMemberIds: string[] = [];
  const pendingMemberIds: string[] = [];

  for (const member of input.members) {
    if (isBranchGroupMemberLanded(member, input.group)) {
      landedMemberIds.push(member.id);
    } else {
      pendingMemberIds.push(member.id);
    }
  }

  const totalMembers = input.members.length;
  return {
    complete: totalMembers > 0 && pendingMemberIds.length === 0,
    totalMembers,
    landedMemberIds,
    pendingMemberIds,
  };
}

/**
 * Evaluates branch-group → default-branch PROMOTION eligibility only.
 * This does not perform promotion and does not govern member → group-integration
 * routing, which stays on the FN-5782 task-level auto-merge path.
 */
export function evaluateBranchGroupPromotion(input: {
  group: Pick<BranchGroup, "id" | "branchName" | "autoMerge" | "status">;
  settings: Pick<Settings, "autoMerge" | "globalPause" | "enginePaused">;
}): BranchGroupPromotionDecision {
  const groupAutoMerge = resolveEffectiveGroupAutoMerge(input.group, input.settings);
  if (input.settings.globalPause) {
    return { eligible: false, reason: "global-pause", groupAutoMerge };
  }
  if (input.settings.enginePaused) {
    return { eligible: false, reason: "engine-paused", groupAutoMerge };
  }
  if (!groupAutoMerge) {
    if (input.group.autoMerge === false) {
      return { eligible: false, reason: "group-automerge-disabled", groupAutoMerge };
    }
    return { eligible: false, reason: "settings-automerge-disabled", groupAutoMerge };
  }
  if (!input.settings.autoMerge) {
    return { eligible: false, reason: "settings-automerge-disabled", groupAutoMerge };
  }
  return { eligible: true, reason: "eligible", groupAutoMerge };
}

async function ensureGroupBranchExists(rootDir: string, branchName: string, startPoint: string): Promise<void> {
  try {
    await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { cwd: rootDir });
    return;
  } catch {
    await execFileAsync("git", ["branch", branchName, startPoint], { cwd: rootDir });
  }
}

/**
 * Per-`groupId` in-process promotion lock (Fix #10). `promoteBranchGroup` can be
 * invoked concurrently — e.g. the dashboard route bridge and the auto-promotion
 * hook firing on the final member landing — and its body runs a long await chain
 * (git checkout/merge on the shared working tree + PR creation) with no atomicity.
 * Interleaving two runs can double-create the managed PR and corrupt HEAD.
 *
 * We serialize per group by chaining each call onto a promise stored in this map;
 * each call only begins after the previous one for the same group settles, and it
 * RE-READS the group state inside the lock (the inner function's first action is
 * `store.getBranchGroup`), so a second waiter observes the first's persisted
 * `prState`/`status` and short-circuits instead of re-doing the work.
 *
 * In-process only: a cross-node lease (FN-4820) is explicitly deferred.
 */
const promotionLocks = new Map<string, Promise<unknown>>();

/**
 * The only entrypoint allowed to perform shared-branch-group → default-branch promotion.
 * Promotion is intentionally idempotent and must never run inline in aiMergeTask.
 *
 * Serialized per `groupId` via {@link promotionLocks}; see that comment for why.
 */
export interface PromoteBranchGroupInput {
  store: Pick<TaskStore, "getBranchGroup" | "getBranchGroupByBranchName" | "listTasksByBranchGroup" | "updateBranchGroup">;
  rootDir: string;
  groupId: string;
  settings: Pick<Settings, "autoMerge" | "globalPause" | "enginePaused"> & Partial<Pick<Settings, "mergeStrategy" | "integrationBranch" | "baseBranch">>;
  /**
   * Injected GitHub PR creator (KTD7). When PR mode is active and the group is
   * complete, the coordinator uses this to create the single managed PR. Omitted
   * for direct-merge mode and in tests that don't exercise PR creation.
   */
  createGroupPr?: CreateGroupPrFn;
  recordAudit?: (event: {
    domain: string;
    mutationType: string;
    target: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void> | void;
}

export async function promoteBranchGroup(input: PromoteBranchGroupInput): Promise<BranchGroupPromotionResult> {
  // Chain onto any in-flight promotion for this group so two concurrent callers
  // (route bridge + auto-promotion on final landing) never run the merge/PR-create
  // sequence at the same time. The continuation re-reads group state inside the
  // lock, so the second caller observes the first's persisted result.
  const prior = promotionLocks.get(input.groupId) ?? Promise.resolve();
  const run = prior
    .catch(() => {
      // A failed prior promotion must not poison the chain; the next caller still
      // gets a fresh, serialized attempt (re-merge is a no-op; PR-create idempotent).
    })
    .then(() => promoteBranchGroupInner(input));
  promotionLocks.set(input.groupId, run);
  try {
    return await run;
  } finally {
    // Only clear if no newer call has chained on top of us.
    if (promotionLocks.get(input.groupId) === run) {
      promotionLocks.delete(input.groupId);
    }
  }
}

async function promoteBranchGroupInner(input: PromoteBranchGroupInput): Promise<BranchGroupPromotionResult> {
  const group = await input.store.getBranchGroup(input.groupId);
  if (!group) {
    return {
      groupId: input.groupId,
      promoted: false,
      alreadyFinalized: false,
      reason: "group-not-found",
      status: "abandoned",
      prState: "none",
    };
  }

  const isPrMode = input.settings.mergeStrategy === "pull-request";

  // Fix #4 (2): a group that finalized but never gained its PR — e.g. a crash
  // between the local integration merge and a successful createGroupPr — would be
  // permanently stranded by the already-finalized short-circuit below. When in PR
  // mode and the finalized group has no persisted PR number, fall through to the
  // PR-creation step ONLY (the integration merge already happened, so we skip it)
  // so a re-promotion can repair it.
  const needsPrRepair =
    isPrMode &&
    group.status === "finalized" &&
    group.prState !== "merged" &&
    (group.prNumber === null || group.prNumber === undefined);

  if (!needsPrRepair && (group.status === "finalized" || group.prState === "merged")) {
    return {
      groupId: group.id,
      promoted: false,
      alreadyFinalized: true,
      reason: "already-finalized",
      status: group.status,
      prState: group.prState,
      prNumber: group.prNumber,
      prUrl: group.prUrl,
    };
  }

  // Legacy fallback rows are exactly `finalized + prState:"open" + prNumber:null`
  // (the old code flipped prState without creating a PR) — the repair path must
  // not be short-circuited by the open-state guard for them.
  if (!needsPrRepair && group.prState === "open") {
    return {
      groupId: group.id,
      promoted: false,
      alreadyFinalized: true,
      reason: "already-finalized",
      status: group.status,
      prState: group.prState,
      prNumber: group.prNumber,
      prUrl: group.prUrl,
    };
  }

  const members = await input.store.listTasksByBranchGroup(group.id);

  // On the PR-repair path the group is already finalized — completion and
  // eligibility were satisfied at finalization, and the integration merge already
  // landed. Re-gating/re-merging would be wrong, so we skip straight to PR-create.
  if (!needsPrRepair) {
    const completion = evaluateBranchGroupCompletion({ members, group });
    if (!completion.complete) {
      return {
        groupId: group.id,
        promoted: false,
        alreadyFinalized: false,
        reason: "incomplete",
        status: group.status,
        prState: group.prState,
        prNumber: group.prNumber,
        prUrl: group.prUrl,
      };
    }

    const eligibility = evaluateBranchGroupPromotion({ group, settings: input.settings });
    if (!eligibility.eligible) {
      await input.recordAudit?.({
        domain: "git",
        mutationType: "merge:branch-group-promotion-gated",
        target: group.id,
        metadata: {
          groupId: group.id,
          branchName: group.branchName,
          groupAutoMerge: eligibility.groupAutoMerge,
          effectiveEligible: false,
          reason: eligibility.reason,
        },
      });
      return {
        groupId: group.id,
        promoted: false,
        alreadyFinalized: false,
        reason: "gated",
        status: group.status,
        prState: group.prState,
        prNumber: group.prNumber,
        prUrl: group.prUrl,
      };
    }
  }

  const integrationBranch = await resolveIntegrationBranch(input.rootDir, input.settings);
  if (!needsPrRepair) {
    await ensureGroupBranchExists(input.rootDir, group.branchName, integrationBranch);
    const currentBranch = (
      await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: input.rootDir })
    ).stdout.trim();
    try {
      await execFileAsync("git", ["checkout", integrationBranch], { cwd: input.rootDir });
      await execFileAsync("git", ["merge", "--no-ff", "--no-edit", group.branchName], { cwd: input.rootDir });
    } finally {
      await execFileAsync("git", ["checkout", currentBranch], { cwd: input.rootDir });
    }
  }

  let prNumber: number | undefined = group.prNumber;
  let prUrl: string | undefined = group.prUrl;
  let prState: BranchGroupPrState = isPrMode ? "open" : "merged";

  if (isPrMode) {
    // Idempotency (KTD4): never open a second PR. Prefer a PR already persisted
    // on this group; otherwise reuse any open PR another group row may hold for
    // the same head branch. Only when neither exists do we invoke the injected
    // creator. The injected creator itself also reuses an existing GitHub PR.
    const persistedPr = group.prNumber
      ? { prNumber: group.prNumber, prUrl: group.prUrl }
      : await (async () => {
          // Only reuse a sibling row's PR when that PR is still OPEN. A
          // closed/merged sibling PR must NOT be relinked onto this group (doing
          // so would persist a terminal PR as if it were live); fall through to
          // creation instead.
          const existing = await input.store.getBranchGroupByBranchName(group.branchName);
          return existing && existing.id !== group.id && existing.prNumber && existing.prState === "open"
            ? { prNumber: existing.prNumber, prUrl: existing.prUrl }
            : null;
        })();

    if (persistedPr) {
      prNumber = persistedPr.prNumber;
      prUrl = persistedPr.prUrl;
      prState = "open";
    } else if (input.createGroupPr) {
      // GitHub failure must leave the group recoverable: do NOT flip prState to a
      // lie. The group is already merged to the integration branch locally; we
      // surface the error so the caller can retry promotion (which is idempotent).
      const created = await input.createGroupPr({
        cwd: input.rootDir,
        group,
        members,
        headBranch: group.branchName,
        baseBranch: integrationBranch,
      });
      prNumber = created.prNumber;
      prUrl = created.prUrl;
      prState = created.prState;
    }
    // If neither a persisted PR nor a createGroupPr callback is available, fall
    // back to the legacy behaviour (flip prState to "open" without a number).
  }

  const updatedGroup = await input.store.updateBranchGroup(group.id, {
    status: "finalized",
    prState,
    prNumber: prNumber ?? null,
    prUrl: prUrl ?? null,
  });

  await input.recordAudit?.({
    domain: "git",
    mutationType: "merge:branch-group-promoted",
    target: group.id,
    metadata: {
      groupId: group.id,
      branchName: group.branchName,
      integrationBranch,
      memberIds: evaluateBranchGroupCompletion({ members, group }).landedMemberIds,
      ...(updatedGroup.prNumber ? { prNumber: updatedGroup.prNumber } : {}),
      ...(updatedGroup.prUrl ? { prUrl: updatedGroup.prUrl } : {}),
    },
  });

  return {
    groupId: group.id,
    promoted: true,
    alreadyFinalized: false,
    reason: "promoted",
    status: updatedGroup.status,
    prState: updatedGroup.prState,
    prNumber: updatedGroup.prNumber,
    prUrl: updatedGroup.prUrl,
  };
}

export interface ReconcileBranchGroupPrResult {
  reconciled: boolean;
  prState: BranchGroupPrState;
  prNumber: number | null;
  prUrl: string | null;
}

/**
 * Fix #3 (engine side): out-of-band PR reconciliation primitive.
 *
 * Once a branch group finalizes, the member-landing sync stops firing, so nothing
 * flips `prState` → "merged" after the managed GitHub PR is merged out-of-band.
 * This helper, given a group carrying a persisted `prNumber` and `prState` "open",
 * invokes the injected {@link SyncGroupPrFn} (which reconciles against GitHub via
 * `getPrStatus`) and persists `prState`/`prUrl`/`prNumber` when GitHub reports a
 * changed state. It mirrors the merger's U6 reconcile block.
 *
 * No-op (no write) when the group has no `prNumber`, is not "open", or GitHub still
 * reports it open. The dashboard route that calls this on a schedule/refresh is
 * wired in a separate batch; this is just the cleanly exported engine primitive.
 *
 * Members fetch is conditional: a body-rewriting {@link SyncGroupPrFn} needs the
 * member list, but the dashboard reconcile callback (`reconcileGroupPullRequest`)
 * only reads PR state via `getPrStatus` and discards `members`. To avoid a wasted
 * full task scan on that read-only path, pass `fetchMembers: false` — the sync
 * callback then receives an empty member list. Defaults to `true` so existing
 * body-rewriting callers are unaffected.
 */
export async function reconcileBranchGroupPr(input: {
  store: Pick<TaskStore, "listTasksByBranchGroup" | "updateBranchGroup">;
  group: BranchGroup;
  /**
   * Project working directory — forwarded to {@link SyncGroupPrFn} so the repo
   * identity is resolved per-project (not from the process cwd). The caller (the
   * dashboard route bridge) resolves this from the per-project engine.
   */
  cwd: string;
  syncGroupPr: SyncGroupPrFn;
  /**
   * When `false`, skip the `listTasksByBranchGroup` scan and invoke `syncGroupPr`
   * with an empty member list. Safe only when the sync callback ignores members
   * (read-only reconcile). Defaults to `true`.
   */
  fetchMembers?: boolean;
}): Promise<ReconcileBranchGroupPrResult> {
  const { group } = input;
  if (group.prNumber == null || group.prState !== "open") {
    return {
      reconciled: false,
      prState: group.prState,
      prNumber: group.prNumber ?? null,
      prUrl: group.prUrl ?? null,
    };
  }

  const members = input.fetchMembers === false ? [] : await input.store.listTasksByBranchGroup(group.id);
  const reconciled = await input.syncGroupPr({ cwd: input.cwd, group, members });

  if (reconciled.prState === group.prState) {
    return {
      reconciled: false,
      prState: group.prState,
      prNumber: group.prNumber ?? null,
      prUrl: group.prUrl ?? null,
    };
  }

  const updated = await input.store.updateBranchGroup(group.id, {
    prState: reconciled.prState,
    prNumber: reconciled.prNumber,
    prUrl: reconciled.prUrl,
  });

  return {
    reconciled: true,
    prState: updated.prState,
    prNumber: updated.prNumber ?? null,
    prUrl: updated.prUrl ?? null,
  };
}

export async function resolveBranchGroupMergeRouting(input: {
  task: Pick<Task, "branchContext" | "baseBranch">;
  store: Pick<TaskStore, "getBranchGroup">;
  projectDefaultBranch: string;
  rootDir?: string;
}): Promise<BranchGroupMergeRouting | null> {
  if (input.task.branchContext?.assignmentMode !== "shared") {
    return null;
  }

  const groupId = input.task.branchContext.groupId;
  if (!groupId) {
    return null;
  }
  const branchGroup = await input.store.getBranchGroup(groupId);
  if (!branchGroup) {
    return null;
  }

  if (input.rootDir) {
    await ensureGroupBranchExists(input.rootDir, branchGroup.branchName, input.projectDefaultBranch);
  }

  return {
    branchGroup,
    mergeTarget: resolveTaskMergeTarget(
      { ...input.task, baseBranch: undefined },
      {
        projectDefaultBranch: input.projectDefaultBranch,
        branchGroup,
      },
    ),
  };
}
