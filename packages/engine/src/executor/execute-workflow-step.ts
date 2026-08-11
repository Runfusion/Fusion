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
  Settings,
  Task,
  TaskStore,
  WorkflowReviewKind,
  WorkflowStep,
} from "@fusion/core";
import {
  applyReviewSeverityGate,
  isOpenWorkflowReviewFinding,
  MAX_WORKFLOW_REVIEW_FINDINGS,
  finalizePlanningSegment,
  resolveExecutorFallbackModel,
  resolvePersistAgentThinkingLog,
  resolveReviewBlockingSeverity,
  resolveValidatorFallbackModel,
  startPlanningSegment,
} from "@fusion/core";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createTaskPromptWriteTool } from "./shared-worker-tools.js";
import type { PluginRunner } from "../plugins/plugin-runner.js";
import { AgentLogger } from "../agents/agent-logger.js";
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
  parseWorkflowStepOutput,
  type WorkflowStepOutcome,
} from "./workflow-step-verdict.js";
import { resolveDiffBaseRef } from "./worktree-git-refs.js";

const execAsync = promisify(exec);

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
  stepOptions?: { unattended?: boolean },
): Promise<WorkflowStepOutcome> {
    let toolMode: "coding" | "readonly" = workflowStep.toolMode || "readonly";
    // (U3) Genuinely-unattended run — set FUSION_HEADLESS=1 below so skills record
    // assumptions and proceed instead of parking on a question. Explicit opt-in
    // only (default false = board run); see runGraphCustomNode / KTD-3.
    const unattended = stepOptions?.unattended === true;
    const isPlanReviewStep = workflowStep.id === "graph:plan-review-step" || workflowStep.name === "Plan Review";
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
    const isReviewTypeWorkflowStep =
      isPlanReviewStep
      || workflowStepMetadata.reviewCanFixInline === true
      || /(?:^|\b)(?:review|verification)(?:\b|$)/i.test(workflowStep.name)
      || optionalGroupId === "plan-review"
      || optionalGroupId === "code-review"
      || optionalGroupId === "browser-verification";
    const reviewerInlineFixesEnabled = (settings as Settings & { reviewerInlineFixes?: boolean }).reviewerInlineFixes !== false;
    const allowReviewerInlineFixes = reviewerInlineFixesEnabled && isReviewTypeWorkflowStep && workflowStep.mode === "prompt";
    const allowPlanReviewPromptWrite = allowReviewerInlineFixes && isPlanReviewStep;
    if (allowReviewerInlineFixes && !isPlanReviewStep) {
      /*
       * FNXC:WorkflowReviewers 2026-07-01-12:36:
       * Review-type workflow nodes can now repair their own findings when the workflow setting `reviewerInlineFixes` is on. Use coding tools for implementation review sessions so Code Review, Browser Verification, and custom review/verification gates do not have to bounce through executor remediation for issues they can safely fix inline. Plan Review stays on a narrow PROMPT.md writer because it runs before implementation.
       */
      toolMode = "coding";
    }
    const requireExternalIntegrationEvidence =
      workflowStepMetadata.requireExternalIntegrationEvidence === true;

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
    const scopedFiles = await deps.captureModifiedFiles(worktreePath, task.baseCommitSha, task.id, undefined, "workflow-step-handler");
    let diffShortstat: string | undefined;
    try {
      const baseRef = await resolveDiffBaseRef(worktreePath, task.baseCommitSha);
      if (baseRef) {
        const { stdout } = await execAsync(`git diff --shortstat ${baseRef}..HEAD`, {
          cwd: worktreePath,
          encoding: "utf-8",
        });
        diffShortstat = stdout.trim() || undefined;
      }
    } catch {
      // best-effort — fall through with no shortstat
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
    const scopeBlock = isPlanReviewStep
      ? `Plan Review Scope:
  - Review the task plan artifact (PROMPT.md), reproduced verbatim below, and task metadata only.
  - The plan is embedded in this prompt — do NOT go looking for a PROMPT.md file in the worktree; it lives at the project root (\`.fusion/tasks/${task.id}/PROMPT.md\`), outside this worktree, so review the embedded copy.
  - Do NOT judge current implementation diffs, uncommitted worktree changes, or unrelated repository changes.
  - If the plan is internally consistent, complete, scoped, and verifiable, approve even when the worktree contains unrelated changes from another task.

  --- BEGIN PROMPT.md ---
  ${planReviewSpecText}
  --- END PROMPT.md ---`
      : `Diff Scope (files changed by THIS task vs base):
  ${scopeFileBlock}${diffShortstat ? `\nDiff stat: ${diffShortstat}` : ""}

  CRITICAL SCOPING RULES — read before doing anything else:
  - Review ONLY the files listed above. Do NOT analyze unmodified files or unrelated parts of the codebase.
  - If NONE of the files in the diff scope are relevant to your review category (e.g. a UX/design reviewer with no UI/CSS/component files in scope, a security reviewer with no auth/network code in scope, an a11y reviewer with no markup changes), respond IMMEDIATELY with a single short approval line such as "No relevant changes in scope — approved." and STOP. Do not start exploring the codebase.
  - Your wall-clock budget is short. Spending it browsing unmodified files will cause this step to time out and block merge.${approvedContractBlock}`;

    const latestTaskForUserComments = await deps.store.getTask(task.id).catch(() => task);
    const workflowStepUserComments = selectUserCommentsForAgentContext(latestTaskForUserComments, { limit: null });
    const workflowStepUserCommentSection = buildUserCommentsPromptSection(workflowStepUserComments);

    /*
     * FNXC:AgentSteering 2026-06-30-14:08:
     * Prompt/custom workflow-step reviewers, including Browser Verification agents, do not call reviewStep. They still gate quality, so their system prompt must carry the same canonical uncapped user comments plus legacy steering selected from a fresh task snapshot.
     */

    // (KTD-6) Verdict-contract reconciliation. The trailing-verdict JSON is the
    // gate-parsing contract — it only matters for steps that gate merge. A skill
    // step that isn't a gate (e.g. ce-plan / ce-work / ce-compound) produces
    // skill-native output (and may emit a ===FUSION_AWAIT_INPUT=== sentinel and
    // stop), so forcing a verdict would contradict the U2 preamble. Require the
    // verdict only for gate steps (and skill-less prompt steps, which keep the
    // legacy reviewer contract); relax it for non-gate skill steps. The executor
    // runs parseAwaitInputSentinel on output regardless, so the await-input
    // sentinel always takes priority when present.
    const isSkillStep = typeof workflowStep.skillName === "string" && workflowStep.skillName.trim().length > 0;
    const isSummaryProjectionStep = (workflowStep as WorkflowStep & { summaryTarget?: string }).summaryTarget === "task";
    const requireVerdict = !isSummaryProjectionStep && (workflowStep.gateMode === "gate" || !isSkillStep);
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
        workflowSettings: await mergeEffectiveSettings(deps.store, task, settings)
          .catch(() => settings) as unknown as Record<string, unknown>,
        nodeBlockingSeverity: (workflowStep as WorkflowStep & { blockingSeverity?: unknown }).blockingSeverity,
      })
      : undefined;
    /*
     * FNXC:WorkflowReviewFindings 2026-08-11-19:39:
     * Prior open findings make cross-lane supersession an explicit reviewer claim rather than a
     * commit-timestamp inference, so receipts cannot be mistaken for new executor work.
     */
    const priorFindings = reviewFindingsContract
      ? (task.workflowStepResults ?? []).flatMap((result) => result.workflowStepId === workflowStep.id
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
    const verdictBlock = requireVerdict
      ? `

  ## Feedback Format

  When your review is complete, your final line MUST be a single JSON object (no markdown fences):

  ${reviewFindingsContract
    ? "{\"verdict\":\"APPROVE|APPROVE_WITH_NOTES|REVISE\",\"notes\":\"...\",\"findings\":[{\"id\":\"stable-id\",\"title\":\"concise issue\",\"body\":\"actionable detail\",\"filePath\":\"optional/path\",\"line\":1,\"severity\":\"low|medium|high|critical\",\"resolution\":\"open|resolved-in-review|superseded\"}],\"supersededFindingSourceWorkflowStepId\":\"prior-review-step-id\",\"supersededFindingIds\":[\"prior-finding-id\"]}"
    : "{\"verdict\":\"APPROVE|APPROVE_WITH_NOTES|REVISE\",\"notes\":\"...\"}"}

  Rules:
  - Output exactly one trailing JSON object and stop.
  - verdict must be exactly APPROVE, APPROVE_WITH_NOTES, or REVISE.
  - notes should be concise and actionable. Use an empty string when there are no notes.
  - For out-of-scope fast-bail responses, use: {"verdict":"APPROVE","notes":"out of scope: no UI files changed"}${reviewFindingsContract ? "\n  - Every finding MUST carry a `severity`. Put each blocking issue in `findings` — prose in `notes` alone does not block.\n  - Omit resolution (or use open) for work still needed; use resolved-in-review only for an issue you fixed in this session.\n  - supersededFindingIds may list only IDs from one named Prior Findings result that you re-verified no longer apply; include that result’s workflow step ID in supersededFindingSourceWorkflowStepId; never list your own findings." : ""}${blockingSeverityRule}

  Backward compat fallback: if JSON is unavailable, you may still begin output with REQUEST REVISION to request changes.`
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
  - Code Review and Browser Verification may fix implementation issues inside the assigned task worktree. Report each self-fixed issue as a finding with resolution resolved-in-review; list a fixed prior-lane finding in supersededFindingIds.`
      : "";

    const systemPrompt = `You are a workflow step agent executing: ${workflowStep.name}

  Task Context:
  - Task ID: ${task.id}
  - Task Description: ${task.description}
  - Worktree: ${worktreePath}

  ${scopeBlock}${workflowStepUserCommentSection ? `\n\n${workflowStepUserCommentSection}` : ""}${priorFindingsBlock}

  Your role:
  - Execute this workflow step exactly as scoped.
  - Report only what changes the delivered result. Do NOT report nits — wording, formatting, naming or ordering preferences, internal numbering/cross-reference mismatches that do not change what gets built, or detail any reasonable implementation choice would satisfy. Omit them entirely rather than filing them as low-severity findings.
  - Assume the implementer is a competent engineer who resolves local detail correctly without being told.
  - Keep feedback actionable and directly tied to evidence in files/outputs.
  - Finding nothing is a valid and common outcome. Do not manufacture findings to justify the review.

  Your Instructions:
  ${workflowStep.prompt}

  You have access to the file system to review changes.${inlineFixBlock}${verdictBlock}`;

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

    // Determine primary model and an explicit fallback. Review-type workflow
    // steps use the validator lane; ordinary workflow prompts use the executor
    // lane. A complete per-step override remains authoritative for either lane.
    // FNXC:ModelResolution 2026-06-25-12:00: FN-7039 requires ordinary workflow
    // steps to inherit project execution-lane model settings before defaults.
    // Review gates are independent validation surfaces and must not silently use
    // the same implementation model merely because they execute in this method.
    const assignedRuntimeConfig = await deps.getAssignedAgentRuntimeConfig(task.assignedAgentId);
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
        task,
        sessionPurpose: "executor",
        projectRootDir: deps.rootDir,
        pluginRunner: deps.options.pluginRunner,
      });

      const workflowAgent = await deps.getAuthoritativeAssignedAgent(task.assignedAgentId);
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
      const { session } = await createResolvedAgentSession({
        sessionPurpose: "executor",
        runtimeHint: workflowRuntimeHint,
        pluginRunner: deps.options.pluginRunner,
        cwd: worktreePath,
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
        // FNXC:SessionRouting 2026-06-24-11:20:
        // #1675: propagate task id so workflow-step requests carry the same
        // X-Session-Id/X-Session-Affinity as the primary session.
        taskId: task.id,
        // FNXC:PluginSkills 2026-07-12-00:00: Workflow-step sessions union plugin skill body dirs with CE's FUSION_CE_SKILLS_DIR so neither plugin-package nor compound-engineering skills are overwritten.
        // Skill selection: assigned-agent / role-fallback skills, plus the step's own named skill (U1) made discoverable via additionalSkillPaths.
        ...(effectiveSkillSelection ? { skillSelection: effectiveSkillSelection } : {}),
        ...(additionalSkillPaths ? { additionalSkillPaths } : {}),
        ...(readonlyCustomTools.allowed.length > 0 ? { customTools: readonlyCustomTools.allowed } : {}),
      });

      const workflowModelDetails = formatModelMarkerDetails(
        describeModel(session),
        workflowStepThinkingLevel,
        [
          useOverride && attemptLabel === "primary" ? "workflow step override" : "",
          attemptLabel === "fallback" ? "fallback after timeout" : "",
        ],
      );
      executorLog.debug(`${task.id}: workflow step '${workflowStep.name}' using model ${workflowModelDetails}`);
      await deps.store.logEntry(
        task.id,
        `Workflow step '${workflowStep.name}' using model: ${workflowModelDetails}`,
      );
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
          return { success: false, error: `workflow step timed out after ${timeoutMs}ms`, timedOut: true };
        }

        // Completed within the timeout — let any post-completion errors surface.
        checkSessionError(session);
        await accumulateSessionTokenUsage(deps.store, task.id, session, {
            agentId: task.assignedAgentId ?? undefined,
            role: "executor",
          });
        session.dispose();
        await agentLogger.flush();

        /*
        FNXC:PlanReviewNoOp 2026-08-09-22:10:
        Thread optionalGroupId so Plan Review CLOSE_NO_OP is accepted only for that group.
        */
        const parsed = requireVerdict
          ? parseWorkflowStepOutput(output, { optionalGroupId })
          : parseWorkflowStepOutput(output, { requireVerdict: false, optionalGroupId });
        if (parsed.verdict) {
          /*
           * FNXC:ReviewSeverityGate 2026-08-10-17:33:
           * Apply the severity gate HERE, at the single parse boundary, so the rewritten verdict is what
           * every downstream consumer sees (step-result status mapping, remediation routing, Review tab,
           * merge blocking). Downgrading later would leave the persisted verdict disagreeing with the
           * routing decision. Only a REVISE with no finding at or above the threshold is relaxed; a
           * prose-only or unclassified REVISE still blocks (fail-closed contract in review-severity-gate.ts).
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
          if (workflowStep.requiresBrowser === true) {
            await logBrowserVerificationActivity(`[browser-verification] finished browser verification for task ${task.id}: verdict ${effectiveVerdict}`);
          }
          return {
            success: !revisionRequested,
            revisionRequested,
            output: parsed.output,
            verdict: effectiveVerdict,
            notes: parsed.notes,
            ...(parsed.findings ? { findings: parsed.findings } : {}),
            ...(parsed.supersededFindingSourceWorkflowStepId && parsed.supersededFindingIds ? { supersededFindingSourceWorkflowStepId: parsed.supersededFindingSourceWorkflowStepId, supersededFindingIds: parsed.supersededFindingIds } : {}),
          };
        }

        if (parsed.malformed) {
          // FNXC:ReviewLeniency 2026-07-02-00:30: malformed output (after the
          // fallback-model retry) is recorded as a NON-BLOCKING advisory, not a
          // hard gate block — see runGraphCustomNode's outcome mapping.
          await deps.store.logEntry(
            task.id,
            `[pre-merge] Workflow step '${workflowStep.name}' produced malformed output (no parseable verdict) — recorded as non-blocking advisory`,
          );
          if (workflowStep.requiresBrowser === true) {
            await logBrowserVerificationActivity(`[browser-verification] finished browser verification for task ${task.id}: malformed output`);
          }
          return {
            success: false,
            output: parsed.output,
            error: "malformed output — no verdict extracted",
            notes: undefined,
            malformed: true,
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
        executorLog.log(`${task.id}: workflow step '${workflowStep.name}' produced malformed output and no fallback is configured — retrying once on the primary model`);
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
