/**
 * FNXC:CodeOrganization 2026-08-03-14:40:
 * runGraphCustomNode peeled from TaskExecutor (U4).
 *
 * Executes a single graph custom/skill/script/CLI/await-input node with column-agent
 * adoption, worktree ensure, and unattended env wiring.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentStore,
  ResolvedTaskOutputLanguage,
  Settings,
  TaskDetail,
  TaskStore,
  ThinkingLevel,
  WorkflowColumnAgent,
  WorkflowIrNode,
  WorkflowStep,
  WorkspaceConfig,
} from "@fusion/core";
import { isFastExecutionMode, isFastLaneSkippableCustomNode, isLegacyWorkspaceWorktreeLayout, requiresContentReviewProof, resolveEffectiveAgent, resolveWorkspaceTaskWorktreeDir, THINKING_LEVELS, WORKFLOW_STEP_NOT_RUN_REASONS } from "@fusion/core";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import type { WorkflowNodeResult } from "../workflows/workflow-graph-executor.js";
import {
  WORKFLOW_OPTIONAL_GROUP_CONTEXT_KEY,
  WORKFLOW_REVIEW_KIND_CONTEXT_KEY,
} from "../workflows/workflow-graph-executor.js";
import { workflowNodeRequiresWorktree } from "../workflows/workflow-node-execution-needs.js";
import {
  FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE,
  parseWorkflowStepOutput,
  type WorkflowStepOutcome,
} from "./workflow-step-verdict.js";
import { parseAwaitInputSentinel } from "./await-input-parse.js";
// FNXC:ReviewLaneRecommendations 2026-08-26-07:34: a readonly review node holds no writer; projection is its only durable channel.
import { parseWorkflowStepRecommendations, resolveMaxRecommendationsPerTask } from "./workflow-step-recommendations.js";
import { buildAgentPersona } from "./agent-binding-pure.js";
import { isApprovalFamilyVerdict, reviewWorkspacePerRepo } from "./workspace-review-per-repo.js";
import { persistWorkspaceCodeReviewApproval } from "./create-authoritative-workflow-seams.js";
import type { ReviewResult } from "../execution/reviewer.js";
import type { SessionBoundaryDescriptor } from "../agents/agent-runtime.js";
import { runDeterministicVerificationGate } from "../workflow-node-runners/verification-gate.js";
import {
  ensureWorktreeDependencies,
  type DependencyCommandRunner,
  type WorktreeDependencyReadiness,
} from "../worktree/worktree-dependency-install.js";
import { resolveContentReviewInputProof } from "../worktree/review-diff-fingerprint.js";

const WORKFLOW_THINKING_LEVEL_SET: ReadonlySet<string> = new Set(THINKING_LEVELS);
const WORKFLOW_STEP_NOT_RUN_REASON_SET: ReadonlySet<string> = new Set(WORKFLOW_STEP_NOT_RUN_REASONS);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

export type RunGraphCustomNodeDeps = {
  store: TaskStore;
  rootDir: string;
  workspaceConfig: WorkspaceConfig | null | undefined;
  ensureWorkspaceConfig?: () => Promise<WorkspaceConfig | null>;
  options: { pluginRunner?: unknown; agentStore?: AgentStore | null; [k: string]: unknown };
  graphUnattendedRuns: Set<string>;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  runContextFor: (taskId: string, fallbackAgentId?: string | null) => import("@fusion/core").RunMutationContext;
  adoptColumnAgentForNode: AnyFn;
  buildInjectedRuntimeEnv: AnyFn;
  ensureGraphCustomNodeWorktree: AnyFn;
  executeScriptWorkflowStep: AnyFn;
  executeWorkflowStep: AnyFn;
  pauseForCliApproval: AnyFn;
  resolveWorkflowInputMarkerForGraphNode: AnyFn;
  runAwaitInputNode: AnyFn;
  runCliAgentNode: AnyFn;
  runRawCliCommand: AnyFn;
  /** Shared sandbox-routed command seam used by the Plan Review dependency catch-up. */
  runConfiguredCommand: DependencyCommandRunner;
};

/*
FNXC:WorkspaceBoundary 2026-08-29-06:36:
Workspace task directories contain the acquired child repository worktrees rather than a `.git`
of their own. Both write-capable nodes and read-only reporting gates must declare that topology so
they inspect the task's delivered tree instead of the shared workspace checkout. On mult-038, a
reporting gate at the shared root contradicted Code Review by reporting delivered fixtures absent.
Plan Review deliberately remains a shared-root reader before scope exists; single-repository,
legacy-layout, and zero-root cases retain their existing implicit boundary behavior.
*/
export function resolveGraphNodeSessionBoundary(input: {
  isWorkspace: boolean;
  writeCapable: boolean;
  isPlanReview?: boolean;
  legacyWorkspaceLayout: boolean;
  rootDir: string;
  worktreePath: string;
  confirmedRepositories?: readonly string[];
}): SessionBoundaryDescriptor | undefined {
  if (!input.isWorkspace || input.legacyWorkspaceLayout) return undefined;
  const repoRoots = (input.confirmedRepositories ?? []).map((repoRelPath) => ({
    repoRelPath,
    repoRootDir: join(input.rootDir, repoRelPath),
  }));
  if (repoRoots.length === 0) return undefined;
  return {
    kind: "workspace-task-dir",
    writableRoot: input.worktreePath,
    projectRoot: input.rootDir,
    repoRoots,
  };
}

export type WorkspaceReadOnlyGateRepositoryContext =
  | { resolved: true }
  | { resolved: false; output: string };

/**
 * Validate that a read-only workspace gate can inspect every task-owned checkout without
 * acquiring or silently falling back to the shared workspace root.
 */
export function resolveWorkspaceReadOnlyGateRepositoryContext(input: {
  task: Pick<TaskDetail, "repositoryScope" | "workspaceWorktrees">;
  workspaceTaskDir: string;
  exists?: (path: string) => boolean;
}): WorkspaceReadOnlyGateRepositoryContext {
  const scope = input.task.repositoryScope;
  if (scope?.state !== "confirmed") {
    return {
      resolved: false,
      output: "Workspace repository context is unresolved: repository scope is not confirmed. This check was not run.",
    };
  }

  const repositories = scope.repositories ?? [];
  if (repositories.length === 0) {
    return {
      resolved: false,
      output: "Workspace repository context is unresolved: no confirmed repositories are recorded. This check was not run.",
    };
  }

  const exists = input.exists ?? existsSync;
  const missing: string[] = [];
  if (!exists(input.workspaceTaskDir)) {
    missing.push(`workspace task directory is missing (${input.workspaceTaskDir})`);
  }
  for (const repoRelPath of repositories) {
    const worktreePath = input.task.workspaceWorktrees?.[repoRelPath]?.worktreePath;
    if (typeof worktreePath !== "string" || !worktreePath.trim()) {
      missing.push(`${repoRelPath}: no recorded task worktree`);
    } else if (!exists(worktreePath)) {
      missing.push(`${repoRelPath}: task worktree is missing on disk`);
    }
  }

  return missing.length > 0
    ? {
        resolved: false,
        output: `Workspace repository context is unresolved: ${missing.join("; ")}. This check was not run.`,
      }
    : { resolved: true };
}

export interface PlanReviewDependencyGateInput {
  task: TaskDetail;
  settings: Settings;
  workspaceConfig: WorkspaceConfig | null | undefined;
  worktreePath: string;
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  runConfiguredCommand: DependencyCommandRunner;
}

interface DependencyGateTarget {
  repository: string;
  worktreePath: string;
}

function dependencyGateDetails(target: DependencyGateTarget, readiness: WorktreeDependencyReadiness): string {
  if (readiness.readiness === "unrecognized") {
    return `${target.repository}: unrecognized dependency evidence (${readiness.evidence.join(", ")}); resolve it with fn_install_worktree_dependencies.`;
  }
  const rows = readiness.unresolvedRepos.map((row) => {
    const entry = readiness.entries.find((candidate) => candidate.ecosystem === row.ecosystem);
    return `${row.manifests.join(", ") || row.ecosystem}; command \`${row.command}\`; ${entry?.reason ?? entry?.outcome ?? "not installed"}`;
  });
  return `${target.repository}: ${rows.join("; ")}`;
}

/**
 * Pre-dispatch Plan Review gate for worktree dependency readiness. This is deliberately a node
 * result, rather than a side-channel pause, so the established Plan Review REVISE/replan cap remains
 * the sole lifecycle authority. A probe that cannot determine readiness is logged and falls through.
 */
export async function runPlanReviewDependencyGate(
  input: PlanReviewDependencyGateInput,
): Promise<WorkflowNodeResult | null> {
  const targets: DependencyGateTarget[] = [];
  if (input.workspaceConfig?.repos.length) {
    for (const repository of input.workspaceConfig.repos) {
      const path = input.task.workspaceWorktrees?.[repository]?.worktreePath;
      if (!path || !existsSync(path)) {
        await input.store.logEntry(
          input.task.id,
          `Dependency readiness not determined for ${repository}; Plan Review dispatch continues`,
          path ? `Task worktree is missing: ${path}` : "No recorded task worktree",
          input.getRunContextFor(input.task.id),
        );
        continue;
      }
      targets.push({ repository, worktreePath: path });
    }
  } else if (input.task.worktree && input.worktreePath && existsSync(input.worktreePath)) {
    targets.push({ repository: "task worktree", worktreePath: input.worktreePath });
  } else {
    await input.store.logEntry(
      input.task.id,
      "Dependency readiness not determined; Plan Review dispatch continues",
      "No readable task worktree is available",
      input.getRunContextFor(input.task.id),
    );
  }

  const blocking: Array<{ target: DependencyGateTarget; readiness: WorktreeDependencyReadiness }> = [];
  for (const target of targets) {
    try {
      const readiness = await ensureWorktreeDependencies({
        worktreePath: target.worktreePath,
        settings: input.settings,
        taskId: input.task.id,
        store: input.store,
        runContext: input.getRunContextFor(input.task.id),
        runConfiguredCommand: input.runConfiguredCommand,
        taskEnv: process.env,
        logger: executorLog,
      });
      if (readiness.readiness === "unresolved" || readiness.readiness === "unrecognized") {
        blocking.push({ target, readiness });
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      await input.store.logEntry(
        input.task.id,
        `Dependency readiness not determined for ${target.repository}; Plan Review dispatch continues`,
        error instanceof Error ? error.message : String(error),
        input.getRunContextFor(input.task.id),
      );
    }
  }
  if (blocking.length === 0) return null;

  const lines = ["Dependencies are not installed.", ...blocking.map(({ target, readiness }) => `- ${dependencyGateDetails(target, readiness)}`)];
  const output = lines.join("\n");
  const findings = blocking.map(({ target, readiness }) => ({
    severity: "high",
    title: "Dependencies are not installed",
    body: dependencyGateDetails(target, readiness),
  }));
  await input.store.logEntry(input.task.id, "Plan Review blocked by worktree dependency readiness", output, input.getRunContextFor(input.task.id));
  return {
    outcome: "failure",
    value: "REVISE",
    contextPatch: {
      output,
      notes: "Plan Review cannot approve until dependency-bearing worktrees have durable readiness.",
      findings,
    },
  };
}

/*
FNXC:WorkspaceReviewFindings 2026-08-27-12:05:
FN-201 requires the workspace callback to preserve structured reviewer findings. Dropping them here
made a workspace REVISE unremediable even though the per-repository reviewer named actionable work.

FNXC:ReviewVerdictNotes 2026-08-28-21:23:
Workspace prompt reviews inherit the one-repair-per-session contract from executeWorkflowStep; do not
add a second repair here. Preserve each repaired note before aggregate composition. If that repair
fails soft, or an exit-zero script review has no stdout and no session to repair, deterministic engine
narration prevents an empty repository section. This follows the lane's existing "No changes — not
reviewed." and "reviewer error" narration rather than fabricating reviewer prose.
*/
export const WORKSPACE_REPO_REVIEW_NO_NOTES_NOTICE = "The repository reviewer recorded no notes for this verdict.";

export function toWorkspaceRepoReviewResult(repoOutcome: WorkflowStepOutcome): ReviewResult {
  const reviewText = repoOutcome.notes?.trim()
    || repoOutcome.output?.trim()
    || repoOutcome.error?.trim()
    || WORKSPACE_REPO_REVIEW_NO_NOTES_NOTICE;
  /*
  FNXC:ReviewVerdictAuthority 2026-09-02-19:25:
  A successful deterministic script still approves from its exit code, but a prompt review that owed
  JSON cannot be promoted from transport success alone. Preserve its missing verdict as UNAVAILABLE
  so workspace aggregation never fabricates authored approval evidence.
  */
  const verdict = repoOutcome.verdict
    ?? (repoOutcome.success && !repoOutcome.verdictRequired ? "APPROVE" : "UNAVAILABLE");
  return {
    verdict: verdict as ReviewResult["verdict"],
    review: reviewText,
    summary: reviewText,
    retryable: !repoOutcome.success || verdict === "UNAVAILABLE",
    ...(repoOutcome.findings ? { findings: repoOutcome.findings } : {}),
  };
}

export function buildWorkspaceReviewOutcome(aggregate: ReviewResult, options: { superseded?: boolean } = {}): WorkflowStepOutcome {
  return {
    success: isApprovalFamilyVerdict(aggregate.verdict),
    verdict: aggregate.verdict as WorkflowStepOutcome["verdict"],
    output: aggregate.review,
    ...(aggregate.review.trim() ? { notes: aggregate.review } : {}),
    repositoryReviewOutcomes: aggregate.repositoryReviewOutcomes,
    repositoryScopeRevision: aggregate.repositoryScopeRevision,
    ...(!options.superseded && aggregate.findings ? { findings: aggregate.findings } : {}),
    ...(aggregate.verdict === "UNAVAILABLE" ? { failureValue: "workspace-review-unavailable" } : {}),
  };
}

export function preserveOutcomeFindingsFromReviewOutput(outcome: WorkflowStepOutcome): WorkflowStepOutcome {
  if (outcome.findings || typeof outcome.output !== "string") return outcome;
  const parsedReviewOutput = parseWorkflowStepOutput(outcome.output, { requireVerdict: false });
  return parsedReviewOutput.findings?.length ? { ...outcome, findings: parsedReviewOutput.findings } : outcome;
}

/*
FNXC:Identity 2026-09-04-08:38:
Session identity is `workflow:principal-agent-id` when FN-8764 routing selected one (including
when an override column agent lacked the node's required role). Column-agent is the worktree
fallback only when that context is absent. `resolveEffectiveAgent` still owns model/persona
overlay after checkout. `cfg.agentId` remains own-settings fallback.
*/
export function resolveGraphCustomNodeWorktreePrincipal(input: {
  cfg: Record<string, unknown>;
  columnBinding?: WorkflowColumnAgent;
  graphContext?: Record<string, unknown>;
}): {
  principalAgentId: string | undefined;
  effective: ReturnType<typeof resolveEffectiveAgent>;
} {
  const ownAgentId = typeof input.cfg.agentId === "string" && input.cfg.agentId.trim()
    ? input.cfg.agentId.trim()
    : undefined;
  const modelProvider = typeof input.cfg.modelProvider === "string" && input.cfg.modelProvider.trim()
    ? input.cfg.modelProvider.trim()
    : undefined;
  const modelId = typeof input.cfg.modelId === "string" && input.cfg.modelId.trim()
    ? input.cfg.modelId.trim()
    : undefined;
  const ownModelComplete = Boolean(modelProvider && modelId);
  const graphPrincipalRaw = input.graphContext?.["workflow:principal-agent-id"];
  const graphPrincipal = typeof graphPrincipalRaw === "string" && graphPrincipalRaw.trim()
    ? graphPrincipalRaw.trim()
    : undefined;
  const effective = resolveEffectiveAgent({
    binding: input.columnBinding,
    ownAgentId,
    ownModelProvider: ownModelComplete ? modelProvider : undefined,
    ownModelId: ownModelComplete ? modelId : undefined,
  });
  return {
    principalAgentId: graphPrincipal
      ?? (effective.source === "column-agent" ? effective.agentId : undefined)
      ?? ownAgentId,
    effective,
  };
}

export async function runGraphCustomNode(
  deps: RunGraphCustomNodeDeps,
  node: WorkflowIrNode,
  nodeTask: TaskDetail,
  settings: Settings,
  columnBinding?: WorkflowColumnAgent,
  graphContext?: Record<string, unknown>,
  outputLanguage?: ResolvedTaskOutputLanguage,
): Promise<WorkflowNodeResult> {
    const cfg = node.config ?? {};
    const { principalAgentId: nodePrincipalAgentId, effective } = resolveGraphCustomNodeWorktreePrincipal({
      cfg,
      columnBinding,
      graphContext,
    });
    let live = await deps.store.getTask(nodeTask.id);

    const staleInput = await deps.resolveWorkflowInputMarkerForGraphNode(live, node.id);
    if (staleInput === "waiting") return { outcome: "failure", value: "awaiting-user-input" };
    if (staleInput === "clear") live = await deps.store.getTask(nodeTask.id);

    // Await-input nodes never run a session — they pause for the user.
    // FNXC:WorkflowAskUser 2026-07-05-00:00: `ask-user` is the dedicated,
    // discoverable node kind for this same pause; `prompt` + `config.awaitInput:
    // true` remains a back-compat alias (both route to the identical runner).
    if (cfg.awaitInput === true || node.kind === "ask-user") {
      return deps.runAwaitInputNode(node, live);
    }

    // Skill-emitted await-input resume (U6): a prior run of THIS node may have
    // paused the task because its skill asked the user a blocking question via
    // the ===FUSION_AWAIT_INPUT=== sentinel. Mirror runAwaitInputNode's resume:
    // when the user has replied (a steering comment at/after the pause
    // watermark), clear the marker and fall through to RE-RUN the skill so it
    // continues with the answer; otherwise keep the task parked and halt.
    const skillAwaitMarker = `workflow-input:${node.id}`;
    const skillPausedReason = live.pausedReason ?? "";
    if (skillPausedReason.startsWith(skillAwaitMarker)) {
      // Mirror runAwaitInputNode: only inspect replies once the task is actually
      // unpaused. While `live.paused` is still true the user has added a comment
      // but not released the task — keep it parked and never consume that reply,
      // so a still-paused task can't short-circuit straight back into the skill.
      if (live.paused) {
        return { outcome: "failure", value: "awaiting-user-input" };
      }
      const watermark = (() => {
        const mm = skillPausedReason.slice(skillAwaitMarker.length).match(/^@(\d+)/);
        const t = mm ? Number(mm[1]) : NaN;
        return Number.isFinite(t) ? t : undefined;
      })();
      const steering = Array.isArray(live.steeringComments) ? live.steeringComments : [];
      const replies = watermark === undefined
        ? steering
        : steering.filter((c) => {
            const created = Date.parse((c as { createdAt?: string }).createdAt ?? "");
            return Number.isFinite(created) ? created >= watermark : false;
          });
      if (replies.length === 0) {
        // Unpaused without a post-watermark reply — re-park and keep waiting.
        await deps.store.updateTask(live.id, { status: "awaiting-user-input", paused: true }, deps.runContextFor(live.id));
        return { outcome: "failure", value: "awaiting-user-input" };
      }
      await deps.store.updateTask(live.id, { status: null, pausedReason: null }, deps.runContextFor(live.id));
      await deps.store.logEntry(live.id, `Workflow input received for step '${node.id}' — resuming`, undefined, deps.runContextFor(live.id));
    }

    const executorKind = typeof cfg.executor === "string" ? cfg.executor : "model";

    // CLI Agent Executor (U7): a `cli-agent` node drives an engine-owned CLI
    // session through the task-session orchestration — NOT through the
    // executeWorkflowStep / model machinery. It is write-capable (the agent edits
    // the worktree), so it requires a task worktree like any coding node.
    if (executorKind === "cli-agent") {
      return deps.runCliAgentNode(node, await deps.store.getTask(live.id), cfg);
    }

    // Fast mode bypasses pre-merge automated review/validation gates. Custom
    // graph prompt/script/gate nodes are implemented by synthesizing pre-merge
    // WorkflowStep executions below, so skip them here before worktree or CLI
    // approval gates can fire. Human waits (`awaitInput`) and implementation
    // CLI-agent nodes are handled above and remain enforced.
    const optionalGroupId = typeof graphContext?.[WORKFLOW_OPTIONAL_GROUP_CONTEXT_KEY] === "string"
      ? graphContext[WORKFLOW_OPTIONAL_GROUP_CONTEXT_KEY]
      : undefined;
    /*
    FNXC:WorkflowReviewFindings 2026-08-05-06:29:
    Carry plan/code reviewKind from node config or optional-group graph context onto the
    synthesized WorkflowStep so prompt nodes emit findings JSON and script nodes can attach
    normalized findings without inventing review metadata for unmarked scripts.
    */
    const declaredReviewKind = cfg.reviewKind === "plan" || cfg.reviewKind === "code"
      ? cfg.reviewKind
      : graphContext?.[WORKFLOW_REVIEW_KIND_CONTEXT_KEY] === "plan" || graphContext?.[WORKFLOW_REVIEW_KIND_CONTEXT_KEY] === "code"
        ? graphContext[WORKFLOW_REVIEW_KIND_CONTEXT_KEY] as "plan" | "code"
        : undefined;
    const effectiveStepId = optionalGroupId ?? node.id;
    const isContentBindingStep = requiresContentReviewProof(effectiveStepId, { reviewKind: declaredReviewKind });
    /*
    FNXC:FastLane 2026-08-29-03:10:
    The pure route predicate keeps custom-node skips aligned with graph bypasses while preserving
    the completion-summary, optional-template, and seam carve-outs. A selected Fast card no longer
    treats an optional-group body as stronger operator intent: its parent pre-merge group is routed
    around before this runner is reached.
    */
    if (
      isFastExecutionMode(live)
      && graphContext?.["workflow:fast-lane-active"] === true
      && isFastLaneSkippableCustomNode(node, { optionalGroupId })
    ) {
      executorLog.debug(`${live.id}: fast mode — skipping custom graph node '${node.id}'`);
      await deps.store.logEntry(
        live.id,
        `Fast mode — custom graph node '${node.id}' skipped`,
        undefined,
        deps.runContextFor(live.id),
      );
      return {
        outcome: "success",
        value: "workflow-step-skipped",
        contextPatch: {
          notRunReason: "execution-mode-skip",
          output: "Fast mode skipped this check — NOTHING WAS VERIFIED.",
        },
      };
    }

    const scriptName = typeof cfg.scriptName === "string" && cfg.scriptName.trim() ? cfg.scriptName : undefined;
    const rawCliCommand = executorKind === "cli" && typeof cfg.cliCommand === "string" && cfg.cliCommand.trim()
      ? cfg.cliCommand.trim()
      : undefined;
    // Nodes that inspect or mutate delivered work must run inside a task worktree,
    // not the shared repo root. Review nodes still need the checkout when their
    // session tool policy is read-only; the classifier therefore answers checkout
    // need rather than whether mutation tools will be exposed.
    const isDeterministicVerificationGate = cfg.workflowAction === "deterministic-verification";
    const writeCapable = isDeterministicVerificationGate || workflowNodeRequiresWorktree(node, { optionalGroupId });
    const workspaceConfig = deps.ensureWorkspaceConfig
      ? await deps.ensureWorkspaceConfig()
      : deps.workspaceConfig;
    let executionTarget = writeCapable ? await deps.store.getTask(live.id) : live;

    /*
    FNXC:NodeWorktreeIsolation 2026-08-22-22:31:
    FN-158 replaces the coordinator checkout with a declared read-only workspace boundary for
    planning and Plan Review. A null writable root is stronger than a writable worktree: planners
    retain task-store tools but cannot alter the operator checkout, so concurrent readers cannot
    collide. Tree freshness is re-checked at Plan Review and execution after scoped acquisition.
    Write-capable workspace nodes still acquire task-owned worktrees; single-repository nodes keep
    their existing worktree acquisition path.
    */
    const nodeDisplayName = typeof cfg.name === "string" && cfg.name.trim() ? cfg.name.trim() : node.id;
    const isPlanReviewNode = node.id === "plan-review-step" || nodeDisplayName === "Plan Review" || optionalGroupId === "plan-review";
    const isScriptPlanReviewNode = isPlanReviewNode && (
      node.kind === "script"
      || (node.kind === "gate" && Boolean(scriptName))
      || executorKind === "cli"
    );
    /*
    FNXC:WorkspaceBoundary 2026-08-22-22:22:
    Reject script Plan Review before worktree acquisition or command dispatch. The script seam has
    no declared read-only boundary, so executing it at the workspace root would let it write the
    operator checkout. Prompt Plan Review remains the supported bounded route.
    */
    if (workspaceConfig && isScriptPlanReviewNode) {
      const error = "Workspace Plan Review scripts are unsupported because they cannot run under the declared read-only boundary";
      await deps.store.logEntry(live.id, error, undefined, deps.runContextFor(live.id));
      return { outcome: "failure", value: "workspace-plan-review-script-readonly-required" };
    }

    if (workspaceConfig?.repos.length) {
      // Re-read the configured set, but only write-capable execution may provision it.
      executionTarget = await deps.store.getTask(live.id);
      const missingRepository = workspaceConfig.repos.find((repository) => {
        const path = executionTarget.workspaceWorktrees?.[repository]?.worktreePath;
        return typeof path !== "string" || !existsSync(path);
      });
      if (writeCapable && missingRepository) {
        await deps.store.logEntry(
          live.id,
          `Workflow node '${node.id}' is acquiring configured workspace checkout '${missingRepository}'`,
          undefined,
          deps.getRunContextFor(live.id),
        );
        executionTarget = await deps.ensureGraphCustomNodeWorktree(executionTarget, settings, node.id, undefined, nodePrincipalAgentId);
      }
    } else if (!workspaceConfig) {
      const recordedWorktreeMissing = Boolean(executionTarget.worktree) && !existsSync(executionTarget.worktree!);
      /*
      FNXC:PlanningBoundary 2026-09-01-14:49:
      Checkout provisioning belongs exclusively to write-capable execution nodes. Plan Review uses
      main read-only and never reacquires a vanished path; write-capable nodes preserve stale-path
      recovery by clearing the missing pointer before acquisition.
      */
      const shouldAcquire = writeCapable && (!executionTarget.worktree || recordedWorktreeMissing);
      if (shouldAcquire) {
        const acquisitionTask = recordedWorktreeMissing
          ? ({ ...executionTarget, worktree: undefined, sessionFile: undefined } as TaskDetail)
          : executionTarget;
        executionTarget = await deps.ensureGraphCustomNodeWorktree(acquisitionTask, settings, node.id, undefined, nodePrincipalAgentId);
      }
    }

    const isWorkspaceTask = Boolean(workspaceConfig?.repos.length);
    const workspaceTaskDir = isWorkspaceTask
      ? resolveWorkspaceTaskWorktreeDir(deps.rootDir, settings, executionTarget.id)
      : undefined;
    const legacyWorkspacePath = isWorkspaceTask && workspaceTaskDir
      && isLegacyWorkspaceWorktreeLayout(executionTarget, workspaceTaskDir)
      ? workspaceConfig!.repos
        .map((repoRelPath) => executionTarget.workspaceWorktrees?.[repoRelPath]?.worktreePath)
        .find((path): path is string => typeof path === "string" && path.length > 0)
      : undefined;
    const hasWorkspaceCheckout = Boolean(workspaceConfig?.repos.some((repoRelPath) => {
      const path = executionTarget.workspaceWorktrees?.[repoRelPath]?.worktreePath;
      return typeof path === "string" && existsSync(path);
    }));
    if (writeCapable && !executionTarget.worktree && !legacyWorkspacePath && !hasWorkspaceCheckout) {
      return { outcome: "failure", value: "no-worktree-for-write-node" };
    }

    /*
    FNXC:WorkspaceGateContext 2026-08-29-06:59:
    Every workspace graph node, including Plan Review and read-only reporting gates, runs from the
    task directory under a workspace-task-dir boundary. The configured repository list determines
    the child roots; a legacy layout remains on its recorded checkout until it completes.
    */
    /*
    FNXC:WorkspaceReadOnlyGate 2026-08-29-12:51:
    Read-only reporting gates must not fall through to a synthetic task-directory session when the
    confirmed workspace context is incomplete. FN-259 verification exposed the dormant guard:
    Documentation would claim success without any acquired repository to inspect. Plan Review keeps
    its separate pre-scope contract; this check applies only after a non-plan reporting gate needs
    the delivered repository set.
    */
    if (isWorkspaceTask && !writeCapable && !isPlanReviewNode) {
      const repositoryContext = resolveWorkspaceReadOnlyGateRepositoryContext({
        task: executionTarget,
        workspaceTaskDir: workspaceTaskDir!,
      });
      if (!repositoryContext.resolved) {
        await deps.store.logEntry(
          live.id,
          `Workflow node '${node.id}' did not run: workspace repository context is unresolved`,
          repositoryContext.output,
          deps.getRunContextFor(live.id),
        );
        return {
          outcome: "success",
          value: "repository-context-unresolved",
          contextPatch: {
            notRunReason: "repository-context-unresolved",
            output: repositoryContext.output,
          },
        };
      }
    }

    const singularCheckoutAvailable = Boolean(executionTarget.worktree && existsSync(executionTarget.worktree));
    const planLaneRootFallback = isPlanReviewNode && !singularCheckoutAvailable
      && !legacyWorkspacePath && !hasWorkspaceCheckout;
    const worktreePath = planLaneRootFallback
      ? deps.rootDir
      : isWorkspaceTask
        ? legacyWorkspacePath ?? workspaceTaskDir!
        : executionTarget.worktree ?? deps.rootDir;
    const nodeSessionBoundary: SessionBoundaryDescriptor | undefined = planLaneRootFallback
      ? {
          kind: "read-only-root",
          writableRoot: null,
          projectRoot: deps.rootDir,
          writableAllowlist: [join(deps.rootDir, ".fusion")],
        }
      : resolveGraphNodeSessionBoundary({
          isWorkspace: isWorkspaceTask,
          writeCapable,
          legacyWorkspaceLayout: Boolean(legacyWorkspacePath),
          rootDir: deps.rootDir,
          worktreePath,
          confirmedRepositories: workspaceConfig?.repos,
        });
    /*
    FNXC:WorktreeDependencies 2026-09-01-14:49:
    Fresh Plan Review owns no checkout, so dependency readiness is not determined here and the gate
    falls through after logging. Execution-time acquisition owns dependency initialization; this
    compatibility probe remains only for replans that already retain an execution checkout.
    */
    if (isPlanReviewNode) {
      const dependencyGate = await runPlanReviewDependencyGate({
        task: executionTarget,
        settings,
        workspaceConfig,
        worktreePath,
        store: deps.store,
        getRunContextFor: deps.getRunContextFor,
        runConfiguredCommand: deps.runConfiguredCommand,
      });
      if (dependencyGate) return dependencyGate;
    }
    if (isDeterministicVerificationGate) {
      return runDeterministicVerificationGate({ store: deps.store, getRunContextFor: deps.getRunContextFor }, node, executionTarget, settings, worktreePath);
    }
    let prompt = typeof cfg.prompt === "string" ? cfg.prompt : "";
    let modelProvider = typeof cfg.modelProvider === "string" && cfg.modelProvider.trim() ? cfg.modelProvider : undefined;
    let modelId = typeof cfg.modelId === "string" && cfg.modelId.trim() ? cfg.modelId : undefined;

    // ── Column-agent binding (plan U3, KTD-2/KTD-3) ──────────────────────────
    // Reuse the early `effective` result so worktree attribution and session
    // adoption cannot drift. Persona/model adoption still happens here, after
    // checkout mint.
    const columnAgentId = effective.source === "column-agent" ? effective.agentId : undefined;
    const columnAgentMode = columnBinding?.mode;

    if (columnAgentId) {
      // CLI executor with a raw command runs no session — the column agent
      // cannot contribute a model/persona to raw process execution, so it is a
      // no-op here. Log the skip so the audit trail explains why the column
      // agent did not apply (plan U3). Skill / model / script-via-session nodes
      // DO adopt the column agent below.
      if (executorKind === "cli" && rawCliCommand) {
        await deps.store.logEntry(
          live.id,
          `Workflow node '${node.id}': column agent '${columnAgentId}' (${columnAgentMode}) not applied — raw CLI execution runs no session`,
          undefined,
          deps.runContextFor(live.id),
        );
      } else {
        const adopted = await deps.adoptColumnAgentForNode(node, live, columnAgentId, columnAgentMode);
        if (adopted) {
          modelProvider = adopted.modelProvider ?? modelProvider;
          modelId = adopted.modelId ?? modelId;
          if (adopted.persona) prompt = `${adopted.persona}\n\n${prompt}`;
        }
        // Whether or not the agent resolved, the column agent SUPERSEDES the
        // node's own `executor: "agent"` adoption — skip that branch so we never
        // blend the column agent's model with the node agent's persona.
      }
    }

    // Executor kinds for prompt nodes:
    // - "model"  (default): run the prompt on the configured/override model.
    // - "agent": run as a named agent — adopt its model and persona prompt.
    // - "skill": invoke a named skill with the prompt as its input.
    // - "cli":   run a named project script with the prompt passed via env
    //            (FUSION_NODE_PROMPT). Named scripts only — raw commands are
    //            never accepted from node config.
    if (!columnAgentId && executorKind === "agent" && typeof cfg.agentId === "string" && cfg.agentId.trim()) {
      try {
        const agent = await deps.options.agentStore?.getAgent(cfg.agentId);
        if (agent) {
          const rc = (agent.runtimeConfig ?? {}) as { executorProvider?: string; executorModelId?: string };
          modelProvider = rc.executorProvider ?? modelProvider;
          modelId = rc.executorModelId ?? modelId;
          // KTD-6: read the TYPED persona fields (soul / instructionsText), not
          // the non-existent `customInstructions` (which was silently undefined,
          // so node-agent persona injection never actually fired). Same fields
          // the column-agent path uses — one consistent persona source.
          const persona = buildAgentPersona(agent);
          if (persona) prompt = `${persona}\n\n${prompt}`;
        } else {
          await deps.store.logEntry(live.id, `Workflow node '${node.id}': agent '${cfg.agentId}' not found — using default model`, undefined, deps.runContextFor(live.id));
        }
      } catch {
        // Agent lookup is best-effort; fall back to the default model.
      }
    } else if (executorKind === "skill" && typeof cfg.skillName === "string" && cfg.skillName.trim()) {
      // (U2) Prepend the Fusion workflow-step conventions preamble BEFORE the
      // "Invoke the skill" line. A skill node always runs as a workflow step here
      // (graph path → executeWorkflowStep), so the conventions always apply.
      prompt = `${FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE}Invoke the "${cfg.skillName}" skill with the following input, following the skill's instructions exactly:\n\n${prompt}`;
    } else if (executorKind === "cli") {
      const rawCommand = rawCliCommand;
      if (rawCommand) {
        // Arbitrary command: gated by trust-on-first-use approval unless the
        // node explicitly opts out. Two node flags bypass the pause:
        //   - cliSkipApproval: CLI-specific "skip first-run approval".
        //   - autoApprove:     the node's general "Auto-approve requests"
        //     toggle. The only human-approval pause reachable from a custom
        //     node is this CLI gate (review-style nodes run as ephemeral
        //     readonly agents with no permission gate), so honoring it here is
        //     what makes that toggle actually do something.
        // The exact command string must otherwise have been approved by the user.
        //
        // SECURITY: both flags are intentional project-owner-only escape hatches.
        // They are only reachable by someone who can author/edit a workflow
        // definition for this project through the trusted dashboard editor /
        // executor lane — the same trust boundary that already lets them add
        // named scripts. They are NOT enforced at the IR-validation layer.
        // Prompt-injectable surfaces strip these flags at the write boundary
        // before persisting: the import / AI-design routes (stripApprovalFlags
        // in register-workflow-routes.ts) and the chat/planning workflow
        // authoring tools (createWorkflowAuthoringTools(..., {stripApprovalFlags:
        // true}) in chat.ts / planning.ts) — all via stripApprovalBypassFlags in
        // @fusion/core. Only the executor lane keeps these flags intact.
        const skipApproval = cfg.cliSkipApproval === true || cfg.autoApprove === true;
        if (!skipApproval && !(await deps.store.isWorkflowCliCommandApproved(rawCommand))) {
          return deps.pauseForCliApproval(node, live, rawCommand);
        }
        // We are proceeding to execute. If this task was previously paused by
        // THIS node's CLI-approval gate, clear that status/pausedReason now —
        // otherwise the task keeps the "awaiting-cli-approval" status through
        // later graph nodes even though approval already happened (mirrors the
        // status reset in runAwaitInputNode).
        const approvalMarker = `workflow-cli-approval:${node.id}`;
        if ((live.pausedReason ?? "").startsWith(approvalMarker)) {
          await deps.store.updateTask(live.id, { status: null, pausedReason: null }, deps.runContextFor(live.id));
        }
        const env = prompt ? { ...process.env, FUSION_NODE_PROMPT: prompt } : undefined;
        const out = await deps.runRawCliCommand(
          live,
          typeof cfg.name === "string" && cfg.name.trim() ? cfg.name : node.id,
          rawCommand,
          worktreePath,
          env,
        );
        const blocking = node.kind === "gate" || cfg.gateMode === "gate";
        return { outcome: out.success || !blocking ? "success" : "failure", value: out.success ? "passed" : "failed" };
      }
      // No raw command: fall back to a named script (still required).
      if (!scriptName) {
        return { outcome: "failure", value: "cli-command-missing" };
      }
    }

    const mode: "prompt" | "script" = executorKind === "cli" || node.kind === "script" || (node.kind === "gate" && scriptName) ? "script" : "prompt";
    const now = new Date().toISOString();
    // (U1) Carry the node's skill name onto the synthesized step so the step
    // session can actually LOAD it (executeWorkflowStep merges it into the
    // resolved skillSelection). Without this, the named skill was only injected
    // as prompt text pointing at a skill the session never discovered.
    const stepSkillName = executorKind === "skill" && typeof cfg.skillName === "string" && cfg.skillName.trim()
      ? cfg.skillName.trim()
      : undefined;
    /*
     * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
     * Graph model nodes can pin reasoning effort independently from modelProvider/modelId; carry only validated THINKING_LEVELS into the synthesized WorkflowStep.
     */
    const stepThinkingLevel = typeof cfg.thinkingLevel === "string" && WORKFLOW_THINKING_LEVEL_SET.has(cfg.thinkingLevel)
      ? cfg.thinkingLevel as ThinkingLevel
      : undefined;
    const readonlyMcpServers = Array.isArray(cfg.readonlyMcpServers)
      ? [...new Set(cfg.readonlyMcpServers.filter((name): name is string => typeof name === "string").map((name) => name.trim()).filter(Boolean))]
      : [];
    const step: WorkflowStep = {
      id: `graph:${node.id}`,
      name: typeof cfg.name === "string" && cfg.name.trim() ? cfg.name : node.id,
      description: typeof cfg.description === "string" ? cfg.description : "",
      mode,
      phase: "pre-merge",
      gateMode: node.kind === "gate" || cfg.gateMode === "gate" ? "gate" : "advisory",
      prompt,
      toolMode: cfg.toolMode === "coding" ? "coding" : "readonly",
      scriptName,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      ...(stepSkillName ? { skillName: stepSkillName } : {}),
      ...(cfg.requiresBrowser === true ? { requiresBrowser: true } : {}),
      ...(modelProvider && modelId ? { modelProvider, modelId } : {}),
      ...(stepThinkingLevel ? { thinkingLevel: stepThinkingLevel } : {}),
      ...(readonlyMcpServers.length > 0 ? { readonlyMcpServers } : {}),
    };
    if (cfg.summaryTarget === "task") {
      (step as WorkflowStep & { summaryTarget?: "task" }).summaryTarget = "task";
    }
    if (cfg.requireExternalIntegrationEvidence === true) {
      (step as WorkflowStep & { requireExternalIntegrationEvidence?: boolean }).requireExternalIntegrationEvidence = true;
    }
    if (optionalGroupId) {
      (step as WorkflowStep & { optionalGroupId?: string }).optionalGroupId = optionalGroupId;
    }
    if (declaredReviewKind) {
      (step as WorkflowStep & { reviewKind?: "plan" | "code" }).reviewKind = declaredReviewKind;
    }
    if (cfg.reviewCanFixInline === true) {
      (step as WorkflowStep & { reviewCanFixInline?: boolean }).reviewCanFixInline = true;
    }

    // (U8a) Thread the plugin-injected runtime env (FUSION_CE_SKILLS_DIR /
    // FUSION_CE_AGENTS_DIR + PATH contribution) into prompt-mode skill/model
    // steps on the GRAPH path. The legacy single-session caller builds this in
    // agentWork; the graph path never did, so skill loading and persona fan-out
    // silently no-op'd here. CLI executor keeps its own FUSION_NODE_PROMPT env.
    let nodeEnv: NodeJS.ProcessEnv | undefined;
    if (executorKind === "cli" && prompt) {
      nodeEnv = { ...process.env, FUSION_NODE_PROMPT: prompt };
    } else if (mode === "prompt") {
      const injected = await deps.buildInjectedRuntimeEnv(live.id, worktreePath, executionTarget.branch ?? undefined);
      nodeEnv = injected.env;
      // FNXC:EngineDiagnostics 2026-08-03-05:54: per-node PATH/key injection is plumbing, not a lifecycle event.
      executorLog.debug(`${live.id}: graph node '${node.id}' runtime env injected (${injected.pathEntryCount} PATH entries, ${injected.injectedKeyCount} env keys)`);
    }

    // (U3) Genuinely-unattended signal. `unattended` is an explicit opt-in
    // threaded from the workflow-run options (default false = board run, where a
    // human can still answer asynchronously via the await-input card button).
    // No origin heuristic — absence always yields a board run. executeWorkflowStep
    // sets FUSION_HEADLESS=1 only when this is explicitly true.
    const unattended = deps.graphUnattendedRuns.has(live.id);

    /*
     * FNXC:WorkflowAgentRouting 2026-08-15-23:41:
     * FN-8764/FN-8821 routing selects a principal before graph execution. Wave-18
     * peel #3317 dropped the handoff to prompt sessions; FN-9108 restores it.
     * Non-string context is unrouted so untrusted graph values cannot become IDs.
     */
    const principalAgentId = typeof graphContext?.["workflow:principal-agent-id"] === "string"
      ? graphContext["workflow:principal-agent-id"]
      : undefined;
    let outcome: WorkflowStepOutcome;
    if (workspaceConfig && declaredReviewKind === "code") {
      /*
      FNXC:RepositoryScope 2026-08-21-00:44:
      Graph custom code-review nodes share the authoritative scoped fresh-diff aggregator with
      step-review. Acquisition is never review intent: clean peers are NOT_REVIEWED and only
      modified confirmed repositories can produce a blocking verdict.
      */
      /*
      FNXC:WorkspaceReviewTarget 2026-08-29-08:03:
      FN-255 requires every workspace Code Review fan-out decision to derive from the refreshed
      execution target. The initial graph snapshot can predate a repository-scope or checkout
      recovery; mixing it into callback paths could inspect a stale child worktree even though the
      later revision fence rejects persistence. Keep scope, worktree, boundary, and dispatch inputs
      on this one authoritative snapshot so a stale tree is never opened for review.
      */
      const workspaceReviewTarget = executionTarget;
      if (workspaceReviewTarget.repositoryScope?.state !== "confirmed") {
        outcome = { success: false, error: "Workspace Code Review requires confirmed repository scope", failureValue: "workspace-review-scope-unresolved" };
      } else {
        const workspaceTaskDir = resolveWorkspaceTaskWorktreeDir(deps.rootDir, settings, workspaceReviewTarget.id);
        const legacyWorkspaceLayout = isLegacyWorkspaceWorktreeLayout(workspaceReviewTarget, workspaceTaskDir);
        const scopedRepoRoots = workspaceReviewTarget.repositoryScope.repositories.map((repoRelPath) => ({
          repoRelPath,
          repoRootDir: join(deps.rootDir, repoRelPath),
        }));
        let aggregate = await reviewWorkspacePerRepo(workspaceReviewTarget, async (repoWorktreePath): Promise<ReviewResult> => {
          const repoRelPath = workspaceConfig.repos.find(
            (repository) => workspaceReviewTarget.workspaceWorktrees?.[repository]?.worktreePath === repoWorktreePath,
          );
          /*
          FNXC:WorkspaceBoundary 2026-08-22-22:49:
          FN-158 Code Review callbacks run from an individual child worktree, but new-layout
          sessions must retain the declared task-directory boundary. Path inference would either
          validate the non-Git task directory as a worktree or fail open for configured roots,
          and would omit task-session sandbox policy. Legacy tasks retain their child-worktree
          boundary so their persisted layout remains executable until completion.
          */
          const reviewBoundary = legacyWorkspaceLayout
            ? {
                kind: "task-worktree" as const,
                writableRoot: repoWorktreePath,
                projectRoot: repoRelPath ? join(deps.rootDir, repoRelPath) : deps.rootDir,
              }
            : {
                kind: "workspace-task-dir" as const,
                writableRoot: workspaceTaskDir,
                projectRoot: deps.rootDir,
                repoRoots: scopedRepoRoots,
              };
          const repoEnv = mode === "prompt"
            ? (await deps.buildInjectedRuntimeEnv(workspaceReviewTarget.id, repoWorktreePath, undefined)).env
            : nodeEnv;
          /*
          FNXC:WorkspaceReviewScope 2026-08-26-09:12:
          Hand the reviewer the base of the repository it is actually reading. The singular
          `task.baseCommitSha` does not resolve inside a sub-repository worktree, so the scope capture
          returned nothing and the prompt told the reviewer there were no modified files — after the
          executor had COMMITTED in that repository. Measured on a real card: the reviewer reported
          the delivered fixtures as never delivered. The per-repo base was already recorded and
          already used by this file's own evidence capture; it simply never reached the reviewer.
          */
          const repoDiffBaseCommitSha = repoRelPath
            ? workspaceReviewTarget.workspaceWorktrees?.[repoRelPath]?.baseCommitSha ?? undefined
            : undefined;
          /*
          FNXC:WorkspaceReviewDispatch 2026-08-29-06:46:
          Code Review legitimately opens one session per child worktree. The second marker is not
          duplicate work; it is a second inspection of a different repository, so preserve both
          dispatches and label each one with the repository rather than suppressing either line.
          */
          const repoOutcome = mode === "script"
            ? await deps.executeScriptWorkflowStep(workspaceReviewTarget, step, repoWorktreePath, settings, repoEnv)
            : await deps.executeWorkflowStep(workspaceReviewTarget, step, repoWorktreePath, settings, repoEnv, {
              unattended,
              principalAgentId,
              outputLanguage,
              sessionBoundary: reviewBoundary,
              ...(repoRelPath ? { dispatchLabel: repoRelPath } : {}),
              ...(repoDiffBaseCommitSha ? { diffBaseCommitSha: repoDiffBaseCommitSha } : {}),
            });
          return toWorkspaceRepoReviewResult(repoOutcome);
        }, { workspaceRepos: workspaceConfig.repos, workspaceRootDir: deps.rootDir, settings });
        /*
        FNXC:WorkspaceReviewEvidence 2026-08-29-12:17:
        FN-259 removes this graph branch's duplicate repositoryScope patch. Both workspace review
        routes use the one fenced TaskStore writer, so a failed durable publication becomes
        UNAVAILABLE rather than a graph-persisted APPROVE that landing cannot prove.
        */
        const workspaceApprovalPublication = await persistWorkspaceCodeReviewApproval(
          deps.store,
          workspaceReviewTarget.id,
          aggregate,
        );
        let reviewSuperseded = workspaceApprovalPublication.superseded;
        if (aggregate.repositoryScopeRevision !== undefined) {
          /* FNXC:RepositoryScope 2026-08-21-02:48: Fence the return handed to graph-result persistence as well as the evidence write. */
          const afterEvidence = await deps.store.getTask(workspaceReviewTarget.id);
          if (afterEvidence.repositoryScope?.revision !== aggregate.repositoryScopeRevision) reviewSuperseded = true;
        }
        if (reviewSuperseded) {
          aggregate = {
            verdict: "UNAVAILABLE",
            retryable: false,
            review: "Workspace Code Review result superseded by a repository scope change.",
            summary: "Unavailable: repository scope changed during review",
            repositoryReviewOutcomes: aggregate.repositoryReviewOutcomes,
            repositoryScopeRevision: aggregate.repositoryScopeRevision,
          };
        } else if (workspaceApprovalPublication.expected && !workspaceApprovalPublication.published) {
          const repositories = Object.keys(aggregate.repositoryDiffFingerprints ?? {}).sort();
          const reason = workspaceApprovalPublication.reason ?? "not-published";
          await deps.store.logEntry(
            workspaceReviewTarget.id,
            `Workspace Code Review approval unavailable for ${workspaceReviewTarget.id}: ${repositories.join(", ")}`,
            `Durable workspace review evidence was not published: ${reason}`,
            deps.getRunContextFor(workspaceReviewTarget.id),
          );
          aggregate = {
            verdict: "UNAVAILABLE",
            retryable: true,
            review: `Workspace Code Review approval could not be persisted for ${repositories.join(", ")}: ${reason}.`,
            summary: `Unavailable: workspace review approval could not be persisted (${reason})`,
            repositoryReviewOutcomes: aggregate.repositoryReviewOutcomes,
            repositoryScopeRevision: aggregate.repositoryScopeRevision,
          };
        } else if (workspaceApprovalPublication.emptyApprovalFingerprints) {
          aggregate = {
            verdict: "UNAVAILABLE",
            retryable: false,
            review: "Workspace Code Review returned approval without repository diff fingerprints.",
            summary: "Unavailable: no workspace review fingerprints were published",
            repositoryReviewOutcomes: aggregate.repositoryReviewOutcomes,
            repositoryScopeRevision: aggregate.repositoryScopeRevision,
          };
        }
        outcome = buildWorkspaceReviewOutcome(aggregate, { superseded: reviewSuperseded });
      }
    } else {
      const dispatchSingularStep = async (reviewInputFingerprint?: string): Promise<WorkflowStepOutcome> => {
        if (mode === "script") {
          const scriptOutcome = await deps.executeScriptWorkflowStep(live, step, worktreePath, settings, nodeEnv);
          return reviewInputFingerprint === undefined
            ? scriptOutcome
            : { ...scriptOutcome, reviewInputFingerprint };
        }
        return deps.executeWorkflowStep(live, step, worktreePath, settings, nodeEnv, {
          unattended,
          principalAgentId,
          outputLanguage,
          ...(nodeSessionBoundary ? { sessionBoundary: nodeSessionBoundary } : {}),
          ...(reviewInputFingerprint !== undefined ? { reviewInputFingerprint } : {}),
        });
      };
      /*
      FNXC:ReviewInputProof 2026-09-01-11:18:
      A singular content-binding review cannot be dispatched unless its exact input proof exists.
      Use the merge gate's identity-or-kind predicate so an id-only `code-review` cannot escape the
      guard, and mirror the workspace lane's existing refusal instead of spending a reviewer session
      on an approval that persistence and merge admission must discard.
      */
      if (isContentBindingStep && !workspaceConfig) {
        const proof = await resolveContentReviewInputProof(worktreePath, executionTarget.baseCommitSha);
        if (proof.kind === "unprovable") {
          const diagnostic = `${step.name} review input is unprovable (${proof.reason}); reviewer dispatch refused.`;
          await deps.store.logEntry(
            live.id,
            `[pre-merge] ${diagnostic}`,
            undefined,
            deps.getRunContextFor(live.id),
          );
          outcome = { success: false, error: diagnostic, failureValue: "review-input-unprovable" };
        } else {
          outcome = await dispatchSingularStep(proof.fingerprint);
        }
      } else {
        outcome = await dispatchSingularStep();
      }
    }
    /*
     * FNXC:WorkflowReviewFindings 2026-08-05-06:29:
     * Script nodes retain their exit-code verdict semantics, but an explicitly classified review
     * script may attach the same trailing JSON findings as prompt nodes. Unmarked scripts never
     * gain review metadata merely because their output happens to contain a findings key.
     */
    if (declaredReviewKind && typeof outcome.output === "string") {
      const rawReviewOutput = outcome.output;
      outcome = preserveOutcomeFindingsFromReviewOutput(outcome);
      const parsedReviewOutput = parseWorkflowStepOutput(rawReviewOutput, { requireVerdict: false });
      if (parsedReviewOutput.supersededFindingIds?.length && parsedReviewOutput.supersededFindingSourceWorkflowStepId && !outcome.supersededFindingIds?.length) {
        outcome = { ...outcome, supersededFindingSourceWorkflowStepId: parsedReviewOutput.supersededFindingSourceWorkflowStepId, supersededFindingIds: parsedReviewOutput.supersededFindingIds };
      }
    }

    // Skill-emitted await-input (U6): if the skill asked the user a blocking
    // question via the ===FUSION_AWAIT_INPUT=== sentinel, park the task
    // awaiting-user-input with the question (dashboard / task card surfaces it)
    // and halt the walk. On resume this node re-runs and the resume check above
    // consumes the user's steering reply.
    const awaitQuestion = parseAwaitInputSentinel((outcome as { output?: string }).output);
    if (awaitQuestion) {
      await deps.store.logEntry(
        live.id,
        `Workflow step '${node.id}' is waiting for your input: ${awaitQuestion}`,
        undefined,
        deps.runContextFor(live.id),
      );
      await deps.store.updateTask(
        live.id,
        { status: "awaiting-user-input", paused: true, pausedReason: `${skillAwaitMarker}@${Date.now()}: ${awaitQuestion}` },
        deps.runContextFor(live.id),
      );
      return { outcome: "failure", value: "awaiting-user-input" };
    }

    const blocking = step.gateMode === "gate";
    // Script-mode outcomes carry no structured verdict; prompt-mode may.
    const verdict = (outcome as { verdict?: string }).verdict;
    // FNXC:WorkflowSteps 2026-06-26-00:00: Surface the step agent's output text
    // and parsed verdict notes on the node result's contextPatch so the
    // optional-group exit record carries them through to the recorded
    // WorkflowStepResult (workflow-graph-loop exitStepRecord →
    // workflow-graph-executor recordOptionalGroupStepResult). Without this the
    // Workflow tab only shows a generic fallback and `[pre-merge]` revision logs
    // pass `undefined` detail. `notes` is only attached when the parsed verdict
    // produced notes; `output` carries the raw step output when present.
    const stepOutput = (outcome as { output?: string }).output;
    const stepNotes = (outcome as { notes?: string }).notes;
    const contextPatch: Record<string, unknown> = {};
    if (typeof stepOutput === "string") contextPatch.output = stepOutput;
    if (typeof outcome.notRunReason === "string" && WORKFLOW_STEP_NOT_RUN_REASON_SET.has(outcome.notRunReason)) {
      contextPatch.notRunReason = outcome.notRunReason;
    }
    if (typeof stepNotes === "string" && stepNotes) contextPatch.notes = stepNotes;
    const stepFindings = outcome.findings;
    if (stepFindings?.length) contextPatch.findings = stepFindings;
    const repositoryReviewOutcomes = outcome.repositoryReviewOutcomes;
    if (repositoryReviewOutcomes?.length) contextPatch.repositoryReviewOutcomes = repositoryReviewOutcomes;
    if (outcome.repositoryScopeRevision !== undefined) contextPatch.repositoryScopeRevision = outcome.repositoryScopeRevision;
    if (outcome.reviewInputFingerprint !== undefined) contextPatch.reviewInputFingerprint = outcome.reviewInputFingerprint;
    if (outcome.reviewedCommitSha !== undefined) contextPatch.reviewedCommitSha = outcome.reviewedCommitSha;
    if (outcome.verdictRequired) contextPatch.verdictRequired = true;
    if (outcome.supersededFindingIds?.length && outcome.supersededFindingSourceWorkflowStepId) {
      contextPatch.supersededFindingSourceWorkflowStepId = outcome.supersededFindingSourceWorkflowStepId;
      contextPatch.supersededFindingIds = outcome.supersededFindingIds;
    }
    /*
    FNXC:ReviewLaneRecommendations 2026-08-26-07:34:
    A node declaring `recommendationsTarget: "task"` proposes follow-up work through its OUTPUT, not
    through a tool. It has none: a readonly workflow-step session is limited to read/grep/find/ls plus
    a few read-only task reads, and `fn_task_create` is explicitly denied there. Projection is the
    only durable channel such a node has, and proposing is the only thing it may do — an operator
    turns a proposal into a task from the Recommendations tab.
    The JSON block is REMOVED from the text before the summary projection reads it, so a card summary
    never shows the machine payload that produced it.
    */
    let projectedText = typeof stepOutput === "string" ? stepOutput : "";
    if (cfg.recommendationsTarget === "task" && projectedText.trim()) {
      const proposed = parseWorkflowStepRecommendations(projectedText, {
        max: resolveMaxRecommendationsPerTask(settings),
      });
      if (proposed.recommendations.length > 0) contextPatch.recommendations = proposed.recommendations;
      projectedText = proposed.remainingText;
    }
    if (cfg.summaryTarget === "task" && projectedText.trim()) {
      /*
       * FNXC:WorkflowCompletion 2026-06-29-11:09:
       * Built-in completion-summary nodes are agent/model workflow steps. Persist
       * their generated text through the graph projection path so summaries are
       * authored during workflow execution, before review/merge, and not only
       * synthesized later by recovery fallback code.
       */
      contextPatch.summary = projectedText.trim();
    }
    /*
     * FNXC:PlanReview 2026-06-29-02:05:
     * Advisory graph steps still need a distinct non-pass value when their
     * review output is malformed. Returning plain `failed` made optional-group
     * recovery synthesize a Plan Review REVISE even when no reviewer requested
     * one; `advisory_failure` preserves visibility without inventing feedback.
     */
    const malformed = (outcome as { malformed?: boolean }).malformed === true;
    const advisoryFailureValue = malformed ? "advisory_failure" : "failed";
    /*
    FNXC:ReviewLeniency 2026-07-02-00:30 (SUPERSEDED for blocking gates — see below):
    Malformed review output (no parseable verdict, even after the fallback-model retry in executeWorkflowStep) was treated as a NON-BLOCKING advisory rather than a hard gate failure. Operators asked that an unparseable reviewer response not block a task in review — a genuine REVISE (parsed verdict) still blocks, and the advisory_failure value keeps the malformed result visible on the Workflow tab.

    FNXC:ReviewVerdictAuthority 2026-09-02-19:25:
    A verdict-less review can never authorize approval. The shared core requirement makes every
    merge-consulted prompt request JSON; both parsers allow prose only to downgrade; this bridge
    forwards `verdictRequired` and refuses workspace success-to-APPROVE synthesis; graph persistence
    records a missing required verdict as failed; and merge admission independently rejects legacy
    review-kind or marked rows without an authored approval verdict.

    The measured failure was a reviewer reporting absent deliverables in prose with no rejection
    keyword and no JSON, followed by an advisory success record and merge. Keep the original text
    visible, but never infer a verdict or rationale from it. Deterministic scripts remain governed by
    exit status because they never carry `verdictRequired`.
    */
    return {
      /*
      FNXC:RepositoryScope 2026-08-21-03:05:
      An advisory review may tolerate malformed reviewer text, but a scope-superseded
      UNAVAILABLE result is never a pass. Returning success here would persist it as passed
      and admit an obsolete Code Review edge.
      */
      outcome: outcome.success || (!blocking && verdict !== "UNAVAILABLE") ? "success" : "failure",
      value: (outcome as WorkflowStepOutcome).failureValue ?? verdict ?? (outcome.success ? "passed" : advisoryFailureValue),
      ...(Object.keys(contextPatch).length > 0 ? { contextPatch } : {}),
    };
}
