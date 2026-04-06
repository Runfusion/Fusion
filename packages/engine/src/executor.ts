import { execSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { TaskStore, Task, TaskDetail, StepStatus, Settings, WorkflowStep, MissionStore, Slice, AgentState, AgentCapability } from "@fusion/core";
import type { AgentStore } from "@fusion/core";
import { findWorktreeUser } from "./merger.js";
import { generateWorktreeName, slugify } from "./worktree-names.js";
import { Type, type Static } from "@mariozechner/pi-ai";
import { createKbAgent, describeModel, promptWithFallback, compactSessionContext } from "./pi.js";
import { reviewStep, type ReviewVerdict } from "./reviewer.js";
import { SessionManager, type ToolDefinition, type AgentSession } from "@mariozechner/pi-coding-agent";
import { PRIORITY_EXECUTE, type AgentSemaphore } from "./concurrency.js";
import type { WorktreePool } from "./worktree-pool.js";
import { AgentLogger } from "./agent-logger.js";
import { executorLog, reviewerLog } from "./logger.js";
import { isUsageLimitError, checkSessionError, type UsageLimitPauser } from "./usage-limit-detector.js";
import { isTransientError, isSilentTransientError } from "./transient-error-detector.js";
import { withRateLimitRetry } from "./rate-limit-retry.js";
import { computeRecoveryDecision, formatDelay, MAX_RECOVERY_RETRIES } from "./recovery-policy.js";
import type { StuckTaskDetector, StuckTaskEvent } from "./stuck-task-detector.js";
import { isContextLimitError } from "./context-limit-detector.js";

// Re-export for backward compatibility (tests import from executor.ts)
export { summarizeToolArgs } from "./agent-logger.js";

const STEP_STATUSES: StepStatus[] = ["pending", "in-progress", "done", "skipped"];

// ── Tool parameter schemas (module-level for reuse in ToolDefinition generics) ──

const taskUpdateParams = Type.Object({
  step: Type.Number({ description: "Step number (0-indexed)" }),
  status: Type.Union(
    STEP_STATUSES.map((s) => Type.Literal(s)),
    { description: "New status: pending, in-progress, done, or skipped" },
  ),
});

const taskLogParams = Type.Object({
  message: Type.String({ description: "What happened" }),
  outcome: Type.Optional(Type.String({ description: "Result or consequence (optional)" })),
});

const taskCreateParams = Type.Object({
  description: Type.String({ description: "What needs to be done" }),
  dependencies: Type.Optional(
    Type.Array(Type.String(), { description: "Task IDs this new task depends on (e.g. [\"KB-001\"])" }),
  ),
});

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

const EXECUTOR_SYSTEM_PROMPT = `You are a task execution agent for "kb", an AI-orchestrated task board.

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

## Git discipline
- Commit after completing each step (not after every file change)
- Use conventional commit messages prefixed with the task ID
- Do NOT commit broken or half-implemented code

## Guardrails
- Treat the File Scope in PROMPT.md as the expected starting scope, not a hard boundary when quality gates fail
- Read "Context to Read First" files before starting
- Follow the "Do NOT" section strictly
- If tests, build, or typecheck fail and the fix requires touching code outside the declared File Scope, fix those failures directly and keep the repo green
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
After all steps are done, tests pass, typecheck passes, and docs are updated:
\`\`\`bash
Call \`task_done()\` to signal completion.
\`\`\`

If a project build command is listed in the prompt, it is a hard completion gate:
- Run the exact build command in the current worktree before \`task_done()\`
- Do not claim the build passes unless you actually ran it and got exit code 0
- If the build fails, do NOT call \`task_done()\`; keep working until it passes

Tests and typecheck are also hard quality gates:
- Keep fixing failures until the configured/full test suite passes
- If the repository exposes a typecheck command, run it and keep fixing failures until it passes
- Do not stop at "out of scope" if additional fixes are required to restore green tests, build, or typecheck`;

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
  /** Active agent sessions per task, used to terminate on pause and inject steering. */
  private activeSessions = new Map<string, {
    session: AgentSession;
    seenSteeringIds: Set<string>;
  }>();
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
  /** Child agent sessions keyed by agent ID. Used for termination. */
  private childSessions = new Map<string, AgentSession>();
  /** Total count of currently spawned agents (across all parents). */
  private totalSpawnedCount = 0;

  /** Returns the set of task IDs currently being executed. */
  getExecutingTaskIds(): Set<string> {
    return new Set(this.executing);
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

    store.on("task:moved", ({ task, to }) => {
      executorLog.log(`[event:task:moved] ${task.id} → ${to}`);
      if (to === "in-progress") {
        executorLog.log(`[event:task:moved] Initiating execute() for ${task.id}`);
        this.execute(task).catch((err) =>
          executorLog.error(`Failed to start ${task.id}:`, err),
        );
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
      // Handle pause - terminate the agent session
      if (task.paused && this.activeSessions.has(task.id)) {
        executorLog.log(`Pausing ${task.id} — terminating agent session`);
        this.pausedAborted.add(task.id);
        this.options.stuckTaskDetector?.untrackTask(task.id);
        const { session } = this.activeSessions.get(task.id)!;
        session.dispose();
        return;
      }

      // Handle unpause of an in-progress task with no active session.
      // This covers orphaned states (e.g., engine restarted while task was
      // paused in-progress) where the task needs to resume execution.
      // The executing/executing guards prevent duplicate runs.
      if (!task.paused && task.column === "in-progress" && !this.activeSessions.has(task.id)) {
        if (!this.executing.has(task.id)) {
          executorLog.log(`Unpaused ${task.id} in-progress with no session — resuming execution`);
          try {
            await this.store.logEntry(task.id, "Resuming execution after unpause");
          } catch { /* non-critical */ }
          this.execute(task).catch((err) =>
            executorLog.error(`Failed to resume unpaused ${task.id}:`, err),
          );
        }
        return;
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
        }
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
        const modifiedFiles = this.captureModifiedFiles(task.worktree, task.baseCommitSha);
        if (modifiedFiles.length > 0) {
          await this.store.updateTask(task.id, { modifiedFiles });
          executorLog.log(`${task.id}: recovered ${modifiedFiles.length} modified files`);
        }

        // Run workflow steps before transitioning
        const workflowSuccess = await this.runWorkflowSteps(task, task.worktree, settings);
        if (!workflowSuccess) {
          await this.store.updateTask(task.id, { status: "failed", error: "Workflow step failed during recovery" });
          await this.store.moveTask(task.id, "in-review");
          executorLog.log(`✗ ${task.id} workflow step failed during recovery → in-review`);
          return true; // Still transitioned out of in-progress
        }
      }

      await this.store.moveTask(task.id, "in-review");
      await this.store.logEntry(task.id, "Auto-recovered: task work was complete but stuck in in-progress — moved to in-review");
      executorLog.log(`✓ ${task.id} auto-recovered completed task → in-review`);
      this.options.onComplete?.(task);
      return true;
    } catch (err: any) {
      executorLog.error(`Failed to recover completed task ${task.id}: ${err.message}`);
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
    const tasks = await this.store.listTasks();
    const inProgress = tasks.filter(
      (t) => t.column === "in-progress" && !this.executing.has(t.id) && !t.paused,
    );

    if (inProgress.length === 0) return;

    executorLog.log(`Found ${inProgress.length} orphaned in-progress task(s)`);
    for (const task of inProgress) {
      // Fast-path: if the task already completed its work (all steps done),
      // move it directly to in-review instead of re-executing from scratch.
      if (this.isTaskWorkComplete(task)) {
        executorLog.log(`${task.id} is already complete — fast-pathing to in-review`);
        await this.recoverCompletedTask(task);
        continue;
      }

      executorLog.log(`Resuming ${task.id}: ${task.title || task.description.slice(0, 60)}`);
      try {
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
  private reuseWorktree(branch: string, worktreePath: string): void {
    execSync(`git checkout -b "${branch}"`, {
      cwd: worktreePath,
      stdio: "pipe",
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
   * as-is. Branches remain task-scoped (`kb/{task-id}`).
   */
  async execute(task: Task): Promise<void> {
    executorLog.log(`execute() called for ${task.id} (already executing=${this.executing.has(task.id)})`);
    if (this.executing.has(task.id)) return;
    this.executing.add(task.id);

    executorLog.log(`Starting ${task.id}: ${task.title || task.description.slice(0, 60)}`);

    // Fetch settings early — needed for worktree naming and later configuration
    const settings = await this.store.getSettings();

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

    try {
      // Check dependencies
      const allTasks = await this.store.listTasks();
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

      if (!isResume) {

        // Try acquiring a warm worktree from the pool
        if (this.options.pool && settings.recycleWorktrees) {
          const pooled = this.options.pool.acquire();
          if (pooled) {
            try {
              const actualBranch = this.options.pool.prepareForTask(pooled, branchName, baseBranch ?? undefined);
              worktreePath = pooled;
              acquiredFromPool = true;
              executorLog.log(`Acquired worktree from pool: ${pooled}`);
              await this.store.updateTask(task.id, { worktree: worktreePath, branch: actualBranch });
              if (actualBranch !== branchName) {
                executorLog.log(`Branch conflict resolved: using ${actualBranch} instead of ${branchName}`);
                await this.store.logEntry(task.id, `Acquired worktree from pool: ${worktreePath} (branch conflict: using ${actualBranch})`);
              } else {
                await this.store.logEntry(task.id, `Acquired worktree from pool: ${worktreePath}`);
              }
            } catch (poolErr: any) {
              // Pool preparation failed — release the worktree back and fall through
              // to fresh worktree creation
              this.options.pool.release(pooled);
              executorLog.log(`Pool prepareForTask failed, falling through to fresh worktree: ${poolErr.message}`);
              await this.store.logEntry(
                task.id,
                `Pool worktree preparation failed (${poolErr.message}), creating fresh worktree`,
              );
            }
          }
        }

        // Fall through to fresh worktree creation if pool had nothing
        if (!acquiredFromPool) {
          const created = await this.createWorktree(branchName, worktreePath, task.id, baseBranch ?? undefined);
          worktreePath = created.path;
          await this.store.updateTask(task.id, { worktree: created.path, branch: created.branch });
          if (created.branch !== branchName) {
            executorLog.log(`Branch conflict resolved: using ${created.branch} instead of ${branchName}`);
            await this.store.logEntry(task.id, `Worktree created at ${worktreePath} (branch conflict: using ${created.branch})`);
          } else if (baseBranch) {
            await this.store.logEntry(task.id, `Worktree created at ${worktreePath} (based on ${baseBranch})`);
          } else {
            await this.store.logEntry(task.id, `Worktree created at ${worktreePath}`);
          }

          // Run worktree init command for fresh worktrees (skip for pooled — caches are warm)
          if (settings.worktreeInitCommand) {
            try {
              execSync(settings.worktreeInitCommand, {
                cwd: worktreePath,
                stdio: "pipe",
                timeout: 120_000,
              });
              await this.store.logEntry(task.id, "Worktree init command completed", settings.worktreeInitCommand);
            } catch (err: any) {
              const message = err.stderr?.toString() || err.message || "Unknown error";
              await this.store.logEntry(task.id, `Worktree init command failed: ${message}`);
            }
          }

          // Run setup script for fresh worktrees (after worktreeInitCommand)
          if (settings.setupScript) {
            const scriptCommand = settings.scripts?.[settings.setupScript];
            if (scriptCommand) {
              try {
                execSync(scriptCommand, {
                  cwd: worktreePath,
                  stdio: "pipe",
                  timeout: 120_000,
                });
                await this.store.logEntry(task.id, `Setup script '${settings.setupScript}' completed`, scriptCommand);
              } catch (err: any) {
                const message = err.stderr?.toString() || err.message || "Unknown error";
                await this.store.logEntry(task.id, `Setup script '${settings.setupScript}' failed: ${message}`);
              }
            } else {
              await this.store.logEntry(task.id, `Setup script '${settings.setupScript}' not found in scripts map — skipping`);
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
      }

      // Capture the base commit SHA for diff computation whenever a task
      // starts with a newly assigned worktree. Recycled worktrees must
      // overwrite any prior task baseline instead of inheriting it.
      if (!isResume) {
        try {
          const baseCommitSha = execSync("git rev-parse HEAD", {
            cwd: worktreePath,
            stdio: "pipe",
            encoding: "utf-8",
          }).trim();
          await this.store.updateTask(task.id, { baseCommitSha });
          executorLog.log(`${task.id}: captured baseCommitSha ${baseCommitSha.slice(0, 7)}`);
        } catch (err: any) {
          executorLog.log(`Failed to capture baseCommitSha for ${task.id}: ${err.message}`);
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

      // Build custom tools for the worker
      // Track the last code review verdict per step so we can enforce REVISE
      // (block task_update status="done" until the agent re-reviews and gets APPROVE).
      const codeReviewVerdicts = new Map<number, ReviewVerdict>();

      let taskDone = false;
      let wasPaused = false;
      // Mutable ref — populated after createKbAgent, tools access lazily via closure
      const sessionRef: { current: AgentSession | null } = { current: null };
      const stepCheckpoints = new Map<number, string>();

      const stuckDetector = this.options.stuckTaskDetector;

      const customTools = [
        this.createTaskUpdateTool(task.id, codeReviewVerdicts, sessionRef, stepCheckpoints, stuckDetector),
        this.createTaskLogTool(task.id),
        this.createTaskCreateTool(),
        this.createTaskAddDepTool(task.id),
        this.createTaskDoneTool(task.id, () => { taskDone = true; }),
        this.createReviewStepTool(task.id, worktreePath, detail.prompt, codeReviewVerdicts, sessionRef, stepCheckpoints, detail),
        this.createSpawnAgentTool(task.id, worktreePath, settings),
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
        // Resolve model settings: use per-task overrides if both provider and modelId are set,
        // otherwise fall back to global settings
        const executorProvider = detail.modelProvider && detail.modelId
          ? detail.modelProvider
          : settings.defaultProvider;
        const executorModelId = detail.modelProvider && detail.modelId
          ? detail.modelId
          : settings.defaultModelId;
        const executorFallbackProvider = settings.fallbackProvider;
        const executorFallbackModelId = settings.fallbackModelId;

        // Determine whether we're resuming a previous session (pause/resume)
        // or starting fresh. Use file-based sessions so conversation state
        // persists across pause/unpause cycles.
        const isResuming = !!task.sessionFile && existsSync(task.sessionFile);
        const sessionManager = isResuming
          ? SessionManager.open(task.sessionFile!)
          : SessionManager.create(worktreePath);

        executorLog.log(`${task.id}: creating agent session (provider=${executorProvider ?? "default"}, model=${executorModelId ?? "default"}, resuming=${isResuming})`);

        let { session, sessionFile } = await createKbAgent({
          cwd: worktreePath,
          systemPrompt: EXECUTOR_SYSTEM_PROMPT,
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
          defaultThinkingLevel: settings.defaultThinkingLevel,
          sessionManager,
        });

        if (isResuming) {
          executorLog.log(`${task.id}: resumed session from ${task.sessionFile}`);
          await this.store.logEntry(task.id, `Resumed agent session after unpause (model: ${describeModel(session)})`);
        } else {
          executorLog.log(`${task.id}: using model ${describeModel(session)}`);
          await this.store.logEntry(task.id, `Executor using model: ${describeModel(session)}`);
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
        this.activeSessions.set(task.id, { session, seenSteeringIds });

        // Register with stuck task detector for heartbeat monitoring
        stuckDetector?.trackTask(task.id, session);
        executorLog.log(`${task.id}: session registered (model=${describeModel(session)}, stuckDetector=${!!stuckDetector})`);

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
            const agentPrompt = buildExecutionPrompt(detail, this.rootDir, settings);
            await promptWithFallback(session, agentPrompt);
          }

          // Re-raise errors that pi-coding-agent swallowed after exhausting retries.
          // session.prompt() resolves normally even when retries are exhausted —
          // the error is stored on session.state.error instead of being thrown.
          checkSessionError(session);

          // If loop recovery is pending (compact-and-resume was triggered by
          // handleLoopDetected), consume the pending state and resume with a
          // deterministic prompt. The session has already been compacted, so
          // we just need to send a fresh prompt to continue execution.
          const loopState = this.loopRecoveryState.get(task.id);
          if (loopState?.pending) {
            loopState.pending = false;
            executorLog.log(`${task.id} consuming loop recovery — resuming with fresh context`);
            await this.store.logEntry(task.id, "Resuming execution after context compaction — taking a different approach");

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
            executorLog.log(`${task.id} paused (graceful session exit) — moving to todo`);
            await this.store.logEntry(task.id, "Execution paused — session preserved for resume, moved to todo");
            await this.store.moveTask(task.id, "todo");
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

          if (taskDone) {
            // Capture modified files before running workflow steps
            const updatedTask = await this.store.getTask(task.id);
            const modifiedFiles = this.captureModifiedFiles(worktreePath, updatedTask.baseCommitSha);
            if (modifiedFiles.length > 0) {
              await this.store.updateTask(task.id, { modifiedFiles });
              executorLog.log(`${task.id}: captured ${modifiedFiles.length} modified files`);
            }

            // Run workflow steps before moving to in-review
            const workflowSuccess = await this.runWorkflowSteps(task, worktreePath, settings);
            if (!workflowSuccess) {
              // Move to in-review even when workflow steps fail so users can see the failure
              await this.store.updateTask(task.id, { status: "failed", error: "Workflow step failed" });
              await this.store.moveTask(task.id, "in-review");
              executorLog.log(`✗ ${task.id} workflow step failed → in-review`);
              this.options.onError?.(task, new Error("Workflow step failed"));
              return;
            }

            await this.store.moveTask(task.id, "in-review");
            executorLog.log(`✓ ${task.id} completed → in-review`);
            this.options.onComplete?.(task);
          } else {
            // Agent finished without calling task_done — retry once with a fresh session
            executorLog.log(`⚠ ${task.id} finished without task_done — retrying with new session`);
            await this.store.logEntry(task.id, "Agent finished without calling task_done — retrying with new session");

            // Dispose old session and create a fresh one
            this.activeSessions.delete(task.id);
            session.dispose();

            const { session: retrySession, sessionFile: retrySessionFile } = await createKbAgent({
              cwd: worktreePath,
              systemPrompt: EXECUTOR_SYSTEM_PROMPT,
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
              defaultThinkingLevel: settings.defaultThinkingLevel,
              sessionManager: SessionManager.create(worktreePath),
            });
            // Update session file for the retry session (so pause/resume works)
            if (retrySessionFile) {
              this.store.updateTask(task.id, { sessionFile: retrySessionFile }).catch(() => {});
            }

            // Reassign so finally{} disposes the correct session
            session = retrySession;
            sessionRef.current = retrySession;
            this.activeSessions.set(task.id, { session: retrySession, seenSteeringIds });
            stuckDetector?.trackTask(task.id, retrySession);

            const retryPrompt = [
              "Your previous session ended without calling the task_done tool.",
              "The task may already be complete — review the current state of the worktree and either:",
              "1. If the work is done, call task_done with a summary of what was accomplished.",
              "2. If there is remaining work, finish it and then call task_done.",
              "",
              "Original task:",
              buildExecutionPrompt(detail, this.rootDir, settings),
            ].join("\n");

            stuckDetector?.recordActivity(task.id);
            await promptWithFallback(retrySession, retryPrompt);
            checkSessionError(retrySession);

            if (taskDone) {
              const updatedTask = await this.store.getTask(task.id);
              const modifiedFiles = this.captureModifiedFiles(worktreePath, updatedTask.baseCommitSha);
              if (modifiedFiles.length > 0) {
                await this.store.updateTask(task.id, { modifiedFiles });
                executorLog.log(`${task.id}: captured ${modifiedFiles.length} modified files`);
              }

              const workflowSuccess = await this.runWorkflowSteps(task, worktreePath, settings);
              if (!workflowSuccess) {
                await this.store.updateTask(task.id, { status: "failed", error: "Workflow step failed" });
                await this.store.moveTask(task.id, "in-review");
                executorLog.log(`✗ ${task.id} workflow step failed on retry → in-review`);
                this.options.onError?.(task, new Error("Workflow step failed"));
                return;
              }

              await this.store.moveTask(task.id, "in-review");
              executorLog.log(`✓ ${task.id} completed on retry → in-review`);
              this.options.onComplete?.(task);
            } else {
              const errorMessage = "Agent finished without calling task_done (after retry)";
              await this.store.updateTask(task.id, { status: "failed", error: errorMessage });
              await this.store.logEntry(task.id, `${errorMessage} — moved to in-review for inspection`);
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
            this.store.updateTask(task.id, { sessionFile: null }).catch(() => {});
          }
        }
      };

      const retryableWork = () => withRateLimitRetry(agentWork, {
        onRetry: (attempt, delayMs, error) => {
          const delaySec = Math.round(delayMs / 1000);
          executorLog.warn(`⏳ ${task.id} rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
          this.store.logEntry(task.id, `Rate limited — retry ${attempt} in ${delaySec}s`).catch(() => {});
        },
      });

      if (this.options.semaphore) {
        await this.options.semaphore.run(retryableWork, PRIORITY_EXECUTE);
      } else {
        await retryableWork();
      }
    } catch (err: any) {
      if (this.depAborted.has(task.id)) {
        // Dependency added mid-execution — discard worktree and move to triage
        this.depAborted.delete(task.id);
        await this.handleDepAbortCleanup(task.id, worktreePath);
      } else if (err.message?.includes("Invalid transition")) {
        // Task was moved by user/process while executor was running — already in desired state
        // This check must come before pausedAborted since it's more specific
        const transitionMatch = err.message.match(/Invalid transition: '([^']+)' → '([^']+)'/);
        const fromColumn = transitionMatch?.[1] ?? "unknown";
        const toColumn = transitionMatch?.[2] ?? "unknown";
        const logMessage = `Task already moved from '${fromColumn}' — skipping transition to '${toColumn}'`;
        executorLog.log(`${task.id} ${logMessage}`);
        await this.store.logEntry(task.id, logMessage, err.message);
        // Task finished successfully (just already moved), so call onComplete
        this.options.onComplete?.(task);
      } else if (this.pausedAborted.has(task.id)) {
        // Task was paused mid-execution — clean up worktree and move to todo
        executorLog.log(`${task.id} paused — moving to todo`);
        this.pausedAborted.delete(task.id);
        if (worktreePath && existsSync(worktreePath)) {
          try {
            execSync(`git worktree remove "${worktreePath}" --force`, { cwd: this.rootDir, stdio: "pipe" });
            executorLog.log(`Removed old worktree for paused task: ${worktreePath}`);
          } catch (cleanupErr: any) {
            executorLog.warn(`Failed to remove old worktree ${worktreePath}: ${cleanupErr.message}`);
          }
        }
        await this.store.updateTask(task.id, { worktree: undefined, branch: undefined });
        await this.store.logEntry(task.id, "Execution paused — agent terminated, moved to todo");
        await this.store.moveTask(task.id, "todo");
      } else if (this.stuckAborted.has(task.id)) {
        // Task was killed by stuck task detector — defer requeue to finally block
        // (after this.executing is cleared) to prevent re-dispatch race.
        stuckRequeue = this.stuckAborted.get(task.id) ?? true;
        this.stuckAborted.delete(task.id);
        executorLog.log(`${task.id} terminated by stuck task detector — will ${stuckRequeue ? "retry" : "not retry (budget exhausted)"}`);
      } else {
        // Check if the error is a context-limit error and attempt compact-and-resume
        // before falling through to the normal failure path. This catches context
        // overflow errors from the LLM provider that occur during prompt execution.
        const loopState = this.loopRecoveryState.get(task.id);
        const loopAttempts = loopState?.attempts ?? 0;

        if (isContextLimitError(err.message) && loopAttempts < 1) {
          const activeEntry = this.activeSessions.get(task.id);
          if (activeEntry) {
            executorLog.log(`${task.id} context limit error — attempting compact-and-resume`);
            await this.store.logEntry(task.id, `Context limit error — attempting compact-and-resume: ${err.message}`);

            const compactResult = await compactSessionContext(activeEntry.session);
            if (compactResult) {
              this.loopRecoveryState.set(task.id, { attempts: loopAttempts + 1, pending: true });
              executorLog.log(`${task.id} context compaction succeeded — resuming`);

              try {
                this.options.stuckTaskDetector?.recordProgress(task.id);
                const resumePrompt = [
                  "Your conversation hit the context window limit and has been compacted.",
                  "Review the current state of the worktree and continue from where you left off.",
                  "Check git log and current files to understand what's already been done.",
                  "Take a different, more efficient approach if needed.",
                  "",
                  "Continue the task.",
                ].join("\n");
                await promptWithFallback(activeEntry.session, resumePrompt);
                checkSessionError(activeEntry.session);

                // Check for loop recovery pending from the compact-and-resume
                const updatedState = this.loopRecoveryState.get(task.id);
                if (updatedState?.pending) {
                  updatedState.pending = false;
                  await promptWithFallback(activeEntry.session, "Continue working on the remaining steps.");
                  checkSessionError(activeEntry.session);
                }
              } catch (resumeErr: any) {
                // Resume after context compaction failed — fall through to normal failure
                executorLog.error(`${task.id} resume after context compaction failed: ${resumeErr.message}`);
              }
            } else {
              executorLog.log(`${task.id} context compaction failed — falling through to normal failure`);
            }
          }
        } else if (this.options.usageLimitPauser && isUsageLimitError(err.message)) {
          await this.options.usageLimitPauser.onUsageLimitHit("executor", task.id, err.message);
        } else if (isTransientError(err.message)) {
          // Transient network/infrastructure error — use bounded recovery policy
          const decision = computeRecoveryDecision({
            recoveryRetryCount: task.recoveryRetryCount,
            nextRecoveryAt: task.nextRecoveryAt,
          });

          if (decision.shouldRetry) {
            const attempt = decision.nextState.recoveryRetryCount;
            const delay = formatDelay(decision.delayMs);
            // Silent transient errors (e.g., "request was aborted") are noisy — skip logging
            if (!isSilentTransientError(err.message)) {
              executorLog.warn(`⚡ ${task.id} transient error — retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}: ${err.message}`);
              await this.store.logEntry(task.id, `Transient error (retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}): ${err.message}`);
            }
            // Clean up the old worktree so the retry gets a fresh one
            if (worktreePath && existsSync(worktreePath)) {
              try {
                execSync(`git worktree remove "${worktreePath}" --force`, { cwd: this.rootDir, stdio: "pipe" });
                executorLog.log(`Removed old worktree for transient retry: ${worktreePath}`);
              } catch (cleanupErr: any) {
                executorLog.warn(`Failed to remove old worktree ${worktreePath}: ${cleanupErr.message}`);
              }
            }
            await this.store.updateTask(task.id, {
              recoveryRetryCount: decision.nextState.recoveryRetryCount,
              nextRecoveryAt: decision.nextState.nextRecoveryAt,
              worktree: undefined,
              branch: undefined,
            });
            await this.store.moveTask(task.id, "todo");
            return;
          }

          // Recovery budget exhausted — escalate to real failure
          executorLog.error(`✗ ${task.id} transient error retries exhausted (${MAX_RECOVERY_RETRIES} attempts): ${err.message}`);
          await this.store.logEntry(task.id, `Transient error retries exhausted after ${MAX_RECOVERY_RETRIES} attempts: ${err.message}`);
          await this.store.updateTask(task.id, {
            status: "failed",
            error: err.message,
            recoveryRetryCount: null,
            nextRecoveryAt: null,
          });
          this.options.onError?.(task, err);
          return;
        }
        executorLog.error(`✗ ${task.id} execution failed:`, err.message);
        await this.store.logEntry(task.id, `Execution failed: ${err.message}`);
        await this.store.updateTask(task.id, { status: "failed", error: err.message });
        this.options.onError?.(task, err);
      }
    } finally {
      this.executing.delete(task.id);

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
          // Clean up the old worktree so the retry gets a fresh one
          if (worktreePath && existsSync(worktreePath)) {
            try {
              execSync(`git worktree remove "${worktreePath}" --force`, { cwd: this.rootDir, stdio: "pipe" });
              executorLog.log(`Removed old worktree for stuck-killed retry: ${worktreePath}`);
            } catch (cleanupErr: any) {
              executorLog.warn(`Failed to remove old worktree ${worktreePath}: ${cleanupErr.message}`);
            }
          }
          await this.store.updateTask(task.id, { status: "stuck-killed", worktree: undefined, branch: undefined });
          await this.store.moveTask(task.id, "todo");
          executorLog.log(`${task.id} moved to todo for retry after stuck kill`);
        } catch (err: any) {
          executorLog.error(`Failed to requeue stuck task ${task.id}: ${err.message}`);
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
    const store = this.store;
    return {
      name: "task_log",
      label: "Log Entry",
      description:
        "Log an important action, decision, or issue for this task. " +
        "Use for significant events — not every small step.",
      parameters: taskLogParams,
      execute: async (_id: string, params: Static<typeof taskLogParams>) => {
        await store.logEntry(taskId, params.message, params.outcome);
        return {
          content: [{ type: "text" as const, text: `Logged: ${params.message}` }],
          details: {},
        };
      },
    };
  }

  private createTaskCreateTool(): ToolDefinition {
    const store = this.store;
    return {
      name: "task_create",
      label: "Create Task",
      description:
        "Create a new task for out-of-scope work discovered during execution. " +
        "The task goes into triage where it will be specified by the AI. " +
        "Optionally set dependencies (e.g., the new task depends on the current one, " +
        "or the current task should wait for the new one).",
      parameters: taskCreateParams,
      execute: async (_id: string, params: Static<typeof taskCreateParams>) => {
        const task = await store.createTask({
          description: params.description,
          dependencies: params.dependencies,
          column: "triage",
        });
        const deps = task.dependencies.length ? ` (depends on: ${task.dependencies.join(", ")})` : "";
        return {
          content: [{
            type: "text" as const,
            text: `Created ${task.id}: ${params.description}${deps}`,
          }],
          details: {},
        };
      },
    };
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
        onDone();
        // Mark all pending/in-progress steps as done
        const task = await store.getTask(taskId);
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
              defaultProvider: settings.defaultProvider,
              defaultModelId: settings.defaultModelId,
              fallbackProvider: settings.fallbackProvider,
              fallbackModelId: settings.fallbackModelId,
              defaultThinkingLevel: settings.defaultThinkingLevel,
              // Per-task validator overrides take precedence over global validator settings
              validatorModelProvider: detail.validatorModelProvider ?? settings.validatorProvider,
              validatorModelId: detail.validatorModelId ?? settings.validatorModelId,
              validatorFallbackModelProvider: settings.validatorFallbackProvider,
              validatorFallbackModelId: settings.validatorFallbackModelId,
              store,
              taskId,
            },
          );

          await store.logEntry(
            taskId,
            `${reviewType} review Step ${step}: ${result.verdict}`,
            result.summary,
          );
          reviewerLog.log(`${taskId}: Step ${step} ${reviewType} → ${result.verdict}`);

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
                  execSync(`git reset --hard ${baseline}`, { cwd: worktreePath, stdio: "pipe" });
                  executorLog.log(`${taskId}: RETHINK — git reset --hard ${baseline}`);
                } catch (gitErr: any) {
                  executorLog.error(`${taskId}: RETHINK git reset failed: ${gitErr.message}`);
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
                } catch {
                  // Fallback to branchWithSummary
                  try {
                    sessionRef.current.sessionManager.branchWithSummary(
                      checkpointId,
                      `RETHINK: ${result.summary || "Approach rejected by reviewer"}`,
                    );
                    executorLog.log(`${taskId}: RETHINK — branched from checkpoint ${checkpointId}`);
                  } catch (branchErr: any) {
                    executorLog.error(`${taskId}: RETHINK session rewind failed: ${branchErr.message}`);
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
        } catch (err: any) {
          reviewerLog.error(`${taskId}: review failed: ${err.message}`);
          await store.logEntry(taskId, `${reviewType} review failed: ${err.message}`);
          return {
            content: [{ type: "text" as const, text: `UNAVAILABLE — reviewer error: ${err.message}` }],
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
      execSync(`git worktree remove "${worktreePath}" --force`, { cwd: this.rootDir, stdio: "pipe" });
    } catch {
      // Worktree may already be gone
    }

    // Delete the branch — use stored branch name if available, fall back to convention
    const task = await this.store.getTask(taskId);
    const branch = task.branch || `fusion/${taskId.toLowerCase()}`;
    try {
      execSync(`git branch -D "${branch}"`, { cwd: this.rootDir, stdio: "pipe" });
    } catch {
      // Branch may not exist
    }

    // Clear worktree tracking
    this.activeWorktrees.delete(taskId);

    // Update task: clear worktree and status, move to triage
    await this.store.updateTask(taskId, { worktree: undefined, status: undefined });
    await this.store.moveTask(taskId, "triage");
    await this.store.logEntry(taskId, "Execution stopped — work discarded, moved to triage for re-specification");
  }

  /**
   * Capture the list of files modified during agent execution.
   * Uses git diff against the stored baseCommitSha to determine what changed.
   * Returns an empty array if no changes or if git commands fail.
   */
  private captureModifiedFiles(worktreePath: string, baseCommitSha?: string): string[] {
    try {
      // Determine the base reference for diff
      // If baseCommitSha is stored, use it; otherwise fall back to merge-base with HEAD
      let baseRef = baseCommitSha;
      if (!baseRef) {
        // Try to find merge-base with main/master as fallback
        try {
          baseRef = execSync("git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main", {
            cwd: worktreePath,
            stdio: "pipe",
            encoding: "utf-8",
          }).trim();
        } catch {
          // If merge-base fails, use HEAD~1 as last resort
          try {
            baseRef = execSync("git rev-parse HEAD~1", {
              cwd: worktreePath,
              stdio: "pipe",
              encoding: "utf-8",
            }).trim();
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
      const output = execSync(`git diff --name-only ${baseRef}..HEAD`, {
        cwd: worktreePath,
        stdio: "pipe",
        encoding: "utf-8",
      }).trim();

      if (!output) {
        return [];
      }

      return output.split("\n").filter(Boolean);
    } catch (err: any) {
      executorLog.log(`Failed to capture modified files: ${err.message}`);
      return [];
    }
  }

  // ── Worktree management ────────────────────────────────────────────

  /**
   * Create a git worktree at `path` on a new branch.
   *
   * @param branch — Branch name (e.g., `kb/kb-042`)
   * @param path — Absolute worktree directory path
   * @param startPoint — Optional git ref to branch from (e.g., `kb/kb-041`).
   *   When provided, the worktree starts from that ref instead of HEAD.
   */
  /**
   * Run workflow step agents sequentially after main task execution completes.
   * Each workflow step spawns a separate agent with the step's prompt.
   * Returns true if all steps pass, false if any fails.
   */
  private async runWorkflowSteps(
    task: Task,
    worktreePath: string,
    settings: Settings,
  ): Promise<boolean> {
    // Check if task has enabled workflow steps
    const currentTask = await this.store.getTask(task.id);
    if (!currentTask.enabledWorkflowSteps?.length) return true;

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

      try {
        const result = stepMode === "script"
          ? await this.executeScriptWorkflowStep(task, ws, worktreePath, settings)
          : await this.executeWorkflowStep(task, ws, worktreePath, settings);
        const completedAt = new Date().toISOString();

        if (result.success) {
          await this.store.logEntry(task.id, `[pre-merge] Workflow step completed: ${ws.name}`);
          executorLog.log(`${task.id} — [pre-merge] workflow step passed: ${ws.name}`);
          results.push({
            workflowStepId: ws.id,
            workflowStepName: ws.name,
            phase: stepPhase,
            status: "passed",
            output: result.output,
            startedAt,
            completedAt,
          });
          await this.store.updateTask(task.id, { workflowStepResults: results });
        } else {
          await this.store.logEntry(
            task.id,
            `[pre-merge] Workflow step failed: ${ws.name}`,
            result.error || "Unknown error",
          );
          executorLog.error(`${task.id} — [pre-merge] workflow step failed: ${ws.name} — ${result.error}`);
          results.push({
            workflowStepId: ws.id,
            workflowStepName: ws.name,
            phase: stepPhase,
            status: "failed",
            output: result.error || "Workflow step failed",
            startedAt,
            completedAt,
          });
          await this.store.updateTask(task.id, { workflowStepResults: results });
          return false;
        }
      } catch (err: any) {
        const completedAt = new Date().toISOString();
        await this.store.logEntry(
          task.id,
          `[pre-merge] Workflow step failed: ${ws.name}`,
          err.message || "Unknown error",
        );
        executorLog.error(`${task.id} — [pre-merge] workflow step error: ${ws.name} — ${err.message}`);
        results.push({
          workflowStepId: ws.id,
          workflowStepName: ws.name,
          phase: stepPhase,
          status: "failed",
          output: err.message || "Workflow step error",
          startedAt,
          completedAt,
        });
        await this.store.updateTask(task.id, { workflowStepResults: results });
        return false;
      }
    }

    return true;
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
      const output = execSync(scriptCommand, {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 120_000,
      });
      const stdout = output.toString().trim();
      return { success: true, output: stdout || `Script '${scriptName}' completed successfully` };
    } catch (err: any) {
      const stderr = err.stderr?.toString()?.trim() || "";
      const stdout = err.stdout?.toString()?.trim() || "";
      const exitCode = err.status;
      const parts: string[] = [];
      if (exitCode !== undefined) parts.push(`Exit code: ${exitCode}`);
      if (stdout) parts.push(`stdout: ${stdout}`);
      if (stderr) parts.push(`stderr: ${stderr}`);
      if (!parts.length) parts.push(err.message || "Unknown error");
      const errorOutput = parts.join("\n");
      return { success: false, error: errorOutput };
    }
  }

  /**
   * Execute a single workflow step by spawning an agent with the step's prompt.
   */
  private async executeWorkflowStep(
    task: Task,
    workflowStep: WorkflowStep,
    worktreePath: string,
    settings: Settings,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    const systemPrompt = `You are a workflow step agent executing: ${workflowStep.name}

Task Context:
- Task ID: ${task.id}
- Task Description: ${task.description}
- Worktree: ${worktreePath}

Your Instructions:
${workflowStep.prompt}

You have access to the file system to review changes.
When your review is complete and everything looks good, simply state your findings.
If issues are found that need attention, describe them clearly.`;

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

      const { session } = await createKbAgent({
        cwd: worktreePath,
        systemPrompt,
        tools: "readonly",
        defaultProvider: stepProvider,
        defaultModelId: stepModelId,
        fallbackProvider: settings.fallbackProvider,
        fallbackModelId: settings.fallbackModelId,
        defaultThinkingLevel: settings.defaultThinkingLevel,
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

      return { success: true, output };
    } catch (err: any) {
      await agentLogger.flush();
      return { success: false, error: err.message };
    }
  }

  private MAX_WORKTREE_RETRIES = 3;
  private WORKTREE_RETRY_DELAYS = [100, 500, 1000]; // ms

  /**
   * Create a git worktree with automatic recovery from conflicts.
   * Implements retry logic with exponential backoff for transient failures.
   * 
   * @param branch - The branch name to create (e.g., "kb/kb-123")
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
    let currentPath = path;

    for (let attempt = 0; attempt < this.MAX_WORKTREE_RETRIES; attempt++) {
      try {
        return await this.tryCreateWorktree(branch, currentPath, taskId, startPoint, attempt);
      } catch (error: any) {
        const isLastAttempt = attempt === this.MAX_WORKTREE_RETRIES - 1;

        if (isLastAttempt) {
          await this.store.logEntry(
            taskId,
            `Worktree creation failed after ${this.MAX_WORKTREE_RETRIES} attempts`,
            error.message,
          );
          throw new Error(
            `Failed to create worktree after ${this.MAX_WORKTREE_RETRIES} attempts: ${error.message}`,
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
  ): Promise<{ path: string; branch: string }> {
    // If directory exists but is not a registered worktree, remove it first
    if (existsSync(path)) {
      const isRegistered = this.isRegisteredWorktree(path);
      if (!isRegistered) {
        await this.store.logEntry(
          taskId,
          `Removing existing directory (not a registered worktree): ${path}`,
        );
        try {
          execSync(`rm -rf "${path}"`, { cwd: this.rootDir, stdio: "pipe" });
        } catch (e: any) {
          throw new Error(`Failed to remove existing directory ${path}: ${e.message}`);
        }
      } else {
        executorLog.log(`Worktree already exists: ${path}`);
        return { path, branch };
      }
    }

    const createWithBranch = (branchToCreate: string) => {
      const cmd = startPoint
        ? `git worktree add -b "${branchToCreate}" "${path}" "${startPoint}"`
        : `git worktree add -b "${branchToCreate}" "${path}"`;
      execSync(cmd, { cwd: this.rootDir, stdio: "pipe" });
    };

    const createFromExistingBranch = () => {
      execSync(`git worktree add "${path}" "${branch}"`, { cwd: this.rootDir, stdio: "pipe" });
    };

    try {
      createWithBranch(branch);
      executorLog.log(`Worktree created: ${path}${startPoint ? ` (from ${startPoint})` : ""}`);
      if (attemptNumber > 0) {
        await this.store.logEntry(taskId, `Worktree created on attempt ${attemptNumber + 1}`, path);
      }
      return { path, branch };
    } catch (initialError: any) {
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
        const branchCleaned = await this.cleanupStaleBranch(branch, taskId);
        if (branchCleaned) {
          await this.store.logEntry(taskId, `Removed stale branch reference, retrying`);
          return this.tryCreateWorktree(branch, path, taskId, startPoint, attemptNumber);
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
        createFromExistingBranch();
        executorLog.log(`Worktree created from existing branch: ${path}`);
        return { path, branch };
      } catch (fallbackError: any) {
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
          const branchCleaned = await this.cleanupStaleBranch(branch, taskId);
          if (branchCleaned) {
            await this.store.logEntry(taskId, `Cleaned up stale reference in fallback, retrying`);
            return this.tryCreateWorktree(branch, path, taskId, startPoint, attemptNumber);
          }
        }

        throw new Error(`Failed to create worktree: ${fallbackError.message}`);
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
        } catch (suffixErr: any) {
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
  private isRegisteredWorktree(path: string): boolean {
    try {
      const output = execSync("git worktree list --porcelain", {
        cwd: this.rootDir,
        encoding: "utf-8",
        stdio: "pipe",
      });
      return output.includes(path);
    } catch {
      return false;
    }
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
        const lockInfo = execSync(`git worktree unlock "${worktreePath}"`, {
          cwd: this.rootDir,
          stdio: "pipe",
        });
        if (lockInfo !== undefined) {
          await this.store.logEntry(taskId, `Unlocked worktree`, worktreePath);
        }
      } catch {
        // Unlock failed - worktree wasn't locked, that's fine
      }

      // Remove the worktree
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: this.rootDir,
        stdio: "pipe",
      });
      await this.store.logEntry(taskId, `Removed conflicting worktree`, worktreePath);

      // Delete the branch if it exists
      try {
        execSync(`git branch -D "${branch}"`, {
          cwd: this.rootDir,
          stdio: "pipe",
        });
        await this.store.logEntry(taskId, `Deleted branch`, branch);
      } catch {
        // Branch might not exist, that's fine
      }

      return true;
    } catch (error: any) {
      await this.store.logEntry(
        taskId,
        `Failed to clean up conflicting worktree`,
        `${worktreePath}: ${error.message}`,
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
      execSync("git worktree prune", { cwd: this.rootDir, stdio: "pipe" });
      await this.store.logEntry(taskId, `Pruned stale worktree metadata`, branch);
    } catch {
      // Prune is best-effort — continue even if it fails
    }

    // Step 2: Try normal branch deletion
    try {
      execSync(`git branch -D "${branch}"`, {
        cwd: this.rootDir,
        stdio: "pipe",
      });
      await this.store.logEntry(taskId, `Removed stale branch`, branch);
      return true;
    } catch (branchDeleteError: any) {
      await this.store.logEntry(
        taskId,
        `git branch -D failed for stale branch, trying update-ref`,
        `${branch}: ${branchDeleteError.message}`,
      );
    }

    // Step 3: Force-remove the reference directly
    try {
      const refPath = `refs/heads/${branch}`;
      execSync(`git update-ref -d "${refPath}"`, {
        cwd: this.rootDir,
        stdio: "pipe",
      });
      await this.store.logEntry(taskId, `Force-removed stale branch reference via update-ref`, refPath);
      return true;
    } catch (updateRefError: any) {
      await this.store.logEntry(
        taskId,
        `Failed to remove stale branch reference`,
        `${branch}: ${updateRefError.message}`,
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
  private extractWorktreeConflictInfo(error: any): {
    type: "already-used" | "invalid-reference" | "leading-directories" | "already-exists" | "unknown";
    path?: string;
    message?: string;
  } {
    const output = [error?.message, error?.stderr?.toString?.(), error?.stdout?.toString?.()]
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
      execSync(`git worktree remove "${worktreePath}" --force`, { cwd: this.rootDir, stdio: "pipe" });
      executorLog.log(`Cleaned up worktree for ${taskId}`);
    } catch (err: any) {
      executorLog.error(`Failed to clean up worktree for ${taskId}:`, err.message);
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
    this.stuckAborted.set(taskId, shouldRequeue);
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
    } catch (err: any) {
      executorLog.error(`${taskId} failed to steer after compaction: ${err.message}`);
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
    } catch {
      // Agent may not exist in store — that's ok for cleanup
    }

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
    } catch {
      // State update failure shouldn't block execution
    }

    try {
      await promptWithFallback(childSession, taskPrompt);
      // Normal completion — mark as active (available)
      try {
        await this.options.agentStore?.updateAgentState(agentId, "active");
      } catch { /* non-critical */ }
    } catch (err: any) {
      // Error during execution — mark as error
      try {
        await this.options.agentStore?.updateAgentState(agentId, "error");
      } catch { /* non-critical */ }
      executorLog.warn(`Child agent ${agentId} failed: ${err.message}`);
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

          // Create child agent session
          const { session: childSession } = await createKbAgent({
            cwd: childWorktreePath,
            systemPrompt: `You are a child agent spawned by a parent task executor. Your job is to complete the following delegated task. Work autonomously and thoroughly. Report your findings and results.\n\nParent task: ${taskId}\nChild agent: ${agent.id} (${name})`,
            tools: "coding",
            defaultProvider: settings.defaultProvider,
            defaultModelId: settings.defaultModelId,
            fallbackProvider: settings.fallbackProvider,
            fallbackModelId: settings.fallbackModelId,
          });

          // Store tracking state
          this.childSessions.set(agent.id, childSession);
          if (!this.spawnedAgents.has(taskId)) {
            this.spawnedAgents.set(taskId, new Set());
          }
          this.spawnedAgents.get(taskId)!.add(agent.id);
          this.totalSpawnedCount++;

          // Run child asynchronously (don't await — parent continues working)
          this.runSpawnedChild(agent.id, childSession, taskPrompt).catch((err: any) => {
            executorLog.warn(`Child agent ${agent.id} async error: ${err.message}`);
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
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `Failed to spawn agent: ${err.message}` }],
            details: { agentId: "", state: "error", message: err.message },
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
export function buildExecutionPrompt(task: TaskDetail, rootDir?: string, settings?: Settings): string {
  const reviewMatch = task.prompt.match(/##\s*Review Level[:\s]*(\d)/);
  const reviewLevel = reviewMatch ? parseInt(reviewMatch[1], 10) : 0;

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
  // When enabled, agents consult and update .fusion/memory.md for durable project learnings.
  // Actual memory instructions will be injected by FN-810; this placeholder establishes
  // the conditional integration point.
  const memoryEnabled = settings?.memoryEnabled !== false;
  let memorySection = "";
  if (memoryEnabled && rootDir) {
    // TODO(FN-810): Call buildMemoryInstructions(rootDir) to populate memory context
    memorySection = "";
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

${task.prompt}
${attachmentsSection}${commandsSection}${memorySection}${progressSection}${steeringSection}
## Review level: ${reviewLevel}

${reviewLevel === 0 ? "No reviews required. Implement directly." : ""}
${reviewLevel >= 1 ? `Before implementing each step (except Step 0 and the final step), call:
\`review_step(step=N, type="plan", step_name="...")\`` : ""}
${reviewLevel >= 2 ? `After implementing + committing each step, call:
\`review_step(step=N, type="code", step_name="...", baseline="<SHA from before step>")\`` : ""}
${reviewLevel >= 3 ? `After tests, also call review_step with type="code" for test review.` : ""}

## Begin

${hasProgress
    ? `Resume from Step ${task.currentStep}. Do NOT redo completed steps.`
    : "Start with Step 0 (Preflight). Work through each step in order."}
Use \`task_update\` to report progress on every step transition.
Use \`task_log\` for important actions and decisions.
Use \`task_create\` for truly separate follow-up work, not for fixes required to get tests, build, or typecheck back to green.
Commit at step boundaries: \`git commit -m "feat(${task.id}): complete Step N — description"\`
When all steps are complete: call \`task_done()\`

If a build command is configured, run that exact command in this worktree before calling \`task_done()\`.
Treat a non-zero exit code as a blocking failure. Do not claim success without a real passing run.
Run the configured/full test suite and fix failures even when that requires edits outside the original File Scope.
If the repo has a typecheck command, run it before \`task_done()\` and fix any failures it reports.`;
}

/**
 * Format a comment for injection into a running agent session.
 * Used for real-time steering during task execution.
 */
function formatCommentForInjection(comment: import("@fusion/core").SteeringComment): string {
  const timestamp = formatTimestamp(comment.createdAt);
  return `📣 **New feedback** — ${timestamp} (${comment.author}):\n\n${comment.text}\n\nPlease adjust your approach based on this feedback.`;
}
