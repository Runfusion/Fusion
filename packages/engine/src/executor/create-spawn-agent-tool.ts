/**
 * FNXC:CodeOrganization 2026-08-03-12:35:
 * createSpawnAgentTool peeled from TaskExecutor (U4).
 *
 * FNXC:CapacityModel 2026-07-29-14:10:
 * fn_spawn_agent gates on project agent count (and worktree budget), not private spawn caps.
 *
 * FNXC:CapacityModel 2026-07-29-19:20:
 * Reserve the spawn slot synchronously before the first await (TOCTOU).
 *
 * FNXC:CapacityModel 2026-08-01-02:40:
 * Also gate live children against maxWorktrees at acquisition.
 *
 * FNXC:WorkflowResolvedColumns 2026-08-01-03:05:
 * Terminal worktree holders are role-resolved, not done/archived literals.
 */
import { Type, type Static } from "@earendil-works/pi-ai";
import type {
  AgentCapability,
  AgentState,
  AgentStore,
  Settings,
  TaskStore,
} from "@fusion/core";
import { resolveEffectiveConcurrency, resolveExecutorFallbackModel, resolveProjectColumnsForRoles } from "@fusion/core";
import type { ToolDefinition, AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createResolvedAgentSession,
  extractRuntimeHint,
  resolveExecutorSessionModel,
  resolveExecutorFallbackThinkingLevel,
} from "../agents/agent-session-helpers.js";
import { buildSessionSkillContext } from "../cli-runtime/session-skill-context.js";
import { computeTopLevelConcurrencyClaimedFromStore } from "../concurrency/concurrency.js";
import { buildSystemPromptWithInstructions } from "../agents/agent-instructions.js";
import { resolveTaskWorktreePath } from "../worktree/worktree-paths.js";
import { createRunAuditor, type EngineRunContext } from "../util/run-audit.js";
import { executorLog } from "../logger.js";
import type { PluginRunner } from "../plugins/plugin-runner.js";

export const spawnAgentParams = Type.Object({
  name: Type.String({ description: "Name for the child agent" }),
  role: Type.Union([
    Type.Literal("triage"),
    Type.Literal("executor"),
    Type.Literal("reviewer"),
    Type.Literal("merger"),
    Type.Literal("engineer"),
    Type.Literal("custom"),
  ], { description: "Role for the child agent" }),
  task: Type.String({ description: "Task description for the child agent to execute" }),
  systemPromptOverride: Type.Optional(
    Type.String({
      description:
        "Optional persona/system-prompt for the child agent. When provided (non-empty), it replaces the generic child base prompt so the child runs as a specific persona (e.g. a compound-engineering reviewer). Executor instructions are still appended.",
    }),
  ),
});

/** Result returned from fn_spawn_agent tool */
export interface SpawnAgentResult {
  agentId: string;
  name: string;
  state: AgentState;
  role: AgentCapability;
  message: string;
}

export type CreateSpawnAgentToolDeps = {
  store: TaskStore;
  rootDir: string;
  agentStore?: AgentStore | null;
  pluginRunner?: PluginRunner;
  /** Live spawn counter owned by TaskExecutor (check-and-reserve TOCTOU). */
  getTotalSpawnedCount: () => number;
  setTotalSpawnedCount: (n: number) => void;
  childSessions: Map<string, AgentSession>;
  spawnedAgents: Map<string, Set<string>>;
  createWorktree: (
    branch: string,
    path: string,
    taskId: string,
    startPoint?: string,
  ) => Promise<{ path: string; branch: string }>;
  resolveInstructionsForRole: (role: string, settings: Settings) => Promise<string>;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MCP server map shape is owned by session helpers
  resolveMcpServers: (agentId: string) => Promise<any>;
  runSpawnedChild: (agentId: string, session: AgentSession, taskPrompt: string) => Promise<void>;
};

/**
 * Create the fn_spawn_agent tool definition.
 * Allows the parent agent to spawn child agents with delegated tasks.
 */
export function createSpawnAgentTool(
  deps: CreateSpawnAgentToolDeps,
  taskId: string,
  worktreePath: string,
  settings: Settings,
  taskEnv?: NodeJS.ProcessEnv,
): ToolDefinition {
    return {
      name: "fn_spawn_agent",
      label: "Spawn Agent",
      description:
        "Spawn a child agent to handle parallel work or specialized sub-tasks. " +
        "Each child runs in its own git worktree (branched from your worktree) and executes autonomously. " +
        "When you end (fn_task_done), all spawned children are terminated.",
      parameters: spawnAgentParams,
      execute: async (_id: string, params: Static<typeof spawnAgentParams>) => {
        const { name, role, task: taskPrompt, systemPromptOverride } = params;

        // Check if AgentStore is available
        if (!deps.agentStore) {
          return {
            content: [{ type: "text" as const, text: "Agent spawning is not available (no AgentStore configured)" }],
            details: { agentId: "", state: "error" },
          };
        }

        /*
        FNXC:CapacityModel 2026-07-29-14:10 (two numbers — spawned agents count):
        `maxSpawnedAgentsPerParent` (5) and `maxSpawnedAgentsGlobal` (20) are DELETED.
        They were a THIRD and FOURTH limiter with their own private budgets, invisible
        to the two the operator configures — and they measured the wrong thing: a
        child that finished still counted against `totalSpawnedCount` until its parent
        task ended, so the cap throttled cumulative spawns rather than concurrent ones.

        A spawned child IS an agent and runs in its own git worktree (branched from the
        parent's), so it consumes both configured dimensions. It now checks the SAME
        project agent count every other lane checks, via the shared live-claim helper —
        one number, one answer, no private budget that can disagree with the board.

        This closes a real hole rather than only deleting knobs: children were counted
        by NEITHER capacity gate, so a fan-out could put up to 20 extra worktrees on
        disk while the scheduler believed the project was at its limit.
        */
        const spawnClaimed = await computeTopLevelConcurrencyClaimedFromStore({
          store: deps.store,
          tasks: await deps.store.listTasks({ slim: true, includeArchived: false }),
        });
        const spawnCap = resolveEffectiveConcurrency(settings).maxConcurrent;
        const liveChildren = deps.getTotalSpawnedCount();
        if (spawnClaimed + liveChildren >= spawnCap) {
          return {
            content: [{
              type: "text" as const,
              text: `Agent capacity reached (${spawnClaimed + liveChildren}/${spawnCap} running, including ${liveChildren} spawned child agent(s)). Wait for work to finish, or raise Max Concurrent Tasks.`,
            }],
            details: { agentId: "", state: "error" },
          };
        }

        /*
        FNXC:CapacityModel 2026-07-29-19:20 (PR #2579 review — greptile P1, TOCTOU):
        RESERVE THE SLOT SYNCHRONOUSLY, before the first await.

        The check above reads capacity, then several awaits follow (createAgent,
        createWorktree, updateAgentState) before `totalSpawnedCount` was incremented.
        Two parents calling fn_spawn_agent with one slot left both passed the check
        and both spawned — more agents and more worktrees than Max Concurrent Tasks
        permits, which is the very hole this change set out to close.

        JS is single-threaded, so incrementing here — with NO await between the read
        and the increment — makes check-and-reserve atomic against every other spawn
        call. The reservation is rolled back on any failure below, and the success
        path no longer double-counts.
        */
        deps.setTotalSpawnedCount(deps.getTotalSpawnedCount() + 1);
        let spawnReservationHeld = true;
        const releaseSpawnReservation = () => {
          if (!spawnReservationHeld) return;
          spawnReservationHeld = false;
          deps.setTotalSpawnedCount(Math.max(0, deps.getTotalSpawnedCount() - 1));
        };

        /*
        FNXC:CapacityModel 2026-08-01-02:40 (same class as the planning-admission gap, 374956ef23):
        The FNXC above says a child "consumes both configured dimensions" — and then gated only ONE.
        A child's worktree is not a task row, so the task-ledger gates never see it; count live
        children against the worktree budget here at the acquisition source, like planning admission
        now does. Runs AFTER the synchronous agent-slot reservation (its own TOCTOU rule: the awaits
        in this check must not reopen the two-racing-spawns hole — the reservation is already held,
        and a worktree refusal unwinds it). Absent/null maxWorktrees (worktrees off) falls through
        to the agent gate alone, matching every other lane.
        */
        {
          const spawnMaxWorktrees = resolveEffectiveConcurrency(settings).worktreeLimit;
          if (spawnMaxWorktrees !== null) {
            const spawnTasks = await deps.store.listTasks({ slim: true, includeArchived: false });
            /*
            FNXC:WorkflowResolvedColumns 2026-08-01-03:05:
            TERMINAL IS A ROLE, NOT A NAME — same conversion as the planning-admission ledger this
            gate was copied from. Against the literals a RENAMED board matches neither `done` nor
            `archived`, so finished cards keep counting as live worktree holders, `heldWorktrees`
            only ever grows, and every spawn is refused on a board with free slots. A permanent
            refusal is worse than the over-spawn this gate exists to prevent, because it is silent.

            PROJECT-level (`resolveProjectColumnsForRoles`) because the ledger spans the whole
            board with no single task to resolve against; it is legacy-seeded, so a default board
            still excludes exactly `done` and `archived` and this is byte-identical there.
            */
            const spawnCompleteColumns = await resolveProjectColumnsForRoles(deps.store, ["complete"]);
            const spawnTerminalColumns = new Set(spawnCompleteColumns);
            const heldWorktrees = spawnTasks.filter((t) =>
              !spawnTerminalColumns.has(t.column)
              && typeof t.worktree === "string" && t.worktree.length > 0).length;
            // totalSpawnedCount already includes THIS reservation; heldWorktrees covers task lanes.
            if (heldWorktrees + deps.getTotalSpawnedCount() > spawnMaxWorktrees) {
              releaseSpawnReservation();
              return {
                content: [{
                  type: "text" as const,
                  text: `Worktree capacity reached (${heldWorktrees + deps.getTotalSpawnedCount() - 1}/${spawnMaxWorktrees} held, including spawned child agent(s)). Wait for work to finish, or raise Max Worktrees.`,
                }],
                details: { agentId: "", state: "error" },
              };
            }
          }
        }

        try {
          // Create agent in AgentStore with reportsTo = parent task ID
          const agent = await deps.agentStore.createAgent({
            name: name.trim(),
            role: role as AgentCapability,
            reportsTo: taskId,
            metadata: { type: "spawned", parentTaskId: taskId },
          });

          // Create git worktree for child (branched from parent's worktree)
          // FNXC:TaskWorktreeNames 2026-08-29-08:51: spawned agents use their
          // durable agent ID rather than a random directory name, so retries do
          // not allocate untraceable worktree paths.
          const childWorktreePath = resolveTaskWorktreePath(deps.rootDir, settings, agent.id.toLowerCase());
          const childBranch = `fusion/spawn-${agent.id}`;
          await deps.createWorktree(childBranch, childWorktreePath, taskId, worktreePath);

          // Transition agent to active state
          await deps.agentStore.updateAgentState(agent.id, "active");

          // Child agents inherit executor instructions
          const childInstructions = await deps.resolveInstructionsForRole("executor", settings);
          // A non-empty systemPromptOverride lets the caller run the child as a
          // specific persona (e.g. a compound-engineering reviewer) instead of the
          // generic child executor. Executor instructions are still appended below.
          //
          // (U9 / KTD-7) The engine does NOT itself resolve the persona def file —
          // the calling skill reads `$FUSION_CE_AGENTS_DIR/<persona>.md` (the
          // FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE instructs a path-confined
          // read: confined to the install dir, `../` rejected, body-size sanity
          // checked) and passes the stripped body here. The override body is
          // therefore trusted only to the extent that read was confined; the
          // agents dir is plugin-installer-owned and lives OUTSIDE the task
          // worktree (so coding-mode plan/code-review steps can't write into it —
          // see assertPluginLocalAgentsTarget in the CE plugin installer).
          const personaOverride = systemPromptOverride?.trim();
          const childBasePrompt = personaOverride
            ? `${personaOverride}

  Parent task: ${taskId}
  Child agent: ${agent.id} (${name})`
            : `You are a child agent spawned by a parent task executor.

  Your role:
  - Complete the delegated task in your own worktree.
  - Work autonomously, but stay tightly scoped to the delegated request.
  - Prefer existing project patterns over inventing new ones.
  - Run relevant tests and report what you verified.
  - Do not widen scope or refactor unrelated areas.

  Output expectations:
  - Provide a concise summary of what you changed.
  - Call out files touched and validations run.
  - Explicitly mention unresolved blockers if you could not finish.

  Parent task: ${taskId}
  Child agent: ${agent.id} (${name})`;
          const childSystemPrompt = buildSystemPromptWithInstructions(childBasePrompt, childInstructions);

          // Build skill selection context for child agent session
          const childTask = await deps.store.getTask(taskId);
          const skillContext = await buildSessionSkillContext({
            agentStore: deps.agentStore!,
            task: childTask,
            sessionPurpose: "executor",
            projectRootDir: deps.rootDir,
            pluginRunner: deps.pluginRunner,
          });
          const parentAgent = childTask.assignedAgentId
            ? await deps.agentStore.getAgent(childTask.assignedAgentId).catch(() => null)
            : null;
          const childRuntimeHint = extractRuntimeHint(agent.runtimeConfig)
            ?? extractRuntimeHint(parentAgent?.runtimeConfig);

          // Resolve executor model via canonical lane hierarchy so child agents
          // honor project executionProvider/executionModelId overrides (parity
          // with main executor at the top of agentWork()).
          const childExecutorSessionModel = resolveExecutorSessionModel(
            undefined,
            undefined,
            settings,
            agent.runtimeConfig as Record<string, unknown> | undefined,
          );
          const { provider: childExecutorProvider, modelId: childExecutorModelId } = childExecutorSessionModel;

          const childExecutorFallback = resolveExecutorFallbackModel(settings);

          // Create child agent session
          const { session: childSession } = await createResolvedAgentSession({
            sessionPurpose: "executor",
            taskExecutionSession: true,
            runtimeHint: childRuntimeHint,
            pluginRunner: deps.pluginRunner,
            cwd: childWorktreePath,
            systemPrompt: childSystemPrompt,
            tools: "coding",
            defaultProvider: childExecutorProvider,
            defaultModelId: childExecutorModelId,
            ...(childExecutorSessionModel.credentialInstanceId ? { credentialInstanceId: childExecutorSessionModel.credentialInstanceId } : {}),
            fallbackProvider: childExecutorFallback.provider,
            fallbackModelId: childExecutorFallback.modelId,
            fallbackThinkingLevel: resolveExecutorFallbackThinkingLevel(undefined, settings),
            runAuditor: createRunAuditor(deps.store, deps.getRunContextFor(taskId)),
            settings,
            taskEnv,
            mcpServers: await deps.resolveMcpServers(agent.id),
            // FNXC:SessionRouting 2026-06-24-11:20:
            // #1675: propagate task id so child-agent requests carry the same
            // X-Session-Id/X-Session-Affinity as the parent task session.
            taskId,
            // FNXC:PluginSkills 2026-07-12-00:00: Child-agent sessions inherit plugin skill body directories from the task skill context so delegated work can load plugin skill guidance.
            ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
            ...(skillContext.additionalSkillPaths.length > 0 ? { additionalSkillPaths: skillContext.additionalSkillPaths } : {}),
          });

          // Store tracking state
          deps.childSessions.set(agent.id, childSession);
          if (!deps.spawnedAgents.has(taskId)) {
            deps.spawnedAgents.set(taskId, new Set());
          }
          deps.spawnedAgents.get(taskId)!.add(agent.id);
          // The slot was already reserved before the awaits above; converting the
          // reservation into the live count is a no-op rather than a second increment.
          spawnReservationHeld = false;

          // Run child asynchronously (don't await — parent continues working)
          deps.runSpawnedChild(agent.id, childSession, taskPrompt).catch((err: unknown) => {
            const errorMessage = err instanceof Error ? err.message : String(err);
            executorLog.warn(`Child agent ${agent.id} async error: ${errorMessage}`);
          });

          const result: SpawnAgentResult = {
            agentId: agent.id,
            name: agent.name,
            state: "running",
            role: agent.role,
            message: `Agent "${name}" spawned and executing task: ${taskPrompt.slice(0, 100)}${taskPrompt.length > 100 ? "..." : ""}`,
          };

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        } catch (err: unknown) {
          // FNXC:CapacityModel 2026-07-29-19:20: a failed spawn must return the slot
          // it reserved, or a project permanently loses capacity to a spawn that
          // never happened.
          releaseSpawnReservation();
          const errorMessage = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Failed to spawn agent: ${errorMessage}` }],
            details: { agentId: "", state: "error", message: errorMessage },
          };
        }
      },
    };
}
