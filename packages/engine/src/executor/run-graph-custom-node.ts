/**
 * FNXC:CodeOrganization 2026-08-03-14:40:
 * runGraphCustomNode peeled from TaskExecutor (U4).
 *
 * Executes a single graph custom/skill/script/CLI/await-input node with column-agent
 * adoption, worktree ensure, and unattended env wiring.
 */
import { existsSync } from "node:fs";
import type {
  AgentStore,
  Settings,
  TaskDetail,
  TaskStore,
  ThinkingLevel,
  WorkflowColumnAgent,
  WorkflowIrNode,
  WorkflowStep,
  WorkspaceConfig,
} from "@fusion/core";
import { resolveEffectiveAgent, THINKING_LEVELS } from "@fusion/core";
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
import { buildAgentPersona } from "./agent-binding-pure.js";

const WORKFLOW_THINKING_LEVEL_SET: ReadonlySet<string> = new Set(THINKING_LEVELS);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

export type RunGraphCustomNodeDeps = {
  store: TaskStore;
  rootDir: string;
  workspaceConfig: WorkspaceConfig | null | undefined;
  options: { pluginRunner?: unknown; agentStore?: AgentStore | null; [k: string]: unknown };
  graphUnattendedRuns: Set<string>;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
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
};

export async function runGraphCustomNode(
  deps: RunGraphCustomNodeDeps,
  node: WorkflowIrNode,
  nodeTask: TaskDetail,
  settings: Settings,
  columnBinding?: WorkflowColumnAgent,
  graphContext?: Record<string, unknown>,
): Promise<WorkflowNodeResult> {
    const cfg = node.config ?? {};
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
        await deps.store.updateTask(live.id, { status: "awaiting-user-input", paused: true }, deps.getRunContextFor(live.id));
        return { outcome: "failure", value: "awaiting-user-input" };
      }
      await deps.store.updateTask(live.id, { status: null, pausedReason: null }, deps.getRunContextFor(live.id));
      await deps.store.logEntry(live.id, `Workflow input received for step '${node.id}' — resuming`, undefined, deps.getRunContextFor(live.id));
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
    /*
    FNXC:FastOptionalSteps 2026-06-30-09:14:
    Fast skips top-level custom prompt/script/gate review bodies by default, but an enabled optional-group template is explicit operator intent. The graph marks those template nodes so Browser Verification and custom optional groups still run under fast mode.
    */
    const isCompletionSummaryNode = cfg.summaryTarget === "task" || node.id === "completion-summary";
    /*
    FNXC:WorkflowCompletion 2026-07-01-18:42:
    Fast mode skips review/validation work, not the agent-authored completion summary. FN-7335 reached review with "Fast mode — custom graph node 'completion-summary' skipped"; keep summary nodes executable so fast tasks still produce the same review/done card summary as standard tasks.
    */
    if (live.executionMode === "fast" && !isCompletionSummaryNode && !optionalGroupId && !cfg.seam && (node.kind === "prompt" || node.kind === "script" || node.kind === "gate")) {
      executorLog.debug(`${live.id}: fast mode — skipping custom graph node '${node.id}'`);
      await deps.store.logEntry(
        live.id,
        `Fast mode — custom graph node '${node.id}' skipped`,
        undefined,
        deps.getRunContextFor(live.id),
      );
      return { outcome: "success", value: "workflow-step-skipped" };
    }

    const scriptName = typeof cfg.scriptName === "string" && cfg.scriptName.trim() ? cfg.scriptName : undefined;
    const rawCliCommand = executorKind === "cli" && typeof cfg.cliCommand === "string" && cfg.cliCommand.trim()
      ? cfg.cliCommand.trim()
      : undefined;
    // Isolation guard: write-capable nodes must run inside a task worktree, not
    // the shared repo root. Before the execute seam runs, live.worktree is unset
    // — a coding/script/CLI node falling back to deps.rootDir would mutate the
    // main checkout and cross-contaminate other tasks. Reject such nodes until a
    // worktree exists. Read-only nodes (default toolMode) are safe against root.
    /*
    FNXC:WorkflowReviewers 2026-07-15-00:00:
    Inline-fix Code Review, Browser Verification, and custom review nodes become
    write-capable even when their workflow definition says `toolMode: readonly`.
    Use the shared classifier consumed by graph preparation so issue #2075 cannot
    leave runtime requiring a worktree that preparation declined to acquire.
    Plan Review remains excluded because it uses the narrow PROMPT.md writer.
    */
    const writeCapable = workflowNodeRequiresWorktree(node, {
      optionalGroupId,
      reviewerInlineFixes: (settings as Settings & { reviewerInlineFixes?: boolean }).reviewerInlineFixes,
    });
    let executionTarget = writeCapable ? await deps.store.getTask(live.id) : live;

    /*
    FNXC:NodeWorktreeIsolation 2026-07-25-22:10 (EVERY node runs in the task's own worktree):
    Operator requirement: Plan Review, Code Review — everything except merge — executes in the
    task-specific worktree, never in the shared main checkout. Read-only gates used to fall back to
    `deps.rootDir` because a pre-execution task has no worktree yet, which is what made two tasks
    share a path in the first place (the reported FN-1398/FN-1403 Plan Review collision) and what let
    a reviewer read a main checkout that other tasks and the operator mutate underneath it.
    ACQUIRE the worktree at planning time instead: `ensureGraphCustomNodeWorktree` is the same
    acquisition the write-capable nodes already use, so the worktree/branch/baseCommitSha the
    implementation session later resumes into is created once, here, and reused.
    A recorded-but-missing worktree is RE-ACQUIRED (strip the stale metadata first, mirroring
    prepareGraphNodeExecution) rather than degraded to the root — this replaces FN-7996's
    run-Plan-Review-from-the-repo-root fallback, which is exactly the shared-path behavior being
    removed. Workspace projects are unchanged: `ensureGraphCustomNodeWorktree` returns the task
    untouched there, because workspace sessions are rooted at the browse-root by design and per-repo
    isolation comes from the sub-repo acquire lease.
    */
    const nodeDisplayName = typeof cfg.name === "string" && cfg.name.trim() ? cfg.name.trim() : node.id;
    const isPlanReviewNode = node.id === "plan-review-step" || nodeDisplayName === "Plan Review" || optionalGroupId === "plan-review";
    if (!deps.workspaceConfig) {
      const recordedWorktreeMissing = Boolean(executionTarget.worktree) && !existsSync(executionTarget.worktree!);
      /*
      A node with NO recorded worktree is pre-execution (planning / Plan Review): acquire one.
      A node whose RECORDED worktree vanished is a different situation — for gates that review
      implementation output, the work is gone with it, and handing them a fresh empty worktree would
      let them review the wrong tree and pass. Those keep failing fast into the unusable-worktree
      recovery (FN-7996). Plan Review is the exception: it reviews the store-injected PROMPT.md, so it
      re-acquires rather than parking — this replaces its old "run from the repo root" degrade.
      */
      const shouldAcquire = !executionTarget.worktree || (recordedWorktreeMissing && isPlanReviewNode);
      if (shouldAcquire) {
        if (recordedWorktreeMissing) {
          await deps.store.logEntry(
            live.id,
            `Plan Review worktree ${executionTarget.worktree} is missing on disk — re-acquiring a task worktree instead of running in the shared checkout`,
            undefined,
            deps.getRunContextFor(live.id),
          );
        }
        const acquisitionTask = recordedWorktreeMissing
          ? ({ ...executionTarget, worktree: undefined, sessionFile: undefined } as TaskDetail)
          : executionTarget;
        executionTarget = await deps.ensureGraphCustomNodeWorktree(acquisitionTask, settings, node.id);
      }
    }

    if (writeCapable && !executionTarget.worktree && !deps.workspaceConfig) {
      return { outcome: "failure", value: "no-worktree-for-write-node" };
    }

    const worktreePath = executionTarget.worktree || deps.rootDir;
    let prompt = typeof cfg.prompt === "string" ? cfg.prompt : "";
    let modelProvider = typeof cfg.modelProvider === "string" && cfg.modelProvider.trim() ? cfg.modelProvider : undefined;
    let modelId = typeof cfg.modelId === "string" && cfg.modelId.trim() ? cfg.modelId : undefined;

    // ── Column-agent binding (plan U3, KTD-2/KTD-3) ──────────────────────────
    // When the node's declared column names an agent, the CORE resolver decides
    // whether the column agent supersedes (override) or defers to the node's own
    // settings — we never reimplement precedence. The node's own `cfg.agentId`
    // and complete model pair feed the resolver as "own settings" (KTD-5).
    const ownModelComplete = Boolean(modelProvider && modelId);
    const effective = resolveEffectiveAgent({
      binding: columnBinding,
      ownAgentId: typeof cfg.agentId === "string" && cfg.agentId.trim() ? cfg.agentId.trim() : undefined,
      ownModelProvider: ownModelComplete ? modelProvider : undefined,
      ownModelId: ownModelComplete ? modelId : undefined,
    });
    // The effective executor identity: a column agent supersedes the node's own
    // `executor: "agent"` adoption wholesale (identity + model + persona). When
    // the resolver yields the column agent, we run the column-agent adoption
    // path below INSTEAD of the node's own agent branch.
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
          deps.getRunContextFor(live.id),
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
          await deps.store.logEntry(live.id, `Workflow node '${node.id}': agent '${cfg.agentId}' not found — using default model`, undefined, deps.getRunContextFor(live.id));
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
          await deps.store.updateTask(live.id, { status: null, pausedReason: null }, deps.getRunContextFor(live.id));
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

    let outcome: WorkflowStepOutcome = mode === "script"
      ? await deps.executeScriptWorkflowStep(live, step, worktreePath, settings, nodeEnv)
      : await deps.executeWorkflowStep(live, step, worktreePath, settings, nodeEnv, { unattended });
    /*
     * FNXC:WorkflowReviewFindings 2026-08-05-06:29:
     * Script nodes retain their exit-code verdict semantics, but an explicitly classified review
     * script may attach the same trailing JSON findings as prompt nodes. Unmarked scripts never
     * gain review metadata merely because their output happens to contain a findings key.
     */
    if (declaredReviewKind && typeof outcome.output === "string") {
      const parsedReviewOutput = parseWorkflowStepOutput(outcome.output, { requireVerdict: false });
      if (parsedReviewOutput.findings?.length) outcome = { ...outcome, findings: parsedReviewOutput.findings };
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
        deps.getRunContextFor(live.id),
      );
      await deps.store.updateTask(
        live.id,
        { status: "awaiting-user-input", paused: true, pausedReason: `${skillAwaitMarker}@${Date.now()}: ${awaitQuestion}` },
        deps.getRunContextFor(live.id),
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
    if (typeof stepNotes === "string" && stepNotes) contextPatch.notes = stepNotes;
    const stepFindings = outcome.findings;
    if (stepFindings?.length) contextPatch.findings = stepFindings;
    if (outcome.supersededFindingIds?.length && outcome.supersededFindingSourceWorkflowStepId) {
      contextPatch.supersededFindingSourceWorkflowStepId = outcome.supersededFindingSourceWorkflowStepId;
      contextPatch.supersededFindingIds = outcome.supersededFindingIds;
    }
    if (cfg.summaryTarget === "task" && typeof stepOutput === "string" && stepOutput.trim()) {
      /*
       * FNXC:WorkflowCompletion 2026-06-29-11:09:
       * Built-in completion-summary nodes are agent/model workflow steps. Persist
       * their generated text through the graph projection path so summaries are
       * authored during workflow execution, before review/merge, and not only
       * synthesized later by recovery fallback code.
       */
      contextPatch.summary = stepOutput.trim();
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
    FNXC:ReviewLeniency 2026-07-02-00:30:
    Malformed review output (no parseable verdict, even after the fallback-model retry in executeWorkflowStep) is treated as a NON-BLOCKING advisory rather than a hard gate failure. Operators asked that an unparseable reviewer response not block a task in review — a genuine REVISE (parsed verdict) still blocks, and the advisory_failure value keeps the malformed result visible on the Workflow tab. Only `malformed` relaxes a gate; every parsed non-pass verdict continues to block exactly as before.
    */
    return {
      outcome: outcome.success || !blocking || malformed ? "success" : "failure",
      value: (outcome as WorkflowStepOutcome).failureValue ?? verdict ?? (outcome.success ? "passed" : advisoryFailureValue),
      ...(Object.keys(contextPatch).length > 0 ? { contextPatch } : {}),
    };
}
