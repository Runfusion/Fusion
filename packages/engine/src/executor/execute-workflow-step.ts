/**
 * FNXC:CodeOrganization 2026-08-03-15:20:
 * executeWorkflowStep peeled from TaskExecutor (U4).
 *
 * Runs a single workflow step (prompt/skill/review) as an agent session with
 * structured verdict parsing, browser-verification probing, and await-input
 * sentinel handling.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type {
  AgentStore,
  ResolvedTaskOutputLanguage,
  Settings,
  Task,
  TaskStore,
  WorkflowReviewKind,
  WorkflowStep,
  WorkflowStepResult,
} from "@fusion/core";
import {
  applyReviewSeverityGate,
  computePlanApprovalFingerprint,
  isOpenWorkflowReviewFinding,
  MAX_WORKFLOW_REVIEW_FINDINGS,
  PLAN_REVIEW_GROUP_ID,
  finalizePlanningSegment,
  resolveExecutorFallbackModel,
  resolvePersistAgentThinkingLog,
  resolveReviewBlockingSeverity,
  resolveWorkflowStepVerdictRequirement,
  requiresContentReviewProof,
  resolveValidatorFallbackModel,
  resolveTaskOutputLanguage,
  startPlanningSegment,
} from "@fusion/core";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createTaskPromptWriteTool } from "./shared-worker-tools.js";
import type { PluginRunner } from "../plugins/plugin-runner.js";
import { AgentLogger } from "../agents/agent-logger.js";
import type { SessionBoundaryDescriptor } from "../agents/agent-runtime.js";
import { buildSystemPromptWithInstructions } from "../agents/agent-instructions.js";
import {
  createResolvedAgentSession,
  extractRuntimeHint,
  resolveExecutorFallbackThinkingLevel,
  resolveExecutorSessionModel,
  resolveExecutorThinkingLevel,
  resolveValidatorFallbackThinkingLevel,
  resolveValidatorSessionModel,
  resolveValidatorThinkingLevel,
} from "../agents/agent-session-helpers.js";
import {
  buildUserCommentsPromptSection,
  selectUserCommentsForAgentContext,
} from "../agents/agent-user-comments.js";
import { buildSessionSkillContext } from "../cli-runtime/session-skill-context.js";
import {
  extractCommandBinaries,
  formatEnvironmentCapabilitiesSection,
  probeEnvironmentCapabilities,
  type EnvironmentCapabilityProbe,
} from "../environment/environment-capabilities.js";
import { checkSessionError } from "../errors/usage-limit-detector.js";
import {
  requiredArtifactMissingValue,
  requiredArtifactReadFailedValue,
} from "../execution/required-workflow-artifacts.js";
import { accumulateSessionTokenUsage } from "../execution/session-token-usage.js";
import { createStreamingDeltaNormalizer } from "../execution/streaming-delta.js";
import { describeModel, formatModelMarkerDetails, promptWithFallback } from "../pi.js";
import {
  detectExternalIntegrationEvidenceGaps,
  formatExternalIntegrationEvidenceDiagnostic,
} from "../spec-validation/external-integration-evidence.js";
import { createRunAuditor, type EngineRunContext } from "../util/run-audit.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import {
  ReadonlyViolationError,
  filterCustomToolsForReadonly,
} from "../workflows/workflow-step-tool-policy.js";
import { executorLog } from "../logger.js";
import { mergeEffectiveSettings } from "../project/effective-settings.js";
import { injectReviewAdvisoryNotes } from "./workflow-step-failure-injection.js";
import { parseAwaitInputQuestionToolCall } from "./await-input-parse.js";
import {
  augmentSessionSkillsForBrowserStep,
  formatAgentBrowserAvailabilityLog,
  probeAgentBrowserAvailability,
  type AgentBrowserExec,
} from "./browser-probe.js";
import { isWorkflowStepSkillDiscoverable, mergeAdditionalSkillPaths } from "./skill-path-helpers.js";
import { createSeenSteeringIds } from "./task-predicates.js";
import {
  parseWorkflowStepNotesRepair,
  parseWorkflowStepOutput,
  parseWorkflowStepVerdictRepair,
  workflowStepMissingVerdictNotice,
  workflowStepVerdictNoNotesNotice,
  WORKFLOW_STEP_NOTES_REPAIR_PROMPT,
  WORKFLOW_STEP_VERDICT_REPAIR_PROMPT,
  type WorkflowStepOutcome,
  type WorkflowStepVerdictNoNotesReason,
} from "./workflow-step-verdict.js";
import { resolveDiffBaseRef } from "./worktree-git-refs.js";
import {
  computeCodeReviewInputFingerprint,
  computeReviewDiffFingerprint,
  EMPTY_REVIEW_DIFF_FINGERPRINT,
  probeReviewChangesSinceCommit,
  resolveContentReviewInputProof,
} from "../worktree/review-diff-fingerprint.js";
import {
  classifyReviewInlineFixRecapture,
  isFastForwardAdvance,
  readHeadSha,
} from "../worktree/review-inline-fix-recapture.js";
// FNXC:PlanReviewConvergence 2026-08-15-22:15: FN-8768 convergence primer + revision-key classifier (restored post-wave-18).
import { buildGraphPlanReviewConvergenceContext, buildReviewConvergenceContext, optionalStepRevisionKey } from "./optional-step-revision.js";
// FNXC:CommandCenterActivity 2026-08-15-22:15: FN-8868 usage telemetry + session boundaries (restored post-wave-18).
import { attachAgentUsageTelemetry, emitAgentSessionStart } from "../agents/agent-usage-telemetry.js";

const execAsync = promisify(exec);

export const WORKFLOW_STEP_NOTES_REPAIR_TIMEOUT_MS = 120_000;
export const WORKFLOW_STEP_VERDICT_REPAIR_TIMEOUT_MS = 120_000;

type WorkflowStepNotesRepairOutcome = "repaired" | Exclude<WorkflowStepVerdictNoNotesReason, "reused-empty">;
type WorkflowStepVerdictRepairOutcome = "repaired" | "empty" | "timed-out" | "failed-soft" | "unavailable";

/** Find the current reusable review result for one node, scope generation, and exact input fingerprint. */
export function findReusableReviewResult(
  task: Pick<Task, "workflowStepResults">,
  workflowStepId: string,
  reviewInputFingerprint: string | undefined,
  repositoryScopeRevision: number | undefined,
): WorkflowStepResult | undefined {
  if (!reviewInputFingerprint) return undefined;
  return (task.workflowStepResults ?? []).find((result) =>
    result.workflowStepId === workflowStepId
      && result.reviewInputFingerprint === reviewInputFingerprint
      && result.repositoryScopeRevision === repositoryScopeRevision
      && result.status !== "pending"
      && result.supersededAt === undefined
      && result.bypassedAt === undefined
      && result.verdict !== undefined,
  );
}

/*
FNXC:ReviewConvergence 2026-08-28-10:57:
Prior findings alone cannot tell a reviewer whether a defect was fixed or ignored. Render a separate
Git-derived changed-since block so the next same-gate round can make that distinction; workspace
reviews omit it because the singular worktree is not authoritative for their repository set.
*/
export async function buildCodeReviewChangeSummaryBlock(
  task: Pick<Task, "workflowStepResults" | "workspaceWorktrees">,
  workflowStepId: string,
  worktreePath: string,
): Promise<string | undefined> {
  if (task.workspaceWorktrees !== undefined) return undefined;
  const ownResult = task.workflowStepResults?.find((result) => result.workflowStepId === workflowStepId);
  const previousReviewedCommit = ownResult?.priorAttempts?.[0]?.reviewedCommitSha;
  if (!previousReviewedCommit) return undefined;

  const changedSince = await probeReviewChangesSinceCommit(worktreePath, previousReviewedCommit);
  if (changedSince.state === "frozen") {
    return `### Changed since your previous review
No commits landed since your previous review; the reviewed code is unchanged.
Maintain each prior finding by ID if it still applies, or approve. Do not derive new findings from unchanged code.`;
  }
  if (changedSince.state !== "changed") return undefined;

  const commitLabel = changedSince.commitCount === 1 ? "commit" : "commits";
  const files = changedSince.changedFiles.map((file) => `- ${file}`);
  if (changedSince.totalChangedFileCount > changedSince.changedFiles.length) {
    files.push(`- ... (${changedSince.totalChangedFileCount - changedSince.changedFiles.length} more files truncated)`);
  }
  return [
    "### Changed since your previous review",
    `${changedSince.commitCount} ${commitLabel} landed since the commit reviewed in your previous round.`,
    "Changed files:",
    ...files,
    ...(changedSince.shortstat ? [`Diff stat: ${changedSince.shortstat}`] : []),
  ].join("\n");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirror TaskExecutor method/map surface
type AnyFn = (...args: any[]) => any;

export type ExecuteWorkflowStepDeps = {
  store: TaskStore;
  rootDir: string;
  options: {
    pluginRunner?: PluginRunner;
    agentStore?: AgentStore | null;
    onAgentText?: (taskId: string, delta: string) => void;
    onAgentTool?: (taskId: string, toolName: string, detail?: string) => void;
    [k: string]: unknown;
  };
  activePlanningWorkflowSessions: Set<string>;
  activeWorkflowStepSessions: Map<string, AgentSession>;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  captureModifiedFiles: AnyFn;
  createSpawnAgentTool: AnyFn;
  /** FNXC:CodeOrganization 2026-08-03-22:25: plan-review prompt-write uses shared free factory */
  sharedWorkerTools: import("./shared-worker-tools.js").SharedWorkerToolsDeps;
  deleteActiveWorkflowStepSession: AnyFn;
  getAssignedAgentRuntimeConfig: AnyFn;
  getAuthoritativeAssignedAgent: AnyFn;
  readTaskArtifact: AnyFn;
  resolveInstructionsForRole: AnyFn;
  resolveMcpServers: AnyFn;
  setActiveWorkflowStepSession: AnyFn;
};

export async function executeWorkflowStep(
  deps: ExecuteWorkflowStepDeps,
  task: Task,
  workflowStep: WorkflowStep,
  worktreePath: string,
  settings: Settings,
  taskEnv?: NodeJS.ProcessEnv,
  /*
  FNXC:WorkspaceReviewScope 2026-08-26-09:12:
  `diffBaseCommitSha` overrides the SINGULAR `task.baseCommitSha` when a caller runs this step against
  a checkout that does not share it. A workspace Code Review does exactly that: it invokes the step
  once per SUB-REPOSITORY worktree, each with its own base recorded in
  `task.workspaceWorktrees[repo].baseCommitSha`.

  Without the override the scope capture resolved the singular base inside a sub-repo, found nothing,
  and told the reviewer "(no modified files detected for this task)". Measured on a real multi-repo
  card whose executor had COMMITTED in both repositories: the reviewer went looking, could not see the
  committed fixtures inside its own scope, and reported them as never delivered — a factual, confident
  rejection produced entirely by a wrong diff base.
  */
  stepOptions?: {
    unattended?: boolean;
    principalAgentId?: string;
    outputLanguage?: ResolvedTaskOutputLanguage;
    sessionBoundary?: SessionBoundaryDescriptor;
    diffBaseCommitSha?: string;
    /** Node-captured proof for singular content-binding reviews; prevents a second Git probe. */
    reviewInputFingerprint?: string;
    /** Identifies the repository inspected by a per-repository workspace dispatch. */
    dispatchLabel?: string;
  },
): Promise<WorkflowStepOutcome> {
  const diffBaseCommitSha = stepOptions?.diffBaseCommitSha ?? task.baseCommitSha;
    let toolMode: "coding" | "readonly" = workflowStep.toolMode || "readonly";
    // (U3) Genuinely-unattended run — set FUSION_HEADLESS=1 below so skills record
    // assumptions and proceed instead of parking on a question. Explicit opt-in
    // only (default false = board run); see runGraphCustomNode / KTD-3.
    const unattended = stepOptions?.unattended === true;
    /*
    FNXC:WorkflowReviewFindings 2026-08-05-06:29:
    reviewKind is carried from graph synthesis (cfg.reviewKind / optional-group context) so prompt
    nodes that classify as plan/code review emit the structured findings schema and return
    normalized findings on the step outcome for the Review tab.
    */
    const workflowStepMetadata = workflowStep as WorkflowStep & {
      optionalGroupId?: string;
      reviewKind?: "plan" | "code";
      reviewCanFixInline?: boolean;
      requireExternalIntegrationEvidence?: boolean;
    };
    const optionalGroupId = workflowStepMetadata.optionalGroupId;
    const effectiveWorkflowStepId = optionalGroupId ?? workflowStep.id.replace(/^graph:/, "");
    const isContentBindingStep = requiresContentReviewProof(effectiveWorkflowStepId, workflowStepMetadata);
    /*
    FNXC:PlanReviewConvergence 2026-08-04-06:35 (FN-8768; restored 2026-08-15-22:15 after the wave-18
    executor.ts shell-ification dropped it): a RENAMED inner step of the canonical Plan Review optional
    group is still Plan Review — classify by group id, not only by the default id/name.
    */
    const isPlanReviewStep = workflowStep.id === "graph:plan-review-step"
      || workflowStep.name === "Plan Review"
      || optionalGroupId === PLAN_REVIEW_GROUP_ID;
    const planReviewRevisionKey = optionalStepRevisionKey(optionalGroupId, workflowStep.name);
    const isReviewTypeWorkflowStep =
      isPlanReviewStep
      || workflowStepMetadata.reviewCanFixInline === true
      || /(?:^|\b)(?:review|verification)(?:\b|$)/i.test(workflowStep.name)
      || optionalGroupId === "plan-review"
      || optionalGroupId === "code-review"
      || optionalGroupId === "browser-verification";
    /*
     * FNXC:WorkflowReviewers 2026-09-03-05:40:
     * Graph execution supplies the raw project settings map, but `reviewerInlineFixes` is workflow-owned and absent from `DEFAULT_PROJECT_SETTINGS`. Resolve the review step's effective workflow settings once so both its declaration default and an operator's stored value reach the tool-policy decision; reading the raw map made both unreachable. The two-tier merge still lets an explicit base value win over a declaration default.
     */
    const effectiveReviewSettings = isReviewTypeWorkflowStep
      ? await mergeEffectiveSettings(deps.store, task, settings).catch(() => settings)
      : settings;
    const reviewerInlineFixesEnabled = (effectiveReviewSettings as Settings & { reviewerInlineFixes?: boolean }).reviewerInlineFixes === true;
    const allowReviewerInlineFixes = reviewerInlineFixesEnabled && isReviewTypeWorkflowStep && workflowStep.mode === "prompt";
    const allowPlanReviewPromptWrite = allowReviewerInlineFixes && isPlanReviewStep;
    if (allowReviewerInlineFixes && !isPlanReviewStep) {
      toolMode = "coding";
    }
    const requireExternalIntegrationEvidence =
      workflowStepMetadata.requireExternalIntegrationEvidence === true;
    const readonlyMcpServerAllowlist = toolMode === "readonly"
      ? [...new Set((workflowStepMetadata.readonlyMcpServers ?? []).map((name) => name.trim()).filter(Boolean))]
      : [];
    /*
     * FNXC:McpConfig 2026-09-01-06:06:
     * A read-only step may use MCP from explicitly named servers without coding-mode promotion,
     * which would expose the adjacent accepted write-capability gap. Coding steps pass no readonly
     * MCP policy because their ordinary MCP behavior is deliberately unchanged.
     */
    const allowReadonlyMcpTools = toolMode === "readonly" && readonlyMcpServerAllowlist.length > 0;

    /*
     * FNXC:WorkflowReviewSpecInjection 2026-07-18-18:15:
     * FN-7561 established that review agents cannot reliably locate the project-root PROMPT.md from a task worktree. Load it once through the store and embed it for every review-type node. FN-8288 extends that invariant beyond Plan Review: approved planning revisions are authoritative, the original task description is historical, and a failed artifact read must stay visible instead of silently restoring superseded scope.
     */
    let workflowReviewSpecArtifact: string | undefined;
    if (isReviewTypeWorkflowStep) {
      try {
        workflowReviewSpecArtifact = await deps.readTaskArtifact(task.id, "PROMPT.md");
      } catch (error) {
        const diagnostic = `PROMPT.md could not be read because task storage failed; ${workflowStep.name} must retry without replanning. ${error instanceof Error ? error.message : String(error)}`;
        await deps.store.logEntry(task.id, `[pre-merge] ${workflowStep.name} artifact read failed: ${diagnostic}`);
        return {
          success: false,
          error: diagnostic,
          output: diagnostic,
          failureValue: requiredArtifactReadFailedValue("PROMPT.md"),
        };
      }
    }
    const workflowReviewSpecText = typeof workflowReviewSpecArtifact === "string" ? workflowReviewSpecArtifact : "";
    const planReviewSpecText = isPlanReviewStep ? workflowReviewSpecText : "";
    const latestTaskForUserComments = await deps.store.getTask(task.id).catch(() => task);
    const sameGateStepId = effectiveWorkflowStepId;
    /*
    FNXC:ReviewConvergence 2026-08-28-10:57:
    Plan Review must assemble convergence from a fresh task snapshot because disputes recorded during
    remediation land after the executor's original task argument was captured. Code Review and Plan
    Review therefore share this read, with the stale argument retained only as the storage-failure fallback.
    */
    const planReviewConvergenceContext = isPlanReviewStep
      ? buildGraphPlanReviewConvergenceContext(latestTaskForUserComments, planReviewRevisionKey)
      : "";
    const planReviewEnvironmentCapabilities = isPlanReviewStep
      ? await probeEnvironmentCapabilities({
        extraCommands: [
          ...extractCommandBinaries(settings.testCommand),
          ...extractCommandBinaries(settings.buildCommand),
        ],
      }).catch((): EnvironmentCapabilityProbe => ({ capabilities: [], degraded: true }))
      : undefined;
    const planReviewEnvironmentCapabilitiesBlock = planReviewEnvironmentCapabilities
      ? formatEnvironmentCapabilitiesSection(planReviewEnvironmentCapabilities)
      : "";

    /*
    FNXC:PlanReview 2026-07-21-16:30:
    Review steps must never approve or execute against an unavailable contract. Confirmed missing or whitespace-only PROMPT.md fails closed before reviewer creation; typed recovery routes ownership back to planning without spending the review-revision budget.
    */
    if (isReviewTypeWorkflowStep && !workflowReviewSpecText.trim()) {
      const diagnostic = `PROMPT.md could not be loaded; ${workflowStep.name} cannot approve without the authoritative task contract.`;
      await deps.store.logEntry(
        task.id,
        `[pre-merge] ${workflowStep.name} refused to run without PROMPT.md: ${diagnostic}`,
      );
      return {
        success: false,
        revisionRequested: true,
        output: `REVISE: ${diagnostic}`,
        verdict: "REVISE",
        notes: diagnostic,
        failureValue: requiredArtifactMissingValue(["PROMPT.md"]),
      };
    }

    if (isPlanReviewStep && requireExternalIntegrationEvidence) {
      /*
       * FNXC:PlanValidation 2026-06-30-09:03:
       * Coding (per-step review) intentionally keeps external-integration evidence as a Plan Review gate. Enforce it here, not in triage, so only workflows that set `requireExternalIntegrationEvidence` block and failures route through the graph's normal plan-replan loop.
       */
      const evidenceGaps = detectExternalIntegrationEvidenceGaps({
        promptContent: planReviewSpecText,
      });
      if (evidenceGaps.length > 0) {
        const diagnostic = formatExternalIntegrationEvidenceDiagnostic(evidenceGaps);
        const output = `REVISE: ${diagnostic}`;
        await deps.store.logEntry(
          task.id,
          `[pre-merge] Plan Review deterministic external-integration evidence check requested revision: ${diagnostic}`,
        );
        return {
          success: false,
          revisionRequested: true,
          output,
          verdict: "REVISE",
          notes: diagnostic,
        };
      }
    }

    // Compute the diff scope so the workflow step agent reviews only what THIS
    // task changed — not unrelated files it might wander into. Without this,
    // open-ended review prompts (e.g. "verify visual polish") have been
    // observed to spend the entire timeout budget reading pre-existing files
    // that match the task description's keywords. See FN-3327 post-mortem.
    const scopedFiles = await deps.captureModifiedFiles(worktreePath, diffBaseCommitSha, task.id, undefined, "workflow-step-handler");
    let diffShortstat: string | undefined;
    let reviewInputFingerprint: string | undefined;
    let reviewedCommitSha: string | undefined;
    let baseRef: string | undefined;
    try {
      baseRef = await resolveDiffBaseRef(worktreePath, diffBaseCommitSha);
    } catch {
      // The content-proof resolver below reports the fail-closed diagnostic when this step binds content.
    }
    if (isContentBindingStep && task.workspaceWorktrees === undefined) {
      const suppliedFingerprint = stepOptions?.reviewInputFingerprint?.trim();
      const proof = suppliedFingerprint
        ? { kind: "fingerprint" as const, fingerprint: suppliedFingerprint }
        : await resolveContentReviewInputProof(worktreePath, diffBaseCommitSha);
      if (proof.kind === "unprovable") {
        const diagnostic = `${workflowStep.name} review input is unprovable (${proof.reason}); reviewer dispatch refused.`;
        await deps.store.logEntry(
          task.id,
          `[pre-merge] ${diagnostic}`,
          undefined,
          deps.getRunContextFor(task.id),
        );
        return { success: false, error: diagnostic, failureValue: "review-input-unprovable" };
      }
      reviewInputFingerprint = proof.fingerprint;
    } else if (baseRef) {
      try {
        if (workflowStepMetadata.reviewKind === "code") {
          reviewInputFingerprint = await computeCodeReviewInputFingerprint(worktreePath, baseRef);
        } else if (isReviewTypeWorkflowStep) {
          reviewInputFingerprint = await computeReviewDiffFingerprint(worktreePath, baseRef);
        }
      } catch {
        // Non-content review fingerprints remain best-effort; content-binding singular steps fail above.
      }
    }
    if (baseRef) {
      try {
        const { stdout } = await execAsync(`git diff --shortstat ${baseRef}..HEAD`, {
          cwd: worktreePath,
          encoding: "utf-8",
        });
        diffShortstat = stdout.trim() || undefined;
      } catch {
        // Shortstat is prompt context only and must never suppress an already-captured proof.
      }
    }
    if (isReviewTypeWorkflowStep) {
      try {
        const { stdout } = await execAsync("git rev-parse HEAD", {
          cwd: worktreePath,
          encoding: "utf-8",
        });
        reviewedCommitSha = stdout.trim() || undefined;
      } catch {
        // best-effort — a missing anchor must not disturb the review fingerprint or prompt
      }
    }

    const MAX_SCOPE_FILES = 100;
    const scopeFileBlock = scopedFiles.length === 0
      ? "(no modified files detected for this task — review the worktree directly, but do NOT browse unrelated files)"
      : scopedFiles.length > MAX_SCOPE_FILES
        ? `${scopedFiles.slice(0, MAX_SCOPE_FILES).map((f: string) => `- ${f}`).join("\n")}\n- ... (${scopedFiles.length - MAX_SCOPE_FILES} more files truncated)`
        : scopedFiles.map((f: string) => `- ${f}`).join("\n");

    /*
     * FNXC:PlanReviewScope 2026-06-29-00:57:
     * Plan Review validates the planned PROMPT.md before execution. It must not
     * inherit the generic workflow-step diff scope, because dirty worktrees or
     * unrelated local commits can make a plan-only gate reject implementation
     * state and loop back to triage after the planner already approved the spec.
     */
    const approvedContractBlock = isReviewTypeWorkflowStep && !isPlanReviewStep
      ? `

Approved Task Contract:
- PROMPT.md is the authoritative current contract for this review. It includes any approved planning revisions and scope decisions.
- The Task Description is historical input only. Do not enforce superseded requirements from the original Task Description when they conflict with PROMPT.md.
- Do not request behavior that PROMPT.md explicitly defers, excludes, or forbids. Review the implementation against the approved contract reproduced below.
- Scope exclusions do not waive security, correctness, or data-integrity defects in the approved implementation.

--- BEGIN APPROVED PROMPT.md ---
${workflowReviewSpecText}
--- END APPROVED PROMPT.md ---`
      : "";
    /*
    FNXC:CodeReviewCompleteness 2026-08-04-00:20 (FN-8768 / #3327; restored 2026-08-15-22:15 after the
    wave-18 executor.ts shell-ification regressed this block to its pre-FN-8768 wording):
    The modified-file list is a starting scope, not a read prohibition — reviewers may read callers,
    helpers, and tests needed to validate the change, while unrelated pre-existing issues stay out of
    scope. Plan Review appends the convergence primer so repeat attempts stop re-raising settled blockers.
    */
    const scopeBlock = isPlanReviewStep
      ? `Plan Review Scope:
- Review the task plan artifact (PROMPT.md), reproduced verbatim below, and task metadata only.
- The plan is embedded in this prompt — do NOT go looking for a PROMPT.md file in the worktree; it lives at the project root (\`.fusion/tasks/${task.id}/PROMPT.md\`), outside this worktree, so review the embedded copy.
- Do NOT judge current implementation diffs, uncommitted worktree changes, or unrelated repository changes.
- If the plan is internally consistent, complete, scoped, and verifiable, approve even when the worktree contains unrelated changes from another task.

--- BEGIN PROMPT.md ---
${planReviewSpecText}
--- END PROMPT.md ---${planReviewConvergenceContext ? `\n\n${planReviewConvergenceContext}` : ""}${planReviewEnvironmentCapabilitiesBlock ? `\n\n${planReviewEnvironmentCapabilitiesBlock}` : ""}`
      : `Diff Scope (files changed by THIS task vs base):
${scopeFileBlock}${diffShortstat ? `\nDiff stat: ${diffShortstat}` : ""}

CRITICAL SCOPING RULES — read before doing anything else:
- The modified-file list is the starting point and primary reporting scope, not a prohibition on reading code required to validate the change.
- Read necessary callers, selectors, shared helpers, consumers, and tests outside that list when they establish production reachability, invariant coverage, or API/UI parity. Do not report unrelated pre-existing issues.
- If NONE of the modified files are relevant to your review category, confirm that from the list and fast-bail without broad repository exploration.
- Keep adjacent reads bounded to the changed behavior and its immediate production/test chain so the review finishes within its wall-clock budget.${approvedContractBlock}`;

    if (isPlanReviewStep && workflowReviewSpecText.trim()) reviewInputFingerprint = computePlanApprovalFingerprint(workflowReviewSpecText);
    const changeSummaryBlock = workflowStepMetadata.reviewKind === "code"
      ? await buildCodeReviewChangeSummaryBlock(latestTaskForUserComments, sameGateStepId, worktreePath)
      : undefined;
    const reviewConvergenceContext = workflowStepMetadata.reviewKind === "code"
      ? buildReviewConvergenceContext(latestTaskForUserComments, {
        revisionKey: sameGateStepId,
        reviewKind: "code",
        ...(changeSummaryBlock ? { changeSummaryBlock } : {}),
      })
      : "";
    const workflowStepUserComments = selectUserCommentsForAgentContext(latestTaskForUserComments, { limit: null });
    const workflowStepUserCommentSection = buildUserCommentsPromptSection(workflowStepUserComments);

    /*
     * FNXC:AgentSteering 2026-06-30-14:08:
     * Prompt/custom workflow-step reviewers, including Browser Verification agents, do not call reviewStep. They still gate quality, so their system prompt must carry the same canonical uncapped user comments plus legacy steering selected from a fresh task snapshot.
     */

    // (KTD-6) Verdict-contract reconciliation. Skill-native plan/work steps keep
    // their own output contract, while prompt steps whose durable optional-group
    // result reaches merge admission must author a structured verdict.
    const requireVerdict = resolveWorkflowStepVerdictRequirement({
      gateMode: workflowStep.gateMode,
      skillName: workflowStep.skillName,
      summaryTarget: (workflowStep as WorkflowStep & { summaryTarget?: string }).summaryTarget,
      optionalGroupId,
    });
    const reviewFindingsContract = workflowStepMetadata.reviewKind === "plan" || workflowStepMetadata.reviewKind === "code";
    /*
     * FNXC:ReviewSeverityGate 2026-08-10-17:33:
     * Severity is now the gate input, not decoration — state the threshold in the prompt so the reviewer
     * knows which classifications actually block. Telling it the exact rule is what makes the
     * classification honest; when severity had no stated consequence, reviewers marked everything
     * blocking and every nit forced a remediation round.
     *
     * `settings` here is the RAW project map: the graph run loads it via `store.getSettings()` and never
     * merges per-workflow values (see execute-workflow-graph.ts). Reading the threshold off it directly
     * would silently ignore an operator's Workflow Editor override and always use the built-in default.
     * Merge the per-task effective workflow settings first, exactly as the remediation path does — the
     * merge is scoped to review-kind nodes so non-review steps pay nothing.
     */
    const reviewBlockingSeverity = reviewFindingsContract
      ? resolveReviewBlockingSeverity({
        reviewKind: workflowStepMetadata.reviewKind as WorkflowReviewKind,
        workflowSettings: effectiveReviewSettings as unknown as Record<string, unknown>,
        nodeBlockingSeverity: (workflowStep as WorkflowStep & { blockingSeverity?: unknown }).blockingSeverity,
      })
      : undefined;
    /*
    FNXC:ReviewInputReuse 2026-08-28-07:48:
    Review-kind nodes are content-addressed by the authoritative plan or Git diff fingerprint. Reuse
    the current non-superseded terminal result when that input is unchanged; another model dispatch
    cannot observe new work and only creates a review loop. Reapply the live severity gate so legacy
    finding-less REVISE results inherit the current non-blocking contract.

    FNXC:ReviewInputReuse 2026-08-28-09:29:
    A workspace Code Review's confirmed repository-scope revision is part of its input identity.
    Identical bytes under a changed scope require a fresh review because the prior result did not
    inspect the current repository set.

    FNXC:ReviewInputReuse 2026-08-28-09:40:
    Fresh model results must return the captured scope revision with their diff fingerprint. The
    graph writer persists only returned review identity, so omitting the revision made two later
    undefined revisions compare equal and allowed stale evidence reuse after a scope change.
    */
    const repositoryScopeRevision = workflowStepMetadata.reviewKind === "code"
      ? latestTaskForUserComments.repositoryScope?.revision
      : undefined;
    /*
    FNXC:ReviewEmptyContent 2026-08-28-13:14:
    A singular task explicitly confirmed with noCommitsExpected=true has no content for Code Review,
    so dispatching a reviewer can only manufacture a REVISE loop. Resolve that exact, fail-closed
    contract as passed; prompt-derived eligibility is intentionally insufficient because merge
    admission honors only the durable field. A passed result satisfies the empty-merge required-gate
    check and stays on the review success edge, avoiding the remediation node's WIP crossing. The
    empty-merge finalization guards remain authoritative and may still refuse completion.
    */
    if (workflowStepMetadata.reviewKind === "code"
      && reviewInputFingerprint === EMPTY_REVIEW_DIFF_FINGERPRINT
      && latestTaskForUserComments.workspaceWorktrees === undefined
      && latestTaskForUserComments.noCommitsExpected === true) {
      const notes = "Code Review is not applicable because this task explicitly expects no commits and its review diff is empty.";
      await deps.store.logEntry(
        task.id,
        `[pre-merge] ${workflowStep.name} passed without reviewer dispatch: ${notes}`,
      );
      return {
        success: true,
        output: notes,
        verdict: "APPROVE",
        notes,
        reviewInputFingerprint,
        ...(reviewedCommitSha ? { reviewedCommitSha } : {}),
        ...(repositoryScopeRevision !== undefined ? { repositoryScopeRevision } : {}),
      };
    }
    const reusableReviewResult = reviewFindingsContract
      ? findReusableReviewResult(
          latestTaskForUserComments,
          sameGateStepId,
          reviewInputFingerprint,
          repositoryScopeRevision,
        )
      : undefined;
    if (reusableReviewResult?.verdict) {
      const gated = reviewBlockingSeverity
        ? applyReviewSeverityGate({
          verdict: reusableReviewResult.verdict,
          findings: reusableReviewResult.findings,
          threshold: reviewBlockingSeverity,
        })
        : undefined;
      const effectiveVerdict = (gated?.verdict ?? reusableReviewResult.verdict) as NonNullable<WorkflowStepOutcome["verdict"]>;
      await deps.store.logEntry(
        task.id,
        `[pre-merge] ${workflowStep.name} reused the recorded result for unchanged review input ${reviewInputFingerprint}`,
      );
      const storedReusedNotes = reusableReviewResult.notes?.trim() || reusableReviewResult.output?.trim() || "";
      const reusedNotes = storedReusedNotes || workflowStepVerdictNoNotesNotice(effectiveVerdict, "reused-empty");
      const reusedOutput = reusableReviewResult.output?.trim() || reusedNotes;
      return {
        success: effectiveVerdict !== "REVISE",
        revisionRequested: effectiveVerdict === "REVISE",
        output: reusedOutput,
        verdict: effectiveVerdict,
        notes: reusedNotes,
        ...(reusableReviewResult.findings ? { findings: reusableReviewResult.findings } : {}),
        reviewInputFingerprint,
        ...(reviewedCommitSha ? { reviewedCommitSha } : {}),
        ...(repositoryScopeRevision !== undefined ? { repositoryScopeRevision } : {}),
        ...(reusableReviewResult.supersededFindingSourceWorkflowStepId && reusableReviewResult.supersededFindingIds
          ? {
            supersededFindingSourceWorkflowStepId: reusableReviewResult.supersededFindingSourceWorkflowStepId,
            supersededFindingIds: reusableReviewResult.supersededFindingIds,
          }
          : {}),
      };
    }
    /*
     * FNXC:WorkflowReviewFindings 2026-08-11-19:39:
     * Prior open findings make cross-lane supersession an explicit reviewer claim rather than a
     * commit-timestamp inference, so receipts cannot be mistaken for new executor work.
     */
    const priorFindings = reviewFindingsContract
      ? (latestTaskForUserComments.workflowStepResults ?? []).flatMap((result) => result.workflowStepId === sameGateStepId
        ? []
        : (result.findings ?? []).filter(isOpenWorkflowReviewFinding).map((finding) => ({ finding, result })))
        .slice(0, MAX_WORKFLOW_REVIEW_FINDINGS)
      : [];
    const priorFindingsBlock = priorFindings.length > 0
      ? `\n\n  ## Prior Findings In This Review Pass\n\n${priorFindings.map(({ finding, result }) => `- [${result.workflowStepId}] ${finding.id} — [${finding.severity ?? "unclassified"}] ${finding.title}${finding.filePath ? ` (${finding.filePath}${finding.line ? `:${finding.line}` : ""})` : ""}`).join("\n")}`
      : "";
    const blockingSeverityRule = reviewBlockingSeverity === undefined || reviewBlockingSeverity === "any"
      ? ""
      : reviewBlockingSeverity === "critical"
        ? "\n  - REVISE requires at least one `critical` (P0) finding. A REVISE without one is recorded as APPROVE_WITH_NOTES and its findings are handed to the implementer without another review round."
        : "\n  - REVISE requires at least one `critical` (P0) or `high` (P1) finding. A REVISE without one is recorded as APPROVE_WITH_NOTES and its findings are handed to the implementer without another review round.";
    /*
    FNXC:ReviewVerdictContract 2026-08-26-11:04:
    Three defects in how the verdict was ASKED FOR, all found by auditing a real off-format review.
    This block is the last thing in the system prompt, which is the strongest position — so what it
    says last matters most.

    1. Its final sentence used to read "Backward compat fallback: if JSON is unavailable, you may
       still begin output with REQUEST REVISION". The closing words of the entire prompt granted
       permission to skip the format, and "if JSON is unavailable" implied it sometimes is — it never
       is. An imperative followed by a dispensation is a preference. The path still exists (the prose
       parser matches a leading REQUEST REVISION) but is now stated as degraded, not alternative.

    2. It forbade markdown fences while the parser scans fenced blocks FIRST. That made "compliant"
       narrower than "parseable" for no benefit, and penalised a habit most models have.

    3. It offered APPROVE / APPROVE_WITH_NOTES / REVISE and no legal way to say "I cannot see the
       change". Measured on a real multi-repo card: the reviewer was told no files had changed (a
       wrong diff base, fixed separately), found nothing, and NONE of the three values described its
       situation — approving would have been a lie, so it wrote prose instead, which the gate then
       swallowed. The model did not go off-format by accident; it was asked to choose from a list
       that did not contain its answer. That case now maps explicitly onto REVISE.

    A new UNAVAILABLE enum value would model it better, but `WorkflowStepVerdict` has no such member
    and adding one reaches the parser, step results, merge admission and the dashboard — out of
    proportion to a prompt repair, so the honest case is expressed with the values that already exist.
    */
    const verdictBlock = requireVerdict
      ? `

  ## Feedback Format

  When your review is complete, your final line MUST be a single JSON object (a \`\`\`json fence around it is also accepted):

  ${reviewFindingsContract
    ? "{\"verdict\":\"APPROVE|APPROVE_WITH_NOTES|REVISE\",\"notes\":\"...\",\"findings\":[{\"id\":\"stable-id\",\"title\":\"concise issue\",\"body\":\"actionable detail\",\"filePath\":\"optional/path\",\"line\":1,\"severity\":\"low|medium|high|critical\",\"resolution\":\"open|resolved-in-review|superseded\"}],\"supersededFindingSourceWorkflowStepId\":\"prior-review-step-id\",\"supersededFindingIds\":[\"prior-finding-id\"]}"
    : "{\"verdict\":\"APPROVE|APPROVE_WITH_NOTES|REVISE\",\"notes\":\"...\"}"}

  Rules:
  - Output exactly one trailing JSON object and stop.
  - verdict must be exactly APPROVE, APPROVE_WITH_NOTES, or REVISE.
  - notes MUST contain one to three non-empty sentences naming what was checked and why the verdict was reached. An empty notes string is a protocol violation.
  - For out-of-scope fast-bail responses, use: {"verdict":"APPROVE","notes":"I checked the diff scope and found no UI file changes, so this review is out of scope."}
  - If you CANNOT SEE the change you were asked to review — the described files appear absent, or the scope you were given looks empty when work was expected — that is NOT an approval and NOT out-of-scope. Return REVISE and state plainly in notes what you looked for and where. Never describe that situation in prose alone: a response with no verdict cannot be acted on and is treated as a failed review.${reviewFindingsContract ? "\n  - Every finding MUST carry a `severity`. Put each blocking issue in `findings` — prose in `notes` alone does not block.\n  - Omit resolution (or use open) for work still needed; use resolved-in-review only for an issue you fixed in this session.\n  - supersededFindingIds may list only IDs from one named Prior Findings result that you re-verified no longer apply; include that result’s workflow step ID in supersededFindingSourceWorkflowStepId; never list your own findings." : ""}${blockingSeverityRule}

  If you cannot produce the object above for any reason, begin your entire response with the line REQUEST REVISION so it can still be read as a revision request. This is a degraded path, not an alternative: every review is expected to end with the JSON object.`
      : `

  ## Output Format

  Follow the skill's own output conventions. You are NOT required to end with a
  verdict JSON object — this step does not gate merge. If you need to ask the user
  a question, emit a single ===FUSION_AWAIT_INPUT=== block and stop (see the
  workflow-step conventions in your instructions).`;

    const inlineFixBlock = allowReviewerInlineFixes
      ? `

  ## Same-Session Fix Policy

  This review-type node may fix issues it finds before returning a final verdict.
  - If you find an in-scope issue you can fix safely, edit the relevant files in this same session, run the smallest relevant verification, and then return APPROVE or APPROVE_WITH_NOTES.
  - Return REVISE only when the issue is still present, cannot be safely fixed in this reviewer session, needs broader executor remediation, or needs user input.
  - Plan Review may use fn_task_prompt_write to replace the task's PROMPT.md with the complete revised plan. Do not implement product code from Plan Review.
  - Code Review and Browser Verification may fix implementation issues inside the assigned task worktree. Report each self-fixed issue as a finding with resolution resolved-in-review; list a fixed prior-lane finding in supersededFindingIds.
  - After any inline edit, treat your own change as untrusted: re-read the fresh diff, restart the mandatory review procedure from its requirements ledger and production-reachability checks, and rerun the smallest relevant verification. Never approve solely because the local fix compiles or its narrow test passes.`
      : "";

    /*
    FNXC:TaskOutputLanguage 2026-08-19-16:34:
    Graph dispatch supplies a start-time target so input-mode detection survives task edits between
    nodes. Direct workflow-step callers retain the live resolver for backward compatibility.
    */
    const systemPrompt = `You are a workflow step agent executing: ${workflowStep.name}

  Task Context:
  - Task ID: ${task.id}
  - Task Description: ${task.description}
  - Worktree: ${worktreePath}

  ${scopeBlock}${reviewConvergenceContext ? `\n\n${reviewConvergenceContext}` : ""}${workflowStepUserCommentSection ? `\n\n${workflowStepUserCommentSection}` : ""}${priorFindingsBlock}

  Your role:
  - Execute this workflow step exactly as scoped.
  - Report only what changes the delivered result. Do NOT report nits — wording, formatting, naming or ordering preferences, internal numbering/cross-reference mismatches that do not change what gets built, or detail any reasonable implementation choice would satisfy. Omit them entirely rather than filing them as low-severity findings.
  - Assume the implementer is a competent engineer who resolves local detail correctly without being told.
  - Keep feedback actionable and directly tied to evidence in files/outputs.
  - Finding nothing is a valid and common outcome. Do not manufacture findings to justify the review.

  Your Instructions:
  ${workflowStep.prompt}

  ## Task Output Language
  ${stepOptions?.outputLanguage?.instruction ?? resolveTaskOutputLanguage(settings, task.description).instruction}
  Apply this only to human-readable task-facing output; do not translate this operator-authored workflow prompt, verdict tokens, JSON, identifiers, tools, or schema fields.

  You have access to the file system to review changes.${inlineFixBlock}${verdictBlock}`;

    /*
     * FNXC:WorkflowAgentRouting 2026-08-07-04:45:
     * The graph admission fence chooses the permanent identity before this
     * session exists. Resolve that exact agent for its model, skills, audit,
     * and log attribution; never fall back to task ownership after routing.
     *
     * FNXC:WorkflowAgentRouting 2026-08-15-23:41:
     * Wave-18 peel #3317 dropped this threading. FN-9108 restores the
     * FN-8764/FN-8821 routed-principal contract and regression coverage.
     */
    const workflowPrincipal = stepOptions?.principalAgentId
      ? await deps.getAuthoritativeAssignedAgent(stepOptions.principalAgentId)
      : undefined;
    if (stepOptions?.principalAgentId && !workflowPrincipal) {
      throw new Error(`workflow-principal-unavailable:${stepOptions.principalAgentId}`);
    }
    const sessionTask = workflowPrincipal
      ? { ...task, assignedAgentId: workflowPrincipal.id }
      : task;
    const agentLogger = new AgentLogger({
      store: deps.store,
      taskId: task.id,
      agent: "reviewer",
      persistAgentToolOutput: settings.persistAgentToolOutput,
      // Review-in-executor sessions are task-scoped ephemeral workers.
      persistAgentThinkingLog: resolvePersistAgentThinkingLog(settings, { ephemeral: true }),
      onAgentText: (taskId, delta) => {
        deps.options.onAgentText?.(taskId, delta);
      },
      onAgentTool: (taskId, toolName, detail) => {
        deps.options.onAgentTool?.(taskId, toolName, detail);
      },
    });
    // FNXC:CommandCenterActivity 2026-08-15-22:15: FN-8868 usage telemetry (restored post-wave-18).
    attachAgentUsageTelemetry(agentLogger, { store: deps.store, agentId: sessionTask.assignedAgentId ?? null, taskId: task.id, nodeId: task.effectiveNodeId ?? task.nodeId ?? null, lane: "executor" });

    // Determine primary model and an explicit fallback. Review-type workflow
    // steps use the validator lane; ordinary workflow prompts use the executor
    // lane. A complete per-step override remains authoritative for either lane.
    // FNXC:ModelResolution 2026-06-25-12:00: FN-7039 requires ordinary workflow
    // steps to inherit project execution-lane model settings before defaults.
    // Review gates are independent validation surfaces and must not silently use
    // the same implementation model merely because they execute in this method.
    const assignedRuntimeConfig = workflowPrincipal?.runtimeConfig
      ?? await deps.getAssignedAgentRuntimeConfig(task.assignedAgentId);
    const laneModel = isReviewTypeWorkflowStep
      ? resolveValidatorSessionModel(
          task.validatorModelProvider,
          task.validatorModelId,
          settings,
          assignedRuntimeConfig,
          task.validatorCredentialInstanceId,
        )
      : resolveExecutorSessionModel(
          task.modelProvider,
          task.modelId,
          settings,
          assignedRuntimeConfig,
          task.credentialInstanceId,
        );
    const useOverride = !!(workflowStep.modelProvider && workflowStep.modelId);
    const primaryProvider = useOverride ? workflowStep.modelProvider : laneModel.provider;
    const primaryModelId = useOverride ? workflowStep.modelId : laneModel.modelId;
    // FNXC:ProviderAuth 2026-08-01-08:39: A workflow-step model override has no paired instance selection, so only the resolved primary task lane may carry its requested credential instance. Fallback attempts must retain their provider-default behavior rather than inheriting a primary-provider identity.
    const primaryCredentialInstanceId = useOverride ? undefined : laneModel.credentialInstanceId;
    attachAgentUsageTelemetry(agentLogger, { store: deps.store, agentId: sessionTask.assignedAgentId ?? null, taskId: task.id, nodeId: task.effectiveNodeId ?? task.nodeId ?? null, model: primaryModelId ?? null, provider: primaryProvider ?? null, lane: "executor" });

    const workflowFallback = isReviewTypeWorkflowStep
      ? resolveValidatorFallbackModel(settings)
      : resolveExecutorFallbackModel(settings);
    const fallback = workflowFallback.provider && workflowFallback.modelId
      && (workflowFallback.provider !== primaryProvider || workflowFallback.modelId !== primaryModelId)
      ? workflowFallback
      : undefined;
    const fallbackSettingsHint = isReviewTypeWorkflowStep
      ? "settings.validatorFallbackProvider/validatorFallbackModelId or fallbackProvider/fallbackModelId"
      : "settings.executionFallbackProvider/executionFallbackModelId or fallbackProvider/fallbackModelId";
    const fallbackLaneLabel = isReviewTypeWorkflowStep ? "validator" : "executor";

    const timeoutMs = Math.max(60_000, settings.workflowStepTimeoutMs ?? 900_000);
    const dispatchLabel = stepOptions?.dispatchLabel?.trim() || undefined;

    /*
    FNXC:WorkflowStepModelMarker 2026-08-29-06:46:
    A workspace review constructs one session per repository, so its model markers must identify
    the inspected tree. A same-model malformed-output self-retry adds no model-resolution value;
    dedupe identical markers within this workflow-step call while retaining a marker for a real
    fallback model change.
    */
    let lastEmittedModelMarker: string | undefined;

    const runOnce = async (
      provider: string | undefined,
      modelId: string | undefined,
      attemptLabel: string,
    ): Promise<WorkflowStepOutcome> => {
      const stepInstructions = await deps.resolveInstructionsForRole("executor", settings);
      const stepSystemPrompt = buildSystemPromptWithInstructions(systemPrompt, stepInstructions);

      // Build skill selection context for workflow step session
      const skillContext = await buildSessionSkillContext({
        agentStore: deps.options.agentStore!,
        task: sessionTask,
        sessionPurpose: "executor",
        projectRootDir: deps.rootDir,
        pluginRunner: deps.options.pluginRunner,
      });

      const workflowAgent = workflowPrincipal ?? await deps.getAuthoritativeAssignedAgent(task.assignedAgentId);
      const workflowRuntimeHint = extractRuntimeHint(workflowAgent?.runtimeConfig);
      // Signal to skills running in this step (e.g. compound-engineering ce-plan /
      // ce-work) that they are inside a Fusion autonomous workflow step, NOT an
      // interactive Claude Code session. There is no synchronous blocking-question
      // tool here, so a skill must surface user questions via the await-input
      // convention (which the dashboard / task card renders) instead of calling
      // AskUserQuestion into the void. Scoped to the step session — the main
      // executor session deliberately does not carry it.
      // (U3) FUSION_HEADLESS=1 marks a genuinely-unattended run (LFG/pipeline) so
      // skills record assumptions and proceed instead of parking. Set ONLY when
      // the explicit `unattended` flag is true; absent on a board run.
      const stepEnv: NodeJS.ProcessEnv = {
        ...(taskEnv ?? process.env),
        FUSION_WORKFLOW_STEP: "1",
      };
      // FNXC:WorkflowSteps 2026-06-21-06:30:
      // Default-safe invariant (KTD-3): a board run must NEVER be headless. Since
      // stepEnv spreads taskEnv/process.env, an inherited FUSION_HEADLESS (e.g. an
      // outer pipeline exported it) would otherwise leak in and silently skip user
      // questions. Set it ONLY on an explicit opt-in; strip any inherited value
      // otherwise so absence of the flag always yields a board run.
      if (unattended) {
        stepEnv.FUSION_HEADLESS = "1";
      } else {
        delete stepEnv.FUSION_HEADLESS;
      }

      // (U1) Load the step's named skill into THIS session. The interactive fix
      // proved the resolver works when fed BOTH a requested name AND a discovery
      // path (compound-engineering-skill-resolution.test.ts). Here we mirror it:
      // merge the step's skillName (both namespaced `compound-engineering:ce-work`
      // and bare `ce-work` — the resolver matches bare names case-insensitively)
      // into the resolved requestedSkillNames, and pass the CE install root (from
      // the injected FUSION_CE_SKILLS_DIR env) as additionalSkillPaths so the
      // loader can actually discover the bundled SKILL.md. Without both halves the
      // named skill was only prompt text pointing at a skill the session never had.
      let effectiveSkillSelection = skillContext.skillSelectionContext;
      const ceSkillsDir = typeof stepEnv.FUSION_CE_SKILLS_DIR === "string" && stepEnv.FUSION_CE_SKILLS_DIR.trim()
        ? stepEnv.FUSION_CE_SKILLS_DIR.trim()
        : undefined;
      if (workflowStep.skillName && workflowStep.skillName.trim()) {
        const namespaced = workflowStep.skillName.trim();
        const bare = namespaced.includes(":") ? namespaced.slice(namespaced.lastIndexOf(":") + 1) : namespaced;
        const existing = effectiveSkillSelection?.requestedSkillNames ?? [];
        const mergedNames = [...new Set([...existing, namespaced, bare])];
        effectiveSkillSelection = {
          projectRootDir: effectiveSkillSelection?.projectRootDir ?? deps.rootDir,
          ...(effectiveSkillSelection?.sessionPurpose ? { sessionPurpose: effectiveSkillSelection.sessionPurpose } : { sessionPurpose: "executor" }),
          requestedSkillNames: mergedNames,
          forcedSkillNames: [...new Set([...(effectiveSkillSelection?.forcedSkillNames ?? []), namespaced, bare])],
        };
      }
      const additionalSkillPaths = mergeAdditionalSkillPaths(skillContext.additionalSkillPaths, ceSkillsDir ? [ceSkillsDir] : undefined);
      // FNXC:WorkflowSteps 2026-07-30-21:40:
      // FN-8461 / GitHub #2388: workflow steps resolve skills from enabled-plugin
      // body directories and the optional CE install root. Warn only after merging
      // those sources when THIS named skill remains undiscoverable: a non-empty path
      // array for another skill is not viable, while an actual plugin body makes CE
      // env absence expected rather than misleading operator-facing noise.
      if (
        workflowStep.skillName?.trim()
        && !isWorkflowStepSkillDiscoverable(workflowStep.skillName.trim(), additionalSkillPaths, ceSkillsDir)
      ) {
        await deps.store.logEntry(
          task.id,
          `[skill-load] Workflow step '${workflowStep.name}' requests skill '${workflowStep.skillName}' but it cannot be discovered from configured plugin body directories or FUSION_CE_SKILLS_DIR; the step runs with role-fallback skills only.`,
        );
      }
      const logBrowserVerificationActivity = async (message: string) => {
        await deps.store.logEntry(task.id, message);
        await deps.store.appendAgentLog(task.id, message, "status", undefined, "reviewer");
      };
      if (workflowStep.requiresBrowser === true) {
        effectiveSkillSelection = augmentSessionSkillsForBrowserStep(effectiveSkillSelection, deps.rootDir);
        await logBrowserVerificationActivity(`[browser-verification] starting browser verification for task ${task.id} using step '${workflowStep.name}'`);
        const browserProbe = await probeAgentBrowserAvailability(execAsync as AgentBrowserExec, {
          cwd: worktreePath,
          env: stepEnv,
          timeoutMs: 5_000,
        });
        await logBrowserVerificationActivity(formatAgentBrowserAvailabilityLog(browserProbe));
        /*
        FNXC:WorkflowStepNotRun 2026-08-28-14:13:
        A missing or hung agent-browser probe means browser verification never started. Return a
        successful control-flow outcome with the fixed not-run reason before session creation so the
        graph advances without allowing a model fast-bail to masquerade as an approval.
        */
        if (!browserProbe.available) {
          return {
            success: true,
            notRunReason: "tooling-unavailable",
            output: `${workflowStep.name} did not run: the agent-browser CLI is unavailable (${browserProbe.reason ?? "unknown reason"}). NOTHING WAS VERIFIED.`,
          };
        }
      }

      // (U8b) Coding-mode skill steps fan out to ce-<persona> subagents via
      // fn_spawn_agent (read the persona def, pass its body as systemPromptOverride).
      // That tool is registered only in the main executor session — never here —
      // so coding mode granted write/edit but NOT spawn. Register it for
      // coding-mode steps now; readonly steps keep no spawn (filterCustomToolsForReadonly
      // strips it). The spawn tool inherits the injected env so children also see
      // FUSION_CE_AGENTS_DIR.
      //
      // (U9 / KTD-4, Risk-1) ACCEPTED WRITE-CAPABILITY POSTURE: coding mode also
      // exposes write/edit. The CE plan/code-review steps run coding ONLY to gain
      // spawn (they are not supposed to mutate the tree), but the tool policy is
      // binary today — coding is the only mode that carries fn_spawn_agent. There
      // is NO engine guard preventing those steps from writing; the only protection
      // is skill discipline plus the U6 no-diff detection assertion. The proper fix
      // (a dedicated readonly-plus-spawn tool mode) is deferred; this is a
      // knowingly-accepted gap, not a closed one — re-evaluate before enabling the
      // CE workflow for genuinely-unattended (FUSION_HEADLESS) LFG/pipeline runs.
      const planReviewPromptTools: ToolDefinition[] = allowPlanReviewPromptWrite
        ? [createTaskPromptWriteTool(deps.sharedWorkerTools, task.id)]
        : [];
      const codingCustomTools: ToolDefinition[] = toolMode === "coding"
        ? [deps.createSpawnAgentTool(task.id, worktreePath, settings, stepEnv)]
        : [];
      const workflowCustomTools = [...planReviewPromptTools, ...codingCustomTools];
      const readonlyCustomTools = toolMode === "readonly"
        ? filterCustomToolsForReadonly(workflowCustomTools, {
            allowTool: (tool) => allowPlanReviewPromptWrite && tool.name === "fn_task_prompt_write",
          })
        : { allowed: workflowCustomTools, denied: [] as string[] };
      if (toolMode === "readonly" && readonlyCustomTools.denied.length > 0) {
        await deps.store.logEntry(
          task.id,
          `[readonly-violation] Workflow step '${workflowStep.name}' dropped denied custom tools: ${readonlyCustomTools.denied.join(", ")}`,
        );
      }

      /*
       * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
       * WorkflowStep sessions resolve reasoning effort as node/step `thinkingLevel` first, then the task override for their selected model lane, then settings defaults/lane fallbacks.
       *
       * FNXC:Settings-ThinkingLevel 2026-07-10-14:20:
       * The step's own `fallback` attempt already swaps to a distinct model (validator fallback OR global fallback pair) — it must honor THAT model's fallback thinking level, not silently reuse the primary lane's thinking level. Route by which candidate `fallback.label` actually matched instead of only special-casing `validatorFallback`.
       */
      const workflowStepThinkingSource = workflowStep.thinkingLevel
        ?? (isReviewTypeWorkflowStep ? task.validatorThinkingLevel ?? task.thinkingLevel : task.thinkingLevel);
      const workflowStepThinkingLevel = attemptLabel === "fallback"
        ? isReviewTypeWorkflowStep
          ? resolveValidatorFallbackThinkingLevel(workflowStepThinkingSource, settings)
          : resolveExecutorFallbackThinkingLevel(workflowStepThinkingSource, settings)
        : isReviewTypeWorkflowStep
          ? resolveValidatorThinkingLevel(workflowStepThinkingSource, settings)
          : resolveExecutorThinkingLevel(workflowStepThinkingSource, settings);
      const workflowStepFallbackThinkingLevel = isReviewTypeWorkflowStep
        ? resolveValidatorFallbackThinkingLevel(workflowStepThinkingSource, settings)
        : resolveExecutorFallbackThinkingLevel(workflowStepThinkingSource, settings);
      if (allowReadonlyMcpTools) {
        await deps.store.logEntry(
          task.id,
          `Workflow step '${workflowStep.name}' enabled read-only MCP servers: ${readonlyMcpServerAllowlist.join(", ")}`,
        );
      }
      const { session } = await createResolvedAgentSession({
        sessionPurpose: "executor",
        taskExecutionSession: true,
        runtimeHint: workflowRuntimeHint,
        pluginRunner: deps.options.pluginRunner,
        cwd: worktreePath,
        ...(stepOptions?.sessionBoundary ? { sessionBoundary: stepOptions.sessionBoundary } : {}),
        systemPrompt: stepSystemPrompt,
        tools: toolMode,
        defaultProvider: provider,
        defaultModelId: modelId,
        ...(attemptLabel !== "fallback" && primaryCredentialInstanceId
          ? { credentialInstanceId: primaryCredentialInstanceId }
          : {}),
        fallbackProvider: workflowFallback.provider,
        fallbackModelId: workflowFallback.modelId,
        fallbackThinkingLevel: workflowStepFallbackThinkingLevel,
        defaultThinkingLevel: workflowStepThinkingLevel,
        runAuditor: createRunAuditor(deps.store, deps.getRunContextFor(task.id)),
        settings,
        taskEnv: stepEnv,
        mcpServers: await deps.resolveMcpServers(undefined),
        ...(allowReadonlyMcpTools
          ? {
              allowMcpToolsInReadonly: true,
              readonlyMcpServerAllowlist,
            }
          : {}),
        // FNXC:SessionRouting 2026-06-24-11:20:
        // #1675: propagate task id so workflow-step requests carry the same
        // X-Session-Id/X-Session-Affinity as the primary session.
        taskId: task.id,
        // FNXC:PluginSkills 2026-07-12-00:00: Workflow-step sessions union plugin skill body dirs with CE's FUSION_CE_SKILLS_DIR so neither plugin-package nor compound-engineering skills are overwritten.
        // Skill selection: assigned-agent / role-fallback skills, plus the step's own named skill (U1) made discoverable via additionalSkillPaths.
        ...(effectiveSkillSelection ? { skillSelection: effectiveSkillSelection } : {}),
        ...(additionalSkillPaths ? { additionalSkillPaths } : {}),
        // FNXC:SkillResolution 2026-08-16-03:19: Workflow steps are task-bound
        // sessions too, so mirror the shared resolver's one-session summary into
        // the task log; unresolved forced requests remain observable but are never
        // presented to the model as required reading.
        onSkillSummary: async (summary) => {
          const unavailable = summary.unresolvedForcedSkills.length
            ? `; forced-unavailable: [${summary.unresolvedForcedSkills.map((entry) => `${entry.requestedName} (${entry.reason})`).join(", ")}]`
            : "";
          await deps.store.logEntry(
            task.id,
            `[skills] [executor]${dispatchLabel ? ` [${dispatchLabel}]` : ""} ${summary.availableCount} skill(s) available; forced: ${summary.forcedSkillNames.length ? `[${summary.forcedSkillNames.join(", ")}]` : "none"}${unavailable}`,
          );
        },
        ...(readonlyCustomTools.allowed.length > 0
          ? { customTools: readonlyCustomTools.allowed, fusionTools: readonlyCustomTools.allowed }
          : {}),
      });
      // FNXC:CommandCenterActivity 2026-08-15-22:15: session boundary for the workflow-step runtime session (restored post-wave-18).
      emitAgentSessionStart({ store: deps.store, agentId: sessionTask.assignedAgentId ?? null, taskId: task.id, nodeId: task.effectiveNodeId ?? task.nodeId ?? null, model: primaryModelId ?? null, provider: primaryProvider ?? null, lane: "executor" });

      const workflowModelDetails = formatModelMarkerDetails(
        describeModel(session),
        workflowStepThinkingLevel,
        [
          useOverride && attemptLabel === "primary" ? "workflow step override" : "",
          attemptLabel === "fallback" ? "fallback after timeout" : "",
        ],
      );
      const workflowModelMarker = `Workflow step '${workflowStep.name}'${dispatchLabel ? ` [${dispatchLabel}]` : ""} using model: ${workflowModelDetails}`;
      executorLog.debug(`${task.id}: ${workflowModelMarker}`);
      if (workflowModelMarker !== lastEmittedModelMarker) {
        lastEmittedModelMarker = workflowModelMarker;
        await deps.store.logEntry(task.id, workflowModelMarker);
      }
      deps.setActiveWorkflowStepSession(task.id, session, worktreePath, createSeenSteeringIds(task));
      // FNXC:TaskTiming 2026-07-30-21:40: graph-owned Plan Review is the only
      // post-spec planning lane. Start before prompting and finalize in finally before any replan handoff.
      const ownsPlanningSegment = workflowStep.id === "graph:plan-review-step" || workflowStep.name === "Plan Review";
      if (ownsPlanningSegment) {
        deps.activePlanningWorkflowSessions.add(task.id);
        const planningStart = startPlanningSegment(task);
        try {
          if (planningStart.planningStartedAt) await deps.store.updateTask(task.id, planningStart);
        } catch (error) {
          deps.activePlanningWorkflowSessions.delete(task.id);
          throw error;
        }
      }

      let output = "";
      const deltaNormalizer = createStreamingDeltaNormalizer();
      let detectedQuestion: string | null = null;
      let resolveQuestion: ((value: "await-input") => void) | undefined;
      const questionPromise = new Promise<"await-input">((resolve) => {
        resolveQuestion = resolve;
      });
      session.subscribe((event) => {
        if (event.type === "message_update") {
          const msgEvent = event.assistantMessageEvent;
          if (msgEvent.type === "text_delta") {
            // Repair dropped sentence-boundary spaces at the shared engine delta chokepoint,
            // including tool-call cross-message boundaries (see streaming-delta.ts).
            const delta = deltaNormalizer.normalize(msgEvent.partial, msgEvent.contentIndex, msgEvent.delta, "text");
            output += delta;
            agentLogger.onText(delta);
          } else if (msgEvent.type === "thinking_delta") {
            // Repair dropped sentence-boundary spaces at the shared engine delta chokepoint,
            // including tool-call cross-message boundaries (see streaming-delta.ts).
            const delta = deltaNormalizer.normalize(msgEvent.partial, msgEvent.contentIndex, msgEvent.delta, "thinking");
            agentLogger.onThinking(delta);
          }
        }
        if (event.type === "tool_execution_start") {
          agentLogger.onToolStart(event.toolName, event.args as Record<string, unknown> | undefined);
          if (!unattended && detectedQuestion === null) {
            const question = parseAwaitInputQuestionToolCall(
              event.toolName,
              event.args as Record<string, unknown> | undefined,
            );
            if (question) {
              detectedQuestion = question;
              resolveQuestion?.("await-input");
            }
          }
        }
        if (event.type === "tool_execution_end") {
          agentLogger.onToolEnd(event.toolName, event.isError, event.result);
        }
      });

      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<"timeout">((resolveTimeout) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          resolveTimeout("timeout");
        }, timeoutMs);
      });

      try {
        const promptPromise = promptWithFallback(
          session,
          `Execute the workflow step "${workflowStep.name}" for task ${task.id}.\n\n` +
          `Review the work done in this worktree and evaluate it against the criteria in your instructions.`,
        );

        const outcome = await Promise.race([
          promptPromise.then(() => "completed" as const),
          timeoutPromise,
          questionPromise,
        ]);

        if (outcome === "await-input" && detectedQuestion) {
          try { session.dispose(); } catch { /* best-effort */ }
          await agentLogger.flush();
          return {
            success: true,
            output: `===FUSION_AWAIT_INPUT===\n${detectedQuestion}\n===END_FUSION_AWAIT_INPUT===`,
          };
        }

        if (outcome === "timeout") {
          executorLog.warn(`${task.id}: workflow step '${workflowStep.name}' (${attemptLabel}) timed out after ${timeoutMs}ms — disposing session`);
          await deps.store.logEntry(
            task.id,
            `Workflow step '${workflowStep.name}' ${attemptLabel === "primary" ? "primary" : "fallback"} model timed out after ${Math.round(timeoutMs / 1000)}s — aborting session`,
          );
          if (workflowStep.requiresBrowser === true) {
            await logBrowserVerificationActivity(`[browser-verification] finished browser verification for task ${task.id}: timed out`);
          }
          // FNXC:TaskCost 2026-07-30-21:40: Plan Review tokens are task cost;
          // snapshot before timeout disposal just like normal completion.
          await accumulateSessionTokenUsage(deps.store, task.id, session, { agentId: task.assignedAgentId ?? undefined, role: "executor" });
          try { session.dispose(); } catch { /* best-effort */ }
          await agentLogger.flush();
          return {
            success: false,
            error: `workflow step timed out after ${timeoutMs}ms`,
            timedOut: true,
            ...(requireVerdict ? { verdictRequired: true } : {}),
          };
        }

        // Completed within the timeout — let any post-completion errors surface.
        checkSessionError(session);

        /*
        FNXC:PlanReviewNoOp 2026-08-09-22:10:
        Thread optionalGroupId so Plan Review CLOSE_NO_OP is accepted only for that group.
        */
        let parsed = requireVerdict
          ? parseWorkflowStepOutput(output, { optionalGroupId })
          : parseWorkflowStepOutput(output, { requireVerdict: false, optionalGroupId });

        /*
        FNXC:ReviewVerdictAuthority 2026-09-03-05:40:
        A verdict-required review cannot finish without authored lifecycle authority. Ask the already-live
        reviewer exactly once for the verdict envelope only, before token accounting and disposal; never
        re-review, use tools, infer approval from prose, or loop. A missing, invalid, failed, or timed-out
        repair remains malformed and is persisted as a failed review by the graph.
        */
        let verdictRepairResult: WorkflowStepVerdictRepairOutcome = "unavailable";
        let repairedVerdict: ReturnType<typeof parseWorkflowStepVerdictRepair> = null;
        if (requireVerdict && parsed.malformed) {
          const repairStart = output.length;
          const originalReviewOutput = output;
          const repairTimeoutMs = Math.min(timeoutMs, WORKFLOW_STEP_VERDICT_REPAIR_TIMEOUT_MS);
          let repairTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const repairTimeout = new Promise<"timeout">((resolve) => {
              repairTimer = setTimeout(() => resolve("timeout"), repairTimeoutMs);
            });
            const repairPrompt = promptWithFallback(session, WORKFLOW_STEP_VERDICT_REPAIR_PROMPT(optionalGroupId));
            const repairOutcome = await Promise.race([
              repairPrompt.then(() => "completed" as const),
              repairTimeout,
            ]);
            if (repairOutcome === "completed") {
              repairedVerdict = parseWorkflowStepVerdictRepair(output.slice(repairStart), { optionalGroupId });
              if (repairedVerdict) {
                const repairedNotes = repairedVerdict === "CLOSE_NO_OP"
                  ? undefined
                  : parseWorkflowStepOutput(
                    `${originalReviewOutput}\n${JSON.stringify({ verdict: repairedVerdict })}`,
                    { optionalGroupId },
                  );
                parsed = repairedVerdict === "CLOSE_NO_OP"
                  ? { output: "", verdict: repairedVerdict, notes: "" }
                  : repairedNotes!;
                verdictRepairResult = "repaired";
              } else {
                verdictRepairResult = "empty";
              }
            } else {
              verdictRepairResult = "timed-out";
            }
          } catch {
            verdictRepairResult = "failed-soft";
          } finally {
            if (repairTimer) clearTimeout(repairTimer);
            try {
              await deps.store.logEntry(
                task.id,
                `[pre-merge] Workflow step '${workflowStep.name}' requested a missing verdict`,
                verdictRepairResult,
              );
            } catch {
              // FNXC:ReviewVerdictAuthority 2026-09-03-05:40: Best-effort verdict-repair telemetry cannot fail the review step.
            }
            const context = deps.getRunContextFor(task.id);
            if (context && verdictRepairResult !== "unavailable") await emitBoundedRunAudit(deps.store, {
              taskId: task.id,
              agentId: context.agentId,
              runId: context.runId,
              domain: "database",
              mutationType: "task:review-verdict-repaired",
              target: task.id,
              metadata: {
                taskId: task.id,
                workflowStepId: sameGateStepId,
                outcome: verdictRepairResult,
                ...(repairedVerdict ? { verdict: repairedVerdict } : {}),
              },
            });
          }
        }

        /*
        FNXC:ReviewVerdictNotes 2026-08-28-21:23:
        Repair a missing rationale as one bounded continuation on the already-live session: the verdict
        is decided and the review context is loaded, while a second session would pay for a full review
        and could destabilize that decision. This seam serves singular reviews, workspace Plan Review,
        and each workspace repository Code Review, so the budget is one prompt per session, not per task.
        Run before the token snapshot so repair usage remains task cost.
        */
        let repairResult: WorkflowStepNotesRepairOutcome = "unavailable";
        if (parsed.verdict && parsed.notesMissing && parsed.verdict !== "CLOSE_NO_OP") {
          const repairStart = output.length;
          const repairTimeoutMs = Math.min(timeoutMs, WORKFLOW_STEP_NOTES_REPAIR_TIMEOUT_MS);
          let repairTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const repairTimeout = new Promise<"timeout">((resolve) => {
              repairTimer = setTimeout(() => resolve("timeout"), repairTimeoutMs);
            });
            const repairPrompt = promptWithFallback(session, WORKFLOW_STEP_NOTES_REPAIR_PROMPT(parsed.verdict));
            const repairOutcome = await Promise.race([
              repairPrompt.then(() => "completed" as const),
              repairTimeout,
            ]);
            if (repairOutcome === "completed") {
              const repairedNotes = parseWorkflowStepNotesRepair(output.slice(repairStart), parsed.verdict);
              if (repairedNotes) {
                const { notesMissing: _notesMissing, ...original } = parsed;
                parsed = { ...original, output: repairedNotes, notes: repairedNotes };
                repairResult = "repaired";
              } else {
                repairResult = "empty";
              }
            } else {
              repairResult = "timed-out";
            }
          } catch {
            repairResult = "failed-soft";
          } finally {
            if (repairTimer) clearTimeout(repairTimer);
            try {
              await deps.store.logEntry(
                task.id,
                `[pre-merge] Workflow step '${workflowStep.name}' requested missing verdict notes`,
                repairResult,
              );
            } catch {
              // FNXC:ReviewVerdictNotes 2026-08-28-21:23: Best-effort repair telemetry cannot fail the review step.
            }
            const context = deps.getRunContextFor(task.id);
            if (context && repairResult !== "unavailable") await emitBoundedRunAudit(deps.store, {
              taskId: task.id,
              agentId: context.agentId,
              runId: context.runId,
              domain: "database",
              mutationType: "task:review-notes-repaired",
              target: task.id,
              metadata: {
                taskId: task.id,
                workflowStepId: sameGateStepId,
                verdict: parsed.verdict,
                outcome: repairResult,
              },
            });
          }
        }

        await accumulateSessionTokenUsage(deps.store, task.id, session, {
            agentId: task.assignedAgentId ?? undefined,
            role: "executor",
          });
        session.dispose();
        await agentLogger.flush();
        if (parsed.verdict) {
          /*
           * FNXC:ReviewSeverityGate 2026-08-10-17:33:
           * Apply the severity gate HERE, at the single parse boundary, so the rewritten verdict is what
           * every downstream consumer sees (step-result status mapping, remediation routing, Review tab,
           * merge blocking). Downgrading later would leave the persisted verdict disagreeing with the
           * routing decision. A finding-less REVISE is non-blocking because it cannot produce
           * remediation; an unclassified open finding remains fail-closed and blocks.
           */
          const gated = reviewBlockingSeverity
            ? applyReviewSeverityGate({
              verdict: parsed.verdict,
              findings: parsed.findings,
              threshold: reviewBlockingSeverity,
            })
            : undefined;
          const effectiveVerdict = (gated?.verdict ?? parsed.verdict) as typeof parsed.verdict;
          if (gated?.downgraded) {
            await deps.store.logEntry(
              task.id,
              `[pre-merge] ${workflowStep.name} returned REVISE with no finding at or above "${reviewBlockingSeverity}" — recorded as APPROVE_WITH_NOTES; ${gated.advisory.length} advisory finding(s) handed to the implementer.`,
            );
            // Non-fatal: losing the advisory carry-forward must never fail the step itself.
            await injectReviewAdvisoryNotes(deps.store, task, workflowStep.name, gated.advisory).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              executorLog.warn(`${task.id}: failed to carry forward advisory review findings: ${msg}`);
            });
          }
          const revisionRequested = effectiveVerdict === "REVISE";

          /*
          FNXC:PreMergeApproval 2026-09-01-06:53:
          FN-9234 removes the inline-fix wedge where this lane approved the pre-fix diff while the
          merge gate probes base..HEAD. Only this reviewing lane may re-bind after a proven
          fast-forward because no other lane inspected its new content. REVISE retains the original
          input identity because convergence compares the input each remediation round received.
          */
          if (isReviewTypeWorkflowStep && !isPlanReviewStep && !revisionRequested) {
            const priorReviewedCommitSha = reviewedCommitSha;
            const currentHeadSha = await readHeadSha(worktreePath);
            const fastForwardAdvance = await isFastForwardAdvance(worktreePath, priorReviewedCommitSha, currentHeadSha);
            const baseIsAncestor = await isFastForwardAdvance(worktreePath, baseRef, currentHeadSha);
            const decision = classifyReviewInlineFixRecapture({
              verdict: effectiveVerdict,
              reviewKind: workflowStepMetadata.reviewKind,
              reviewedCommitSha: priorReviewedCommitSha,
              currentHeadSha,
              baseRef,
              fastForwardAdvance,
              baseIsAncestor,
              fingerprintProbeAvailable: true,
            });
            if (decision.recapture) {
              // A post-review fingerprint is evidence only: an unreadable probe must preserve the
              // already-recorded approval identity rather than converting a completed review to failure.
              try {
                const recapturedFingerprint = workflowStepMetadata.reviewKind === "code"
                  ? await computeCodeReviewInputFingerprint(worktreePath, baseRef)
                  : await computeReviewDiffFingerprint(worktreePath, baseRef);
                const finalDecision = classifyReviewInlineFixRecapture({
                  verdict: effectiveVerdict,
                  reviewKind: workflowStepMetadata.reviewKind,
                  reviewedCommitSha: priorReviewedCommitSha,
                  currentHeadSha,
                  baseRef,
                  fastForwardAdvance,
                  baseIsAncestor,
                  fingerprintProbeAvailable: recapturedFingerprint !== undefined,
                });
                if (finalDecision.recapture && currentHeadSha) {
                  reviewInputFingerprint = recapturedFingerprint;
                  reviewedCommitSha = currentHeadSha;
                  const resolvedInReviewFindingCount = parsed.findings?.filter((finding) => finding.resolution === "resolved-in-review").length ?? 0;
                  await deps.store.logEntry(task.id, `[pre-merge] ${workflowStep.name} re-captured its own review identity after fast-forward ${priorReviewedCommitSha?.slice(0, 7)} → ${currentHeadSha.slice(0, 7)} (${finalDecision.reason})`);
                  const runContext = deps.getRunContextFor(task.id);
                  if (runContext) await emitBoundedRunAudit(deps.store, {
                    taskId: task.id,
                    agentId: runContext.agentId,
                    runId: runContext.runId,
                    domain: "git",
                    mutationType: "task:review-input-recaptured",
                    target: task.id,
                    metadata: {
                      taskId: task.id,
                      workflowStepId: workflowStep.id,
                      verdict: effectiveVerdict,
                      resolvedInReviewFindingCount,
                      reason: finalDecision.reason,
                    },
                  });
                }
              } catch {
                // Keep the original pre-dispatch identity; an unproven tree must still face the gate.
              }
            }
          }
          if (workflowStep.requiresBrowser === true) {
            await logBrowserVerificationActivity(`[browser-verification] finished browser verification for task ${task.id}: verdict ${effectiveVerdict}`);
          }
          const noNotesReason = repairResult === "repaired" ? "unavailable" : repairResult;
          const noNotesNotice = parsed.notesMissing && parsed.verdict !== "CLOSE_NO_OP"
            ? workflowStepVerdictNoNotesNotice(effectiveVerdict, noNotesReason)
            : undefined;
          return {
            success: !revisionRequested,
            revisionRequested,
            output: noNotesNotice ?? parsed.output,
            verdict: effectiveVerdict,
            ...(requireVerdict ? { verdictRequired: true } : {}),
            notes: noNotesNotice ?? parsed.notes,
            ...(parsed.notesMissing ? { notesMissing: true } : {}),
            ...(parsed.findings ? { findings: parsed.findings } : {}),
            ...(reviewInputFingerprint ? { reviewInputFingerprint } : {}),
            ...(reviewedCommitSha ? { reviewedCommitSha } : {}),
            ...(repositoryScopeRevision !== undefined ? { repositoryScopeRevision } : {}),
            ...(parsed.supersededFindingSourceWorkflowStepId && parsed.supersededFindingIds ? { supersededFindingSourceWorkflowStepId: parsed.supersededFindingSourceWorkflowStepId, supersededFindingIds: parsed.supersededFindingIds } : {}),
          };
        }

        if (parsed.malformed) {
          const malformedReason = parsed.malformedReason ?? "no-verdict";
          const missingVerdictNotice = workflowStepMissingVerdictNotice(malformedReason);
          await deps.store.logEntry(
            task.id,
            `[pre-merge] Workflow step '${workflowStep.name}' produced malformed output (${malformedReason}) — ${missingVerdictNotice}`,
          );
          if (workflowStep.requiresBrowser === true) {
            await logBrowserVerificationActivity(`[browser-verification] finished browser verification for task ${task.id}: malformed output`);
          }
          return {
            success: false,
            output: parsed.output,
            error: `malformed output — ${malformedReason}`,
            notes: missingVerdictNotice,
            malformed: true,
            ...(requireVerdict ? { verdictRequired: true } : {}),
            ...(reviewedCommitSha ? { reviewedCommitSha } : {}),
          };
        }

        if (workflowStep.requiresBrowser === true) {
          await logBrowserVerificationActivity(`[browser-verification] finished browser verification for task ${task.id}: completed`);
        }
        return { success: true, output: parsed.output };
      } catch (err: unknown) {
        await agentLogger.flush();
        // Persist the delta before error disposal so graph-owned planning reviews
        // cannot disappear from operator cost totals.
        await accumulateSessionTokenUsage(deps.store, task.id, session, { agentId: task.assignedAgentId ?? undefined, role: "executor" });
        try { session.dispose(); } catch { /* best-effort */ }
        if ((err instanceof ReadonlyViolationError) || ((err as { code?: string } | null)?.code === "READONLY_VIOLATION")) {
          const violation = err as ReadonlyViolationError;
          const deniedTool = violation.toolName || "unknown";
          await deps.store.logEntry(
            task.id,
            `[readonly-violation] Workflow step '${workflowStep.name}' attempted denied tool '${deniedTool}'`,
          );
          if (workflowStep.requiresBrowser === true) {
            await logBrowserVerificationActivity(`[browser-verification] finished browser verification for task ${task.id}: readonly violation`);
          }
          return { success: false, error: `[readonly-violation] ${violation.message}` };
        }
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (workflowStep.requiresBrowser === true) {
          await logBrowserVerificationActivity(`[browser-verification] finished browser verification for task ${task.id}: failed — ${errorMessage}`);
        }
        return { success: false, error: errorMessage };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (ownsPlanningSegment) {
          try {
            const livePlanningTask = await deps.store.getTask(task.id);
            if (livePlanningTask) {
              const planningEnd = finalizePlanningSegment(livePlanningTask);
              if (planningEnd.planningStartedAt === null) await deps.store.updateTask(task.id, planningEnd);
            }
          } finally {
            // Finalize before releasing Plan Review ownership so triage can only
            // begin a subsequent, non-overlapping planning segment.
            deps.activePlanningWorkflowSessions.delete(task.id);
          }
        }
        const activeWorkflowStepSession = deps.activeWorkflowStepSessions.get(task.id);
        if (activeWorkflowStepSession === session) {
          deps.deleteActiveWorkflowStepSession(task.id, worktreePath);
        }
        // Suppress unused-variable warning; `timedOut` documents intent.
        void timedOut;
      }
    };

    const primaryOutcome = await runOnce(primaryProvider, primaryModelId, "primary");
    /*
    FNXC:ReviewLeniency 2026-07-02-00:30:
    Retry the fallback model on a MALFORMED (unparseable-verdict) primary response, not only on a timeout. A single fumbled response — reasoning with no trailing verdict — should get one more attempt on the fallback model before the gate result is recorded, mirroring the reviewer path's UNAVAILABLE retry. If no fallback is configured the malformed primary is returned as-is (and is treated as a non-blocking advisory downstream, see runGraphCustomNode).
    */
    const primaryMalformed = (primaryOutcome as { malformed?: boolean }).malformed === true;
    if (!primaryOutcome.timedOut && !primaryMalformed) return primaryOutcome;

    if (!fallback) {
      /*
       * FNXC:ReviewLeniency 2026-07-05-17:24:
       * FN-7561: when NO fallback model is configured, a MALFORMED primary (unparseable verdict — a single fumbled response) still deserves one retry so a transient formatting fumble does not feed the plan-review replan loop. Self-retry once on the SAME primary model. Timeouts are NOT self-retried — they would likely just time out again and burn another full budget. If the self-retry is still malformed it is returned as a non-blocking advisory downstream.
       */
      if (primaryMalformed && !primaryOutcome.timedOut) {
        await deps.store.logEntry(
          task.id,
          `Workflow step '${workflowStep.name}' retrying the primary model after malformed output — no fallback model is configured`,
        );
        const retryOutcome = await runOnce(primaryProvider, primaryModelId, "primary-retry");
        const retryMalformed = (retryOutcome as { malformed?: boolean }).malformed === true;
        if (!retryMalformed) return retryOutcome;
        await deps.store.logEntry(
          task.id,
          `Workflow step '${workflowStep.name}' produced malformed output on both the primary attempt and one self-retry — no fallback model configured (set ${fallbackSettingsHint})`,
        );
        return retryOutcome;
      }
      const reason = primaryOutcome.timedOut ? "timed out" : "produced malformed output";
      executorLog.warn(`${task.id}: workflow step '${workflowStep.name}' ${reason} and no fallback model is configured`);
      await deps.store.logEntry(
        task.id,
        `Workflow step '${workflowStep.name}' ${reason} — no fallback model configured (set ${fallbackSettingsHint})`,
      );
      return primaryOutcome;
    }

    executorLog.log(`${task.id}: retrying workflow step '${workflowStep.name}' with ${fallbackLaneLabel} fallback ${fallback.provider}/${fallback.modelId} after primary ${primaryOutcome.timedOut ? "timeout" : "malformed output"}`);
    return runOnce(fallback.provider, fallback.modelId, "fallback");
}
