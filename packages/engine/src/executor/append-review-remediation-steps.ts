import {
  buildStepLedgerReopenLog,
  DEFAULT_MAX_POST_REVIEW_FIXES,
  formatRemediationStepName,
  hasOpenEquivalentRemediationStep,
  remediationDeclaredFiles,
  remediationWaveCount,
  planRemediationPlacement,
  resolveOptionalReviewRevisionBudget,
  resolveOptionalStepRevisionBudget,
  type RunMutationContext,
  type Task,
  type TaskStep,
  type TaskStore,
} from "@fusion/core";
import { deriveRemediationSteps, verificationEvidenceDigest } from "./derive-remediation-steps.js";
import { reviewInputSignature, type RequestPreMergeOptionalStepFixInfo } from "./request-pre-merge-optional-step-fix.js";
import { deriveWorkspaceReviewRemediation } from "./workspace-review-remediation.js";
import { mergeEffectiveSettings } from "../project/effective-settings.js";
import { resolveReviewRemediationGate } from "./review-remediation-gate.js";
import { resolveRemediationCheckout } from "./resolve-remediation-checkout.js";
import {
  countOptionalStepRevisionAttempts,
  hasReviewRemediationAttemptForEpisode,
  optionalStepRevisionKey,
  optionalStepRevisionLogOutcome,
  reviewRemediationEpisodeIdentity,
} from "./optional-step-revision.js";

export type AppendReviewRemediationStepsDeps = {
  store: TaskStore;
  readTaskArtifact: (taskId: string, key: string) => Promise<string | undefined>;
  sendTaskBackForFix: (...args: any[]) => Promise<void>;
};

export type AppendReviewRemediationOutcome =
  | "appended"
  | "budget-exhausted"
  | "released-verification-no-progress"
  | "released-upstream-out-of-scope"
  | "released-no-actionable-findings"
  | "released-no-pending-work"
  | "released-workspace-worktree-missing"
  | "superseded-scope"
  | "superseded-review"
  | "duplicate-no-new-work"
  | "not-applicable";

/**
 * FNXC:ReviewGatedRemediation 2026-08-23-05:14:
 * A review-gated rejection appends named provenance work before it can bounce. This deliberately
 * refuses a blind return to implementation: no candidate, out-of-scope evidence, or duplicate-only
 * work is recorded and released as non-blocking rather than producing either an empty executor
 * dispatch or an engine-authored human hold.
 *
 * FNXC:ReviewGatedRemediation 2026-09-03-05:40:
 * `wave` remains provenance rather than a second budget. The caller resolves stored workflow policy
 * and authored `maxRevisions`, then the atomic attempt claim enforces that bound while publishing
 * named work; evidence-based releases remain separate from budget exhaustion.
 *
 * FNXC:ReviewGatedRemediation 2026-08-28-07:48:
 * Review remediation may ask for human action only when an operator authored that gate. Automatic
 * convergence failures leave task lifecycle state untouched and release the review as advice.
 */
/*
FNXC:VerificationRemediation 2026-08-26-06:31:
`worktreePath` lets a caller that already HOLDS the live checkout hand it in instead of falling back
to `task.worktree`. The executor's deterministic-verification gate is such a caller, and the fallback
is not safe for it: `performWorkflowRerunBounce` persists whatever path it receives back onto
`task.worktree`, so an empty fallback WIPES the pointer — the card renders "Unassigned" and
self-healing can no longer reclaim the worktree as idle. Graph-driven callers (the Code Review
remediation node) have no such path in hand and keep the task-record fallback.
*/
export type ReviewRemediationAttemptClaim = {
  revisionKey: string;
  stepName: string;
  status: string;
  maxRevisions: number | "unbounded";
  expectedWorkflowStepId?: string;
  /** Legacy content-review signature retained for adapter compatibility. */
  expectedReviewSignature?: string;
  expectedReviewEpisodeIdentity?: string;
  /** Fences deterministic executor verification, which has no WorkflowStepResult occurrence. */
  expectedTaskUpdatedAt?: string;
  runContext?: RunMutationContext;
};

export type AppendReviewRemediationOptions = {
  worktreePath?: string;
  attemptClaim?: ReviewRemediationAttemptClaim;
  /** Executor verification requests resolution before entering the strict fenced producer. */
  resolveAttemptClaim?: true;
};

/*
FNXC:CodeReviewFixSteps 2026-08-30-12:57:
A Code Review REVISE is a repair request, never an operator-blocking state merely because a model
omitted a file-specific finding or pointed outside the original scope. The fallback is itself a
structural pending Fix step: it tells the executor exactly which missing review artifact to turn into
concrete implementation work while preserving the review feedback. Verification and other gates keep
their stricter evidence-based release behavior.
*/
function missingCodeReviewFixSteps(info: RequestPreMergeOptionalStepFixInfo, wave: number): TaskStep {
  const feedback = info.feedback.replace(/\s+/g, " ").trim().slice(0, 4_000) || "No review feedback was captured.";
  const detail = "Code Review returned REVISE without usable file-scoped Fix steps. Inspect the review feedback, identify the affected implementation, make the correction, and leave concrete file-scoped remediation for any issue that remains. Reviewer feedback: " + feedback;
  return {
    name: formatRemediationStepName({ title: "Turn Code Review feedback into actionable fixes", detail }),
    status: "pending",
    remediation: {
      wave,
      gate: "Code Review",
      gateStepId: info.nodeId ?? "code-review",
      findingId: "missing-code-review-fix-steps",
      detail,
    },
  };
}

export async function appendReviewRemediationStepsWithResolvedAccounting(
  deps: AppendReviewRemediationStepsDeps,
  task: Task,
  info: RequestPreMergeOptionalStepFixInfo,
  options: AppendReviewRemediationOptions = {},
): Promise<AppendReviewRemediationOutcome> {
  if (options.attemptClaim) return appendReviewRemediationSteps(deps, task, info, options);
  if (options.resolveAttemptClaim !== true) return appendReviewRemediationSteps(deps, task, info, options);
  const gate = resolveReviewRemediationGate(info);
  if (!gate) return "not-applicable";
  const failed = (task.workflowStepResults ?? []).find((result) =>
    result.workflowStepId === info.nodeId && result.status === "failed",
  );
  if (!failed && gate !== "Verification") return "not-applicable";
  const settings = await mergeEffectiveSettings(deps.store, task, await deps.store.getSettings());
  const maxRevisions = resolveOptionalReviewRevisionBudget({
    optionalGroupId: info.nodeId ?? info.stepName,
    workflowSettings: settings as Record<string, unknown>,
    nodeMaxRevisions: info.maxRevisions,
    fallbackMaxRevisions: settings.maxPostReviewFixes ?? DEFAULT_MAX_POST_REVIEW_FIXES,
  });
  const budget = resolveOptionalStepRevisionBudget(
    maxRevisions,
    settings.maxPostReviewFixes ?? DEFAULT_MAX_POST_REVIEW_FIXES,
  );
  const expectedReviewEpisodeIdentity = failed
    ? reviewRemediationEpisodeIdentity(failed)
    : `executor-verification:${verificationEvidenceDigest(info.feedback) ?? "empty"}`;
  return appendReviewRemediationSteps(deps, task, info, {
    ...options,
    attemptClaim: {
      revisionKey: optionalStepRevisionKey(info.nodeId, info.stepName),
      stepName: info.stepName,
      status: info.status,
      maxRevisions: budget.unbounded ? "unbounded" : budget.max,
      expectedWorkflowStepId: failed?.workflowStepId,
      expectedReviewEpisodeIdentity,
      ...(!failed ? { expectedTaskUpdatedAt: task.updatedAt } : {}),
    },
  });
}

export async function appendReviewRemediationSteps(
  deps: AppendReviewRemediationStepsDeps,
  task: Task,
  info: RequestPreMergeOptionalStepFixInfo,
  options: AppendReviewRemediationOptions = {},
): Promise<AppendReviewRemediationOutcome> {
  const gate = resolveReviewRemediationGate(info);
  if (!gate) return "not-applicable";
  /*
  FNXC:ReviewRemediationBudget 2026-09-08-02:24:
  Named remediation has no compatibility path that may publish executable work without its keyed
  attempt and aggregate charge. Callers that cannot identify the budget and failed review episode
  are reporting-only: refuse before reading or mutating task artifacts, workspace claims, logs, or
  lifecycle state so the work-and-accounting transaction remains the sole publication authority.
  */
  if (!options.attemptClaim) return "not-applicable";
  const wave = remediationWaveCount(task.steps ?? []) + 1;
  if (gate === "Verification") {
    const currentEvidenceDigest = verificationEvidenceDigest(info.feedback);
    const priorEvidenceDigest = (task.steps ?? [])
      .filter((step) => step.remediation?.gate === "Verification"
        && typeof step.remediation.evidenceDigest === "string"
        && step.remediation.evidenceDigest.length > 0)
      .sort((left, right) => (right.remediation?.wave ?? 0) - (left.remediation?.wave ?? 0))[0]
      ?.remediation?.evidenceDigest;
    if (currentEvidenceDigest && priorEvidenceDigest === currentEvidenceDigest) {
      return release(
        deps.store,
        task.id,
        "review-remediation-verification-no-progress",
        "released-verification-no-progress",
      );
    }
  }
  const prompt = await deps.readTaskArtifact(task.id, "PROMPT.md");
  const derived = deriveRemediationSteps({
    gate,
    gateStepId: info.nodeId!,
    wave,
    findings: info.findings,
    verificationOutput: info.feedback,
    verificationCommandLabel: gate === "Verification" ? info.stepName : undefined,
    prompt,
    changedFiles: task.modifiedFiles,
    confirmedRepositories: task.repositoryScope?.state === "confirmed"
      ? task.repositoryScope.repositories
      : undefined,
  });
  const remediationSteps = gate === "Code Review" && derived.steps.length === 0
    ? [missingCodeReviewFixSteps(info, wave)]
    : derived.steps;
  if (derived.reason === "upstream-out-of-scope" && gate !== "Code Review") {
    return release(
      deps.store,
      task.id,
      `review-remediation-upstream-out-of-scope:${derived.outOfScope.map((item) => item.filePath).filter(Boolean).join(",")}`,
      "released-upstream-out-of-scope",
    );
  }
  if (remediationSteps.length === 0) {
    return release(
      deps.store,
      task.id,
      "review-remediation-no-actionable-findings",
      "released-no-actionable-findings",
    );
  }
  /*
  FNXC:WorkspaceReviewRemediation 2026-08-27-12:26:
  A named-remediation workflow reaches this appender only under the `none` reopen policy, which
  bypasses requestPreMergeOptionalStepFix's workspace-routing branch. Claim the scope generation
  before changing steps or PROMPT.md so a superseded Code Review cannot leave stale work behind.
  */
  const reviewResult = (task.workflowStepResults ?? []).find((result) =>
    (result.workflowStepId === info.nodeId || result.workflowStepName === info.stepName)
    && result.verdict === "REVISE",
  );
  const remediation = task.workspaceWorktrees && reviewResult
    ? deriveWorkspaceReviewRemediation(reviewResult)
    : undefined;
  if (remediation) {
    const updateWorkspaceReviewState = (deps.store as TaskStore & {
      updateWorkspaceReviewState?: TaskStore["updateWorkspaceReviewState"];
    }).updateWorkspaceReviewState;
    if (updateWorkspaceReviewState) {
      const persisted = await updateWorkspaceReviewState.call(deps.store, task.id, remediation.scopeRevision, remediation);
      if (!persisted.updated) {
        await deps.store.logEntry(task.id, "Workspace review remediation superseded by repository scope change");
        return "superseded-scope";
      }
    }
  }

  let appended: TaskStep[];
  let scopeSuperseded = false;
  let reviewSuperseded = false;
  let budgetExhausted = false;
  let duplicate = false;
  let alreadyCommitted = false;
  appended = [];
  const publish = deps.store.publishReviewRemediationFenced?.bind(deps.store);
  const claim = options.attemptClaim;
  const initialExpectedResult = (task.workflowStepResults ?? []).find((result) =>
    result.workflowStepId === (claim.expectedWorkflowStepId ?? info.nodeId)
    && result.status === "failed",
  );
  const expectedEpisodeIdentity = claim.expectedReviewEpisodeIdentity
    ?? (initialExpectedResult ? reviewRemediationEpisodeIdentity(initialExpectedResult) : undefined);
  const expectedColumn = task.column;
  const expectedStatus = task.status;
  const mutate = (current: Task) => {
      /*
      FNXC:WorkspaceReviewRemediation 2026-08-27-12:32:
      A successful review-remediation CAS only claims the target at that instant. Append its named
      work and widen PROMPT.md in the same revision-fenced mutation, so an intervening scope edit
      cannot leave an invalid review episode's steps or File Scope behind.

      FNXC:ReviewRemediationBudget 2026-09-08-01:02:
      The authored revision budget is claimed in the same project-scoped advisory transaction that
      publishes named fix steps. The live failed review, keyed ledger, pending-work duplicate guard,
      prompt, placement, and aggregate counter are re-read and committed together; only executable
      new work is charged, and executor dispatch happens after this transaction commits.

      FNXC:ReviewRemediationBudget 2026-09-08-01:46:
      The transaction revalidates the exact failed occurrence and its lifecycle admission, not merely
      a content-review fingerprint. This fences verification rounds without fingerprints and rejects
      a concurrent pause, manual-review hold, lane move, status replacement, or review replacement.
      */
      if (current.deletedAt || current.paused || current.userPaused || current.autoMerge === false
        || current.column !== expectedColumn || current.status !== expectedStatus) {
        reviewSuperseded = true;
        return null;
      }
      if (remediation && current.repositoryScope?.revision !== remediation.scopeRevision) {
        scopeSuperseded = true;
        return null;
      }
      const expected = (current.workflowStepResults ?? []).find((result) =>
        result.workflowStepId === (claim.expectedWorkflowStepId ?? info.nodeId) && result.status === "failed",
      );
      const exactEpisode = expected ? reviewRemediationEpisodeIdentity(expected) : undefined;
      const legacySignatureMatches = claim.expectedReviewSignature === undefined
        || (expected !== undefined && (reviewInputSignature(expected) ?? "") === claim.expectedReviewSignature);
      const deterministicVerificationMatches = gate === "Verification"
        && !expected
        && claim.expectedTaskUpdatedAt !== undefined
        && current.updatedAt === claim.expectedTaskUpdatedAt;
      if (!expectedEpisodeIdentity
        || (!deterministicVerificationMatches && (!expected || exactEpisode !== expectedEpisodeIdentity || !legacySignatureMatches))) {
        reviewSuperseded = true;
        return null;
      }
      const attemptCount = countOptionalStepRevisionAttempts(current, claim.revisionKey, claim.stepName);
      const existing = current.steps ?? [];
      const transactionWave = remediationWaveCount(existing) + 1;
      appended = remediationSteps
        .filter((candidate) => candidate.remediation !== undefined)
        .filter((candidate) => !hasOpenEquivalentRemediationStep([...existing, ...appended], candidate))
        .map((candidate) => ({
          ...candidate,
          status: "pending" as const,
          remediation: { ...candidate.remediation!, wave: transactionWave },
          ...(candidate.dependsOn ? { dependsOn: [...candidate.dependsOn] } : {}),
        }));
      if (appended.length === 0) {
        duplicate = true;
        if (expectedEpisodeIdentity && hasReviewRemediationAttemptForEpisode(current, expectedEpisodeIdentity)) {
          const equivalentPending = existing.filter((step) =>
            step.status === "pending"
            && step.remediation !== undefined
            && remediationSteps.some((candidate) => hasOpenEquivalentRemediationStep([step], candidate)),
          );
          if (equivalentPending.length > 0) {
            alreadyCommitted = true;
            appended = equivalentPending;
          }
        }
        return null;
      }
      if (claim.maxRevisions !== "unbounded" && attemptCount >= claim.maxRevisions) {
        budgetExhausted = true;
        appended = [];
        return null;
      }
      const placement = planRemediationPlacement(existing, appended);
      const nextPrompt = widenPromptFileScopeContent(current.prompt ?? prompt, remediationDeclaredFiles(appended));
      const attemptEntry = {
        timestamp: new Date().toISOString(),
        action: `Review gate ${gate} requested named remediation (attempt ${attemptCount + 1}/${claim.maxRevisions})`,
        outcome: optionalStepRevisionLogOutcome(
          `Step: ${claim.stepName}\nStatus: ${claim.status}`,
          claim.revisionKey,
          expectedEpisodeIdentity,
        ),
        ...(claim.runContext ? { runContext: claim.runContext } : {}),
      };
      /*
      FNXC:StepLedgerIntegrity 2026-09-01-00:45:
      Reopen the step ledger HERE too. This is the branch Code Review actually takes.

      The completion seal refuses any step transition after "Task marked done by agent" until a
      re-entry marker supersedes it, and the stamp was added to `appendRemediationStepsImpl` -- the
      `else` branch below. Code Review always supplies `attemptClaim`, so it takes THIS inline
      transaction instead and never reached that stamp: the fix shipped into a path the failing case
      does not traverse. Measured on FN-270 after the fix was live -- "Ignored post-completion
      in-progress for step 12 (Fix: ...)" with no reopen entry anywhere before it.

      Stamped inside the same atomic mutation as the steps, so no window exists in which the work is
      present while the ledger still claims completion. Only a real seal is answered, so an append
      during a live session still writes nothing.
      */
      const logWithAttempt = [...(current.log ?? []), attemptEntry];
      const reopenedLog = buildStepLedgerReopenLog(
        logWithAttempt,
        `${appended.length} remediation step(s) appended after completion (wave ${transactionWave})`,
      );
      return {
        steps: placement.steps,
        currentStep: placement.insertionIndex,
        ...(nextPrompt !== current.prompt ? { prompt: nextPrompt } : {}),
        log: reopenedLog ?? logWithAttempt,
        postReviewFixCount: (current.postReviewFixCount ?? 0) + 1,
      };
  };
  const outcome = publish
    ? await publish(task.id, mutate)
    : { applied: true as const, task: await deps.store.updateTaskAtomic(task.id, mutate, claim.runContext) };
  const live = outcome.applied ? outcome.task : await deps.store.getTask(task.id);
  if (scopeSuperseded) {
    await deps.store.logEntry(task.id, "Workspace review remediation superseded by repository scope change");
    return "superseded-scope";
  }
  if (reviewSuperseded) return "superseded-review";
  if (budgetExhausted) return "budget-exhausted";
  if (!alreadyCommitted && (duplicate || !outcome.applied)) return "duplicate-no-new-work";
  if (appended.length === 0 || !live.steps.some((step) => step.status === "pending")) {
    return release(
      deps.store,
      task.id,
      "review-remediation-no-pending-work",
      "released-no-pending-work",
    );
  }
  if (remediation) {
    const workspaceWorktreePath = live.workspaceWorktrees?.[remediation.repository]?.worktreePath;
    if (!workspaceWorktreePath) {
      return release(
        deps.store,
        task.id,
        "review-remediation-workspace-worktree-missing",
        "released-workspace-worktree-missing",
      );
    }
    await deps.sendTaskBackForFix(
      live,
      workspaceWorktreePath,
      info.feedback,
      info.stepName,
      `Review gate ${gate} requested named remediation`,
      true,
      false,
      undefined,
      info.findings,
      false,
      "none",
    );
    return "appended";
  }
  const providedPath = options.worktreePath?.trim();
  const checkout = providedPath
    ? { path: providedPath, persist: undefined }
    : resolveRemediationCheckout(live, reviewResult);
  if (!checkout) {
    return release(
      deps.store,
      task.id,
      "review-remediation-workspace-worktree-missing",
      "released-workspace-worktree-missing",
    );
  }
  await deps.sendTaskBackForFix(
    live,
    checkout.path,
    info.feedback,
    info.stepName,
    `Review gate ${gate} requested named remediation`,
    true,
    false,
    undefined,
    info.findings,
    checkout.persist,
    "none",
  );
  return "appended";
}

async function release<T extends AppendReviewRemediationOutcome>(
  store: TaskStore,
  taskId: string,
  reason: string,
  outcome: T,
): Promise<T> {
  await store.logEntry(taskId, "Review remediation released as non-blocking", reason);
  return outcome;
}

function widenPromptFileScopeContent(prompt: string | undefined, files: readonly string[]): string | undefined {
  const additions = [...new Set(files.map((file) => file.trim()).filter(Boolean))];
  if (additions.length === 0 || !prompt) return prompt;
  const heading = /^##\s+File Scope\s*$/m.exec(prompt);
  if (!heading || heading.index === undefined) return prompt;
  const sectionStart = heading.index + heading[0].length;
  const rest = prompt.slice(sectionStart);
  const nextHeading = rest.search(/^##\s/m);
  const sectionEnd = nextHeading === -1 ? prompt.length : sectionStart + nextHeading;
  const section = prompt.slice(sectionStart, sectionEnd);
  const existing = new Set((section.match(/`([^`]+)`/g) ?? []).map((entry) => entry.slice(1, -1)));
  const missing = additions.filter((file) => !existing.has(file));
  if (missing.length === 0) return prompt;
  const trimmed = section.replace(/\s+$/, "");
  const insertion = missing.map((file) => `- \`${file}\``).join("\n");
  const replacement = trimmed.length === 0 ? `\n\n${insertion}\n` : `${trimmed}\n${insertion}\n`;
  return prompt.slice(0, sectionStart) + replacement + prompt.slice(sectionEnd);
}
