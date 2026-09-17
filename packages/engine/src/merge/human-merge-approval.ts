/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
FN-514 — server-side resolution of a delivery-lock DECISION POINT: is a decision due right now, what
exactly is the operator deciding on, and which of the three commands can actually be carried out.

Two things are deliberately kept apart here, because collapsing them is how a usable feature turns
into a dead end:

  • AVAILABILITY  — "the work and every configured pre-merge gate are genuinely satisfied, and the
                    only thing left is the human decision". This REUSES the existing merge doors
                    (`resolvePreMergeGateForTask` + `getTaskMergeBlocker` + `evaluatePreMergeApprovals`
                    through the same helper), excluding ONLY this feature's own barrier so the lock
                    does not report itself as the reason a decision cannot be made.
  • CAPABILITY    — "can THIS action be executed": missing GitHub auth disables «Créer PR» with a
                    reason and leaves «Merger» and «Refuser» untouched; a multi-repository workspace
                    that the single-PR path cannot cover disables «Créer PR» rather than inventing a
                    fictitious global PR.

An empty gate selection (notably Fast) is a VALID availability answer: no artificial review is
imposed. Unreadable content or an unresolvable workflow selection is NOT — those fail closed.
*/

import {
  describeHumanMergeContentSignature,
  describeHumanMergeTargetSignature,
  encodeHumanMergeCandidateToken,
  getTaskMergeBlocker,
  isHumanMergeApprovalBlocker,
  isHumanMergeApprovalEnabled,
  isWorkspaceTask,
  resolveHumanMergeDecision,
  resolveHumanMergeLockGeneration,
  resolvePendingHumanMergeRejection,
  resolvePreMergeGateForTask,
  resolveTaskMergeTarget,
  type HumanMergeCandidateIdentity,
  type HumanMergeDecisionAction,
  type HumanMergeTargetDescriptor,
  type MergeContentDescriptor,
  type Task,
  type TaskStore,
} from "@fusion/core";

import { captureMergeContentDescriptor } from "./merge-content-capture.js";

export type HumanMergeActionCapability = {
  action: HumanMergeDecisionAction;
  enabled: boolean;
  /** Stable, translatable reason code. Never raw error prose. */
  reason?:
    | "github-auth-unavailable"
    | "no-remote"
    | "workspace-multi-repository"
    | "content-unavailable"
    | "already-decided";
};

export type HumanMergeDecisionPoint = {
  /** True when the card carries the per-card requirement at all. */
  enabled: boolean;
  /** True when a decision is genuinely due now. */
  available: boolean;
  /** Stable reason code when not available. */
  unavailableReason?:
    | "not-armed"
    | "workflow-unresolvable"
    | "content-unavailable"
    | "target-unresolvable"
    | "rejection-in-progress"
    | "already-approved"
    | "blocked";
  /** Human-readable pass-through of the underlying merge blocker, when there is one. */
  blocker?: string;
  candidate?: HumanMergeCandidateIdentity;
  candidateToken?: string;
  /** Presentation of what is being delivered. */
  content?: MergeContentDescriptor;
  targets?: { merge?: HumanMergeTargetDescriptor; "create-pr"?: HumanMergeTargetDescriptor };
  capabilities: HumanMergeActionCapability[];
  /** Echoed so the client can send a matching optimistic precondition. */
  revision: string;
};

export type HumanMergeDecisionPointDeps = {
  store: TaskStore;
  workspaceRootDir: string;
  settings: Record<string, unknown>;
  /** Injected so the engine never imports the dashboard's GitHub surface. */
  isGithubAuthenticated?: () => boolean | Promise<boolean>;
  /** Resolved remote name for the task's primary repository, when one exists. */
  resolveRemote?: (task: Task) => string | undefined | Promise<string | undefined>;
  /** Head branch the delivery would publish. */
  resolveHeadBranch?: (task: Task) => string | undefined;
  /*
  FNXC:HumanMergeApproval 2026-09-17-18:09:
  Content capture is an injectable SEAM, not a hidden import, so route and boundary tests can supply
  the three evidence shapes that matter (a real fingerprint, a proven-empty diff, unreadable Git)
  without a worktree. Production callers omit it and get the real Git probe.
  */
  captureContent?: (task: Task) => Promise<MergeContentDescriptor>;
};

/*
The review episode a candidate is bound to: the completion stamp of the LAST terminal pre-merge
review result. A new review run necessarily produces a new stamp, which is what makes a decision made
against an earlier review unusable without comparing reviewer prose.
*/
export function resolveMergeReviewEpisodeId(task: Pick<Task, "workflowStepResults">): string | undefined {
  const results = (task.workflowStepResults ?? [])
    .filter((result) => (result.phase ?? "pre-merge") === "pre-merge")
    .filter((result) => result.status === "passed" || result.status === "skipped");
  if (results.length === 0) {
    /*
    A card with NO pre-merge review results at all is a legitimate candidate (Fast, or a workflow
    whose gate selection is empty). Its episode identity is the completion of the work itself, so use
    a fixed sentinel rather than refusing to present a candidate.
    */
    return "no-pre-merge-review";
  }
  const stamps = results
    .map((result) => result.completedAt ?? result.startedAt)
    .filter((stamp): stamp is string => typeof stamp === "string" && stamp.trim().length > 0)
    .sort();
  return stamps.length > 0 ? stamps[stamps.length - 1] : undefined;
}

/** Workflow identity component: selection id plus the resolved IR hash when available. */
export async function resolveMergeWorkflowSignature(
  store: TaskStore,
  taskId: string,
  task: Task,
): Promise<string | undefined> {
  try {
    const selection = typeof (store as { getTaskWorkflowSelectionAsync?: (id: string) => Promise<unknown> })
      .getTaskWorkflowSelectionAsync === "function"
      ? await (store as { getTaskWorkflowSelectionAsync: (id: string) => Promise<unknown> }).getTaskWorkflowSelectionAsync(taskId)
      : typeof (store as { getTaskWorkflowSelection?: (id: string) => unknown }).getTaskWorkflowSelection === "function"
        ? (store as { getTaskWorkflowSelection: (id: string) => unknown }).getTaskWorkflowSelection(taskId)
        : undefined;
    const selectionId = selection && typeof selection === "object" && "workflowId" in selection
      ? String((selection as { workflowId?: unknown }).workflowId ?? "")
      : typeof selection === "string" ? selection : "";
    const pin = task.workflowIrPin?.trim();
    return `${selectionId || "default"}@${pin || "unpinned"}`;
  } catch {
    // Unreadable selection fails closed: the caller reports `workflow-unresolvable`.
    return undefined;
  }
}

function resolveDefaultHeadBranch(task: Task): string | undefined {
  const branch = task.branch?.trim();
  return branch && branch.length > 0 ? branch : undefined;
}

/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
THE decision-point resolver shared by the operator route, the graph boundary and the detail panel.
Availability deliberately excludes only this feature's own barrier so the card never reports "you
cannot decide because you have not decided".
*/
export async function resolveHumanMergeDecisionPoint(
  task: Task,
  deps: HumanMergeDecisionPointDeps,
): Promise<HumanMergeDecisionPoint> {
  const revision = task.updatedAt;
  const enabled = isHumanMergeApprovalEnabled(task);
  const base: HumanMergeDecisionPoint = { enabled, available: false, capabilities: [], revision };

  if (!enabled) return { ...base, unavailableReason: "not-armed" };

  /*
  A rejection already accepted owns the card until its corrections are published. Presenting a new
  decision here would let an operator quietly undo their own refusal.
  */
  if (resolvePendingHumanMergeRejection(task)) {
    return { ...base, unavailableReason: "rejection-in-progress" };
  }

  let gate;
  try {
    gate = await resolvePreMergeGateForTask(deps.store, task.id, task.enabledWorkflowSteps, task);
  } catch {
    return { ...base, unavailableReason: "workflow-unresolvable" };
  }
  if (gate.provenance === "default" && !gate.selectionAbsent) {
    return { ...base, unavailableReason: "workflow-unresolvable" };
  }

  const workflowSignature = await resolveMergeWorkflowSignature(deps.store, task.id, task);
  if (!workflowSignature) return { ...base, unavailableReason: "workflow-unresolvable" };

  const content = deps.captureContent
    ? await deps.captureContent(task)
    : await captureMergeContentDescriptor(task, {
      workspaceRootDir: deps.workspaceRootDir,
      settings: deps.settings,
    });

  /*
  The SAME door every merge owner consults, minus this feature's own barrier. A blocker that is not
  ours (paused, incomplete steps, a failed or unrun gate, a stale-content approval) means the work is
  not finished, so no decision is due yet.
  */
  const blocker = getTaskMergeBlocker(task, {
    manual: true,
    reviewColumns: gate.reviewColumns.size > 0 ? gate.reviewColumns : new Set(["in-review"]),
    requiredPreMergeStepIds: gate.requiredPreMergeStepIds,
    mergeContent: content,
    skipHumanMergeApproval: true,
  });
  if (blocker) return { ...base, unavailableReason: "blocked", blocker };

  const contentSignature = describeHumanMergeContentSignature(content);
  if (!contentSignature) return { ...base, unavailableReason: "content-unavailable", content };

  const target = resolveTaskMergeTarget(task);
  const head = deps.resolveHeadBranch?.(task) ?? resolveDefaultHeadBranch(task);
  if (!target.branch || !head) return { ...base, unavailableReason: "target-unresolvable", content };

  const remote = await deps.resolveRemote?.(task);
  const repository = isWorkspaceTask(task)
    ? Object.keys(task.workspaceWorktrees ?? {}).sort()
    : ["."];
  const repositories = repository.map((repo) => ({
    repository: repo,
    head,
    base: target.branch!,
    ...(remote ? { remote } : {}),
  }));

  const mergeTarget: HumanMergeTargetDescriptor = { kind: "merge", repositories };
  const createPrTarget: HumanMergeTargetDescriptor = { kind: "create-pr", repositories };
  const targetSignature = describeHumanMergeTargetSignature(mergeTarget);
  if (!targetSignature) return { ...base, unavailableReason: "target-unresolvable", content };

  const candidate: HumanMergeCandidateIdentity = {
    lockGeneration: resolveHumanMergeLockGeneration(task),
    workflowSignature,
    reviewEpisodeId: resolveMergeReviewEpisodeId(task) ?? "unknown",
    contentSignature,
    targetSignature,
    ...(task.repositoryScope?.revision !== undefined ? { repositoryScopeRevision: task.repositoryScope.revision } : {}),
  };

  /*
  A decision already recorded for THIS candidate is not re-decidable: the graph owns its dispatch.
  The panel then shows the receipt (merge progress, or a PR link plus the manual handoff) instead of
  re-offering the same command.
  */
  const existing = resolveHumanMergeDecision(task);
  const alreadyDecided = existing !== undefined
    && encodeHumanMergeCandidateToken(existing.candidate) === encodeHumanMergeCandidateToken(candidate)
    && existing.receipt?.state !== "failed";

  /*
  Capability resolution. «Refuser» is ALWAYS available when a decision is due: it depends on no
  provider, no remote and no authentication. «Créer PR» needs a real remote, real authentication, and
  a scope the existing single-PR path actually covers.
  */
  const githubAuthenticated = (await deps.isGithubAuthenticated?.()) ?? false;
  const createPrReason: HumanMergeActionCapability["reason"] | undefined =
    alreadyDecided ? "already-decided"
      : repositories.length > 1 ? "workspace-multi-repository"
        : !remote ? "no-remote"
          : !githubAuthenticated ? "github-auth-unavailable"
            : undefined;

  const capabilities: HumanMergeActionCapability[] = [
    { action: "create-pr", enabled: createPrReason === undefined, ...(createPrReason ? { reason: createPrReason } : {}) },
    { action: "merge", enabled: !alreadyDecided, ...(alreadyDecided ? { reason: "already-decided" as const } : {}) },
    { action: "reject", enabled: !alreadyDecided, ...(alreadyDecided ? { reason: "already-decided" as const } : {}) },
  ];

  return {
    enabled: true,
    available: !alreadyDecided,
    ...(alreadyDecided ? { unavailableReason: "already-approved" as const } : {}),
    candidate,
    candidateToken: encodeHumanMergeCandidateToken(candidate),
    content,
    targets: { merge: mergeTarget, "create-pr": createPrTarget },
    capabilities,
    revision,
  };
}

/** True when a blocker reported by any door is this feature's human wait rather than a failure. */
export { isHumanMergeApprovalBlocker };
