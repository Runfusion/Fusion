/*
FNXC:ReviewConvergence 2026-08-22-05:44:
FN-149 requires a second, independent validator decision after a bounded remediation escalation.
The arbiter may release only the failed review attempt whose identity it captured; it never uses the
blanket remediation archive because concurrent review gates may still be blocking.
*/
import type { ArbitrationFailureFence, Task, TaskStore, WorkflowReviewFinding, WorkflowStepResult } from "@fusion/core";
import {
  archiveArbitratedWorkflowStepFailure,
  resolveReviewArbitrationTarget,
  resolveStepReopenPolicy,
  resolveValidatorFallbackModel,
  resolveWorkflowIrForTask,
} from "@fusion/core";
import { mergeEffectiveSettings } from "../project/effective-settings.js";
import { reviewStep } from "../execution/reviewer.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { emitBoundedRunAudit } from "./emit-bounded-run-audit.js";
import type { AppendReviewRemediationOptions, AppendReviewRemediationOutcome } from "./append-review-remediation-steps.js";
import type { RequestPreMergeOptionalStepFixInfo } from "./request-pre-merge-optional-step-fix.js";
import { resolveRemediationCheckout } from "./resolve-remediation-checkout.js";

export type ReviewArbitrationReleaseDeps = {
  /** FNXC:Identity 2026-08-23-06:40: total run carrier — main added this seam after U18 converted
   *  the store, so its writes arrived with no actor. Required so a call site cannot omit it. */
  runContextFor: (taskId: string, fallbackAgentId?: string | null) => import("@fusion/core").RunMutationContext;
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
};

export type ReviewArbitrationDeps = ReviewArbitrationReleaseDeps & {
  sendTaskBackForFix: (
    task: Task, worktreePath: string, failureFeedback: string, stepName: string, reason: string,
    preserveResumeState: boolean, mergeVerificationFailure: boolean,
    retryPresentation?: { attempt: number; max?: number }, findings?: WorkflowReviewFinding[],
    persistWorktreePath?: boolean, stepReopenPolicy?: "reopen-trailing" | "none",
  ) => Promise<void>;
  appendReviewRemediationSteps?: (
    task: Task,
    info: RequestPreMergeOptionalStepFixInfo,
    options?: AppendReviewRemediationOptions,
  ) => Promise<AppendReviewRemediationOutcome>;
};

type ArbitrationDecision = "UPHOLD_REVIEW" | "UPHOLD_IMPLEMENTER" | "SPLIT";

function parseArbitrationDecision(value: string): { decision: ArbitrationDecision; notes: string; bindingFindingIds: string[] } | undefined {
  const candidate = value.match(/\{\s*"decision"\s*:\s*"(?:UPHOLD_REVIEW|UPHOLD_IMPLEMENTER|SPLIT)"[\s\S]*\}\s*$/)?.[0];
  if (!candidate) return undefined;
  try {
    const parsed = JSON.parse(candidate) as { decision?: unknown; notes?: unknown; bindingFindingIds?: unknown };
    if (parsed.decision !== "UPHOLD_REVIEW" && parsed.decision !== "UPHOLD_IMPLEMENTER" && parsed.decision !== "SPLIT") return undefined;
    if (typeof parsed.notes !== "string" || !Array.isArray(parsed.bindingFindingIds) || !parsed.bindingFindingIds.every((id) => typeof id === "string")) return undefined;
    return { decision: parsed.decision, notes: parsed.notes, bindingFindingIds: parsed.bindingFindingIds };
  } catch {
    return undefined;
  }
}

function collectGateAttemptHistory(task: Task, workflowStepId: string) {
  const result = task.workflowStepResults?.find((entry) => entry.workflowStepId === workflowStepId);
  if (!result) return [];
  return [...(result.priorAttempts ?? [])].reverse().concat(result).filter((entry) => entry.verdict === "REVISE");
}

function failedFence(result: NonNullable<Task["workflowStepResults"]>[number], decision: ArbitrationDecision, bindingFindingCount: number, notes: string): ArbitrationFailureFence {
  return {
    workflowStepId: result.workflowStepId,
    expectedStartedAt: result.startedAt,
    expectedCompletedAt: result.completedAt,
    expectedVerdict: result.verdict,
    ...(result.reviewInputFingerprint ? { expectedReviewInputFingerprint: result.reviewInputFingerprint } : {}),
    decision,
    bindingFindingCount,
    arbitratedAt: new Date().toISOString(),
    arbitrationNotes: notes,
  };
}

/** Apply an already-parsed implementer ruling, refusing every stale or partial attempt. */
/*
FNXC:ReviewConvergence 2026-08-22-05:56:
FN-149 requires an implementer ruling to leave an auditable disposition on disputed findings before
its exact failed gate is archived. This transformation is deliberately limited to the fenced gate;
a sibling failed gate must remain byte-identical and merge-blocking.
*/
function upholdDisputedFindings(results: WorkflowStepResult[] | undefined, workflowStepId: string): WorkflowStepResult[] | undefined {
  let changed = false;
  const next = results?.map((result) => {
    if (result.workflowStepId !== workflowStepId || !result.findings?.length) return result;
    const findings = result.findings.map((finding) => {
      if (!finding.disputedAt || (finding.resolution !== undefined && finding.resolution !== "open")) return finding;
      changed = true;
      return { ...finding, resolution: "dispute-upheld" as const };
    });
    return findings === result.findings ? result : { ...result, findings };
  });
  return changed ? next : results;
}

function bindingObligations(
  findings: WorkflowReviewFinding[] | undefined,
  bindingFindingIds: readonly string[],
  decision: ArbitrationDecision,
): WorkflowReviewFinding[] | undefined {
  if (!findings) return undefined;
  // A malformed UPHOLD_REVIEW with no IDs must not erase obligations; a SPLIT with none releases.
  const binding = new Set(bindingFindingIds);
  const survivors = binding.size === 0 && decision === "UPHOLD_REVIEW"
    ? findings
    : findings.filter((finding) => binding.has(finding.id));
  return survivors.map((finding) => ({
    ...finding,
    disputeRationale: undefined,
    disputedAt: undefined,
    disputeRebuttedAt: undefined,
  }));
}

export async function applyReviewArbitrationRelease(
  deps: ReviewArbitrationReleaseDeps,
  taskId: string,
  fence: ArbitrationFailureFence,
): Promise<{ applied: boolean; reason?: string }> {
  let outcome: { applied: boolean; reason?: string } = { applied: false };
  await deps.store.updateTaskAtomic(taskId, (task) => {
    const adjudicated = upholdDisputedFindings(task.workflowStepResults, fence.workflowStepId);
    const release = archiveArbitratedWorkflowStepFailure(adjudicated, fence);
    if (!release.applied) {
      outcome = { applied: false, reason: release.reason };
      return null;
    }
    outcome = { applied: true };
    return { workflowStepResults: release.results };
  }, deps.runContextFor(taskId));
  const context = deps.runContextFor(taskId);
  if (context) await emitBoundedRunAudit(deps.store, {
    taskId, agentId: context.agentId, runId: context.runId, domain: "database",
    mutationType: "task:review-arbitration", target: taskId,
    metadata: {
      workflowStepId: fence.workflowStepId, decision: fence.decision,
      bindingFindingCount: fence.bindingFindingCount, released: outcome.applied,
      outcome: outcome.applied ? "released" : "fenced-stale",
    },
  });
  if (outcome.applied) await deps.store.logEntry(
    taskId,
    "Review arbitration released adjudicated gate",
    `Arbitration released only workflow step '${fence.workflowStepId}' after an implementer ruling.`,
    context,
  );
  return outcome;
}

/** Dispatch one validator arbitration and make its ruling lifecycle-effective. */
export async function runReviewArbitration(
  deps: ReviewArbitrationDeps,
  task: Task,
  workflowStepId: string,
  stepName: string,
  feedback: string,
  attempt: number,
  max: number | undefined,
): Promise<"arbitrated" | "declined"> {
  // Never select a display-name match or an unrelated failed gate: the ladder selected this ID.
  const failed = (task.workflowStepResults ?? []).find((result) =>
    result.workflowStepId === workflowStepId && result.status === "failed");
  if (!failed) return "declined";
  const remediationCheckout = resolveRemediationCheckout(task, failed);
  const settings = await mergeEffectiveSettings(deps.store, task, await deps.store.getSettings());
  const configuredTarget = resolveReviewArbitrationTarget(settings);
  if (settings.reviewArbitrationEnabled === false) return "declined";
  // A configured arbitration pair owns this third-model lane; otherwise use the validator fallback.
  const fallbackTarget = resolveValidatorFallbackModel(settings);
  const provider = configuredTarget.provider ?? fallbackTarget.provider;
  const modelId = configuredTarget.modelId ?? fallbackTarget.modelId;
  const history = collectGateAttemptHistory(task, failed.workflowStepId);
  const prompt = `${task.prompt ?? ""}\n\n## Review arbitration\nDecide this disagreement using the code and the complete same-gate ledger below. Return exactly one trailing JSON object: {"decision":"UPHOLD_REVIEW"|"UPHOLD_IMPLEMENTER"|"SPLIT","notes":"...","bindingFindingIds":["..."]}.\n\n${JSON.stringify(history)}`;
  let raw: string;
  try {
    const result = await reviewStep(remediationCheckout?.path ?? process.cwd(), task.id, 0, `Arbitration: ${stepName}`, "code", prompt, undefined, {
      store: deps.store,
      taskId: task.id,
      settings,
      // Task-validator overrides are the highest reviewer-lane precedence, so the configured
      // arbitration pair cannot be shadowed by the ordinary validator model selection.
      ...(provider && modelId ? { taskValidatorProvider: provider, taskValidatorModelId: modelId } : {}),
    });
    raw = result.review;
  } catch {
    return "declined";
  }
  const ruling = parseArbitrationDecision(raw);
  if (!ruling) return "declined";
  const fence = failedFence(failed, ruling.decision, ruling.bindingFindingIds.length, ruling.notes);
  if ((ruling.decision === "UPHOLD_IMPLEMENTER" || (ruling.decision === "SPLIT" && ruling.bindingFindingIds.length === 0))) {
    const release = await applyReviewArbitrationRelease(deps, task.id, fence);
    return release.applied ? "arbitrated" : "declined";
  }
  if (!remediationCheckout) return "declined";
  const obligations = bindingObligations(failed.findings, ruling.bindingFindingIds, ruling.decision);
  /*
  FNXC:ReviewConvergence 2026-08-22-05:56:
  A review-upheld or binding SPLIT ruling removes only the dispute annotation from the surviving
  obligations. It does not release their failed gate; the next remediation receives the arbiter's
  binding subset as its must-fix findings.
  */
  let obligationsApplied = false;
  await deps.store.updateTaskAtomic(task.id, (current) => {
    const currentGate = current.workflowStepResults?.find((entry) => entry.workflowStepId === failed.workflowStepId);
    const fenceStillMatches = currentGate?.status === "failed"
      && currentGate.startedAt === failed.startedAt
      && currentGate.completedAt === failed.completedAt
      && currentGate.verdict === failed.verdict
      && currentGate.reviewInputFingerprint === failed.reviewInputFingerprint
      && currentGate.supersededAt == null;
    if (!fenceStillMatches) return null;
    obligationsApplied = true;
    return {
      workflowStepResults: obligations
        ? current.workflowStepResults?.map((entry) => entry.workflowStepId === failed.workflowStepId
          ? { ...entry, findings: obligations }
          : entry)
        : current.workflowStepResults,
    };
  }, deps.runContextFor(task.id));
  /*
  FNXC:ReviewConvergence 2026-08-22-06:06:
  FN-149 fences review-upheld rulings as strictly as implementer releases. An arbiter that read an
  older failed attempt must not bounce a newer gate or inject obsolete obligations into it; a lost
  compare-and-set is a declined, lifecycle-inert ruling rather than a remediation request.
  */
  if (!obligationsApplied) {
    const context = deps.runContextFor(task.id);
    if (context) await emitBoundedRunAudit(deps.store, {
      taskId: task.id, agentId: context.agentId, runId: context.runId, domain: "database",
      mutationType: "task:review-arbitration", target: task.id,
      metadata: {
        workflowStepId: failed.workflowStepId, decision: ruling.decision,
        bindingFindingCount: ruling.bindingFindingIds.length, released: false, outcome: "fenced-stale",
      },
    });
    return "declined";
  }
  const workflowIr = await resolveWorkflowIrForTask(deps.store, task.id).catch(() => undefined);
  const stepReopenPolicy = resolveStepReopenPolicy(workflowIr);
  /*
  FNXC:LifecycleContainment 2026-08-30-12:57:
  Arbitration must use the selected workflow's remediation model too. A `none` workflow cannot
  receive a raw send-back: append the arbiter's surviving obligations first, including the
  deterministic Code Review fallback when the reviewer omitted usable Fix steps.
  */
  if (stepReopenPolicy === "none") {
    const appender = deps.appendReviewRemediationSteps;
    if (!appender) return "declined";
    const outcome = await appender(task, {
      nodeId: failed.workflowStepId,
      stepName,
      feedback,
      phase: failed.phase ?? "pre-merge",
      status: failed.status,
      verdict: failed.verdict,
      reviewKind: failed.reviewKind,
      findings: obligations ?? failed.findings,
    });
    return outcome === "appended" ? "arbitrated" : "declined";
  }
  await deps.sendTaskBackForFix(task, remediationCheckout.path, feedback, stepName,
    "Review arbitration upheld remaining review obligations", true, false,
    { attempt: attempt + 1, max }, obligations ?? failed.findings, remediationCheckout.persist, stepReopenPolicy);
  return "arbitrated";
}
