import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
import { isAbsolute, join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { TaskStore, Task, TaskDetail, StepStatus, Settings, WorkflowStep, MissionStore, Slice, AgentState, AgentCapability, RunMutationContext } from "@fusion/core";
import { buildExecutionMemoryInstructions, getTaskMergeBlocker, resolveAgentPrompt, type RunCommandResult } from "@fusion/core";
import { findWorktreeUser } from "./merger.js";
import { generateWorktreeName, slugify } from "./worktree-names.js";
import { Type, type Static } from "@mariozechner/pi-ai";
import { createKbAgent, describeModel, promptWithFallback, compactSessionContext } from "./pi.js";
import { buildSessionSkillContext } from "./session-skill-context.js";
import { reviewStep, type ReviewVerdict } from "./reviewer.js";
import { ModelRegistry, SessionManager, type ToolDefinition, type AgentSession } from "@mariozechner/pi-coding-agent";
import { PRIORITY_EXECUTE, type AgentSemaphore } from "./concurrency.js";
import { isRegisteredGitWorktree, isUsableTaskWorktree, type WorktreePool } from "./worktree-pool.js";
import { AgentLogger } from "./agent-logger.js";
import { executorLog, reviewerLog } from "./logger.js";
import { TokenCapDetector } from "./token-cap-detector.js";
import { isUsageLimitError, checkSessionError, type UsageLimitPauser } from "./usage-limit-detector.js";
import { isTransientError, isSilentTransientError } from "./transient-error-detector.js";
import { withRateLimitRetry } from "./rate-limit-retry.js";
import { computeRecoveryDecision, formatDelay, MAX_RECOVERY_RETRIES } from "./recovery-policy.js";
import type { StuckTaskDetector, StuckTaskEvent } from "./stuck-task-detector.js";
import type { PluginRunner } from "./plugin-runner.js";
import { isContextLimitError } from "./context-limit-detector.js";
import { StepSessionExecutor } from "./step-session-executor.js";
import { resolveAgentInstructions, buildSystemPromptWithInstructions } from "./agent-instructions.js";
import type { AgentReflectionService } from "./agent-reflection.js";
import { createRunAuditor, generateSyntheticRunId, type EngineRunContext } from "./run-audit.js";
import { evaluateSpecStaleness, getPromptPath } from "./spec-staleness.js";
import {
  createDelegateTaskTool,
  createListAgentsTool,
  createMemoryTools,
  createReadMessagesTool,
  createReflectOnPerformanceTool,
  createSendMessageTool,
  createTaskCreateTool as sharedCreateTaskCreateTool,
  createTaskDocumentReadTool as sharedCreateTaskDocumentReadTool,
  createTaskDocumentWriteTool as sharedCreateTaskDocumentWriteTool,
  createTaskLogTool as sharedCreateTaskLogTool,
} from "./agent-tools.js";
import { getTaskCompletionBlockerForStore } from "./task-completion.js";
import { createFusionAuthStorage, getModelRegistryModelsPath } from "./auth-storage.js";

// Re-export for backward compatibility (tests import from executor.ts)
export { summarizeToolArgs } from "./agent-logger.js";
export {
  createDelegateTaskTool,
  createListAgentsTool,
  createReadMessagesTool,
  createSendMessageTool,
  createTaskCreateTool,
  createTaskDocumentReadTool,
  createTaskDocumentWriteTool,
  createTaskLogTool,
  delegateTaskParams,
  listAgentsParams,
  memoryAppendParams,
  memoryGetParams,
  memorySearchParams,
  readMessagesParams,
  sendMessageParams,
  taskCreateParams,
  taskLogParams,
} from "./agent-tools.js";

const STEP_STATUSES: StepStatus[] = ["pending", "in-progress", "done", "skipped"];

/** Maximum retry attempts for workflow step hard failures before giving up */
const MAX_WORKFLOW_STEP_RETRIES = 3;
const WORKFLOW_SCRIPT_OUTPUT_MAX_CHARS = 4_000;

class NonRetryableWorktreeError extends Error {}

function truncateWorkflowScriptOutput(output: string): string {
  if (output.length <= WORKFLOW_SCRIPT_OUTPUT_MAX_CHARS) return output;
  return `... output truncated to last ${WORKFLOW_SCRIPT_OUTPUT_MAX_CHARS} characters ...\n${output.slice(-WORKFLOW_SCRIPT_OUTPUT_MAX_CHARS)}`;
}

function configuredCommandErrorMessage(result: RunCommandResult): string {
  if (result.spawnError) return result.spawnError.message;
  const parts: string[] = [];
  if (result.timedOut) parts.push("Timed out");
  if (result.exitCode !== null) parts.push(`Exit code: ${result.exitCode}`);
  if (result.signal) parts.push(`Signal: ${result.signal}`);
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout) parts.push(`stdout: ${truncateWorkflowScriptOutput(stdout)}`);
  if (stderr) parts.push(`stderr: ${truncateWorkflowScriptOutput(stderr)}`);
  return parts.length ? parts.join("\n") : "Command failed";
}

async function runConfiguredCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<RunCommandResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
    });

    return {
      stdout: stdout?.toString?.() ?? "",
      stderr: stderr?.toString?.() ?? "",
      exitCode: 0,
      signal: null,
      bufferExceeded: false,
      timedOut: false,
    };
  } catch (error: any) {
    const code = error?.code;
    const status = typeof error?.status === "number" ? error.status : null;
    const exitCode = typeof code === "number" ? code : status;
    const message = String(error?.message ?? "");

    return {
      stdout: error?.stdout?.toString?.() ?? "",
      stderr: error?.stderr?.toString?.() ?? "",
      exitCode,
      signal: (error?.signal as NodeJS.Signals | null | undefined) ?? null,
      bufferExceeded:
        code === "ENOBUFS"
        || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        || message.includes("maxBuffer"),
      timedOut:
        code === "ETIMEDOUT"
        || (error?.killed === true && (error?.signal === "SIGTERM" || message.includes("timed out"))),
      spawnError: code === "ENOENT" || code === "EACCES" ? error : undefined,
    };
  }
}

// ── Tool parameter schemas (module-level for reuse in ToolDefinition generics) ──

const taskUpdateParams = Type.Object({
  step: Type.Number({ description: "Step number (0-indexed)" }),
  status: Type.Union(
    STEP_STATUSES.map((s) => Type.Literal(s)),
    { description: "New status: pending, in-progress, done, or skipped" },
  ),
});

// taskLogParams and taskCreateParams are imported from agent-tools.ts

const taskAddDepParams = Type.Object({
  task_id: Type.String({ description: "The ID of the task to depend on (e.g. \"KB-001\")" }),
  confirm: Type.Optional(Type.Boolean({ description: "Set to true to confirm adding the dependency. Required because adding a dep to an in-progress task will stop execution and discard current work." })),
});

const spawnAgentParams = Type.Object({
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
});

/** Result returned from spawn_agent tool */
interface SpawnAgentResult {
  agentId: string;
  name: string;
  state: AgentState;
  role: AgentCapability;
  message: string;
}

/**
 * Outcome of a single workflow step execution.
 * Supports three states: pass, hard failure, or revision requested with feedback.
 */
export interface WorkflowStepOutcome {
  success: boolean;
  revisionRequested?: boolean;
  output?: string;
  error?: string;
}

/**
 * Result of running all pre-merge workflow steps.
 * Returns true if all passed, false if any hard failure, or a structured
 * revision result if a revision was requested.
 */
export type WorkflowStepResult =
  | { allPassed: true }
  | { allPassed: false; revisionRequested: false; feedback: string; stepName: string }
  | { allPassed: false; revisionRequested: true; feedback: string; stepName: string };


const reviewStepParams = Type.Object({
  step: Type.Number({ description: "Step number to review" }),
  type: Type.Union(
    [Type.Literal("plan"), Type.Literal("code")],
    { description: 'Review type: "plan" or "code"' },
  ),
  step_name: Type.String({ description: "Name of the step being reviewed" }),
  baseline: Type.Optional(
    Type.String({
      description:
        "Git commit SHA for code review diff baseline. " +
        "Capture HEAD before starting a step and pass it here.",
    }),
  ),
});

const EXECUTOR_SYSTEM_PROMPT = `You are a task execution agent for "fn", an AI-orchestrated task board.

You are working in a git worktree isolated from the main branch. Your job is to implement the task described in the PROMPT.md specification you're given.

## How to work
1. Read the PROMPT.md carefully — it contains your mission, steps, file scope, and acceptance criteria
2. Work through each step in order
3. Write clean, production-quality code
4. Test your changes
5. Commit at meaningful boundaries (step completion)

## Reporting progress via tools

You have tools to report progress. The board updates in real-time.

**Step lifecycle:**
- Before starting a step: \`task_update(step=N, status="in-progress")\`
- After completing a step: \`task_update(step=N, status="done")\`
- If skipping a step: \`task_update(step=N, status="skipped")\`

**Logging important actions:** \`task_log(message="what happened")\`

**Out-of-scope work found during execution:** \`task_create(description="what needs doing")\`
When creating multiple related tasks, declare dependencies between them:
\`task_create(description="load door sounds", dependencies=[])\` → returns KB-050
\`task_create(description="play sound on door open/close", dependencies=["KB-050"])\`

**Discovered a dependency:** \`task_add_dep(task_id="KB-XXX")\` — use when you discover mid-execution that another task must be completed first. This will return a warning first — you must call again with \`confirm=true\` to proceed. Adding a dependency stops execution, discards current work, and moves the task to triage for re-specification.

## Cross-model review via review_step tool

You have a \`review_step\` tool. It spawns a SEPARATE reviewer agent (different
model, read-only access) to independently assess your work.

**When to call it** — based on the Review Level in the PROMPT.md:

| Review Level | Before implementing | After implementing + committing |
|-------------|--------------------|---------------------------------|
| 0 (None)    | —                  | —                               |
| 1 (Plan)    | \`review_step(step, "plan", step_name)\` | —              |
| 2 (Plan+Code) | \`review_step(step, "plan", step_name)\` | \`review_step(step, "code", step_name, baseline)\` |
| 3 (Full)    | plan review        | code review + test review       |

**Skip reviews for** Step 0 (Preflight) and the final documentation/delivery step.

**Code review flow:**
1. Before starting a step, capture baseline: \`git rev-parse HEAD\`
2. Implement the step
3. Commit
4. Call \`review_step\` with the baseline SHA so the reviewer sees only your changes

**Handling verdicts:**
- **APPROVE** → proceed to next step
- **REVISE (code review)** → **enforced**. You MUST fix the issues, commit again,
  and re-run \`review_step(type="code")\` before the step can be marked done.
  \`task_update(status="done")\` will be rejected until the code review passes.
- **REVISE (plan review)** → advisory. Incorporate the feedback at your discretion
  and proceed with implementation. No re-review is required.
- **RETHINK (code review)** → your code changes have been reverted and conversation rewound. Read the feedback carefully and take a fundamentally different approach. Do NOT repeat the rejected strategy.
- **RETHINK (plan review)** → conversation rewound to before the step (no git reset since no code was written). Read the feedback and take a fundamentally different approach to planning this step.

## Task Documents

You can save and retrieve named documents for this task. Use these to store planning notes, research findings, or any persistent data that should survive across sessions.

- **Save a document:** \`task_document_write(key="plan", content="...")\`
- **Read a document:** \`task_document_read(key="plan")\`
- **List all documents:** \`task_document_read()\` (no key)

Documents are versioned — each write creates a new revision. Use meaningful keys like "plan", "notes", "research", "architecture".

**IMPORTANT — Save your deliverables as documents:** When your task produces written output (documentation, specifications, reports, API references, README updates, guides, or any other content), you MUST save that content as a task document using \`task_document_write\`. Use a key that describes the deliverable (e.g., key="readme", key="api-docs", key="changelog"). Do this in addition to writing the file to disk — the document persists in the task for review even after the worktree is cleaned up.

If the task's PROMPT.md includes a "Documentation Requirements" section listing files to update, save each updated file's final content as a task document with a matching key.

## Git discipline
- Commit after completing each step (not after every file change)
- Use conventional commit messages prefixed with the task ID
- Do NOT commit broken or half-implemented code

## Worktree Boundaries

You are running in an **isolated git worktree**. This means:

- **All code changes must be made inside the current worktree directory.** Do not modify files outside the worktree — the worktree is your isolated execution environment.
- **Exception — Project memory:** You MAY read and write to .fusion/memory/MEMORY.md at the project root to save durable project learnings (architecture patterns, conventions, pitfalls).
- **Exception — Task attachments:** You MAY read files under .fusion/tasks/{taskId}/attachments/ at the project root for context screenshots and documents attached to this task.
- **Shell commands** run inside the worktree by default. Avoid using cd to navigate outside the worktree.

If you attempt to write to a path outside the worktree, the file tools will reject the operation with an error explaining the boundary.

## Guardrails
- **NEVER kill processes on port 4040.** Port 4040 is the production dashboard. Do not run \`kill\`, \`pkill\`, \`killall\`, or \`lsof -ti:4040 | xargs kill\` against it. If you need to start a test server, use \`--port 0\` for a random free port. If port 4040 is occupied, pick a different port — do NOT kill the occupant.
- Treat the File Scope in PROMPT.md as the expected starting scope, not a hard boundary when quality gates fail
- Read "Context to Read First" files before starting
- Follow the "Do NOT" section strictly
- If tests, lint, build, or typecheck fail and the fix requires touching code outside the declared File Scope, fix those failures directly and keep the repo green
- Use \`task_create\` for genuinely separate follow-up work, not for mandatory fixes required to make this task land cleanly
- Update documentation listed in "Must Update" and check "Check If Affected"
- NEVER delete, remove, or gut modules, interfaces, settings, exports, or test files outside your File Scope
- NEVER remove features as "cleanup" — if something seems unused, create a task for investigation instead
- Removing code is acceptable ONLY when it is explicitly part of your task's mission
- If you remove existing functionality, you MUST create a changeset in \`.changeset/\` explaining the removal and rationale

## Spawning Child Agents

You can spawn child agents to handle parallel work or specialized sub-tasks:

**When to use \`spawn_agent\`:**
- Parallel work that can be divided into independent chunks
- Specialized tasks requiring different expertise or tools
- Delegation of sub-tasks to specialized agents

**How to spawn:**
\`\`\`javascript
spawn_agent({
  name: "researcher",
  role: "engineer",
  task: "Research best practices for authentication in React applications"
})
\`\`\`

**Child agent behavior:**
- Each child runs in its own git worktree (branched from your worktree)
- Children execute autonomously and report completion
- When you end (task_done), all spawned children are terminated
- Check AgentStore for spawned agent status

**Limits:**
- Max 5 spawned agents per parent by default (configurable via settings)
- Max 20 total spawned agents system-wide (configurable via settings)

## Completion
After all steps are done, lint passes, tests pass, typecheck passes, and docs are updated:
\`\`\`bash
Call \`task_done()\` to signal completion.
\`\`\`

If a project build command is listed in the prompt, it is a hard completion gate:
- Run the exact build command in the current worktree before \`task_done()\`
- Do not claim the build passes unless you actually ran it and got exit code 0
- If the build fails, do NOT call \`task_done()\`; keep working until it passes

Lint, tests, and typecheck are also hard quality gates:
- Keep fixing failures until lint, the configured/full test suite, and typecheck all pass
- If the repository exposes a typecheck command, run it and keep fixing failures until it passes
- Do not stop at "out of scope" if additional fixes are required to restore green lint, tests, build, or typecheck
- **CRITICAL: Resolve ALL lint failures and test failures before completing the task, even if they appear unrelated or pre-existing.** Unrelated failures left unfixed accumulate technical debt and block future integrations. Investigate and fix or suppress them — do not defer them to a separate task.`;

/** Resolve the executor system prompt from settings, falling back to the hardcoded constant. */
function getExecutorSystemPrompt(settings: Settings): string {
  const customPrompt = resolveAgentPrompt("executor", settings.agentPrompts);
  return customPrompt || EXECUTOR_SYSTEM_PROMPT;
}

export interface TaskExecutorOptions {
  semaphore?: AgentSemaphore;
  /** Worktree pool for recycling idle worktrees across tasks. */
  pool?: WorktreePool;
  /** Usage limit pauser — triggers global pause when API limits are detected. */
  usageLimitPauser?: UsageLimitPauser;
  /** Stuck task detector — monitors agent sessions for stagnation and triggers recovery. */
  stuckTaskDetector?: StuckTaskDetector;
  /** AgentStore for tracking spawned child agents. If not provided, spawning is disabled. */
  agentStore?: import("@fusion/core").AgentStore;
  /** Reflection service used to generate self-reflection insights for agents. */
  reflectionService?: AgentReflectionService;
  /** Plugin runner for invoking plugin hooks and providing plugin tools. */
  pluginRunner?: PluginRunner;
  /** MessageStore for sending messages to other agents. When provided, executor agents gain send_message capability. */
  messageStore?: import("@fusion/core").MessageStore;
  missionStore?: MissionStore;
  onSliceComplete?: (slice: Slice) => void;
  onStart?: (task: Task, worktreePath: string) => void;
  onComplete?: (task: Task) => void;
  onError?: (task: Task, error: Error) => void;
  onAgentText?: (taskId: string, delta: string) => void;
  onAgentTool?: (taskId: string, toolName: string) => void;
}

export class TaskExecutor {
  private activeWorktrees = new Map<string, string>();
  private executing = new Set<string>();
  /** Tasks currently being prepared for unpause resume, before execute() has registered them. */
  private resumingUnpaused = new Set<string>();
  /** Completed orphan recovery tasks currently running during startup. */
  private recoveringCompleted = new Set<string>();
  /** Active agent sessions per task, used to terminate on pause and inject steering. */
  private activeSessions = new Map<string, {
    session: AgentSession;
    seenSteeringIds: Set<string>;
    lastModelProvider?: string | null;
    lastModelId?: string | null;
  }>();
  /** Active step-session executors per task (mutually exclusive with activeSessions). */
  private activeStepExecutors = new Map<string, StepSessionExecutor>();
  /** Tasks that were paused mid-execution (to avoid marking them as "failed"). */
  private pausedAborted = new Set<string>();
  /** Tasks that had a dependency added mid-execution (abort + discard worktree). */
  private depAborted = new Set<string>();
  /** Tasks killed by stuck task detector. Value = shouldRequeue (budget not exhausted). */
  private stuckAborted = new Map<string, boolean>();
  /** In-memory loop recovery state per task. Keyed by taskId, not persisted.
   *  Tracks compact-and-resume attempt count per execute() lifecycle.
   *  Reset at execute() lifecycle end (finally block). */
  private loopRecoveryState = new Map<string, { attempts: number; pending: boolean }>();
  /** Spawned child agent IDs per parent task ID. Used for lifecycle tracking. */
  private spawnedAgents = new Map<string, Set<string>>();

  private async finalizeAlreadyReviewedTask(taskId: string): Promise<"merged" | "blocked" | "missing"> {
    const latestTask = await this.store.getTask(taskId);
    if (!latestTask || latestTask.column !== "in-review") {
      return "missing";
    }

    const blocker = getTaskMergeBlocker(latestTask);
    if (blocker) {
      await this.store.logEntry(taskId, "Task already in-review; merge deferred", blocker, this.currentRunContext);
      return "blocked";
    }

    await this.store.logEntry(
      taskId,
      "Task already in-review after completion — finalizing merge",
      undefined,
      this.currentRunContext,
    );
    await this.store.mergeTask(taskId);
    return "merged";
  }
  /** Child agent sessions keyed by agent ID. Used for termination. */
  private childSessions = new Map<string, AgentSession>();
  /** Total count of currently spawned agents (across all parents). */
  private totalSpawnedCount = 0;
  /** Token cap detector for proactive context compaction. */
  private tokenCapDetector = new TokenCapDetector();
  private _modelRegistry?: InstanceType<typeof ModelRegistry>;
  /** Current run context for mutation correlation. Set at execute() start, cleared in finally. */
  private currentRunContext: RunMutationContext | undefined;

  private get modelRegistry(): InstanceType<typeof ModelRegistry> {
    if (!this._modelRegistry) {
      const authStorage = createFusionAuthStorage();
      this._modelRegistry = new ModelRegistry(authStorage, getModelRegistryModelsPath());
      this._modelRegistry.refresh();
    }
    return this._modelRegistry;
  }

  /** Returns the set of task IDs currently being executed. */
  getExecutingTaskIds(): Set<string> {
    return new Set([...this.executing, ...this.recoveringCompleted]);
  }

  /**
   * @param store — Task store instance (also used to listen for events)
   * @param rootDir — Project root directory
   * @param options — Executor configuration
   *
   * Listens for `task:moved` to auto-execute tasks moved to `in-progress`,
   * `task:updated` to terminate agent sessions when individual tasks are paused,
   * and `settings:updated` to terminate **all** active agent sessions when
   * `globalPause` transitions from `false` to `true`. `enginePaused` only
   * prevents new work dispatch — running sessions continue to completion.
   * Paused tasks are moved back to `todo` rather than marked as `failed`.
   */
  constructor(
    private store: TaskStore,
    private rootDir: string,
    private options: TaskExecutorOptions = {},
  ) {
    executorLog.log(`TaskExecutor constructed (rootDir=${rootDir}, hasSemaphore=${!!options.semaphore}, hasStuckDetector=${!!options.stuckTaskDetector})`);

    store.on("task:moved", ({ task, from, to }) => {
      executorLog.log(`[event:task:moved] ${task.id}: ${from} → ${to}`);
      if (to === "in-progress") {
        executorLog.log(`[event:task:moved] Initiating execute() for ${task.id}`);
        this.execute(task).catch((err) =>
          executorLog.error(`Failed to start ${task.id}:`, err),
        );
      } else if (from === "in-progress") {
        // Task moved away from in-progress — terminate any active sessions
        if (this.activeSessions.has(task.id)) {
          executorLog.log(`${task.id} moved from in-progress to ${to} — terminating agent session`);
          this.pausedAborted.add(task.id);
          this.options.stuckTaskDetector?.untrackTask(task.id);
          const { session } = this.activeSessions.get(task.id)!;
          session.dispose();
          this.activeSessions.delete(task.id);
        }
        if (this.activeStepExecutors.has(task.id)) {
          executorLog.log(`${task.id} moved from in-progress to ${to} — terminating step sessions`);
          this.pausedAborted.add(task.id);
          this.options.stuckTaskDetector?.untrackTask(task.id);
          const stepExecutor = this.activeStepExecutors.get(task.id)!;
          stepExecutor.terminateAllSessions().catch((err) =>
            executorLog.error(`Failed to terminate step sessions for ${task.id}:`, err),
          );
          this.activeStepExecutors.delete(task.id);
        }
        // Clean up all in-memory state for this task so nothing leaks across runs.
        // This prevents zombie state from persisting when a task moves away from
        // in-progress while execute() is still unwinding, or when the scheduler
        // moves a task out before the executor's task:moved fires.
        this.loopRecoveryState.delete(task.id);
        this.spawnedAgents.delete(task.id);
        this.stuckAborted.delete(task.id);
      }
    });

    // When a task is paused while executing, terminate the agent session.
    // When steering comments are added during execution, inject them into the running session.
    //
    // Real-time steering comment injection mechanism:
    // 1. When execution starts, we initialize seenSteeringIds with all existing comment IDs
    // 2. On each task:updated event, we check if there are new comments not in seenSteeringIds
    // 3. New comments are injected via session.steer() which queues them for delivery
    //    after the current assistant turn completes (before the next LLM call)
    // 4. Comments are marked as seen BEFORE injection to prevent retry loops on failure
    // 5. Each injection is logged to the task for user visibility
    store.on("task:updated", async (task) => {
      try {
        // Handle pause - terminate the agent session or step sessions
        if (task.paused && this.activeSessions.has(task.id)) {
          executorLog.log(`Pausing ${task.id} — terminating agent session`);
          this.pausedAborted.add(task.id);
          this.options.stuckTaskDetector?.untrackTask(task.id);
          const { session } = this.activeSessions.get(task.id)!;
          session.dispose();
          // Also clean up in-memory state to prevent leaks if the task is later unpaused
          this.loopRecoveryState.delete(task.id);
          this.spawnedAgents.delete(task.id);
          this.stuckAborted.delete(task.id);
          return;
        }
        if (task.paused && this.activeStepExecutors.has(task.id)) {
          executorLog.log(`Pausing ${task.id} — terminating step sessions`);
          this.pausedAborted.add(task.id);
          this.options.stuckTaskDetector?.untrackTask(task.id);
          const stepExecutor = this.activeStepExecutors.get(task.id)!;
          await stepExecutor.terminateAllSessions();
          // Also clean up in-memory state to prevent leaks if the task is later unpaused
          this.loopRecoveryState.delete(task.id);
          this.spawnedAgents.delete(task.id);
          this.stuckAborted.delete(task.id);
          return;
        }

        // Handle unpause of an in-progress task with no active session.
        // This covers orphaned states (e.g., engine restarted while task was
        // paused in-progress) where the task needs to resume execution.
        // The executing/resuming guards prevent duplicate runs.
        if (
          !task.paused
          && task.column === "in-progress"
          && !this.activeSessions.has(task.id)
          && !this.activeStepExecutors.has(task.id)
        ) {
          if (!this.executing.has(task.id) && !this.resumingUnpaused.has(task.id)) {
            this.resumingUnpaused.add(task.id);
            executorLog.log(`Unpaused ${task.id} in-progress with no session — resuming execution`);
            try {
              await this.clearResumeFailureState(task);
              await this.store.logEntry(task.id, "Resuming execution after unpause", undefined, this.currentRunContext);
            } catch (clearErr) {
              executorLog.warn(`${task.id} clearResumeFailureState failed during unpause: ${clearErr instanceof Error ? clearErr.message : String(clearErr)}`);
            }
            this.execute(task)
              .catch((err) =>
                executorLog.error(`Failed to resume unpaused ${task.id}:`, err),
              )
              .finally(() => {
                this.resumingUnpaused.delete(task.id);
              });
          }
          return;
        }

        // Handle executor model hot-swap on active single-session executions
        if (this.activeSessions.has(task.id) && !task.paused) {
          const activeEntry = this.activeSessions.get(task.id)!;
          const providerChanged = task.modelProvider !== activeEntry.lastModelProvider;
          const modelIdChanged = task.modelId !== activeEntry.lastModelId;

          if (providerChanged || modelIdChanged) {
            activeEntry.lastModelProvider = task.modelProvider;
            activeEntry.lastModelId = task.modelId;

            const settings = await this.store.getSettings();
            // Resolve model using canonical lane hierarchy for hot-swap
            const newProvider = task.modelProvider && task.modelId
              ? task.modelProvider
              : (settings?.executionProvider && settings?.executionModelId
                  ? settings.executionProvider
                  : (settings?.executionGlobalProvider && settings?.executionGlobalModelId
                      ? settings.executionGlobalProvider
                      : settings?.defaultProvider));
            const newModelId = task.modelProvider && task.modelId
              ? task.modelId
              : (settings?.executionProvider && settings?.executionModelId
                  ? settings.executionModelId
                  : (settings?.executionGlobalProvider && settings?.executionGlobalModelId
                      ? settings.executionGlobalModelId
                      : settings?.defaultModelId));

            if (newProvider && newModelId) {
              try {
                const model = this.modelRegistry.find(newProvider, newModelId);
                if (model) {
                  await activeEntry.session.setModel(model);
                  executorLog.log(`${task.id}: executor model hot-swapped to ${newProvider}/${newModelId}`);
                  await this.store.logEntry(task.id, `Model changed to ${newProvider}/${newModelId}`, undefined, this.currentRunContext);
                } else {
                  executorLog.log(`${task.id}: model ${newProvider}/${newModelId} not found in registry for hot-swap`);
                }
              } catch (err: unknown) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                executorLog.error(`${task.id}: failed to hot-swap model: ${errorMessage}`);
                await this.store.logEntry(task.id, `Model change failed: ${errorMessage}`, undefined, this.currentRunContext);
              }
            }
          }
        }

        // Handle steering comments - inject new ones into the running session
        // Only process if session is active (activeSessions check is sufficient
        // since entries are only added when a task is in-progress)
        if (this.activeSessions.has(task.id) && task.steeringComments) {
          const activeSession = this.activeSessions.get(task.id)!;
          const { session, seenSteeringIds } = activeSession;

          // Find new steering comments that haven't been seen yet
          const newComments = task.steeringComments.filter(c => !seenSteeringIds.has(c.id));

          if (newComments.length > 0) {
            for (const comment of newComments) {
              const summary = comment.text.length > 80
                ? comment.text.slice(0, 80) + "..."
                : comment.text;

              // Mark as seen BEFORE attempting injection to prevent retry loops on failure
              seenSteeringIds.add(comment.id);

              // Format and inject the comment
              const commentMessage = formatCommentForInjection(comment);
              try {
                executorLog.log(`Injecting comment into ${task.id}: ${summary}`);
                await session.steer(commentMessage);
                executorLog.log(`Successfully injected comment into ${task.id}`);

                // Log to the task that comment was received
                await this.store.logEntry(
                  task.id,
                  `Comment received mid-execution: ${summary}`,
                  `by ${comment.author}`
                );
              } catch (err) {
                executorLog.error(`Failed to inject comment for ${task.id}:`, err);
                // Comment is already marked as seen - we won't retry to avoid spamming
                // the agent with failed injections. The error is logged for debugging.
              }
            }

            // After injecting comments, check for review handoff intent
            // Only detect handoff in agent-authored comments when policy is enabled
            const settings = await this.store.getSettings();
            if (settings.reviewHandoffPolicy === "comment-triggered") {
              const agentComments = newComments.filter(c => c.author !== "user");
              for (const comment of agentComments) {
                if (detectReviewHandoffIntent(comment.text)) {
                  executorLog.log(`Review handoff detected in ${task.id}: ${comment.text.slice(0, 50)}...`);
                  await this.executeReviewHandoff(task, session, activeSession);
                  return; // Exit early - handoff handles session disposal
                }
              }
            }
          }
        }
      } catch (err) {
        executorLog.error("Uncaught error in task:updated listener:", err);
      }
    });

    // When globalPause transitions from false → true, terminate all active agent sessions.
    store.on("settings:updated", ({ settings, previous }) => {
      if (settings.globalPause && !previous.globalPause) {
        for (const [taskId, { session }] of this.activeSessions) {
          executorLog.log(`Global pause — terminating agent session for ${taskId}`);
          this.pausedAborted.add(taskId);
          this.options.stuckTaskDetector?.untrackTask(taskId);
          session.dispose();
          // Clean up all in-memory state so nothing leaks when tasks are later unpaused
          this.loopRecoveryState.delete(taskId);
          this.spawnedAgents.delete(taskId);
          this.stuckAborted.delete(taskId);
        }
        for (const [taskId, stepExecutor] of this.activeStepExecutors) {
          executorLog.log(`Global pause — terminating step sessions for ${taskId}`);
          this.pausedAborted.add(taskId);
          this.options.stuckTaskDetector?.untrackTask(taskId);
          stepExecutor.terminateAllSessions().catch(err =>
            executorLog.warn(`Failed to terminate step sessions for global pause ${taskId}: ${err}`)
          );
          // Clean up all in-memory state so nothing leaks when tasks are later unpaused
          this.loopRecoveryState.delete(taskId);
          this.spawnedAgents.delete(taskId);
          this.stuckAborted.delete(taskId);
        }
      }
    });

  }

  /**
   * Check whether a task's work is complete — all steps are done or skipped.
   * Used to detect tasks that called task_done() but never transitioned to in-review
   * (e.g., killed by stuck detector after task_done but before moveTask).
   */
  private isTaskWorkComplete(task: Task): boolean {
    if (task.steps.length === 0) return false;
    return task.steps.every((s) => s.status === "done" || s.status === "skipped");
  }

  private isNoProgressNoTaskDoneFailure(task: Task): boolean {
    return task.status === "failed" &&
      task.error?.includes("without calling task_done") === true &&
      task.steps.every((step) => step.status === "pending");
  }

  private async clearResumeFailureState(task: Task): Promise<void> {
    if (task.status === "failed" || task.error) {
      await this.store.updateTask(task.id, { status: null, error: null });
    }
  }

  private async shouldFinalizeCompletedTask(taskId: string, taskDone: boolean): Promise<boolean> {
    const task = await this.store.getTask(taskId);
    const completionBlocker = await this.getTaskCompletionBlocker(task);
    if (completionBlocker) {
      executorLog.log(`${taskId} completion blocked — ${completionBlocker}`);
      return false;
    }
    if (taskDone) return true;
    return this.isTaskWorkComplete(task);
  }

  private async getTaskCompletionBlocker(task: Task): Promise<string | undefined> {
    return getTaskCompletionBlockerForStore(this.store, task);
  }

  /**
   * Execute a review handoff: move the task to in-review column with
   * awaiting-user-review status, assign the requesting user, and dispose
   * the agent session.
   */
  private async executeReviewHandoff(
    task: Task,
    _session: AgentSession,
    _sessionEntry: { session: AgentSession; seenSteeringIds: Set<string>; lastModelProvider?: string | null; lastModelId?: string | null },
  ): Promise<void> {
    try {
      executorLog.log(`Executing review handoff for ${task.id}`);

      // Log the handoff event
      await this.store.logEntry(
        task.id,
        "Review handoff requested by agent — moving to in-review for user review",
        undefined,
        this.currentRunContext
      );

      // Update task with awaiting-user-review status and assignee
      // Use a single updateTask call for atomicity
      await this.store.updateTask(
        task.id,
        {
          status: "awaiting-user-review",
          assigneeUserId: "requesting-user",
        },
        this.currentRunContext
      );

      // Move the task to in-review column (this will also emit task:moved event)
      // The task:moved handler will clean up activeSessions
      await this.store.moveTask(task.id, "in-review");

      // Dispose the agent session (this may already be done by task:moved handler)
      // but we do it here to be explicit
      if (this.activeSessions.has(task.id)) {
        const { session: activeSession } = this.activeSessions.get(task.id)!;
        activeSession.dispose();
        this.activeSessions.delete(task.id);
      }

      // Untrack from stuck detector
      this.options.stuckTaskDetector?.untrackTask(task.id);

      executorLog.log(`Review handoff complete for ${task.id} — task moved to in-review`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.error(`Failed to execute review handoff for ${task.id}: ${errorMessage}`);
    }
  }

  /**
   * Fast-path a completed task directly to in-review without spawning a new agent.
   * Captures modified files, runs workflow steps, and transitions the task.
   *
   * @returns true if the task was successfully transitioned, false otherwise.
   */
  async recoverCompletedTask(task: Task): Promise<boolean> {
    try {
      const settings = await this.store.getSettings();

      // Capture modified files if the worktree still exists
      if (task.worktree && existsSync(task.worktree)) {
        const modifiedFiles = await this.captureModifiedFiles(task.worktree, task.baseCommitSha);
        if (modifiedFiles.length > 0) {
          await this.store.updateTask(task.id, { modifiedFiles });
          executorLog.log(`${task.id}: recovered ${modifiedFiles.length} modified files`);
        }

        // Run workflow steps before transitioning
        const workflowResult = await this.runWorkflowSteps(task, task.worktree, settings);
        if (!workflowResult.allPassed) {
          // For recovery path, treat any failure (including revision) as hard failure
          // Send back to in-progress so executor can attempt to fix the issues
          await this.sendTaskBackForFix(task, task.worktree!, workflowResult.feedback, workflowResult.stepName || "Unknown", "Workflow step failed during recovery");
          return true; // Still transitioned out of in-progress
        }
      }

      await this.store.moveTask(task.id, "in-review");
      await this.store.logEntry(task.id, "Auto-recovered: task work was complete but stuck in in-progress — moved to in-review");
      executorLog.log(`✓ ${task.id} auto-recovered completed task → in-review`);
      this.options.onComplete?.(task);
      return true;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.error(`Failed to recover completed task ${task.id}: ${errorMessage}`);
      return false;
    }
  }

  /**
   * Auto-revive an `in-review` task whose pre-merge workflow step(s) failed, by
   * replaying the same send-back-for-fix flow the executor uses during a live
   * run. Invoked by SelfHealingManager's `recoverReviewTasksWithFailedPreMergeSteps`
   * scan when a task is parked in review with a failed pre-merge step and no
   * active session.
   *
   * Picks the latest failed pre-merge workflow step result (there is usually only
   * one, but if several ran we want the most recent), injects its feedback into
   * `PROMPT.md`, resets steps, and schedules todo → in-progress. The call site
   * is responsible for enforcing the `maxPostReviewFixes` budget before invoking
   * this method — this method itself does no accounting.
   *
   * @returns true when the task was sent back, false when no eligible failed
   *          step exists (caller should skip).
   */
  async recoverFailedPreMergeWorkflowStep(task: Task): Promise<boolean> {
    try {
      const failed = (task.workflowStepResults ?? [])
        .filter((r) => (r.phase || "pre-merge") === "pre-merge" && r.status === "failed")
        .sort((a, b) => {
          const aTs = Date.parse(a.completedAt || a.startedAt || "");
          const bTs = Date.parse(b.completedAt || b.startedAt || "");
          return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
        });
      const target = failed[0];
      if (!target) {
        executorLog.warn(`${task.id}: no failed pre-merge workflow step to recover from`);
        return false;
      }

      const feedback = target.output?.trim() || "(no feedback captured)";
      const stepName = target.workflowStepName || target.workflowStepId || "Unknown";

      await this.sendTaskBackForFix(
        task,
        task.worktree ?? "",
        feedback,
        stepName,
        `Auto-revived from in-review: pre-merge workflow step "${stepName}" had failed`,
      );
      return true;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.error(`Failed to recover failed pre-merge workflow step for ${task.id}: ${errorMessage}`);
      return false;
    }
  }

  /**
   * Resume orphaned in-progress tasks (e.g., after crash/restart).
   * Call once after engine startup.
   *
   * Tasks that are already complete (all steps done/skipped) are fast-pathed
   * directly to in-review without spawning a new agent session.
   */
  async resumeOrphaned(): Promise<void> {
    const tasks = await this.store.listTasks({ slim: true, column: "in-progress" });
    const inProgress = tasks.filter(
      (t) => t.column === "in-progress" && !this.executing.has(t.id) && !t.paused,
    );

    if (inProgress.length === 0) return;

    executorLog.log(`Found ${inProgress.length} orphaned in-progress task(s)`);
    for (const task of inProgress) {
      // Fast-path: if the task already completed its work (all steps done),
      // move it directly to in-review instead of re-executing from scratch.
      if (this.isTaskWorkComplete(task)) {
        if (this.recoveringCompleted.has(task.id)) {
          executorLog.log(`${task.id} completed-task recovery already running - skipping duplicate startup recovery`);
          continue;
        }
        executorLog.log(`${task.id} is already complete — fast-pathing to in-review`);
        this.recoveringCompleted.add(task.id);
        void this.recoverCompletedTask(task)
          .catch((err) =>
            executorLog.error(`Failed to recover completed orphan ${task.id}:`, err),
          )
          .finally(() => {
            this.recoveringCompleted.delete(task.id);
          });
        continue;
      }

      if (this.isNoProgressNoTaskDoneFailure(task)) {
        executorLog.log(`${task.id} failed without task_done and has no step progress — leaving for self-healing requeue`);
        continue;
      }

      executorLog.log(`Resuming ${task.id}: ${task.title || task.description.slice(0, 60)}`);
      try {
        await this.clearResumeFailureState(task);
        await this.store.logEntry(task.id, "Resumed after engine restart");
      } catch (err) {
        executorLog.error(`Failed to write resume log for ${task.id}:`, err);
      }
      this.execute(task).catch((err) =>
        executorLog.error(`Failed to resume ${task.id}:`, err),
      );
    }
  }

  /**
   * Execute a task in an isolated git worktree.
   *
   * Worktree acquisition flow:
   * 1. If the worktree already exists on disk (resume after crash), reuse it.
   * 2. If a {@link WorktreePool} is provided and `recycleWorktrees` is enabled,
   *    attempt to acquire a warm worktree from the pool. Pooled worktrees skip
   *    the `worktreeInitCommand` since their build caches are already warm.
   * 3. Otherwise, create a fresh worktree via `git worktree add` and run the
   *    `worktreeInitCommand` if configured.
   */

  /**
   * Resolve custom instructions for a given agent role by looking up agents
   * in the AgentStore that have instructions configured.
   * Returns an empty string if no instructions are found.
   */
  private async resolveInstructionsForRole(role: string): Promise<string> {
    if (!this.options.agentStore) return "";
    try {
      const agents = await this.options.agentStore.listAgents({ role: role as AgentCapability });
      for (const agent of agents) {
        if (agent.instructionsText || agent.instructionsPath) {
          try {
            const ratingSummary = await this.options.agentStore.getRatingSummary(agent.id);
            return await resolveAgentInstructions(agent, this.rootDir, ratingSummary);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            executorLog.warn(`${agent.id}: failed to load rating summary for instruction resolution, falling back to default instructions: ${msg}`);
            return await resolveAgentInstructions(agent, this.rootDir);
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`Failed to resolve instructions for role '${role}', continuing without custom instructions: ${msg}`);
    }
    return "";
  }

  private resolveDependencyWorktree(task: Task, allTasks: Task[]): string | null {
    if (task.dependencies.length === 0) return null;

    for (const depId of task.dependencies) {
      const dep = allTasks.find((t) => t.id === depId);
      if (
        dep &&
        dep.worktree &&
        (dep.column === "done" || dep.column === "in-review") &&
        existsSync(dep.worktree)
      ) {
        return dep.worktree;
      }
    }
    return null;
  }

  /**
   * Reuse an existing worktree directory from a dependency task.
   * Instead of creating a new worktree with `git worktree add`, this creates
   * a new branch in the existing worktree via `git checkout -b`. The worktree
   * directory (and its build caches) are preserved.
   */
  private async reuseWorktree(branch: string, worktreePath: string): Promise<void> {
    await execAsync(`git checkout -b "${branch}"`, {
      cwd: worktreePath,
    });
    executorLog.log(`Reused worktree at ${worktreePath}, created branch ${branch}`);
  }

  /**
   * Execute a task in an isolated git worktree.
   *
   * **Worktree assignment:** New worktrees get humanized random names
   * (e.g., `.worktrees/swift-falcon/`) via `generateWorktreeName()` rather
   * than being named after the task ID. This decouples directory names from
   * tasks, enabling worktree reuse across dependency chains. When resuming
   * a task that already has `task.worktree` set, the existing path is used
   * as-is. Branches remain task-scoped (`fusion/{task-id}`).
   */
  async execute(task: Task): Promise<void> {
    executorLog.log(`execute() called for ${task.id} (already executing=${this.executing.has(task.id)})`);
    if (this.executing.has(task.id)) return;
    this.executing.add(task.id);

    executorLog.log(`Starting ${task.id}: ${task.title || task.description.slice(0, 60)}`);

    // Fetch settings early — needed for worktree naming and later configuration
    const settings = await this.store.getSettings();

    // Construct run context for mutation correlation
    // Use a synthetic correlation ID: task ID + timestamp + random suffix
    const syntheticRunId = generateSyntheticRunId("exec", task.id);
    this.currentRunContext = {
      runId: syntheticRunId,
      agentId: task.assignedAgentId ?? "executor",
    };

    // Build engine run context for audit instrumentation (FN-1404)
    const engineRunContext: EngineRunContext = {
      runId: syntheticRunId,
      agentId: task.assignedAgentId ?? "executor",
      taskId: task.id,
      phase: "execute",
    };

    // Create run auditor for TaskStore-backed audit emission (no-ops if store doesn't support it)
    const audit = createRunAuditor(this.store, engineRunContext);

    // Stale spec enforcement: check if PROMPT.md has aged beyond the configured threshold.
    // When enabled, stale tasks are moved back to triage with status "needs-respecify"
    // so they receive fresh specification before execution. This guard runs early in
    // execute() to prevent stale tasks from entering worktree creation or agent sessions.
    // If timestamp evaluation is skipped (missing/unreadable file), continue with execution
    // so existing filesystem validation paths remain authoritative.
    // Skip for tasks that are already in-progress, in-review, merging, or done —
    // these should not be interrupted and sent back to triage for respecification.
    const activeColumns = new Set(["in-progress", "in-review", "done"]);
    const activeMergeStatuses = new Set(["merging", "merging-pr"]);
    const isActiveTask = activeColumns.has(task.column) || activeMergeStatuses.has(task.status ?? "");
    if (!isActiveTask) {
      const tasksDir = join(this.store.getFusionDir(), "tasks");
      const promptPath = getPromptPath(tasksDir, task.id);
      const staleness = await evaluateSpecStaleness({ settings, promptPath });
      if (staleness.isStale) {
        executorLog.warn(`Task ${task.id} specification is stale — ${staleness.reason}`);
        // Move to triage first, then set status so the task enters triage with needs-respecify
        await this.store.moveTask(task.id, "triage");
        await this.store.updateTask(task.id, { status: "needs-respecify" });
        await this.store.logEntry(task.id, staleness.reason, undefined, this.currentRunContext);
        return;
      }
    }

    // Hoist worktreePath so it's accessible in the catch block for dep-abort cleanup
    // Determine worktree name based on settings
    let worktreePath: string;
    if (task.worktree) {
      worktreePath = task.worktree;
    } else {
      const naming = settings.worktreeNaming || "random";
      let worktreeName: string;
      
      switch (naming) {
        case "task-id":
          worktreeName = task.id.toLowerCase();
          break;
        case "task-title":
          worktreeName = slugify(task.title || task.description.slice(0, 60));
          break;
        case "random":
        default:
          worktreeName = generateWorktreeName(this.rootDir);
          break;
      }
      worktreePath = join(this.rootDir, ".worktrees", worktreeName);
    }

    // Set by stuck-abort handlers; the actual moveTask("todo") is deferred to
    // the finally block so this.executing is cleared first (prevents re-dispatch race).
    // true = requeue to todo, false = budget exhausted (already marked failed).
    let stuckRequeue: boolean | null = null;
    let taskDone = false;

    try {
      // Check dependencies
      const allTasks = await this.store.listTasks({ slim: true, includeArchived: false });
      const unmetDeps = task.dependencies.filter((depId) => {
        const dep = allTasks.find((t) => t.id === depId);
        return dep && dep.column !== "done" && dep.column !== "in-review" && dep.column !== "archived";
      });

      if (unmetDeps.length > 0) {
        executorLog.log(`${task.id} blocked by: ${unmetDeps.join(", ")} — deferring`);
        return;
      }

      // Create or reuse worktree — try pool first when recycling is enabled
      const branchName = `fusion/${task.id.toLowerCase()}`;
      // Use generateWorktreeName for human-friendly directory names (adjective-noun pattern)
      // instead of task.id, so worktrees are named like ".worktrees/swift-falcon"
      let isResume = existsSync(worktreePath);
      let acquiredFromPool = false;

      // Resolve the base branch — set by the scheduler when a dep is in-review
      const baseBranch = task.baseBranch || null;

      if (task.worktree && isResume && !await isUsableTaskWorktree(this.rootDir, worktreePath)) {
        const invalidWorktreePath = worktreePath;
        executorLog.log(`${task.id}: assigned worktree is not usable; creating a fresh worktree instead: ${invalidWorktreePath}`);
        await this.store.logEntry(
          task.id,
          `Assigned worktree is not a registered, usable git worktree; creating a fresh worktree instead`,
          invalidWorktreePath,
          this.currentRunContext,
        );
        await this.store.updateTask(task.id, { worktree: null, branch: null });
        worktreePath = join(this.rootDir, ".worktrees", generateWorktreeName(this.rootDir));
        isResume = existsSync(worktreePath);
      }

      if (!isResume) {

        // Try acquiring a warm worktree from the pool
        if (this.options.pool && settings.recycleWorktrees) {
          const pooled = this.options.pool.acquire();
          if (pooled) {
            try {
              const actualBranch = await this.options.pool.prepareForTask(pooled, branchName, baseBranch ?? undefined);
              worktreePath = pooled;
              acquiredFromPool = true;
              executorLog.log(`Acquired worktree from pool: ${pooled}`);
              await this.store.updateTask(task.id, { worktree: worktreePath, branch: actualBranch });
              // Audit trail: record worktree reuse (FN-1404)
              await audit.git({ type: "worktree:reuse", target: worktreePath, metadata: { branch: actualBranch } });
              if (actualBranch !== branchName) {
                executorLog.log(`Branch conflict resolved: using ${actualBranch} instead of ${branchName}`);
                await this.store.logEntry(task.id, `Acquired worktree from pool: ${worktreePath} (branch conflict: using ${actualBranch})`, undefined, this.currentRunContext);
              } else {
                await this.store.logEntry(task.id, `Acquired worktree from pool: ${worktreePath}`, undefined, this.currentRunContext);
              }
            } catch (poolErr: unknown) {
              // Pool preparation failed — release the worktree back and fall through
              // to fresh worktree creation
              const poolErrMessage = poolErr instanceof Error ? poolErr.message : String(poolErr);
              this.options.pool.release(pooled);
              executorLog.log(`Pool prepareForTask failed, falling through to fresh worktree: ${poolErrMessage}`);
              await this.store.logEntry(
                task.id,
                `Pool worktree preparation failed (${poolErrMessage}), creating fresh worktree`,
                undefined,
                this.currentRunContext,
              );
            }
          }
        }

        // Fall through to fresh worktree creation if pool had nothing
        if (!acquiredFromPool) {
          const created = await this.createWorktree(branchName, worktreePath, task.id, baseBranch ?? undefined);
          worktreePath = created.path;
          await this.store.updateTask(task.id, { worktree: created.path, branch: created.branch });
          // Audit trail: record worktree creation and branch creation (FN-1404)
          await audit.git({ type: "worktree:create", target: created.path, metadata: { branch: created.branch } });
          await audit.git({ type: "branch:create", target: created.branch });
          if (created.branch !== branchName) {
            executorLog.log(`Branch conflict resolved: using ${created.branch} instead of ${branchName}`);
            await this.store.logEntry(task.id, `Worktree created at ${worktreePath} (branch conflict: using ${created.branch})`, undefined, this.currentRunContext);
          } else if (baseBranch) {
            await this.store.logEntry(task.id, `Worktree created at ${worktreePath} (based on ${baseBranch})`, undefined, this.currentRunContext);
          } else {
            await this.store.logEntry(task.id, `Worktree created at ${worktreePath}`, undefined, this.currentRunContext);
          }

          // Run worktree init command for fresh worktrees (skip for pooled — caches are warm)
          // Non-blocking: uses async exec so the executor event loop keeps running
          // while the user-configured command (e.g. `pnpm install`) executes.
          if (settings.worktreeInitCommand) {
            try {
              const initResult = await runConfiguredCommand(settings.worktreeInitCommand, worktreePath, 120_000);
              if (initResult.spawnError || initResult.timedOut || initResult.exitCode !== 0) {
                throw new Error(configuredCommandErrorMessage(initResult));
              }
              await this.store.logEntry(task.id, "Worktree init command completed", settings.worktreeInitCommand, this.currentRunContext);
            } catch (err: unknown) {
              const execError = err instanceof Error ? err : new Error(String(err));
              const message = "stderr" in execError && typeof (execError as Record<string, unknown>).stderr === "string"
                ? String((execError as Record<string, unknown>).stderr)
                : execError.message;
              await this.store.logEntry(task.id, `Worktree init command failed: ${message}`, undefined, this.currentRunContext);
            }
          }

          // Run setup script for fresh worktrees (after worktreeInitCommand)
          if (settings.setupScript) {
            const scriptCommand = settings.scripts?.[settings.setupScript];
            if (scriptCommand) {
              try {
                const setupResult = await runConfiguredCommand(scriptCommand, worktreePath, 120_000);
                if (setupResult.spawnError || setupResult.timedOut || setupResult.exitCode !== 0) {
                  throw new Error(configuredCommandErrorMessage(setupResult));
                }
                await this.store.logEntry(task.id, `Setup script '${settings.setupScript}' completed`, scriptCommand, this.currentRunContext);
              } catch (err: unknown) {
                const execError = err instanceof Error ? err : new Error(String(err));
                const message = "stderr" in execError && typeof (execError as Record<string, unknown>).stderr === "string"
                  ? String((execError as Record<string, unknown>).stderr)
                  : execError.message;
                await this.store.logEntry(task.id, `Setup script '${settings.setupScript}' failed: ${message}`, undefined, this.currentRunContext);
              }
            } else {
              await this.store.logEntry(task.id, `Setup script '${settings.setupScript}' not found in scripts map — skipping`, undefined, this.currentRunContext);
            }
          }
        }
      } else if (task.worktree) {
        // Task already had a worktree assigned and it exists on disk — reuse it
        executorLog.log(`Reusing existing worktree: ${worktreePath}`);
      } else {
        // Directory exists at generated path but task has no worktree — create via normal flow
        const created = await this.createWorktree(branchName, worktreePath, task.id);
        worktreePath = created.path;
        await this.store.updateTask(task.id, { worktree: created.path, branch: created.branch });
        // Audit trail: record worktree creation and branch creation (FN-1404)
        await audit.git({ type: "worktree:create", target: created.path, metadata: { branch: created.branch } });
        await audit.git({ type: "branch:create", target: created.branch });
      }

      // Capture the base commit SHA for diff computation whenever a task
      // starts with a newly assigned worktree. Recycled worktrees must
      // overwrite any prior task baseline instead of inheriting it.
      if (!isResume) {
        try {
          const { stdout } = await execAsync("git rev-parse HEAD", {
            cwd: worktreePath,
            encoding: "utf-8",
          });
          const baseCommitSha = stdout.trim();
          await this.store.updateTask(task.id, { baseCommitSha });
          executorLog.log(`${task.id}: captured baseCommitSha ${baseCommitSha.slice(0, 7)}`);
          // Audit trail: record base commit capture for later diff computation (FN-1404)
          await audit.git({ type: "commit:create", target: baseCommitSha, metadata: { purpose: "base" } });
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          executorLog.log(`Failed to capture baseCommitSha for ${task.id}: ${errorMessage}`);
          // Non-fatal: task can continue without baseCommitSha
        }
      }

      this.activeWorktrees.set(task.id, worktreePath);
      executorLog.log(`${task.id}: worktree ready at ${worktreePath}`);

      this.options.onStart?.(task, worktreePath);

      const detail = await this.store.getTask(task.id);
      executorLog.log(`${task.id}: fetched task detail (${detail.steps.length} steps, prompt length=${detail.prompt?.length ?? 0})`);

      // Initialize steps from PROMPT.md if empty
      if (detail.steps.length === 0) {
        const steps = await this.store.parseStepsFromPrompt(task.id);
        if (steps.length > 0) {
          await this.store.updateStep(task.id, 0, "pending");
        }
      }

      // ── Step-Session vs Single-Session execution path ──
      // When runStepsInNewSessions is enabled, each step runs in its own
      // fresh agent session via StepSessionExecutor. Otherwise, the existing
      // single-session flow runs all steps in one monolithic session.

      // Build skill selection context early so it's available in both paths
      const skillContext = await buildSessionSkillContext({
        agentStore: this.options.agentStore!,
        task: detail,
        sessionPurpose: "executor",
        projectRootDir: this.rootDir,
      });

      if (settings.runStepsInNewSessions) {
        // ── Step-Session Path ──────────────────────────────────────────
        executorLog.log(`${task.id}: using step-session mode (maxParallel=${settings.maxParallelSteps ?? 2})`);

        const stepExecutor = new StepSessionExecutor({
          store: this.store,
          taskDetail: detail,
          worktreePath,
          rootDir: this.rootDir,
          settings,
          semaphore: this.options.semaphore,
          stuckTaskDetector: this.options.stuckTaskDetector,
          pluginRunner: this.options.pluginRunner,
          // Pass skill selection context from the main executor session
          skillSelection: skillContext.skillSelectionContext,
          // Pass agentStore and messageStore for delegation and messaging tools
          agentStore: this.options.agentStore,
          messageStore: this.options.messageStore,
          onStepStart: (stepIndex) => {
            this.options.stuckTaskDetector?.recordProgress(task.id);
            try {
              this.store.updateStep(task.id, stepIndex, "in-progress").catch((err) => {
                executorLog.warn(`${task.id}: failed to update step ${stepIndex} status to in-progress: ${err}`);
              });
            } catch (err) {
              executorLog.warn(`${task.id}: failed to update step ${stepIndex} status to in-progress: ${err}`);
            }
          },
          onStepComplete: (stepIndex, result) => {
            executorLog.log(`${task.id}: step ${stepIndex} ${result.success ? "succeeded" : "failed"} (${result.retries} retries)`);
            try {
              this.store.updateStep(task.id, stepIndex, result.success ? "done" : "skipped").catch((err) => {
                executorLog.warn(`${task.id}: failed to update step ${stepIndex} status: ${err}`);
              });
            } catch (err) {
              executorLog.warn(`${task.id}: failed to update step ${stepIndex} status: ${err}`);
            }
          },
        });
        this.activeStepExecutors.set(task.id, stepExecutor);

        const stepWork = async () => {
          const results = await stepExecutor.executeAll();

          // Check abort conditions after execution completes
          if (this.depAborted.has(task.id)) {
            this.depAborted.delete(task.id);
            await this.handleDepAbortCleanup(task.id, worktreePath);
            return;
          }
          if (this.pausedAborted.has(task.id)) {
            this.pausedAborted.delete(task.id);
            await this.store.logEntry(task.id, "Execution paused — step sessions terminated, moved to todo", undefined, this.currentRunContext);
            await this.store.moveTask(task.id, "todo");
            return;
          }
          if (this.stuckAborted.has(task.id)) {
            stuckRequeue = this.stuckAborted.get(task.id) ?? true;
            this.stuckAborted.delete(task.id);
            return;
          }

          const allSuccess = results.every(r => r.success);
          if (allSuccess) {
            const updatedTask = await this.store.getTask(task.id);
            const modifiedFiles = await this.captureModifiedFiles(worktreePath, updatedTask.baseCommitSha);
            if (modifiedFiles.length > 0) {
              await this.store.updateTask(task.id, { modifiedFiles });
              executorLog.log(`${task.id}: captured ${modifiedFiles.length} modified files`);
              // Audit trail: record filesystem mutation (FN-1404)
              await audit.filesystem({ type: "file:capture-modified", target: task.id, metadata: { files: modifiedFiles } });
            }

            const workflowResult = await this.runWorkflowSteps(task, worktreePath, settings);
            if (!workflowResult.allPassed) {
              // Check if revision was requested
              if (workflowResult.revisionRequested) {
                await this.handleWorkflowRevisionRequest(task, worktreePath, workflowResult.feedback, workflowResult.stepName);
                return;
              }
              // Try to fix workflow step failures with retries
              const retried = await this.handleWorkflowStepFailure(task, worktreePath, workflowResult.feedback, workflowResult.stepName || "Unknown");
              if (retried) {
                return; // Retry scheduled
              }
              // Retries exhausted - send back to in-progress for remediation
              await this.sendTaskBackForFix(task, worktreePath, workflowResult.feedback, workflowResult.stepName || "Unknown", "Workflow step failed");
              return;
            }

            // Reset workflowStepRetries counter on success
            await this.store.updateTask(task.id, { workflowStepRetries: undefined });

            await this.store.moveTask(task.id, "in-review");
            // Audit trail: record task move (FN-1404)
            await audit.database({ type: "task:move", target: task.id, metadata: { to: "in-review" } });
            executorLog.log(`✓ ${task.id} completed (step-session) → in-review`);
            this.options.onComplete?.(task);
          } else {
            const failedSteps = results.filter(r => !r.success);
            const errorSummary = failedSteps.map(r => `Step ${r.stepIndex}: ${r.error || "unknown error"}`).join("; ");
            await this.store.updateTask(task.id, { status: "failed", error: errorSummary });
            await this.store.moveTask(task.id, "in-review");
            executorLog.log(`✗ ${task.id} step-session failed → in-review: ${errorSummary}`);
            this.options.onError?.(task, new Error(errorSummary));
          }
        };

        const retryableStepWork = () => withRateLimitRetry(stepWork, {
          onRetry: (attempt, delayMs, error) => {
            const delaySec = Math.round(delayMs / 1000);
            executorLog.warn(`⏳ ${task.id} rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
            this.store.logEntry(task.id, `Rate limited — retry ${attempt} in ${delaySec}s`, undefined, this.currentRunContext).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              executorLog.warn(`${task.id} failed to log rate-limit retry: ${msg}`);
            });
          },
        });

        try {
          if (this.options.semaphore) {
            await this.options.semaphore.run(retryableStepWork, PRIORITY_EXECUTE);
          } else {
            await retryableStepWork();
          }
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          if (this.depAborted.has(task.id)) {
            this.depAborted.delete(task.id);
            await this.handleDepAbortCleanup(task.id, worktreePath);
          } else if (this.pausedAborted.has(task.id)) {
            this.pausedAborted.delete(task.id);
            await this.store.logEntry(task.id, "Execution paused during step-session", undefined, this.currentRunContext);
            await this.store.moveTask(task.id, "todo");
          } else if (this.stuckAborted.has(task.id)) {
            stuckRequeue = this.stuckAborted.get(task.id) ?? true;
            this.stuckAborted.delete(task.id);
          } else if (this.options.usageLimitPauser && isUsageLimitError(errorMessage)) {
            await this.options.usageLimitPauser.onUsageLimitHit("executor", task.id, errorMessage);
          } else if (isTransientError(errorMessage)) {
            const decision = computeRecoveryDecision({
              recoveryRetryCount: task.recoveryRetryCount,
              nextRecoveryAt: task.nextRecoveryAt,
            });

            if (decision.shouldRetry) {
              const attempt = decision.nextState.recoveryRetryCount;
              const delay = formatDelay(decision.delayMs);
              if (!isSilentTransientError(errorMessage)) {
                executorLog.warn(`⚡ ${task.id} transient error — retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}: ${errorMessage}`);
                await this.store.logEntry(task.id, `Transient error (retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}): ${errorMessage}`, undefined, this.currentRunContext);
              }
              if (worktreePath && existsSync(worktreePath)) {
                try {
                  await execAsync(`git worktree remove "${worktreePath}" --force`, { cwd: this.rootDir });
                  // Audit trail: record worktree removal (FN-1404)
                  await audit.git({ type: "worktree:remove", target: worktreePath });
                } catch (wtErr: unknown) {
                  const msg = wtErr instanceof Error ? wtErr.message : String(wtErr);
                  executorLog.warn(`${task.id}: worktree removal failed during transient-error retry cleanup (${worktreePath}): ${msg}`);
                }
              }
              await this.store.updateTask(task.id, {
                recoveryRetryCount: decision.nextState.recoveryRetryCount,
                nextRecoveryAt: decision.nextState.nextRecoveryAt,
                worktree: null,
                branch: null,
              });
              await this.store.moveTask(task.id, "todo");
              stuckRequeue = null; // Prevent outer finally from re-processing
              return;
            }

            executorLog.error(`✗ ${task.id} transient error retries exhausted: ${errorMessage}`);
            await this.store.updateTask(task.id, {
              status: "failed",
              error: errorMessage,
              recoveryRetryCount: null,
              nextRecoveryAt: null,
            });
            await this.store.moveTask(task.id, "in-review");
            executorLog.log(`✗ ${task.id} transient retries exhausted → in-review`);
            this.options.onError?.(task, err instanceof Error ? err : new Error(errorMessage));
          } else {
            executorLog.error(`✗ ${task.id} step-session execution failed:`, errorMessage);
            await this.store.logEntry(task.id, `Step-session execution failed: ${errorMessage}`, undefined, this.currentRunContext);
            await this.store.updateTask(task.id, { status: "failed", error: errorMessage });
            await this.store.moveTask(task.id, "in-review");
            executorLog.log(`✗ ${task.id} step-session execution failed → in-review`);
            this.options.onError?.(task, err instanceof Error ? err : new Error(errorMessage));
          }
        } finally {
          this.executing.delete(task.id);
          this.loopRecoveryState.delete(task.id);
          // Wrap cleanup in try/catch so activeStepExecutors.delete() always runs.
          // If cleanup() throws, the executor continues to clean up the in-memory map
          // and requeue logic without leaking the reference.
          try {
            await stepExecutor.cleanup();
          } catch (cleanupErr) {
            executorLog.warn(`StepSessionExecutor cleanup failed for ${task.id}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
          }
          this.activeStepExecutors.delete(task.id);

          // Stuck-requeue: clean up worktree and move to todo
          if (stuckRequeue === true) {
            try {
              // Reset steps whose work was never committed before destroying the worktree
              const latestTask = await this.store.getTask(task.id);
              await this.resetStepsIfWorkLost(latestTask);

              if (worktreePath && existsSync(worktreePath)) {
                try {
                  await execAsync(`git worktree remove "${worktreePath}" --force`, { cwd: this.rootDir });
                } catch (wtErr: unknown) {
                  const msg = wtErr instanceof Error ? wtErr.message : String(wtErr);
                  executorLog.warn(`${task.id}: worktree removal failed during stuck-requeue cleanup (${worktreePath}): ${msg}`);
                }
              }
              await this.store.updateTask(task.id, { status: "stuck-killed", worktree: null, branch: null });
              if (task.column !== "todo") {
                await this.store.moveTask(task.id, "todo");
                executorLog.log(`${task.id} moved to todo for retry after stuck kill`);
              }
            } catch (err: unknown) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              executorLog.error(`Failed to requeue stuck task ${task.id}: ${errorMessage}`);
            }
            stuckRequeue = null; // Prevent outer finally from re-processing
          }
        }
        // Step-session path handled completely — return before outer catch/finally
        return;
      }

      // ── Single-Session Path (default) ────────────────────────────────
      // Build custom tools for the worker
      // Track the last code review verdict per step so we can enforce REVISE
      // (block task_update status="done" until the agent re-reviews and gets APPROVE).
      const codeReviewVerdicts = new Map<number, ReviewVerdict>();

      let wasPaused = false;
      // Mutable ref — populated after createKbAgent, tools access lazily via closure
      const sessionRef: { current: AgentSession | null } = { current: null };
      const stepCheckpoints = new Map<number, string>();

      const stuckDetector = this.options.stuckTaskDetector;
      const assignedAgentId = detail.assignedAgentId?.trim();
      const reflectionTools = this.options.reflectionService && settings.reflectionEnabled && assignedAgentId
        ? [createReflectOnPerformanceTool(this.options.reflectionService, assignedAgentId)]
        : [];
      const assignedAgent = assignedAgentId && this.options.agentStore
        ? await this.options.agentStore.getAgent(assignedAgentId).catch(() => null)
        : null;

      const customTools = [
        this.createTaskUpdateTool(task.id, codeReviewVerdicts, sessionRef, stepCheckpoints, stuckDetector),
        this.createTaskLogTool(task.id),
        this.createTaskCreateTool(),
        this.createTaskAddDepTool(task.id),
        this.createTaskDoneTool(task.id, () => { taskDone = true; }),
        this.createReviewStepTool(task.id, worktreePath, detail.prompt, codeReviewVerdicts, sessionRef, stepCheckpoints, detail, stuckDetector),
        this.createSpawnAgentTool(task.id, worktreePath, settings),
        this.createTaskDocumentWriteTool(task.id),
        this.createTaskDocumentReadTool(task.id),
        ...createMemoryTools(this.rootDir, settings, assignedAgent ? {
          agentMemory: {
            agentId: assignedAgent.id,
            agentName: assignedAgent.name,
            memory: assignedAgent.memory,
          },
        } : undefined),
        // Conditionally add agent self-reflection when enabled and task has an assigned agent.
        ...reflectionTools,
        // Agent delegation tools — discover and delegate work to other agents.
        ...(this.options.agentStore ? [
          createListAgentsTool(this.options.agentStore),
          createDelegateTaskTool(this.options.agentStore, this.store),
        ] : []),
        // Messaging tools — allows executor agents to send and receive messages.
        ...(this.options.messageStore && assignedAgentId ? [
          createSendMessageTool(this.options.messageStore, assignedAgentId),
          createReadMessagesTool(this.options.messageStore, assignedAgentId),
        ] : []),
        // Add plugin tools from PluginRunner
        ...(this.options.pluginRunner?.getPluginTools() ?? []),
      ];

      const agentLogger = new AgentLogger({
        store: this.store,
        taskId: task.id,
        agent: "executor",
        onAgentText: (taskId, delta) => {
          stuckDetector?.recordActivity(taskId);
          this.options.onAgentText?.(taskId, delta);
        },
        onAgentTool: (taskId, toolName) => {
          stuckDetector?.recordActivity(taskId);
          this.options.onAgentTool?.(taskId, toolName);
        },
      });

      const agentWork = async () => {
        // Resolve model settings using canonical lane hierarchy:
        // 1. Task override pair (modelProvider + modelId)
        // 2. Project execution override pair (executionProvider + executionModelId)
        // 3. Global execution lane pair (executionGlobalProvider + executionGlobalModelId)
        // 4. Default pair (defaultProvider + defaultModelId)
        const executorProvider = detail.modelProvider && detail.modelId
          ? detail.modelProvider
          : (settings.executionProvider && settings.executionModelId
              ? settings.executionProvider
              : (settings.executionGlobalProvider && settings.executionGlobalModelId
                  ? settings.executionGlobalProvider
                  : settings.defaultProvider));
        const executorModelId = detail.modelProvider && detail.modelId
          ? detail.modelId
          : (settings.executionProvider && settings.executionModelId
              ? settings.executionModelId
              : (settings.executionGlobalProvider && settings.executionGlobalModelId
                  ? settings.executionGlobalModelId
                  : settings.defaultModelId));
        const executorFallbackProvider = settings.fallbackProvider;
        const executorFallbackModelId = settings.fallbackModelId;
        const executorThinkingLevel = detail.thinkingLevel ?? settings.defaultThinkingLevel;

        // Determine whether we're resuming a previous session (pause/resume)
        // or starting fresh. Use file-based sessions so conversation state
        // persists across pause/unpause cycles.
        const isResuming = !!task.sessionFile && existsSync(task.sessionFile);
        const sessionManager = isResuming
          ? SessionManager.open(task.sessionFile!)
          : SessionManager.create(worktreePath);

        executorLog.log(`${task.id}: creating agent session (provider=${executorProvider ?? "default"}, model=${executorModelId ?? "default"}, resuming=${isResuming})`);

        // Resolve per-agent custom instructions for the executor role
        const executorInstructions = await this.resolveInstructionsForRole("executor");
        const executorSystemPrompt = buildSystemPromptWithInstructions(
          getExecutorSystemPrompt(settings),
          executorInstructions,
        );

        // sessionFile must be let because it's destructured alongside session which is reassigned
        // eslint-disable-next-line prefer-const
        let { session, sessionFile } = await createKbAgent({
          cwd: worktreePath,
          systemPrompt: executorSystemPrompt,
          tools: "coding",
          customTools,
          onText: agentLogger.onText,
          onThinking: agentLogger.onThinking,
          onToolStart: agentLogger.onToolStart,
          onToolEnd: agentLogger.onToolEnd,
          defaultProvider: executorProvider,
          defaultModelId: executorModelId,
          fallbackProvider: executorFallbackProvider,
          fallbackModelId: executorFallbackModelId,
          defaultThinkingLevel: executorThinkingLevel,
          sessionManager,
          // Skill selection: use assigned agent skills if available, otherwise role fallback
          ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
        });

        if (isResuming) {
          executorLog.log(`${task.id}: resumed session from ${task.sessionFile}`);
          await this.store.logEntry(task.id, `Resumed agent session after unpause (model: ${describeModel(session)})`, undefined, this.currentRunContext);
        } else {
          executorLog.log(`${task.id}: using model ${describeModel(session)}`);
          await this.store.logEntry(task.id, `Executor using model: ${describeModel(session)}`, undefined, this.currentRunContext);
          // Persist session file path so pause/resume can reopen it
          if (sessionFile) {
            await this.store.updateTask(task.id, { sessionFile });
          }
        }

        // Make session available to custom tools (task_update checkpoint capture, review_step rewind)
        sessionRef.current = session;

        // Register session so the pause listener can terminate it
        // Initialize with empty set of seen comments
        const seenSteeringIds = new Set<string>();
        if (detail.comments) {
          for (const comment of detail.comments) {
            seenSteeringIds.add(comment.id);
          }
        }
        this.activeSessions.set(task.id, {
          session,
          seenSteeringIds,
          lastModelProvider: detail.modelProvider,
          lastModelId: detail.modelId,
        });

        // Register with stuck task detector for heartbeat monitoring
        stuckDetector?.trackTask(task.id, session);
        executorLog.log(`${task.id}: session registered (model=${describeModel(session)}, stuckDetector=${!!stuckDetector})`);

        // Invoke plugin onAgentRunStart hook (fire-and-forget)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        void (this.options.pluginRunner as any)?.invokeHook("onAgentRunStart", task.id);

        try {
          // Record activity on prompt start (heartbeat for stuck detection)
          stuckDetector?.recordActivity(task.id);

          executorLog.log(`${task.id}: calling promptWithFallback()...`);
          if (isResuming) {
            // Session already has full conversation history — just tell the
            // agent it was paused and should pick up where it left off.
            await promptWithFallback(session, [
              "Your session was paused and has now been resumed.",
              "Continue working on the task from where you left off.",
              "Review the current state of your worktree and proceed with the next pending step.",
            ].join("\n"));
          } else {
            const agentPrompt = buildExecutionPrompt(detail, this.rootDir, settings, worktreePath);
            await promptWithFallback(session, agentPrompt);
          }

          // Re-raise errors that pi-coding-agent swallowed after exhausting retries.
          // session.prompt() resolves normally even when retries are exhausted —
          // the error is stored on session.state.error instead of being thrown.
          checkSessionError(session);

          // Check if proactive context compaction is needed based on token cap setting.
          // This runs after the main prompt completes to avoid interrupting active work.
          try {
            const capResult = await this.tokenCapDetector.checkAndCompact(
              session,
              task.id,
              settings.tokenCap,
              async (s) => {
                const compactResult = await compactSessionContext(s);
                if (compactResult) {
                  await this.store.logEntry(
                    task.id,
                    `Context compacted at ${compactResult.tokensBefore} tokens (token cap: ${settings.tokenCap})`,
                    undefined,
                    this.currentRunContext,
                  );
                }
                return compactResult;
              },
            );
            if (capResult.triggered) {
              executorLog.log(`${task.id} token cap check: ${capResult.message}`);
            }
          } catch (err) {
            executorLog.log(`${task.id} token cap check failed (non-fatal): ${err}`);
          }

          // If loop recovery is pending (compact-and-resume was triggered by
          // handleLoopDetected), consume the pending state and resume with a
          // deterministic prompt. The session has already been compacted, so
          // we just need to send a fresh prompt to continue execution.
          const loopState = this.loopRecoveryState.get(task.id);
          if (loopState?.pending) {
            loopState.pending = false;
            executorLog.log(`${task.id} consuming loop recovery — resuming with fresh context`);
            await this.store.logEntry(task.id, "Resuming execution after context compaction — taking a different approach", undefined, this.currentRunContext);

            // Reset activity tracking so the detector doesn't immediately re-trigger
            stuckDetector?.recordProgress(task.id);

            const resumePrompt = [
              "Your conversation was compacted because you were looping without making progress.",
              "Review the current state of the worktree carefully:",
              "1. Check `git log --oneline` to see what's already been committed",
              "2. Read the files you were working on to understand current state",
              "3. Review the PROMPT.md steps to see which are still pending",
              "",
              "Take a DIFFERENT approach from what you were doing before.",
              "If the current step is complete, call task_update to mark it done and move to the next step.",
              "If you're stuck on a problem, try a simpler or alternative solution.",
              "",
              "Continue the task from where you left off.",
            ].join("\n");

            await promptWithFallback(session, resumePrompt);
            checkSessionError(session);
          }

          // If dependency was added during execution, discard worktree and move to triage
          if (this.depAborted.has(task.id)) {
            this.depAborted.delete(task.id);
            await this.handleDepAbortCleanup(task.id, worktreePath);
            return;
          }

          // If paused during execution, move to todo so the scheduler can resume
          // after unpause. This path fires when session.dispose() causes the
          // prompt to resolve gracefully instead of throwing.
          if (this.pausedAborted.has(task.id)) {
            this.pausedAborted.delete(task.id);
            wasPaused = true;
            if (await this.shouldFinalizeCompletedTask(task.id, taskDone)) {
              executorLog.log(`${task.id} paused after completion (graceful session exit) — finalizing to in-review`);
              await this.store.logEntry(task.id, "Execution paused after completion — finalizing to in-review");
              await this.store.moveTask(task.id, "in-review");
              this.options.onComplete?.(task);
            } else {
              executorLog.log(`${task.id} paused (graceful session exit) — moving to todo`);
              await this.store.logEntry(task.id, "Execution paused — session preserved for resume, moved to todo");
              await this.store.moveTask(task.id, "todo");
            }
            return;
          }

          // If the stuck task detector disposed the session and the agent exited
          // cleanly, stop here. The requeue is deferred to the finally block
          // (after this.executing is cleared) to prevent a race where the
          // scheduler re-dispatches while the old execution guard is still set.
          if (this.stuckAborted.has(task.id)) {
            stuckRequeue = this.stuckAborted.get(task.id) ?? true;
            this.stuckAborted.delete(task.id);
            executorLog.log(`${task.id} terminated by stuck task detector (graceful session exit)`);
            return;
          }

          // If the agent didn't explicitly call task_done, check whether
          // all steps are already complete — treat as implicit done to avoid
          // unnecessary retry sessions for context-overflow / compaction cases.
          if (!taskDone) {
            const implicitCheck = await this.store.getTask(task.id);
            if (implicitCheck.steps.length > 0 &&
                implicitCheck.steps.every((s) => s.status === "done" || s.status === "skipped")) {
              taskDone = true;
              executorLog.log(`${task.id} all steps done — treating as implicit task_done`);
              await this.store.logEntry(task.id, "All steps complete — implicit task_done (agent did not call tool explicitly)", undefined, this.currentRunContext);
            }
          }

          if (taskDone) {
            // Capture modified files before running workflow steps
            const updatedTask = await this.store.getTask(task.id);
            const modifiedFiles = await this.captureModifiedFiles(worktreePath, updatedTask.baseCommitSha);
            if (modifiedFiles.length > 0) {
              await this.store.updateTask(task.id, { modifiedFiles });
              executorLog.log(`${task.id}: captured ${modifiedFiles.length} modified files`);
            }

            // Run workflow steps before moving to in-review
            const workflowResult = await this.runWorkflowSteps(task, worktreePath, settings);
            if (!workflowResult.allPassed) {
              // Check if revision was requested
              if (workflowResult.revisionRequested) {
                await this.handleWorkflowRevisionRequest(task, worktreePath, workflowResult.feedback, workflowResult.stepName);
                return;
              }
              // Try to fix workflow step failures with retries
              const retried = await this.handleWorkflowStepFailure(task, worktreePath, workflowResult.feedback, workflowResult.stepName || "Unknown");
              if (retried) {
                return; // Retry scheduled
              }
              // Retries exhausted - send back to in-progress for remediation
              await this.sendTaskBackForFix(task, worktreePath, workflowResult.feedback, workflowResult.stepName || "Unknown", "Workflow step failed");
              return;
            }

            // Reset workflowStepRetries counter on success
            await this.store.updateTask(task.id, { workflowStepRetries: undefined });

            await this.store.moveTask(task.id, "in-review");
            executorLog.log(`✓ ${task.id} completed → in-review`);
            this.options.onComplete?.(task);
          } else {
            // Agent finished without calling task_done — retry once with a fresh session
            executorLog.log(`⚠ ${task.id} finished without task_done — retrying with new session`);
            await this.store.logEntry(task.id, "Agent finished without calling task_done — retrying with new session", undefined, this.currentRunContext);

            // Dispose old session and create a fresh one
            this.activeSessions.delete(task.id);
            session.dispose();

            const { session: retrySession, sessionFile: retrySessionFile } = await createKbAgent({
              cwd: worktreePath,
              systemPrompt: executorSystemPrompt,
              tools: "coding",
              customTools,
              onText: agentLogger.onText,
              onThinking: agentLogger.onThinking,
              onToolStart: agentLogger.onToolStart,
              onToolEnd: agentLogger.onToolEnd,
              defaultProvider: executorProvider,
              defaultModelId: executorModelId,
              fallbackProvider: executorFallbackProvider,
              fallbackModelId: executorFallbackModelId,
              defaultThinkingLevel: executorThinkingLevel,
              sessionManager: SessionManager.create(worktreePath),
              // Skill selection: use assigned agent skills if available, otherwise role fallback
              ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
            });
            // Update session file for the retry session (so pause/resume works)
            if (retrySessionFile) {
              this.store.updateTask(task.id, { sessionFile: retrySessionFile }).catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                executorLog.warn(`${task.id} failed to persist retry sessionFile: ${msg}`);
              });
            }

            // Reassign so finally{} disposes the correct session
            session = retrySession;
            sessionRef.current = retrySession;
            this.activeSessions.set(task.id, {
              session: retrySession,
              seenSteeringIds,
              lastModelProvider: detail.modelProvider,
              lastModelId: detail.modelId,
            });
            stuckDetector?.trackTask(task.id, retrySession);

            const retryPrompt = [
              "Your previous session ended without calling the task_done tool.",
              "The task may already be complete — review the current state of the worktree and either:",
              "1. If the work is done, call task_done with a summary of what was accomplished.",
              "2. If there is remaining work, finish it and then call task_done.",
              "",
              "Original task:",
              buildExecutionPrompt(detail, this.rootDir, settings, worktreePath),
            ].join("\n");

            stuckDetector?.recordActivity(task.id);
            await promptWithFallback(retrySession, retryPrompt);
            checkSessionError(retrySession);

            // If the agent didn't explicitly call task_done, check whether
            // all steps are already complete — if so, treat as implicit done.
            // This handles context-overflow / compaction scenarios where the
            // agent lost awareness of the task_done tool but finished the work.
            if (!taskDone) {
              const implicitCheck = await this.store.getTask(task.id);
              if (implicitCheck.steps.length > 0 &&
                  implicitCheck.steps.every((s) => s.status === "done" || s.status === "skipped")) {
                taskDone = true;
                executorLog.log(`${task.id} all steps done — treating as implicit task_done`);
                await this.store.logEntry(task.id, "All steps complete — implicit task_done (agent did not call tool explicitly)", undefined, this.currentRunContext);
              }
            }

            if (taskDone) {
              const updatedTask = await this.store.getTask(task.id);
              const modifiedFiles = await this.captureModifiedFiles(worktreePath, updatedTask.baseCommitSha);
              if (modifiedFiles.length > 0) {
                await this.store.updateTask(task.id, { modifiedFiles });
                executorLog.log(`${task.id}: captured ${modifiedFiles.length} modified files`);
              }

              const workflowResult = await this.runWorkflowSteps(task, worktreePath, settings);
              if (!workflowResult.allPassed) {
                // Check if revision was requested
                if (workflowResult.revisionRequested) {
                  await this.handleWorkflowRevisionRequest(task, worktreePath, workflowResult.feedback, workflowResult.stepName);
                  return;
                }
                // Hard failure - send back to in-progress for remediation
                await this.sendTaskBackForFix(task, worktreePath, workflowResult.feedback, workflowResult.stepName || "Unknown", "Workflow step failed on retry");
                return;
              }

              await this.store.moveTask(task.id, "in-review");
              executorLog.log(`✓ ${task.id} completed on retry → in-review`);
              this.options.onComplete?.(task);
            } else {
              const errorMessage = "Agent finished without calling task_done (after retry)";
              await this.store.updateTask(task.id, { status: "failed", error: errorMessage });
              await this.store.logEntry(task.id, `${errorMessage} — moved to in-review for inspection`, undefined, this.currentRunContext);
              await this.store.moveTask(task.id, "in-review");
              executorLog.log(`✗ ${task.id} failed after retry — no task_done → in-review`);
              this.options.onError?.(task, new Error(errorMessage));
            }
          }
        } finally {
          this.activeSessions.delete(task.id);
          stuckDetector?.untrackTask(task.id);
          await agentLogger.flush();
          session.dispose();
          // Terminate all spawned child agents when parent session ends
          await this.terminateAllChildren(task.id);
          // Clear session file when task completes or fails (not when paused —
          // the file is preserved so unpause can resume the conversation).
          // Check both the local flag (graceful exit) and the instance set
          // (error path where dispose caused prompt to throw).
          if (!wasPaused && !this.pausedAborted.has(task.id)) {
            this.store.updateTask(task.id, { sessionFile: null }).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              executorLog.warn(`${task.id} failed to clear sessionFile: ${msg}`);
            });
          }
          // Invoke plugin onAgentRunEnd hook (fire-and-forget)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          void (this.options.pluginRunner as any)?.invokeHook("onAgentRunEnd", task.id);
        }
      };

      const retryableWork = () => withRateLimitRetry(agentWork, {
        onRetry: (attempt, delayMs, error) => {
          const delaySec = Math.round(delayMs / 1000);
          executorLog.warn(`⏳ ${task.id} rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
          this.store.logEntry(task.id, `Rate limited — retry ${attempt} in ${delaySec}s`, undefined, this.currentRunContext).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            executorLog.warn(`${task.id} failed to log rate-limit retry: ${msg}`);
          });
        },
      });

      if (this.options.semaphore) {
        await this.options.semaphore.run(retryableWork, PRIORITY_EXECUTE);
      } else {
        await retryableWork();
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (this.depAborted.has(task.id)) {
        // Dependency added mid-execution — discard worktree and move to triage
        this.depAborted.delete(task.id);
        await this.handleDepAbortCleanup(task.id, worktreePath);
      } else if (errorMessage.includes("Invalid transition")) {
        // Task was moved by user/process while executor was running — already in desired state
        // This check must come before pausedAborted since it's more specific
        const transitionMatch = errorMessage.match(/Invalid transition: '([^']+)' → '([^']+)'/);
        const fromColumn = transitionMatch?.[1] ?? "unknown";
        const toColumn = transitionMatch?.[2] ?? "unknown";
        const logMessage = `Task already moved from '${fromColumn}' — skipping transition to '${toColumn}'`;
        executorLog.log(`${task.id} ${logMessage}`);
        await this.store.logEntry(task.id, logMessage, errorMessage, this.currentRunContext);
        if (fromColumn === "in-review" && toColumn === "in-review") {
          try {
            const finalizeResult = await this.finalizeAlreadyReviewedTask(task.id);
            executorLog.log(`${task.id} duplicate in-review finalization result: ${finalizeResult}`);
          } catch (finalizeErr: unknown) {
            const finalizeErrMessage = finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr);
            executorLog.warn(`${task.id} failed to finalize duplicate in-review transition: ${finalizeErrMessage}`);
          }
        }
        // Task finished successfully (just already moved), so call onComplete
        this.options.onComplete?.(task);
      } else if (this.pausedAborted.has(task.id)) {
        // Task was paused mid-execution — clean up worktree and move to todo
        this.pausedAborted.delete(task.id);
        if (await this.shouldFinalizeCompletedTask(task.id, taskDone)) {
          executorLog.log(`${task.id} paused after completion — finalizing to in-review`);
          await this.store.logEntry(task.id, "Execution paused after completion — finalizing to in-review", undefined, this.currentRunContext);
          await this.store.moveTask(task.id, "in-review");
          this.options.onComplete?.(task);
        } else {
          executorLog.log(`${task.id} paused — moving to todo`);
          if (worktreePath && existsSync(worktreePath)) {
            try {
              await execAsync(`git worktree remove "${worktreePath}" --force`, { cwd: this.rootDir });
              executorLog.log(`Removed old worktree for paused task: ${worktreePath}`);
              // Audit trail: record worktree removal (FN-1404)
              await audit.git({ type: "worktree:remove", target: worktreePath });
            } catch (cleanupErr: unknown) {
              const cleanupErrMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
              executorLog.warn(`Failed to remove old worktree ${worktreePath}: ${cleanupErrMessage}`);
            }
          }
          await this.store.updateTask(task.id, { worktree: undefined, branch: undefined });
          await this.store.logEntry(task.id, "Execution paused — agent terminated, moved to todo", undefined, this.currentRunContext);
          await this.store.moveTask(task.id, "todo");
        }
      } else if (this.stuckAborted.has(task.id)) {
        // Task was killed by stuck task detector — defer requeue to finally block
        // (after this.executing is cleared) to prevent re-dispatch race.
        stuckRequeue = this.stuckAborted.get(task.id) ?? true;
        this.stuckAborted.delete(task.id);
        executorLog.log(`${task.id} terminated by stuck task detector — will ${stuckRequeue ? "retry" : "not retry (budget exhausted)"}`);
      } else {
        // Context-limit error reached the executor after promptWithFallback's auto-compaction
        // already attempted to recover. Try reduced-prompt retry as a second-level fallback.
        // This is bounded to 1 attempt to prevent infinite retry loops.
        const loopState = this.loopRecoveryState.get(task.id);
        const loopAttempts = loopState?.attempts ?? 0;

        if (isContextLimitError(errorMessage) && loopAttempts < 1) {
          const activeEntry = this.activeSessions.get(task.id);
          if (activeEntry) {
            executorLog.log(`${task.id} context limit error after auto-compaction — attempting reduced-prompt retry`);
            await this.store.logEntry(task.id, `Context limit error after auto-compaction — attempting reduced-prompt retry: ${errorMessage}`, undefined, this.currentRunContext);

            this.loopRecoveryState.set(task.id, { attempts: loopAttempts + 1, pending: false });

            try {
              this.options.stuckTaskDetector?.recordProgress(task.id);
              // Build a reduced prompt that's simpler and shorter to avoid context overflow
              const reducedPrompt = [
                "Your previous attempt hit the context window limit.",
                "Focus on completing the task efficiently with minimal context:",
                "1. Review git status and git log to see what's been done",
                "2. Identify the most critical remaining work",
                "3. Complete it with a simpler, more focused approach",
                "",
                "Do not repeat what's already been done. Just complete the task and call task_done.",
              ].join("\n");

              await promptWithFallback(activeEntry.session, reducedPrompt);
              checkSessionError(activeEntry.session);

              // Reduced-prompt retry succeeded — return to let the finally block clean up
              // without marking the task as failed.
              executorLog.log(`${task.id} reduced-prompt recovery succeeded — continuing`);
              await this.store.logEntry(task.id, "Reduced-prompt recovery succeeded — continuing execution", undefined, this.currentRunContext);
              return;
            } catch (reducedErr: unknown) {
              const reducedErrorMessage = reducedErr instanceof Error ? reducedErr.message : String(reducedErr);
              executorLog.error(`${task.id} reduced-prompt recovery also failed: ${reducedErrorMessage}`);
              await this.store.logEntry(task.id, `Reduced-prompt recovery failed: ${reducedErrorMessage}`, undefined, this.currentRunContext);
              // Fall through to mark task as failed
            }
          }
        } else if (this.options.usageLimitPauser && isUsageLimitError(errorMessage)) {
          await this.options.usageLimitPauser.onUsageLimitHit("executor", task.id, errorMessage);
        } else if (isTransientError(errorMessage)) {
          // Transient network/infrastructure error — use bounded recovery policy
          const decision = computeRecoveryDecision({
            recoveryRetryCount: task.recoveryRetryCount,
            nextRecoveryAt: task.nextRecoveryAt,
          });

          if (decision.shouldRetry) {
            const attempt = decision.nextState.recoveryRetryCount;
            const delay = formatDelay(decision.delayMs);
            // Silent transient errors (e.g., "request was aborted") are noisy — skip logging
            if (!isSilentTransientError(errorMessage)) {
              executorLog.warn(`⚡ ${task.id} transient error — retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}: ${errorMessage}`);
              await this.store.logEntry(task.id, `Transient error (retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}): ${errorMessage}`, undefined, this.currentRunContext);
            }
            // Clean up the old worktree so the retry gets a fresh one
            if (worktreePath && existsSync(worktreePath)) {
              try {
                await execAsync(`git worktree remove "${worktreePath}" --force`, { cwd: this.rootDir });
                executorLog.log(`Removed old worktree for transient retry: ${worktreePath}`);
                // Audit trail: record worktree removal (FN-1404)
                await audit.git({ type: "worktree:remove", target: worktreePath });
              } catch (cleanupErr: unknown) {
                const cleanupErrMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
                executorLog.warn(`Failed to remove old worktree ${worktreePath}: ${cleanupErrMessage}`);
              }
            }
            await this.store.updateTask(task.id, {
              recoveryRetryCount: decision.nextState.recoveryRetryCount,
              nextRecoveryAt: decision.nextState.nextRecoveryAt,
              worktree: null,
              branch: null,
            });
            await this.store.moveTask(task.id, "todo");
            return;
          }

          // Recovery budget exhausted — escalate to real failure
          executorLog.error(`✗ ${task.id} transient error retries exhausted (${MAX_RECOVERY_RETRIES} attempts): ${errorMessage}`);
          await this.store.logEntry(task.id, `Transient error retries exhausted after ${MAX_RECOVERY_RETRIES} attempts: ${errorMessage}`, undefined, this.currentRunContext);
          await this.store.updateTask(task.id, {
            status: "failed",
            error: errorMessage,
            recoveryRetryCount: null,
            nextRecoveryAt: null,
          });
          await this.store.moveTask(task.id, "in-review");
          executorLog.log(`✗ ${task.id} transient retries exhausted → in-review`);
          this.options.onError?.(task, err instanceof Error ? err : new Error(errorMessage));
          return;
        }
        executorLog.error(`✗ ${task.id} execution failed:`, errorMessage);
        await this.store.logEntry(task.id, `Execution failed: ${errorMessage}`, undefined, this.currentRunContext);
        await this.store.updateTask(task.id, { status: "failed", error: errorMessage });
        await this.store.moveTask(task.id, "in-review");
        executorLog.log(`✗ ${task.id} execution failed → in-review`);
        this.options.onError?.(task, err instanceof Error ? err : new Error(errorMessage));
      }
    } finally {
      this.executing.delete(task.id);
      // Clear run context at end of execute() lifecycle
      this.currentRunContext = undefined;

      // Terminate all spawned child agents on ALL exit paths.
      // This must run here (in the outer finally) rather than only in agentWork's
      // finally block, because failures during worktree creation or before
      // agentWork is entered leave children orphaned with no other cleanup path.
      try {
        await this.terminateAllChildren(task.id);
      } catch (err) {
        executorLog.warn(`terminateAllChildren failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Reset loop recovery state at end of execute() lifecycle.
      // State is in-memory and per-run — should not persist across attempts.
      this.loopRecoveryState.delete(task.id);

      // Requeue stuck-killed task AFTER this.executing is cleared.
      // This prevents the race where the scheduler re-dispatches the task
      // (via task:moved → execute()) while the old execution guard is still set,
      // which caused the new execute() call to silently no-op, stranding the
      // task in "in-progress" with no active session or worktree.
      if (stuckRequeue === true) {
        try {
          // Reset steps whose work was never committed before destroying the worktree
          const latestTask = await this.store.getTask(task.id);
          await this.resetStepsIfWorkLost(latestTask);

          // Clean up the old worktree so the retry gets a fresh one
          if (worktreePath && existsSync(worktreePath)) {
            try {
              await execAsync(`git worktree remove "${worktreePath}" --force`, { cwd: this.rootDir });
              executorLog.log(`Removed old worktree for stuck-killed retry: ${worktreePath}`);
              // Audit trail: record worktree removal (FN-1404)
              await audit.git({ type: "worktree:remove", target: worktreePath });
            } catch (cleanupErr: unknown) {
              const cleanupErrMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
              executorLog.warn(`Failed to remove old worktree ${worktreePath}: ${cleanupErrMessage}`);
            }
          }
          await this.store.updateTask(task.id, { status: "stuck-killed", worktree: null, branch: null });
          // Only move to todo if not already there. The task.column check uses the
          // captured task object from execute() start — if the task was already in "todo"
          // when execute() started (e.g., resumed orphan), we skip the redundant move.
          if (task.column !== "todo") {
            await this.store.moveTask(task.id, "todo");
            // Audit trail: record task move (FN-1404)
            await audit.database({ type: "task:move", target: task.id, metadata: { to: "todo" } });
            executorLog.log(`${task.id} moved to todo for retry after stuck kill`);
          } else {
            executorLog.log(`${task.id} already in todo — skipping redundant move`);
          }
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          executorLog.error(`Failed to requeue stuck task ${task.id}: ${errorMessage}`);
        }
      }
    }
  }

  // ── Custom tools for the worker agent ──────────────────────────────

  private createTaskUpdateTool(
    taskId: string,
    codeReviewVerdicts: Map<number, ReviewVerdict>,
    sessionRef: { current: AgentSession | null },
    stepCheckpoints: Map<number, string>,
    stuckDetector?: StuckTaskDetector,
  ): ToolDefinition {
    const store = this.store;
    return {
      name: "task_update",
      label: "Update Step",
      description:
        "Update a step's status. Call before starting a step (in-progress), " +
        "after completing it (done), or to skip it (skipped). " +
        "The board updates in real-time.",
      parameters: taskUpdateParams,
      execute: async (_id: string, params: Static<typeof taskUpdateParams>) => {
        const { step, status } = params;

        // Record step progress for stuck task detection.
        // Step transitions (in-progress, done, skipped) indicate real progress
        // and reset the loop detection counter. Generic activity (text deltas,
        // tool calls) is tracked separately via recordActivity in AgentLogger.
        if (status === "in-progress" || status === "done" || status === "skipped") {
          stuckDetector?.recordProgress(taskId);
        }

        // Enforce code review REVISE: block advancing to "done" when the last
        // code review for this step returned REVISE. The agent must fix the
        // issues and call review_step(type="code") again before proceeding.
        if (status === "done" && codeReviewVerdicts.get(step) === "REVISE") {
          return {
            content: [{
              type: "text" as const,
              text: `Cannot mark Step ${step} as done — the last code review returned REVISE. ` +
                `Fix the issues from the code review, commit your changes, and call ` +
                `review_step(step=${step}, type="code") again. The step can only advance ` +
                `after the code review passes.`,
            }],
            details: {},
          };
        }

        // Capture session checkpoint when a step starts, so RETHINK can rewind to it
        if (status === "in-progress" && sessionRef.current) {
          const leafId = sessionRef.current.sessionManager.getLeafId();
          if (leafId) {
            stepCheckpoints.set(step, leafId);
          }
        }

        const task = await store.updateStep(taskId, step, status as StepStatus);
        const stepInfo = task.steps[step];
        const progress = task.steps.filter((s) => s.status === "done").length;
        return {
          content: [{
            type: "text" as const,
            text: `Step ${step} (${stepInfo.name}) → ${status}. Progress: ${progress}/${task.steps.length} done.`,
          }],
          details: {},
        };
      },
    };
  }

  private createTaskLogTool(taskId: string): ToolDefinition {
    return sharedCreateTaskLogTool(this.store, taskId);
  }

  private createTaskCreateTool(): ToolDefinition {
    return sharedCreateTaskCreateTool(this.store);
  }

  private createTaskDocumentWriteTool(taskId: string): ToolDefinition {
    return sharedCreateTaskDocumentWriteTool(this.store, taskId);
  }

  private createTaskDocumentReadTool(taskId: string): ToolDefinition {
    return sharedCreateTaskDocumentReadTool(this.store, taskId);
  }

  private createTaskAddDepTool(taskId: string): ToolDefinition {
    const store = this.store;
    return {
      name: "task_add_dep",
      label: "Add Dependency",
      description:
        "Declare a dependency on an existing task. Use when you discover " +
        "mid-execution that another task must be completed first. " +
        "Adding a dependency to an in-progress task will stop execution " +
        "and discard current work, so confirm=true is required. " +
        "Without confirm=true, a warning is returned first.",
      parameters: taskAddDepParams,
      execute: async (_id: string, params: Static<typeof taskAddDepParams>) => {
        const targetId = params.task_id;

        // Prevent self-dependency
        if (targetId === taskId) {
          return {
            content: [{
              type: "text" as const,
              text: `Cannot add self-dependency: ${taskId} cannot depend on itself.`,
            }],
            details: {},
          };
        }

        // Validate target task exists
        try {
          await store.getTask(targetId);
        } catch {
          return {
            content: [{
              type: "text" as const,
              text: `Task ${targetId} not found. Cannot add dependency on a non-existent task.`,
            }],
            details: {},
          };
        }

        // Read current task to get existing dependencies
        const currentTask = await store.getTask(taskId);
        const existing = currentTask.dependencies;

        // Dedup check
        if (existing.includes(targetId)) {
          return {
            content: [{
              type: "text" as const,
              text: `${targetId} is already a dependency of ${taskId}. No changes made.`,
            }],
            details: {},
          };
        }

        // Confirmation gate — destructive action for in-progress tasks
        if (!params.confirm) {
          return {
            content: [{
              type: "text" as const,
              text: `Warning: adding a dependency to an in-progress task will stop execution and discard current work. Call with confirm=true to proceed.`,
            }],
            details: {},
          };
        }

        // Add the dependency
        await store.updateTask(taskId, { dependencies: [...existing, targetId] });
        await store.logEntry(taskId, `Added dependency on ${targetId} — stopping execution for re-specification`);

        // Trigger abort flow (same pattern as pausedAborted)
        this.depAborted.add(taskId);
        const activeSession = this.activeSessions.get(taskId);
        activeSession?.session.dispose();

        // Also terminate step sessions if active
        const stepExecutor = this.activeStepExecutors.get(taskId);
        if (stepExecutor) {
          stepExecutor.terminateAllSessions().catch(err =>
            executorLog.warn(`Failed to terminate step sessions for dep-abort ${taskId}: ${err}`)
          );
        }

        return {
          content: [{
            type: "text" as const,
            text: `Added dependency on ${targetId}. Stopping execution — task will move to triage for re-specification.`,
          }],
          details: {},
        };
      },
    };
  }

  private createTaskDoneTool(taskId: string, onDone: () => void): ToolDefinition {
    const store = this.store;
    return {
      name: "task_done",
      label: "Mark Task Done",
      description:
        "Signal that all steps are complete, tests pass, and documentation is updated. " +
        "Call this as the final action after finishing all work. " +
        "Automatically marks all remaining steps as done. " +
        "Optionally provide a summary of what was changed/fixed.",
      parameters: Type.Object({
        summary: Type.Optional(Type.String({
          description: "Optional summary of what was changed/fixed and what was verified (2-4 sentences)",
        })),
      }),
      execute: async (_id: string, params: { summary?: string }) => {
        const task = await store.getTask(taskId);
        const completionBlocker = await this.getTaskCompletionBlocker(task);
        if (completionBlocker) {
          return {
            content: [{
              type: "text" as const,
              text: `Cannot mark task done yet — ${completionBlocker}. Resolve the blocker before calling task_done().`,
            }],
            details: {},
          };
        }

        onDone();

        // Mark all pending/in-progress steps as done
        for (let i = 0; i < task.steps.length; i++) {
          if (task.steps[i].status !== "done" && task.steps[i].status !== "skipped") {
            await store.updateStep(taskId, i, "done");
          }
        }
        // Save summary if provided
        if (params.summary) {
          await store.updateTask(taskId, { summary: params.summary });
        }
        await store.logEntry(taskId, "Task marked done by agent");
        const successMessage = params.summary
          ? "Task marked complete with summary. All steps done. Moving to in-review."
          : "Task marked complete. All steps done. Moving to in-review.";
        return {
          content: [{ type: "text" as const, text: successMessage }],
          details: {},
        };
      },
    };
  }

  /**
   * Create the review_step tool for the executor agent.
   *
   * When the reviewer returns a RETHINK verdict, this tool:
   * 1. Runs `git reset --hard <baseline>` to revert file changes
   * 2. Rewinds the conversation to the pre-step checkpoint via `session.navigateTree()`
   * 3. Resets the step status to "pending"
   * 4. Returns a re-prompt instructing the agent to take a different approach
   */
  private createReviewStepTool(
    taskId: string,
    worktreePath: string,
    promptContent: string,
    codeReviewVerdicts: Map<number, ReviewVerdict>,
    sessionRef: { current: AgentSession | null },
    stepCheckpoints: Map<number, string>,
    detail: TaskDetail,
    stuckDetector?: StuckTaskDetector,
  ): ToolDefinition {
    const store = this.store;
    const options = this.options;

    return {
      name: "review_step",
      label: "Review Step",
      description:
        "Spawn a reviewer agent to evaluate your plan or code for a step. " +
        "Returns APPROVE, REVISE, RETHINK, or UNAVAILABLE. " +
        "Call at step boundaries based on the task's review level. " +
        "Skip reviews for Step 0 (Preflight) and the final documentation step.",
      parameters: reviewStepParams,
      execute: async (_toolCallId: string, params: Static<typeof reviewStepParams>) => {
        const { step, type: reviewType, step_name, baseline } = params;

        reviewerLog.log(`${taskId}: ${reviewType} review for Step ${step} (${step_name})`);
        await store.logEntry(taskId, `${reviewType} review requested for Step ${step} (${step_name})`);

        try {
          const settings = await store.getSettings();
          const result = await reviewStep(
            worktreePath, taskId, step, step_name,
            reviewType, promptContent, baseline,
            {
              onText: (delta) => options.onAgentText?.(taskId, delta),
              // Execution defaults as final fallback
              defaultProvider: settings.defaultProvider,
              defaultModelId: settings.defaultModelId,
              fallbackProvider: settings.fallbackProvider,
              fallbackModelId: settings.fallbackModelId,
              defaultThinkingLevel: detail.thinkingLevel ?? settings.defaultThinkingLevel,
              // Task-level validator override (from task)
              taskValidatorProvider: detail.validatorModelProvider,
              taskValidatorModelId: detail.validatorModelId,
              // Project-level validator override
              projectValidatorProvider: settings.validatorProvider,
              projectValidatorModelId: settings.validatorModelId,
              // Project-level validator fallback
              projectValidatorFallbackProvider: settings.validatorFallbackProvider,
              projectValidatorFallbackModelId: settings.validatorFallbackModelId,
              // Global validator lane
              globalValidatorProvider: settings.validatorGlobalProvider,
              globalValidatorModelId: settings.validatorGlobalModelId,
              store,
              taskId,
              task: detail,
              agentPrompts: settings.agentPrompts,
              agentStore: this.options.agentStore,
              rootDir: this.rootDir,
              settings,
            },
          );

          await store.logEntry(
            taskId,
            `${reviewType} review Step ${step}: ${result.verdict}`,
            result.summary,
          );
          reviewerLog.log(`${taskId}: Step ${step} ${reviewType} → ${result.verdict}`);
          stuckDetector?.recordProgress(taskId);

          // Track code review verdicts for enforcement. Plan reviews remain
          // advisory — only code reviews write to the verdict map.
          if (reviewType === "code") {
            if (result.verdict === "REVISE") {
              codeReviewVerdicts.set(step, "REVISE");
            } else if (result.verdict === "APPROVE") {
              codeReviewVerdicts.delete(step);
            }
          }

          let text: string;
          switch (result.verdict) {
            case "APPROVE": text = "APPROVE"; break;
            case "REVISE":
              if (reviewType === "code") {
                text = `REVISE — this step cannot be marked done until the code review passes.\n\n` +
                  `Fix the issues below, commit your changes, and call review_step(step=${step}, ` +
                  `type="code", step_name="${step_name}", baseline="<new SHA>") again.\n\n${result.review}`;
              } else {
                text = `REVISE\n\n${result.review}`;
              }
              break;
            case "RETHINK": {
              // For code reviews: git reset to baseline to revert file changes
              // For plan reviews: skip git reset (no code has been written yet)
              if (reviewType === "code" && baseline) {
                try {
                  await execAsync(`git reset --hard ${baseline}`, { cwd: worktreePath });
                  executorLog.log(`${taskId}: RETHINK — git reset --hard ${baseline}`);
                } catch (gitErr: unknown) {
                  const gitErrMessage = gitErr instanceof Error ? gitErr.message : String(gitErr);
                  executorLog.error(`${taskId}: RETHINK git reset failed: ${gitErrMessage}`);
                }
              } else if (reviewType === "code") {
                executorLog.log(`${taskId}: RETHINK — no baseline SHA, skipping git reset`);
              }

              // Rewind conversation to pre-step checkpoint
              const checkpointId = stepCheckpoints.get(step);
              if (checkpointId && sessionRef.current) {
                try {
                  await sessionRef.current.navigateTree(checkpointId, { summarize: false });
                  executorLog.log(`${taskId}: RETHINK — session rewound to checkpoint ${checkpointId}`);
                } catch (rewindErr: unknown) {
                  const msg = rewindErr instanceof Error ? rewindErr.message : String(rewindErr);
                  executorLog.warn(`${taskId}: RETHINK navigateTree rewind failed, falling back to branchWithSummary: ${msg}`);
                  // Fallback to branchWithSummary
                  try {
                    sessionRef.current.sessionManager.branchWithSummary(
                      checkpointId,
                      `RETHINK: ${result.summary || "Approach rejected by reviewer"}`,
                    );
                    executorLog.log(`${taskId}: RETHINK — branched from checkpoint ${checkpointId}`);
                  } catch (branchErr: unknown) {
                    const branchErrMessage = branchErr instanceof Error ? branchErr.message : String(branchErr);
                    executorLog.error(`${taskId}: RETHINK session rewind failed: ${branchErrMessage}`);
                  }
                }
              } else {
                executorLog.log(`${taskId}: RETHINK — no session checkpoint for step ${step}, skipping rewind`);
              }

              // Reset step status to pending
              await store.updateStep(taskId, step, "pending");

              if (reviewType === "plan") {
                await store.logEntry(
                  taskId,
                  `RETHINK: Step ${step} plan rewound — session checkpoint ${checkpointId || "N/A"}`,
                  result.summary,
                );
                text = `RETHINK\n\nYour plan was rejected. Here is why:\n\n${result.review}\n\nTake a different approach to planning this step. Do NOT repeat the rejected strategy.`;
              } else {
                await store.logEntry(
                  taskId,
                  `RETHINK: Step ${step} rewound — git reset to ${baseline || "N/A"}, session checkpoint ${checkpointId || "N/A"}`,
                  result.summary,
                );
                text = `RETHINK\n\nYour previous approach was rejected. Here is why:\n\n${result.review}\n\nTake a different approach. Do NOT repeat the rejected strategy. Re-read the step requirements and find an alternative solution.`;
              }
              break;
            }
            default: text = "UNAVAILABLE — reviewer did not produce a usable verdict.";
          }

          return { content: [{ type: "text" as const, text }], details: {} };
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          reviewerLog.error(`${taskId}: review failed: ${errorMessage}`);
          await store.logEntry(taskId, `${reviewType} review failed: ${errorMessage}`);
          return {
            content: [{ type: "text" as const, text: `UNAVAILABLE — reviewer error: ${errorMessage}` }],
            details: {},
          };
        }
      },
    };
  }

  /**
   * Clean up after a dep-abort: remove worktree, delete branch, move task to triage.
   * Shared between the try-block (graceful return) and catch-block (error) paths.
   */
  private async handleDepAbortCleanup(taskId: string, worktreePath: string): Promise<void> {
    executorLog.log(`${taskId} dependency added — work discarded, moved to triage for re-specification`);

    // Remove worktree
    try {
      await execAsync(`git worktree remove "${worktreePath}" --force`, { cwd: this.rootDir });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`${taskId}: failed to remove worktree during dep-abort cleanup (${worktreePath}): ${msg}`);
    }

    // Delete the branch — use stored branch name if available, fall back to convention
    const task = await this.store.getTask(taskId);
    const branch = task.branch || `fusion/${taskId.toLowerCase()}`;
    try {
      await execAsync(`git branch -D "${branch}"`, { cwd: this.rootDir });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`${taskId}: failed to delete branch during dep-abort cleanup (${branch}): ${msg}`);
    }

    // Clear worktree tracking
    this.activeWorktrees.delete(taskId);

    // Update task: clear worktree and status, move to triage
    await this.store.updateTask(taskId, { worktree: null, status: null });
    await this.store.moveTask(taskId, "triage");
    await this.store.logEntry(taskId, "Execution stopped — work discarded, moved to triage for re-specification");
  }

  /**
   * Handle a workflow step revision request.
   * 
   * This method:
   * 1. Updates PROMPT.md with "Workflow Revision Instructions" section
   * 2. Resets task execution state (all steps reset to pending)
   * 3. Schedules fresh execution to run after current guard unwinds
   * 
   * The task stays in "in-progress" and is scheduled for a fresh executor pass.
   */
  private async handleWorkflowRevisionRequest(
    task: Task,
    worktreePath: string,
    feedback: string,
    stepName: string,
  ): Promise<void> {
    executorLog.log(`${task.id}: workflow revision requested by step "${stepName}"`);
    await this.store.logEntry(
      task.id,
      `Workflow step "${stepName}" requested revision — resetting execution state`,
      feedback,
    );

    // 1. Update PROMPT.md with revision instructions
    await this.injectWorkflowRevisionInstructions(task, feedback);

    // 2. Reset all steps to pending for fresh execution
    const updatedTask = await this.store.getTask(task.id);
    for (let i = 0; i < updatedTask.steps.length; i++) {
      if (updatedTask.steps[i].status !== "pending") {
        await this.store.updateStep(task.id, i, "pending");
      }
    }

    // 3. Clear any session file so we get a fresh session
    await this.store.updateTask(task.id, {
      status: null,
      sessionFile: null,
    });

    // 4. Schedule fresh execution after guard unwinds
    // This prevents the race condition where the scheduler re-dispatches
    // while the old execution guard is still set.
    executorLog.log(`${task.id}: scheduling fresh execution after revision request`);
    setTimeout(async () => {
      try {
        // Move task to todo briefly, then back to in-progress to trigger fresh execution
        // The task is already in in-progress, so we need to:
        // 1. Move to todo (this triggers the guard to clear)
        // 2. Move back to in-progress (this triggers fresh execution)
        await this.store.moveTask(task.id, "todo");
        await this.store.moveTask(task.id, "in-progress");
        executorLog.log(`${task.id}: revision rerun scheduled — moved to todo then in-progress`);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        executorLog.error(`${task.id}: failed to schedule revision rerun: ${errorMessage}`);
        // Fallback: log entry and let scheduler pick it up on next tick
        await this.store.logEntry(
          task.id,
          "Workflow revision requested — executor ready for fresh execution",
        );
      }
    }, 0);
  }

  /**
   * Inject or update the "Workflow Revision Instructions" section in PROMPT.md.
   * This section contains feedback from workflow steps that requested revisions.
   * The section is replaced entirely to avoid accumulation of old feedback.
   */
  private async injectWorkflowRevisionInstructions(task: Task, feedback: string): Promise<void> {
    const promptPath = join(this.store.getFusionDir(), "tasks", task.id, "PROMPT.md");
    
    // Read existing PROMPT.md
    let content: string;
    try {
      content = await readFile(promptPath, "utf-8");
    } catch {
      executorLog.warn(`${task.id}: PROMPT.md not found at ${promptPath}, skipping revision injection`);
      return;
    }

    // Check for existing Workflow Revision Instructions section
    const revisionSectionHeader = "## Workflow Revision Instructions";
    const revisionSectionContent = `${revisionSectionHeader}

The following feedback was received from quality gates and requires implementation changes:

${feedback}

**Important:** This is a revision request — address the feedback above by making the necessary code changes, then mark all affected steps as done and call task_done() when complete.

`;

    let newContent: string;
    if (content.includes(revisionSectionHeader)) {
      // Replace existing section
      const sectionRegex = new RegExp(
        `${revisionSectionHeader}[\\s\\S]*?(?=\\n## |\\n# |$)`,
        "i"
      );
      if (sectionRegex.test(content)) {
        newContent = content.replace(sectionRegex, revisionSectionContent);
      } else {
        // Fallback: append at end
        newContent = content + "\n" + revisionSectionContent;
      }
    } else {
      // Append new section before any closing markers or at end
      // Look for common markers like "## Acceptance Criteria" or just append
      const acceptanceCriteriaMatch = content.match(/\n##\s+Acceptance Criteria\n/);
      if (acceptanceCriteriaMatch) {
        const insertIdx = acceptanceCriteriaMatch.index!;
        newContent = content.slice(0, insertIdx) + "\n" + revisionSectionContent + content.slice(insertIdx);
      } else {
        newContent = content + "\n" + revisionSectionContent;
      }
    }

    // Write updated content
    try {
      await writeFile(promptPath, newContent);
      executorLog.log(`${task.id}: injected workflow revision instructions into PROMPT.md`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.error(`${task.id}: failed to inject revision instructions: ${errorMessage}`);
    }
  }

  /**
   * Handle workflow step hard failures by retrying execution up to MAX_WORKFLOW_STEP_RETRIES times.
   * This gives the executor a chance to fix workflow step failures automatically before
   * moving the task to in-review with failed status.
   *
   * @returns true if a retry was scheduled, false if retries are exhausted
   */
  private async handleWorkflowStepFailure(
    task: Task,
    worktreePath: string,
    failureFeedback: string,
    stepName: string,
  ): Promise<boolean> {
    const currentRetries = task.workflowStepRetries ?? 0;

    if (currentRetries >= MAX_WORKFLOW_STEP_RETRIES) {
      // Retries exhausted — caller should fall through to hard failure
      executorLog.warn(`${task.id}: workflow step "${stepName}" failed — retries exhausted (${MAX_WORKFLOW_STEP_RETRIES}/${MAX_WORKFLOW_STEP_RETRIES})`);
      return false;
    }

    const retryCount = currentRetries + 1;
    executorLog.log(`${task.id}: workflow step "${stepName}" failed — retry ${retryCount}/${MAX_WORKFLOW_STEP_RETRIES} (executor will attempt to fix)`);

    // 1. Update the workflowStepRetries counter on the task
    await this.store.updateTask(task.id, {
      workflowStepRetries: retryCount,
    });

    // 2. Inject failure feedback into PROMPT.md
    await this.injectWorkflowStepFailureInstructions(task, failureFeedback, stepName, retryCount);

    // 3. Reset all steps to pending for fresh execution
    const updatedTask = await this.store.getTask(task.id);
    for (let i = 0; i < updatedTask.steps.length; i++) {
      if (updatedTask.steps[i].status !== "pending") {
        await this.store.updateStep(task.id, i, "pending");
      }
    }

    // 4. Clear any session file so we get a fresh session
    await this.store.updateTask(task.id, {
      status: null,
      sessionFile: null,
    });

    // 5. Schedule fresh execution after guard unwinds
    executorLog.log(`${task.id}: scheduling fresh execution after workflow step failure (retry ${retryCount}/${MAX_WORKFLOW_STEP_RETRIES})`);
    setTimeout(async () => {
      try {
        // Move task to todo briefly, then back to in-progress to trigger fresh execution
        await this.store.moveTask(task.id, "todo");
        await this.store.moveTask(task.id, "in-progress");
        executorLog.log(`${task.id}: workflow step retry scheduled — moved to todo then in-progress`);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        executorLog.error(`${task.id}: failed to schedule workflow step retry: ${errorMessage}`);
        // Fallback: log entry and let scheduler pick it up on next tick
        await this.store.logEntry(
          task.id,
          "Workflow step failed — executor ready for fresh execution",
        );
      }
    }, 0);

    return true;
  }

  /**
   * Send a task back to in-progress after verification failure.
   * Injects failure feedback into PROMPT.md, resets steps, clears session,
   * and schedules a move to todo → in-progress after the executing guard clears.
   */
  private async sendTaskBackForFix(
    task: Task,
    worktreePath: string,
    failureFeedback: string,
    stepName: string,
    reason: string,
  ): Promise<void> {
    const taskId = task.id;

    // 1. Add a task comment explaining the failure
    await this.store.addTaskComment(
      taskId,
      `${reason}. The failing workflow step was "${stepName}". ` +
      `Feedback:\n${failureFeedback}\n\n` +
      `Please fix the issues so the verification can pass on the next attempt.`,
      "agent",
    );

    // 2. Log an entry explaining the task was sent back
    await this.store.logEntry(
      taskId,
      `${reason} — moved back to in-progress for remediation`,
    );

    // 3. Inject failure feedback into PROMPT.md using the existing method
    // Pass MAX_WORKFLOW_STEP_RETRIES to indicate retries are exhausted (shows "3/3 (0 remaining)")
    await this.injectWorkflowStepFailureInstructions(task, failureFeedback, stepName, MAX_WORKFLOW_STEP_RETRIES);

    // 4. Reset all steps to pending
    const updatedTask = await this.store.getTask(taskId);
    for (let i = 0; i < updatedTask.steps.length; i++) {
      if (updatedTask.steps[i].status !== "pending") {
        await this.store.updateStep(taskId, i, "pending");
      }
    }

    // 5. Clear error/status/session fields and reset workflow step retries
    await this.store.updateTask(taskId, {
      status: null,
      error: null,
      sessionFile: null,
      workflowStepRetries: 0,
    });

    // 6. Schedule the move after the guard unwinds (per guard-unwind requirement)
    setTimeout(async () => {
      try {
        await this.store.moveTask(taskId, "todo");
        await this.store.moveTask(taskId, "in-progress");
        executorLog.log(`${taskId}: sent back to in-progress for remediation`);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        executorLog.error(`${taskId}: failed to move back to in-progress: ${errorMessage}`);
      }
    }, 0);
  }

  /**
   * Inject or update the "Workflow Step Failure" section in PROMPT.md.
   * This section contains failure feedback from workflow steps that hard-failed.
   * The section is replaced entirely to avoid accumulation of old feedback.
   */
  private async injectWorkflowStepFailureInstructions(
    task: Task,
    failureFeedback: string,
    stepName: string,
    retryCount: number,
  ): Promise<void> {
    const promptPath = join(this.store.getFusionDir(), "tasks", task.id, "PROMPT.md");

    // Read existing PROMPT.md
    let content: string;
    try {
      content = await readFile(promptPath, "utf-8");
    } catch {
      executorLog.warn(`${task.id}: PROMPT.md not found at ${promptPath}, skipping workflow failure injection`);
      return;
    }

    const remainingRetries = MAX_WORKFLOW_STEP_RETRIES - retryCount;
    const failureSectionHeader = "## Workflow Step Failure";
    const failureSectionContent = `${failureSectionHeader}

The following workflow step failed and requires implementation fixes:

**Step:** ${stepName}

**Failure Feedback:**
${failureFeedback}

**Retry:** ${retryCount}/${MAX_WORKFLOW_STEP_RETRIES} (${remainingRetries} remaining)

**Important:** This is a workflow step failure — fix the issues above by making the necessary code changes. The task has been sent back to in-progress for remediation. The executor will attempt to fix the issues on the next pass.

`;

    let newContent: string;
    if (content.includes(failureSectionHeader)) {
      // Replace existing section
      const sectionRegex = new RegExp(
        `${failureSectionHeader}[\\s\\S]*?(?=\\n## |\\n# |$)`,
        "i"
      );
      if (sectionRegex.test(content)) {
        newContent = content.replace(sectionRegex, failureSectionContent);
      } else {
        // Fallback: append at end
        newContent = content + "\n" + failureSectionContent;
      }
    } else {
      // Remove any existing Workflow Revision Instructions section first (conflicting state)
      const revisionSectionHeader = "## Workflow Revision Instructions";
      if (content.includes(revisionSectionHeader)) {
        const revisionRegex = new RegExp(
          `${revisionSectionHeader}[\\s\\S]*?(?=\\n## |\\n# |$)`,
          "i"
        );
        content = content.replace(revisionRegex, "");
      }

      // Append new section before any closing markers or at end
      const acceptanceCriteriaMatch = content.match(/\n##\s+Acceptance Criteria\n/);
      if (acceptanceCriteriaMatch) {
        const insertIdx = acceptanceCriteriaMatch.index!;
        newContent = content.slice(0, insertIdx) + "\n" + failureSectionContent + content.slice(insertIdx);
      } else {
        newContent = content + "\n" + failureSectionContent;
      }
    }

    // Write updated content
    try {
      await writeFile(promptPath, newContent);
      executorLog.log(`${task.id}: injected workflow step failure instructions into PROMPT.md (retry ${retryCount}/${MAX_WORKFLOW_STEP_RETRIES})`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.error(`${task.id}: failed to inject workflow step failure instructions: ${errorMessage}`);
    }
  }

  /**
   * Capture the list of files modified during agent execution.
   * Uses git diff against the stored baseCommitSha to determine what changed.
   * Returns an empty array if no changes or if git commands fail.
   */
  private async captureModifiedFiles(worktreePath: string, baseCommitSha?: string): Promise<string[]> {
    try {
      // Determine the base reference for diff
      // If baseCommitSha is stored, use it; otherwise fall back to merge-base with HEAD
      let baseRef = baseCommitSha;
      if (!baseRef) {
        // Try to find merge-base with main/master as fallback
        try {
          const { stdout } = await execAsync("git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main", {
            cwd: worktreePath,
            encoding: "utf-8",
          });
          baseRef = stdout.trim();
        } catch (mergeBaseErr: unknown) {
          const mergeBaseMsg = mergeBaseErr instanceof Error ? mergeBaseErr.message : String(mergeBaseErr);
          executorLog.warn(`Failed merge-base lookup for diff base in ${worktreePath}, trying HEAD~1 fallback: ${mergeBaseMsg}`);
          // If merge-base fails, use HEAD~1 as last resort
          try {
            const { stdout } = await execAsync("git rev-parse HEAD~1", {
              cwd: worktreePath,
              encoding: "utf-8",
            });
            baseRef = stdout.trim();
          } catch {
            executorLog.log(`Could not determine base commit for diff in ${worktreePath}`);
            return [];
          }
        }
      }

      if (!baseRef) {
        return [];
      }

      // Get list of modified files using git diff --name-only
      const { stdout } = await execAsync(`git diff --name-only ${baseRef}..HEAD`, {
        cwd: worktreePath,
        encoding: "utf-8",
      });
      const output = stdout.trim();

      if (!output) {
        return [];
      }

      return output.split("\n").filter(Boolean);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.log(`Failed to capture modified files: ${errorMessage}`);
      return [];
    }
  }

  // ── Worktree management ────────────────────────────────────────────

  /**
   * Create a git worktree at `path` on a new branch.
   *
   * @param branch — Branch name (e.g., `fusion/fn-042`)
   * @param path — Absolute worktree directory path
   * @param startPoint — Optional git ref to branch from (e.g., `fusion/fn-041`).
   *   When provided, the worktree starts from that ref instead of HEAD.
   */
  /**
   * Run workflow step agents sequentially after main task execution completes.
   * Each workflow step spawns a separate agent with the step's prompt.
   * Returns structured result: all passed, all passed (true), failed (false), or revision requested.
   */
  private async runWorkflowSteps(
    task: Task,
    worktreePath: string,
    settings: Settings,
  ): Promise<WorkflowStepResult> {
    // Check if task has enabled workflow steps
    const currentTask = await this.store.getTask(task.id);
    if (!currentTask.enabledWorkflowSteps?.length) return { allPassed: true };

    const workflowStepIds = currentTask.enabledWorkflowSteps;
    const results: import("@fusion/core").WorkflowStepResult[] = [];

    for (const wsId of workflowStepIds) {
      const ws = await this.store.getWorkflowStep(wsId);
      if (!ws) {
        await this.store.logEntry(task.id, `[pre-merge] Workflow step ${wsId} not found — skipping`);
        results.push({
          workflowStepId: wsId,
          workflowStepName: "Unknown",
          phase: "pre-merge",
          status: "skipped",
          output: "Workflow step definition not found",
        });
        await this.store.updateTask(task.id, { workflowStepResults: results });
        continue;
      }

      // Normalize legacy steps: undefined phase → "pre-merge"
      const stepPhase = ws.phase || "pre-merge";

      // Skip post-merge steps — those run in the merger after merge
      if (stepPhase === "post-merge") continue;

      // Normalize legacy steps without mode to prompt-mode
      const stepMode: "prompt" | "script" = ws.mode || "prompt";

      // Skip validation per mode
      if (stepMode === "prompt" && !ws.prompt?.trim()) {
        await this.store.logEntry(task.id, `[pre-merge] Workflow step '${ws.name}' has no prompt — skipping`);
        results.push({
          workflowStepId: ws.id,
          workflowStepName: ws.name,
          phase: stepPhase,
          status: "skipped",
          output: "No prompt configured for this workflow step",
        });
        await this.store.updateTask(task.id, { workflowStepResults: results });
        continue;
      }

      if (stepMode === "script" && !ws.scriptName?.trim()) {
        await this.store.logEntry(task.id, `[pre-merge] Workflow step '${ws.name}' has no scriptName — skipping`);
        results.push({
          workflowStepId: ws.id,
          workflowStepName: ws.name,
          phase: stepPhase,
          status: "skipped",
          output: "No scriptName configured for this workflow step",
        });
        await this.store.updateTask(task.id, { workflowStepResults: results });
        continue;
      }

      await this.store.logEntry(task.id, `[pre-merge] Starting workflow step: ${ws.name} (${stepMode} mode)`);
      executorLog.log(`${task.id} — [pre-merge] running workflow step: ${ws.name} (${stepMode} mode)`);

      const startedAt = new Date().toISOString();

      // Push pending entry BEFORE execution so dashboard can show live status
      results.push({
        workflowStepId: ws.id,
        workflowStepName: ws.name,
        phase: stepPhase,
        status: "pending",
        startedAt,
      });
      await this.store.updateTask(task.id, { workflowStepResults: results });

      try {
        const result: WorkflowStepOutcome = stepMode === "script"
          ? await this.executeScriptWorkflowStep(task, ws, worktreePath, settings)
          : await this.executeWorkflowStep(task, ws, worktreePath, settings);
        const completedAt = new Date().toISOString();

        if (result.success) {
          await this.store.logEntry(task.id, `[pre-merge] Workflow step completed: ${ws.name}`);
          executorLog.log(`${task.id} — [pre-merge] workflow step passed: ${ws.name}`);
          // Update existing pending entry in place
          const existingIdx = results.findIndex(r => r.workflowStepId === ws.id);
          if (existingIdx >= 0) {
            results[existingIdx] = {
              ...results[existingIdx],
              status: "passed",
              output: result.output,
              completedAt,
            };
          }
          await this.store.updateTask(task.id, { workflowStepResults: results });
        } else if (result.revisionRequested) {
          // Revision requested — this is a structured outcome that routes back to executor
          await this.store.logEntry(
            task.id,
            `[pre-merge] Workflow step requested revision: ${ws.name}`,
            result.output,
          );
          executorLog.log(`${task.id} — [pre-merge] workflow step requested revision: ${ws.name}`);
          // Update existing pending entry in place
          const existingIdx = results.findIndex(r => r.workflowStepId === ws.id);
          if (existingIdx >= 0) {
            results[existingIdx] = {
              ...results[existingIdx],
              status: "failed",
              output: result.output || "Revision requested",
              completedAt,
            };
          }
          await this.store.updateTask(task.id, { workflowStepResults: results });
          return {
            allPassed: false,
            revisionRequested: true,
            feedback: result.output || "Workflow step requested revision",
            stepName: ws.name,
          };
        } else {
          // Hard failure
          await this.store.logEntry(
            task.id,
            `[pre-merge] Workflow step failed: ${ws.name}`,
            result.error || "Unknown error",
          );
          executorLog.error(`${task.id} — [pre-merge] workflow step failed: ${ws.name}; output captured in task log`);
          // Update existing pending entry in place
          const existingIdx = results.findIndex(r => r.workflowStepId === ws.id);
          if (existingIdx >= 0) {
            results[existingIdx] = {
              ...results[existingIdx],
              status: "failed",
              output: result.error || "Workflow step failed",
              completedAt,
            };
          }
          await this.store.updateTask(task.id, { workflowStepResults: results });
          return {
            allPassed: false,
            revisionRequested: false,
            feedback: result.error || "Workflow step failed",
            stepName: ws.name,
          };
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const completedAt = new Date().toISOString();
        await this.store.logEntry(
          task.id,
          `[pre-merge] Workflow step failed: ${ws.name}`,
          errorMessage,
        );
        executorLog.error(`${task.id} — [pre-merge] workflow step error: ${ws.name} — ${errorMessage}`);
        // Update existing pending entry in place
        const existingIdx = results.findIndex(r => r.workflowStepId === ws.id);
        if (existingIdx >= 0) {
          results[existingIdx] = {
            ...results[existingIdx],
            status: "failed",
            output: errorMessage || "Workflow step error",
            completedAt,
          };
        }
        await this.store.updateTask(task.id, { workflowStepResults: results });
        return {
          allPassed: false,
          revisionRequested: false,
          feedback: errorMessage || "Workflow step error",
          stepName: ws.name,
        };
      }
    }

    return { allPassed: true };
  }

  /**
   * Execute a script-mode workflow step by resolving the scriptName to a command
   * from project settings and running it in the task worktree.
   */
  private async executeScriptWorkflowStep(
    task: Task,
    workflowStep: WorkflowStep,
    worktreePath: string,
    settings: Settings,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    const scriptName = workflowStep.scriptName!.trim();
    const scriptCommand = settings.scripts?.[scriptName];

    if (!scriptCommand) {
      const available = settings.scripts ? Object.keys(settings.scripts).join(", ") : "none";
      const msg = `Script '${scriptName}' not found in project settings. Available scripts: ${available}`;
      await this.store.logEntry(task.id, msg);
      return { success: false, error: msg };
    }

    executorLog.log(`${task.id}: workflow step '${workflowStep.name}' executing script '${scriptName}': ${scriptCommand}`);
    await this.store.logEntry(task.id, `Workflow step '${workflowStep.name}' executing script '${scriptName}': ${scriptCommand}`);

    try {
      const scriptResult = await runConfiguredCommand(scriptCommand, worktreePath, 120_000);
      if (scriptResult.spawnError || scriptResult.timedOut || scriptResult.exitCode !== 0) {
        return { success: false, error: configuredCommandErrorMessage(scriptResult) };
      }
      return { success: true, output: `Script '${scriptName}' completed successfully` };
    } catch (err: unknown) {
      const execError = err instanceof Error ? err : new Error(String(err));
      const stderr = "stderr" in execError && typeof execError.stderr === "string" ? execError.stderr.trim() : "";
      const stdout = "stdout" in execError && typeof execError.stdout === "string" ? execError.stdout.trim() : "";
      const exitCode = "code" in execError ? execError.code : ("status" in execError ? execError.status : undefined);
      const parts: string[] = [];
      if (exitCode !== undefined) parts.push(`Exit code: ${exitCode}`);
      if (stdout) parts.push(`stdout: ${truncateWorkflowScriptOutput(stdout)}`);
      if (stderr) parts.push(`stderr: ${truncateWorkflowScriptOutput(stderr)}`);
      if (!parts.length) parts.push(execError.message || "Unknown error");
      const errorOutput = parts.join("\n");
      return { success: false, error: errorOutput };
    }
  }

  /**
   * Execute a single workflow step by spawning an agent with the step's prompt.
   * Returns structured outcome with support for revision requests.
   */
  private async executeWorkflowStep(
    task: Task,
    workflowStep: WorkflowStep,
    worktreePath: string,
    settings: Settings,
  ): Promise<WorkflowStepOutcome> {
    const toolMode: "coding" | "readonly" = workflowStep.toolMode || "readonly";
    const systemPrompt = `You are a workflow step agent executing: ${workflowStep.name}

Task Context:
- Task ID: ${task.id}
- Task Description: ${task.description}
- Worktree: ${worktreePath}

Your Instructions:
${workflowStep.prompt}

You have access to the file system to review changes.

## Feedback Format

When your review is complete, you MUST use one of these exact formats:

**For PASS (no issues found):**
Simply state your findings and approval. No special formatting required.

**For REVISION REQUESTED (issues found that require code changes):**
Your response MUST start with the exact phrase:
\`REQUEST REVISION\`

Followed by a clear, actionable description of what needs to be fixed.
Be specific: reference exact files, line numbers, or functions that need changes.

Example:
\`REQUEST REVISION

The login function in src/auth.ts does not handle the case where the user
account is locked. Add proper error handling for the LOCKED_ACCOUNT error code
and show an appropriate message to the user.\`

**Important:**
- Only use "REQUEST REVISION" when the implementation needs code changes.
- If the code is correct and no changes are needed, just state your findings.
- Be constructive and actionable — vague feedback wastes the executor's time.`;

    const agentLogger = new AgentLogger({
      store: this.store,
      taskId: task.id,
      agent: "reviewer",
      onAgentText: (taskId, delta) => {
        this.options.onAgentText?.(taskId, delta);
      },
      onAgentTool: (taskId, toolName) => {
        this.options.onAgentTool?.(taskId, toolName);
      },
    });

    try {
      // Determine model: prefer workflow step override, fall back to global settings
      const stepProvider = workflowStep.modelProvider || settings.defaultProvider;
      const stepModelId = workflowStep.modelId || settings.defaultModelId;
      const useOverride = !!(workflowStep.modelProvider && workflowStep.modelId);

      // Workflow step agents inherit executor instructions
      const stepInstructions = await this.resolveInstructionsForRole("executor");
      const stepSystemPrompt = buildSystemPromptWithInstructions(systemPrompt, stepInstructions);

      // Build skill selection context for workflow step session
      const skillContext = await buildSessionSkillContext({
        agentStore: this.options.agentStore!,
        task,
        sessionPurpose: "executor",
        projectRootDir: this.rootDir,
      });

      const { session } = await createKbAgent({
        cwd: worktreePath,
        systemPrompt: stepSystemPrompt,
        tools: toolMode,
        defaultProvider: stepProvider,
        defaultModelId: stepModelId,
        fallbackProvider: settings.fallbackProvider,
        fallbackModelId: settings.fallbackModelId,
        defaultThinkingLevel: settings.defaultThinkingLevel,
        // Skill selection: use assigned agent skills if available, otherwise role fallback
        ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
      });

      executorLog.log(`${task.id}: workflow step '${workflowStep.name}' using model ${describeModel(session)}${useOverride ? " (workflow step override)" : ""}`);
      await this.store.logEntry(task.id, `Workflow step '${workflowStep.name}' using model: ${describeModel(session)}${useOverride ? " (workflow step override)" : ""}`);

      let output = "";
      session.subscribe((event) => {
        if (event.type === "message_update") {
          const msgEvent = event.assistantMessageEvent;
          if (msgEvent.type === "text_delta") {
            output += msgEvent.delta;
            agentLogger.onText(msgEvent.delta);
          } else if (msgEvent.type === "thinking_delta") {
            agentLogger.onThinking(msgEvent.delta);
          }
        }
        if (event.type === "tool_execution_start") {
          agentLogger.onToolStart(event.toolName, event.args as Record<string, unknown> | undefined);
        }
        if (event.type === "tool_execution_end") {
          agentLogger.onToolEnd(event.toolName, event.isError, event.result);
        }
      });

      await promptWithFallback(
        session,
        `Execute the workflow step "${workflowStep.name}" for task ${task.id}.\n\n` +
        `Review the work done in this worktree and evaluate it against the criteria in your instructions.`,
      );

      checkSessionError(session);
      session.dispose();
      await agentLogger.flush();

      // Check if the output contains a revision request
      const trimmedOutput = output.trim();
      const revisionMatch = trimmedOutput.match(/^REQUEST REVISION\s*\n*/i);
      if (revisionMatch) {
        // Extract the feedback after "REQUEST REVISION"
        const feedbackStart = revisionMatch[0].length;
        const feedback = trimmedOutput.slice(feedbackStart).trim();
        return {
          success: false,
          revisionRequested: true,
          output: feedback,
        };
      }

      return { success: true, output };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await agentLogger.flush();
      return { success: false, error: errorMessage };
    }
  }

  private MAX_WORKTREE_RETRIES = 3;
  private WORKTREE_RETRY_DELAYS = [100, 500, 1000]; // ms

  /**
   * Create a git worktree with automatic recovery from conflicts.
   * Implements retry logic with exponential backoff for transient failures.
   * 
   * @param branch - The branch name to create (e.g., "fusion/fn-123")
   * @param path - The desired worktree path
   * @param taskId - The task ID for logging
   * @param startPoint - Optional base branch/commit for new branch
   * @returns The actual worktree path (may differ if recovery generated new name)
   */
  private async createWorktree(
    branch: string,
    path: string,
    taskId: string,
    startPoint?: string,
  ): Promise<{ path: string; branch: string }> {
    // Track the worktree path we're attempting to use (may change during recovery)
    const currentPath = path;
    const resolvedStartPoint = startPoint
      ? await this.resolveWorktreeStartPoint(startPoint, taskId)
      : undefined;

    for (let attempt = 0; attempt < this.MAX_WORKTREE_RETRIES; attempt++) {
      try {
        return await this.tryCreateWorktree(branch, currentPath, taskId, resolvedStartPoint, attempt);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isLastAttempt = attempt === this.MAX_WORKTREE_RETRIES - 1;
        const isTerminalWorktreeError = error instanceof NonRetryableWorktreeError;

        if (isLastAttempt || isTerminalWorktreeError) {
          await this.store.logEntry(
            taskId,
            `Worktree creation failed after ${this.MAX_WORKTREE_RETRIES} attempts`,
            errorMessage,
          );
          throw new Error(
            `Failed to create worktree after ${this.MAX_WORKTREE_RETRIES} attempts: ${errorMessage}`,
          );
        }

        // Wait before retry (exponential backoff)
        const delay = this.WORKTREE_RETRY_DELAYS[attempt] || 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Should never reach here, but TypeScript needs a return
    throw new Error("Unexpected exit from worktree creation retry loop");
  }

  private async resolveWorktreeStartPoint(startPoint: string, taskId: string): Promise<string> {
    const command = isAbsolute(startPoint) && existsSync(startPoint)
      ? `git -C "${startPoint}" rev-parse --verify HEAD^{commit}`
      : `git rev-parse --verify "${startPoint}^{commit}"`;

    try {
      const { stdout } = await execAsync(command, { cwd: this.rootDir });
      return stdout.trim() || startPoint;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.store.logEntry(
        taskId,
        `Worktree base ref is missing`,
        `${startPoint}: ${errorMessage}`,
      );
      throw new NonRetryableWorktreeError(
        `Cannot create worktree for ${taskId}: base ref "${startPoint}" does not exist or cannot be resolved`,
      );
    }
  }

  /**
   * Single attempt to create a worktree with conflict detection and recovery.
   * Returns the actual worktree path used (may differ from input if recovery generated new name).
   */
  private async tryCreateWorktree(
    branch: string,
    path: string,
    taskId: string,
    startPoint?: string,
    attemptNumber = 0,
    recoveryDepth = 0,
  ): Promise<{ path: string; branch: string }> {
    // If directory exists but is not a registered worktree, remove it first
    if (existsSync(path)) {
      const isRegistered = await this.isRegisteredWorktree(path);
      if (!isRegistered) {
        await this.store.logEntry(
          taskId,
          `Removing existing directory (not a registered worktree): ${path}`,
        );
        try {
          await execAsync(`rm -rf "${path}"`, { cwd: this.rootDir });
        } catch (e: unknown) {
          const eMessage = e instanceof Error ? e.message : String(e);
          throw new Error(`Failed to remove existing directory ${path}: ${eMessage}`);
        }
      } else {
        executorLog.log(`Worktree already exists: ${path}`);
        return { path, branch };
      }
    }

    const createWithBranch = async (branchToCreate: string) => {
      const cmd = startPoint
        ? `git worktree add -b "${branchToCreate}" "${path}" "${startPoint}"`
        : `git worktree add -b "${branchToCreate}" "${path}"`;
      await execAsync(cmd, { cwd: this.rootDir });
    };

    const createFromExistingBranch = async () => {
      await execAsync(`git worktree add "${path}" "${branch}"`, { cwd: this.rootDir });
    };

    try {
      await createWithBranch(branch);
      executorLog.log(`Worktree created: ${path}${startPoint ? ` (from ${startPoint})` : ""}`);
      if (attemptNumber > 0) {
        await this.store.logEntry(taskId, `Worktree created on attempt ${attemptNumber + 1}`, path);
      }
      return { path, branch };
    } catch (initialError: unknown) {
      const conflictInfo = this.extractWorktreeConflictInfo(initialError);

      // Handle "already used by worktree" conflict
      if (conflictInfo.type === "already-used" && conflictInfo.path) {
        const result = await this.handleWorktreeConflict(
          conflictInfo.path,
          branch,
          path,
          taskId,
          startPoint,
          attemptNumber,
        );
        if (result) {
          return result;
        }
        throw new Error(
          `Worktree conflict at ${conflictInfo.path}: automatic cleanup failed`,
        );
      }

      // Handle "invalid reference" - stale branch that doesn't exist
      if (conflictInfo.type === "invalid-reference") {
        if (recoveryDepth >= this.MAX_WORKTREE_RETRIES - 1) {
          throw new NonRetryableWorktreeError(
            `Stale branch reference for ${branch} remained invalid after ${this.MAX_WORKTREE_RETRIES} cleanup attempts`,
          );
        }
        const branchCleaned = await this.cleanupStaleBranch(branch, taskId);
        if (branchCleaned) {
          await this.store.logEntry(taskId, `Removed stale branch reference, retrying`);
          return this.tryCreateWorktree(branch, path, taskId, startPoint, attemptNumber, recoveryDepth + 1);
        }
        throw new Error(
          `Invalid reference for branch ${branch}: unable to clean up stale reference`,
        );
      }

      // Handle "could not create leading directories" - permission/path issues
      if (conflictInfo.type === "leading-directories") {
        throw new Error(
          `Cannot create worktree at ${path}: permission or path issue. ` +
          `Check that parent directories are writable.`,
        );
      }

      // Try creating from existing branch (branch might already exist)
      try {
        await createFromExistingBranch();
        executorLog.log(`Worktree created from existing branch: ${path}`);
        return { path, branch };
      } catch (fallbackError: unknown) {
        const fallbackErrorMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        // Check if the fallback also hit an "already used" conflict
        const fallbackConflictInfo = this.extractWorktreeConflictInfo(fallbackError);
        if (fallbackConflictInfo.type === "already-used" && fallbackConflictInfo.path) {
          const result = await this.handleWorktreeConflict(
            fallbackConflictInfo.path,
            branch,
            path,
            taskId,
            startPoint,
            attemptNumber,
          );
          if (result) {
            return result;
          }
          throw new Error(
            `Worktree conflict at ${fallbackConflictInfo.path}: automatic cleanup failed`,
          );
        }

        // Handle stale reference in fallback path too
        if (fallbackConflictInfo.type === "invalid-reference") {
          if (recoveryDepth >= this.MAX_WORKTREE_RETRIES - 1) {
            throw new NonRetryableWorktreeError(
              `Stale branch reference for ${branch} remained invalid after ${this.MAX_WORKTREE_RETRIES} cleanup attempts`,
            );
          }
          const branchCleaned = await this.cleanupStaleBranch(branch, taskId);
          if (branchCleaned) {
            await this.store.logEntry(taskId, `Cleaned up stale reference in fallback, retrying`);
            return this.tryCreateWorktree(branch, path, taskId, startPoint, attemptNumber, recoveryDepth + 1);
          }
        }

        throw new Error(`Failed to create worktree: ${fallbackErrorMessage}`);
      }
    }
  }

  /**
   * Handle "already used by worktree" conflict.
   * Either generates a new worktree name (if conflicting worktree is in use by active task)
   * or cleans up the conflicting worktree and retries.
   * 
   * @returns The worktree path if recovery succeeded, null if recovery failed
   */
  private async handleWorktreeConflict(
    conflictPath: string,
    branch: string,
    path: string,
    taskId: string,
    startPoint?: string,
    attemptNumber?: number,
  ): Promise<{ path: string; branch: string } | null> {
    const shouldGenerateNewName = await this.shouldGenerateNewWorktreeName(
      conflictPath,
      taskId,
    );

    if (shouldGenerateNewName) {
      // Conflicting worktree belongs to an active task — generate new path AND
      // use a suffixed branch name so git doesn't conflict with the branch
      // already checked out in the existing worktree.
      const newPath = join(this.rootDir, ".worktrees", generateWorktreeName(this.rootDir));
      for (let suffix = 2; suffix <= 6; suffix++) {
        const suffixedBranch = `${branch}-${suffix}`;
        try {
          await this.store.logEntry(
            taskId,
            `Conflicting worktree in use by active task, trying new path with branch ${suffixedBranch}`,
            newPath,
          );
          return await this.tryCreateWorktree(suffixedBranch, newPath, taskId, startPoint, attemptNumber);
        } catch (suffixErr: unknown) {
          const info = this.extractWorktreeConflictInfo(suffixErr);
          if (info.type === "already-used") {
            // This suffixed branch is also in use — try next suffix
            continue;
          }
          throw suffixErr;
        }
      }
      throw new Error(
        `Cannot create branch for task: "${branch}" and suffixes -2 through -6 are all in use by other worktrees`,
      );
    }

    // Safe to clean up - conflicting worktree is not in use
    const cleanupSuccess = await this.cleanupConflictingWorktree(conflictPath, branch, taskId);
    if (cleanupSuccess) {
      await this.store.logEntry(taskId, `Cleaned up conflicting worktree, retrying`, path);
      return this.tryCreateWorktree(branch, path, taskId, startPoint, attemptNumber);
    }

    return null;
  }

  /**
   * Check if a path is registered as a git worktree.
   */
  private async isRegisteredWorktree(path: string): Promise<boolean> {
    return isRegisteredGitWorktree(this.rootDir, path);
  }

  /**
   * Determine if we should generate a new worktree name instead of cleaning up.
   * Returns true if the conflicting worktree is used by an active task.
   */
  private async shouldGenerateNewWorktreeName(
    conflictPath: string,
    currentTaskId: string,
  ): Promise<boolean> {
    // Check if conflicting worktree is in our active set
    for (const [taskId, worktreePath] of this.activeWorktrees) {
      if (taskId !== currentTaskId && worktreePath === conflictPath) {
        return true;
      }
    }

    // Check if another non-done task uses this worktree
    const otherUser = await findWorktreeUser(this.store, conflictPath, currentTaskId);
    return otherUser !== null;
  }

  /**
   * Clean up a conflicting worktree and its branch.
   * Handles locked worktrees by unlocking first.
   * Returns true if cleanup succeeded.
   */
  private async cleanupConflictingWorktree(
    worktreePath: string,
    branch: string,
    taskId: string,
  ): Promise<boolean> {
    try {
      // Check if worktree is locked and unlock if needed
      try {
        await execAsync(`git worktree unlock "${worktreePath}"`, {
          cwd: this.rootDir,
        });
        await this.store.logEntry(taskId, `Unlocked worktree`, worktreePath);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        executorLog.warn(`${taskId}: failed to unlock conflicting worktree ${worktreePath} before cleanup: ${msg}`);
      }

      // Remove the worktree
      await execAsync(`git worktree remove "${worktreePath}" --force`, {
        cwd: this.rootDir,
      });
      await this.store.logEntry(taskId, `Removed conflicting worktree`, worktreePath);

      // Delete the branch if it exists
      try {
        await execAsync(`git branch -D "${branch}"`, {
          cwd: this.rootDir,
        });
        await this.store.logEntry(taskId, `Deleted branch`, branch);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        executorLog.warn(`${taskId}: failed to delete conflicting branch ${branch}: ${msg}`);
      }

      return true;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.store.logEntry(
        taskId,
        `Failed to clean up conflicting worktree`,
        `${worktreePath}: ${errorMessage}`,
      );
      return false;
    }
  }

  /**
   * Clean up a stale branch that no longer has a valid reference.
   *
   * Recovery strategy (in order):
   * 1. `git worktree prune` — remove stale worktree metadata that may
   *    hold a lock on the branch reference
   * 2. `git branch -D` — delete the branch normally
   * 3. `git update-ref -d refs/heads/<branch>` — force-remove a corrupted
   *    or dangling reference when `git branch -D` fails
   *
   * Each step is logged so operators can trace the recovery path.
   * Returns true if the branch reference was successfully removed.
   */
  private async cleanupStaleBranch(branch: string, taskId: string): Promise<boolean> {
    // Step 1: Prune stale worktree metadata that may hold a lock on the branch
    try {
      await execAsync("git worktree prune", { cwd: this.rootDir });
      await this.store.logEntry(taskId, `Pruned stale worktree metadata`, branch);
    } catch {
      // Prune is best-effort — continue even if it fails
    }

    // Step 2: Try normal branch deletion
    try {
      await execAsync(`git branch -D "${branch}"`, {
        cwd: this.rootDir,
      });
      await this.store.logEntry(taskId, `Removed stale branch`, branch);
      return true;
    } catch (branchDeleteError: unknown) {
      const branchDeleteErrorMessage = branchDeleteError instanceof Error ? branchDeleteError.message : String(branchDeleteError);
      await this.store.logEntry(
        taskId,
        `git branch -D failed for stale branch, trying update-ref`,
        `${branch}: ${branchDeleteErrorMessage}`,
      );
    }

    // Step 3: Force-remove the reference directly
    try {
      const refPath = `refs/heads/${branch}`;
      await execAsync(`git update-ref -d "${refPath}"`, {
        cwd: this.rootDir,
      });
      await this.store.logEntry(taskId, `Force-removed stale branch reference via update-ref`, refPath);
      return true;
    } catch (updateRefError: unknown) {
      const updateRefErrorMessage = updateRefError instanceof Error ? updateRefError.message : String(updateRefError);
      await this.store.logEntry(
        taskId,
        `Failed to remove stale branch reference`,
        `${branch}: ${updateRefErrorMessage}`,
      );
      return false;
    }
  }

  /**
   * Extract conflict information from git worktree error output.
   * Handles multiple error patterns:
   * - "already used by worktree at '...'"
   * - "invalid reference" / "unable to resolve reference" / "stale file handle"
   * - "could not create leading directories"
   * - "working tree already exists"
   */
  private extractWorktreeConflictInfo(error: unknown): {
    type: "already-used" | "invalid-reference" | "leading-directories" | "already-exists" | "unknown";
    path?: string;
    message?: string;
  } {
    const execError = error instanceof Error ? error : new Error(String(error));
    const output = [
      execError.message,
      "stderr" in execError && typeof execError.stderr === "string" ? execError.stderr.toString() : undefined,
      "stdout" in execError && typeof execError.stdout === "string" ? execError.stdout.toString() : undefined,
    ]
      .filter(Boolean)
      .join("\n");

    // Pattern: already used by worktree at '/path/to/worktree'
    const alreadyUsedMatch = output.match(/already used by worktree at '([^']+)'/);
    if (alreadyUsedMatch) {
      return { type: "already-used", path: alreadyUsedMatch[1], message: output };
    }

    // Pattern: invalid reference: 'branch-name'
    // Also covers: unable to resolve reference, stale file handle, not a valid ref
    if (
      output.match(/invalid reference/i) ||
      output.match(/unable to resolve reference/i) ||
      output.match(/stale file handle/i) ||
      output.match(/not a valid ref/i) ||
      output.match(/unable to delete.*ref/i)
    ) {
      return { type: "invalid-reference", message: output };
    }

    // Pattern: could not create leading directories
    if (output.match(/could not create leading directories/i)) {
      return { type: "leading-directories", message: output };
    }

    // Pattern: working tree already exists
    if (output.match(/working tree already exists/i)) {
      return { type: "already-exists", message: output };
    }

    return { type: "unknown", message: output };
  }

  /**
   * Remove a task's worktree, but only if no other in-progress or todo task
   * shares the same worktree path (dependency-chain reuse). The branch is
   * always cleaned up by the merger on a per-task basis.
   */
  async cleanup(taskId: string): Promise<void> {
    const worktreePath = this.activeWorktrees.get(taskId);
    if (!worktreePath) return;

    this.activeWorktrees.delete(taskId);

    // Check if another task still needs this worktree
    const otherUser = await findWorktreeUser(this.store, worktreePath, taskId);
    if (otherUser) {
      executorLog.log(`Worktree retained for ${taskId} — still needed by ${otherUser}`);
      return;
    }

    try {
      await execAsync(`git worktree remove "${worktreePath}" --force`, { cwd: this.rootDir });
      executorLog.log(`Cleaned up worktree for ${taskId}`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.error(`Failed to clean up worktree for ${taskId}:`, errorMessage);
    }
  }

  /**
   * Check whether the task's branch has any unique commits compared to main.
   * If the branch has no unique commits and the task has steps marked done,
   * those steps represent lost uncommitted work — reset them to "pending"
   * so the next execution doesn't skip them.
   *
   * Called during stuck-kill cleanup when the worktree is about to be destroyed.
   */
  private async resetStepsIfWorkLost(task: Task): Promise<void> {
    const completedSteps = task.steps.filter(
      (s) => s.status === "done" || s.status === "in-progress",
    );
    if (completedSteps.length === 0) return;

    const branchName = task.branch || `fusion/${task.id.toLowerCase()}`;

    try {
      // Check if the branch has any unique commits vs main
      const { stdout: mergeBaseStdout } = await execAsync(
        `git merge-base "${branchName}" HEAD 2>/dev/null`,
        { cwd: this.rootDir, encoding: "utf-8" },
      );
      const { stdout: branchHeadStdout } = await execAsync(
        `git rev-parse "${branchName}" 2>/dev/null`,
        { cwd: this.rootDir, encoding: "utf-8" },
      );
      const mergeBase = mergeBaseStdout.trim();
      const branchHead = branchHeadStdout.trim();

      if (mergeBase === branchHead) {
        // Branch has no unique commits — all step work was lost
        executorLog.warn(
          `${task.id} branch has no unique commits — resetting ${completedSteps.length} step(s) to pending`,
        );

        for (let i = 0; i < task.steps.length; i++) {
          if (task.steps[i].status === "done" || task.steps[i].status === "in-progress") {
            await this.store.updateStep(task.id, i, "pending");
          }
        }

        await this.store.logEntry(
          task.id,
          `Reset ${completedSteps.length} step(s) to pending — branch had no commits (uncommitted work lost with worktree)`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`${task.id}: step-reset-on-work-lost failed (non-fatal, steps keep current status): ${msg}`);
      // Branch may not exist or git commands may fail — non-fatal.
      // Steps keep their current status (safe default: agent can
      // inspect the worktree and decide).
    }
  }

  /**
   * Mark a task as stuck-aborted so the executor's error handling
   * knows not to treat the disposed session as a genuine failure.
   * Called by the stuck task detector's onStuck callback.
   *
   * @param shouldRequeue — true to move the task back to "todo" for retry,
   *   false if the stuck kill budget is exhausted (task already marked failed).
   */
  markStuckAborted(taskId: string, shouldRequeue: boolean = true): void {
    // Terminate step-session executor if active
    const stepExecutor = this.activeStepExecutors.get(taskId);
    if (stepExecutor) {
      stepExecutor.terminateAllSessions().catch(err =>
        executorLog.warn(`Failed to terminate step sessions for stuck task ${taskId}: ${err}`)
      );
    }
    this.stuckAborted.set(taskId, shouldRequeue);

    // Safety net: if the executor's Promise never resolves (e.g. a bash subprocess
    // is blocking the agent session even after dispose()), force-requeue the task
    // directly after a short grace period.  Without this, a task with a hung tool
    // call stays stranded in "in-progress" until the engine restarts.
    if (shouldRequeue && this.executing.has(taskId)) {
      const FORCE_REQUEUE_GRACE_MS = 60_000; // 60 s — generous, but bounded
      setTimeout(async () => {
        if (!this.executing.has(taskId)) return; // executor unwound normally — nothing to do
        executorLog.warn(
          `${taskId} still executing ${FORCE_REQUEUE_GRACE_MS / 1000}s after stuck-kill signal ` +
          `(likely a hung subprocess) — force-requeueing`,
        );
        try {
          await this.store.logEntry(
            taskId,
            `Force-requeued after stuck-kill: executor did not unwind within ${FORCE_REQUEUE_GRACE_MS / 1000}s (hung subprocess)`,
          );
          await this.store.updateTask(taskId, { status: "stuck-killed", worktree: null, branch: null });
          await this.store.moveTask(taskId, "todo");
          // Remove from executing so the scheduler can re-dispatch normally.
          // The old Promise is still running but the executing guard is cleared so
          // a fresh execute() call won't be blocked.
          this.executing.delete(taskId);
          this.stuckAborted.delete(taskId);
          executorLog.log(`${taskId} force-requeued to todo`);
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          executorLog.error(`Failed to force-requeue stuck task ${taskId}: ${errorMessage}`);
        }
      }, FORCE_REQUEUE_GRACE_MS);
    }
  }

  /**
   * Handle a loop-detected event from the stuck task detector.
   * Attempts an in-process compact-and-resume before falling back to kill/requeue.
   *
   * This method is the `onLoopDetected` callback wired through the dashboard.
   * It:
   * 1. Checks if the task has an active session
   * 2. Rejects if the one-attempt ceiling has been reached
   * 3. Calls `compactSessionContext()` to compact the conversation
   * 4. Sets recovery-pending state so the execution flow can resume
   *
   * @returns true if the executor accepted recovery ownership (detector skips kill),
   *   false if recovery should not be attempted (detector proceeds with kill/requeue)
   */
  async handleLoopDetected(event: StuckTaskEvent): Promise<boolean> {
    const { taskId } = event;
    const activeEntry = this.activeSessions.get(taskId);

    // No active session — can't compact, let detector kill/requeue
    if (!activeEntry) {
      executorLog.log(`${taskId} loop detected but no active session — falling back to kill/requeue`);
      return false;
    }

    // Check attempt ceiling (max 1 compact-and-resume per execute() lifecycle)
    const state = this.loopRecoveryState.get(taskId);
    if (state && state.attempts >= 1) {
      executorLog.log(`${taskId} loop detected but compact ceiling reached — falling back to kill/requeue`);
      return false;
    }

    // Attempt compaction
    const attempt = (state?.attempts ?? 0) + 1;
    executorLog.log(`${taskId} loop detected (attempt ${attempt}) — attempting compact-and-resume`);
    await this.store.logEntry(taskId, `Loop detected (${event.activitySinceProgress} events since last progress) — attempting compact-and-resume (attempt ${attempt})`);

    const compactResult = await compactSessionContext(activeEntry.session);
    if (!compactResult) {
      executorLog.log(`${taskId} compaction failed or unavailable — falling back to kill/requeue`);
      await this.store.logEntry(taskId, "Context compaction failed or unavailable — falling back to kill/requeue");
      return false;
    }

    executorLog.log(`${taskId} compaction succeeded (freed ${compactResult.tokensBefore} tokens) — setting recovery-pending`);
    await this.store.logEntry(taskId, `Context compacted successfully — will resume with fresh context`);

    // Mark recovery-pending so the execution flow can consume it
    this.loopRecoveryState.set(taskId, { attempts: attempt, pending: true });

    // Steer the session with a resume prompt to break the loop
    try {
      await activeEntry.session.steer(
        "⚠️ Loop detected: you were repeating actions without making progress. " +
        "The conversation has been compacted. Review the current state carefully, " +
        "check what's already been done (git log, file contents), and take a different " +
        "approach. Do NOT repeat the same actions. Advance to the next step if the " +
        "current work is complete.",
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.error(`${taskId} failed to steer after compaction: ${errorMessage}`);
      // Recovery-pending is still set — the execution flow will handle it
    }

    return true;
  }

  getWorktreePath(taskId: string): string | undefined {
    return this.activeWorktrees.get(taskId);
  }

  // ── Agent Spawning ─────────────────────────────────────────────────────

  /**
   * Terminate all child agents spawned by a parent task.
   * Called from the finally block of agentWork when the parent session ends.
   */
  private async terminateAllChildren(parentTaskId: string): Promise<void> {
    const childIds = this.spawnedAgents.get(parentTaskId);
    if (!childIds || childIds.size === 0) return;

    executorLog.log(`Terminating ${childIds.size} child agents for parent ${parentTaskId}`);

    for (const childId of childIds) {
      await this.terminateChildAgent(childId);
    }
    this.spawnedAgents.delete(parentTaskId);
  }

  /**
   * Terminate a single child agent by ID.
   * Disposes the session, updates AgentStore state, and cleans up tracking Maps.
   */
  private async terminateChildAgent(childId: string): Promise<void> {
    const childSession = this.childSessions.get(childId);
    if (childSession) {
      childSession.dispose();
      this.childSessions.delete(childId);
    }

    try {
      await this.options.agentStore?.updateAgentState(childId, "terminated");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`Failed to update spawned child ${childId} state to 'terminated' during cleanup: ${msg}`);
    }

    // Auto-delete the child agent after a short delay so the UI can observe
    // the terminal state before the agent is removed.
    void setTimeout(() => {
      this.options.agentStore?.deleteAgent(childId).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        executorLog.warn(`Failed to delete spawned agent ${childId}: ${msg}`);
      });
    }, 5000);

    this.totalSpawnedCount = Math.max(0, this.totalSpawnedCount - 1);
  }

  /**
   * Run a spawned child agent's task to completion.
   * Handles state transitions and cleanup.
   */
  private async runSpawnedChild(
    agentId: string,
    childSession: AgentSession,
    taskPrompt: string,
  ): Promise<void> {
    try {
      await this.options.agentStore?.updateAgentState(agentId, "running");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`Failed to update spawned child ${agentId} state to 'running': ${msg}`);
    }

    try {
      await promptWithFallback(childSession, taskPrompt);
      // Normal completion — mark as active (available)
      try {
        await this.options.agentStore?.updateAgentState(agentId, "active");
      } catch (markActiveErr) {
        executorLog.warn(`Child agent ${agentId} updateAgentState(active) failed: ${markActiveErr instanceof Error ? markActiveErr.message : String(markActiveErr)}`);
      }
    } catch (err: unknown) {
      // Error during execution — mark as error
      try {
        await this.options.agentStore?.updateAgentState(agentId, "error");
      } catch (markErrorErr) {
        executorLog.warn(`Child agent ${agentId} updateAgentState(error) failed: ${markErrorErr instanceof Error ? markErrorErr.message : String(markErrorErr)}`);
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.warn(`Child agent ${agentId} failed: ${errorMessage}`);
    } finally {
      this.childSessions.delete(agentId);
      this.totalSpawnedCount = Math.max(0, this.totalSpawnedCount - 1);
    }
  }

  /**
   * Create the spawn_agent tool definition.
   * Allows the parent agent to spawn child agents with delegated tasks.
   */
  private createSpawnAgentTool(taskId: string, worktreePath: string, settings: Settings): ToolDefinition {
    return {
      name: "spawn_agent",
      label: "Spawn Agent",
      description:
        "Spawn a child agent to handle parallel work or specialized sub-tasks. " +
        "Each child runs in its own git worktree (branched from your worktree) and executes autonomously. " +
        "When you end (task_done), all spawned children are terminated.",
      parameters: spawnAgentParams,
      execute: async (_id: string, params: Static<typeof spawnAgentParams>) => {
        const { name, role, task: taskPrompt } = params;

        // Check if AgentStore is available
        if (!this.options.agentStore) {
          return {
            content: [{ type: "text" as const, text: "Agent spawning is not available (no AgentStore configured)" }],
            details: { agentId: "", state: "error" },
          };
        }

        // Read spawn limits from settings
        const maxPerParent = settings.maxSpawnedAgentsPerParent ?? 5;
        const maxGlobal = settings.maxSpawnedAgentsGlobal ?? 20;

        // Check per-parent limit
        const currentPerParent = this.spawnedAgents.get(taskId)?.size ?? 0;
        if (currentPerParent >= maxPerParent) {
          return {
            content: [{ type: "text" as const, text: `Per-parent spawn limit reached (${currentPerParent}/${maxPerParent}). Wait for children to finish or reduce parallelism.` }],
            details: { agentId: "", state: "error" },
          };
        }

        // Check global limit
        if (this.totalSpawnedCount >= maxGlobal) {
          return {
            content: [{ type: "text" as const, text: `Global spawn limit reached (${this.totalSpawnedCount}/${maxGlobal}). Cannot spawn more agents.` }],
            details: { agentId: "", state: "error" },
          };
        }

        try {
          // Create agent in AgentStore with reportsTo = parent task ID
          const agent = await this.options.agentStore.createAgent({
            name: name.trim(),
            role: role as AgentCapability,
            reportsTo: taskId,
            metadata: { type: "spawned", parentTaskId: taskId },
          });

          // Create git worktree for child (branched from parent's worktree)
          const childWorktreeName = generateWorktreeName(this.rootDir);
          const childWorktreePath = join(this.rootDir, ".worktrees", childWorktreeName);
          const childBranch = `fusion/spawn-${agent.id}`;
          await this.createWorktree(childBranch, childWorktreePath, taskId, worktreePath);

          // Transition agent to active state
          await this.options.agentStore.updateAgentState(agent.id, "active");

          // Child agents inherit executor instructions
          const childInstructions = await this.resolveInstructionsForRole("executor");
          const childBasePrompt = `You are a child agent spawned by a parent task executor. Your job is to complete the following delegated task. Work autonomously and thoroughly. Report your findings and results.\n\nParent task: ${taskId}\nChild agent: ${agent.id} (${name})`;
          const childSystemPrompt = buildSystemPromptWithInstructions(childBasePrompt, childInstructions);

          // Build skill selection context for child agent session
          const childTask = await this.store.getTask(taskId);
          const skillContext = await buildSessionSkillContext({
            agentStore: this.options.agentStore!,
            task: childTask,
            sessionPurpose: "executor",
            projectRootDir: this.rootDir,
          });

          // Create child agent session
          const { session: childSession } = await createKbAgent({
            cwd: childWorktreePath,
            systemPrompt: childSystemPrompt,
            tools: "coding",
            defaultProvider: settings.defaultProvider,
            defaultModelId: settings.defaultModelId,
            fallbackProvider: settings.fallbackProvider,
            fallbackModelId: settings.fallbackModelId,
            // Skill selection: use assigned agent skills if available, otherwise role fallback
            ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
          });

          // Store tracking state
          this.childSessions.set(agent.id, childSession);
          if (!this.spawnedAgents.has(taskId)) {
            this.spawnedAgents.set(taskId, new Set());
          }
          this.spawnedAgents.get(taskId)!.add(agent.id);
          this.totalSpawnedCount++;

          // Run child asynchronously (don't await — parent continues working)
          this.runSpawnedChild(agent.id, childSession, taskPrompt).catch((err: unknown) => {
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
          const errorMessage = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Failed to spawn agent: ${errorMessage}` }],
            details: { agentId: "", state: "error", message: errorMessage },
          };
        }
      },
    };
  }
}

/**
 * Format a timestamp for display in steering comments.
 * Returns relative time for recent comments, absolute date for older ones.
 */
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

// Project commands are injected here (for reliability) and also in the PROMPT.md (by triage).
// This ensures the executor agent always sees the authoritative commands from settings,
// even if the PROMPT.md was written manually or before commands were configured.
function scopePromptToWorktree(prompt: string, rootDir?: string, worktreePath?: string): string {
  if (!rootDir || !worktreePath || rootDir === worktreePath || !prompt.includes(rootDir)) {
    return prompt;
  }

  return prompt
    .replaceAll(`${rootDir}/`, `${worktreePath}/`)
    .replaceAll(`${worktreePath}/.fusion/`, `${rootDir}/.fusion/`);
}

export function buildExecutionPrompt(task: TaskDetail, rootDir?: string, settings?: Settings, worktreePath?: string): string {
  const prompt = scopePromptToWorktree(task.prompt, rootDir, worktreePath);
  const reviewMatch = prompt.match(/##\s*Review Level[:\s]*(\d)/);
  const reviewLevel = reviewMatch ? parseInt(reviewMatch[1], 10) : 0;

  // Build author arg for git commits based on settings
  const authorArg = settings?.commitAuthorEnabled !== false
    ? ` --author="${settings?.commitAuthorName || "Fusion"} <${settings?.commitAuthorEmail || "noreply@runfusion.ai"}>"`
    : "";

  // Build step progress for resume
  const hasProgress = task.steps.length > 0 && task.steps.some((s) => s.status !== "pending");
  let progressSection = "";
  if (hasProgress) {
    const doneSteps = task.steps
      .map((s, i) => ({ ...s, index: i }))
      .filter((s) => s.status === "done");
    const currentStep = task.currentStep;
    const currentStepInfo = task.steps[currentStep];

    progressSection = `
## ⚠️ RESUMING — Previous progress exists

This task was already partially executed. DO NOT redo completed steps.

### Step status:
${task.steps.map((s, i) => `- Step ${i} (${s.name}): **${s.status}**`).join("\n")}

### Resume from: Step ${currentStep}${currentStepInfo ? ` (${currentStepInfo.name})` : ""}

${doneSteps.length > 0 ? `Steps ${doneSteps.map((s) => s.index).join(", ")} are already complete — skip them entirely.` : ""}
Check the git log to understand what was already implemented:
\`\`\`bash
git log --oneline
\`\`\`
`;
  }

  // Build attachments section
  let attachmentsSection = "";
  if (task.attachments && task.attachments.length > 0 && rootDir) {
    const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    const lines = ["## Attachments", ""];
    for (const att of task.attachments) {
      const absPath = `${rootDir}/.fusion/tasks/${task.id}/attachments/${att.filename}`;
      if (IMAGE_MIMES.has(att.mimeType)) {
        lines.push(`- **${att.originalName}** (screenshot): \`${absPath}\``);
      } else {
        lines.push(`- **${att.originalName}** (${att.mimeType}): \`${absPath}\` — read for context`);
      }
    }
    attachmentsSection = "\n" + lines.join("\n") + "\n";
  }

  // Build project commands section from settings
  let commandsSection = "";
  if (settings?.testCommand || settings?.buildCommand) {
    const lines = ["## Project Commands"];
    if (settings.testCommand) lines.push(`- **Test:** \`${settings.testCommand}\``);
    if (settings.buildCommand) lines.push(`- **Build:** \`${settings.buildCommand}\``);
    commandsSection = "\n" + lines.join("\n") + "\n";
  }

  // Build project memory section from settings
  // When enabled, agents consult and update project memory for durable project learnings.
  // Backend-aware: instructions branch based on memoryBackendType (file, readonly, qmd)
  const memoryEnabled = settings?.memoryEnabled !== false;
  let memorySection = "";
  if (memoryEnabled && rootDir) {
    memorySection = "\n" + buildExecutionMemoryInstructions(rootDir, settings);
  }

  // Build steering comments section (last 10 comments only to avoid context bloat)
  let steeringSection = "";
  if (task.steeringComments && task.steeringComments.length > 0) {
    const recentComments = [...task.steeringComments].slice(-10);
    const lines = [
      "",
      "## Steering Comments",
      "",
      "The following comments were added by the user during execution. Consider adjusting your approach or replanning remaining steps based on this feedback.",
      "",
    ];
    for (const comment of recentComments) {
      const timestamp = formatTimestamp(comment.createdAt);
      lines.push(`**${comment.author}** — ${timestamp}`);
      lines.push(`> ${comment.text}`);
      lines.push("");
    }
    steeringSection = lines.join("\n");
  }

  return `Execute this task.

## Task: ${task.id}
${task.title ? `**${task.title}**` : ""}
${task.dependencies.length > 0 ? `Dependencies: ${task.dependencies.join(", ")}` : ""}

## PROMPT.md

${prompt}
${attachmentsSection}${commandsSection}${memorySection}${progressSection}${steeringSection}
## Review level: ${reviewLevel}

${reviewLevel === 0 ? "No reviews required. Implement directly." : ""}
${reviewLevel >= 1 ? `Before implementing each step (except Step 0 and the final step), call:
\`review_step(step=N, type="plan", step_name="...")\`` : ""}
${reviewLevel >= 2 ? `After implementing + committing each step, call:
\`review_step(step=N, type="code", step_name="...", baseline="<SHA from before step>")\`` : ""}
${reviewLevel >= 3 ? `After tests, also call review_step with type="code" for test review.` : ""}

## Worktree Boundaries

You are running in an **isolated git worktree**. This means:

- **All code changes must be made inside the current worktree directory.** Do not modify files outside the worktree.
- **Exception — Project memory:** You MAY read and write to \`.fusion/memory/MEMORY.md\` at the project root to save durable project learnings.
- **Exception — Task attachments:** You MAY read files under \`.fusion/tasks/{taskId}/attachments/\` at the project root for context.
- **Shell commands** run inside the worktree by default. Avoid using \`cd\` to navigate outside the worktree.

## Begin

${hasProgress
    ? `Resume from Step ${task.currentStep}. Do NOT redo completed steps.`
    : "Start with Step 0 (Preflight). Work through each step in order."}
Use \`task_update\` to report progress on every step transition.
Use \`task_log\` for important actions and decisions.
Use \`task_create\` for truly separate follow-up work, not for fixes required to get tests, build, or typecheck back to green.
Commit at step boundaries: \`git commit -m "feat(${task.id}): complete Step N — description"${authorArg}\`
When all steps are complete: call \`task_done()\`

If a build command is configured, run that exact command in this worktree before calling \`task_done()\`.
Treat a non-zero exit code as a blocking failure. Do not claim success without a real passing run.
Run the configured/full test suite and fix failures even when that requires edits outside the original File Scope.
If the repo has a typecheck command, run it before \`task_done()\` and fix any failures it reports.
Use \`task_create\` for truly separate follow-up work, not for fixes required to get tests, build, or typecheck back to green.
**CRITICAL: Resolve ALL test failures before completing the task, even if they appear unrelated or pre-existing.** Unrelated failures left unfixed accumulate technical debt and block future integrations. Investigate and fix or suppress them — do not defer them to a separate task.`;
}

/**
 * Format a comment for injection into a running agent session.
 * Used for real-time steering during task execution.
 */
function formatCommentForInjection(comment: import("@fusion/core").SteeringComment): string {
  const timestamp = formatTimestamp(comment.createdAt);
  return `📣 **New feedback** — ${timestamp} (${comment.author}):\n\n${comment.text}\n\nPlease adjust your approach based on this feedback.`;
}

/**
 * Detect if a steering comment contains a review handoff request.
 * Matches common handoff phrases that agents can use to request
 * human review of their work.
 */
export function detectReviewHandoffIntent(commentText: string): boolean {
  const text = commentText.toLowerCase();
  const handoffPhrases = [
    "send it back to me",
    "hand off to user",
    "needs human review",
    "assign to user",
    "return to user",
    "user review needed",
    "requesting user review",
  ];

  return handoffPhrases.some((phrase) => text.includes(phrase));
}
