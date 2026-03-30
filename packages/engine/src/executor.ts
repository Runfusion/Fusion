import { execSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { TaskStore, Task, TaskDetail, StepStatus, Settings } from "@kb/core";
import { findWorktreeUser } from "./merger.js";
import { generateWorktreeName } from "./worktree-names.js";
import { Type, type Static } from "@mariozechner/pi-ai";
import { createKbAgent } from "./pi.js";
import { reviewStep, type ReviewVerdict } from "./reviewer.js";
import type { ToolDefinition, AgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import { PRIORITY_EXECUTE, type AgentSemaphore } from "./concurrency.js";
import type { WorktreePool } from "./worktree-pool.js";
import { AgentLogger } from "./agent-logger.js";
import { executorLog, reviewerLog } from "./logger.js";
import { isUsageLimitError, checkSessionError, type UsageLimitPauser } from "./usage-limit-detector.js";

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
- Stay within the file scope defined in PROMPT.md
- Read "Context to Read First" files before starting
- Follow the "Do NOT" section strictly
- If you find work outside the task's scope, use \`task_create\`
- Update documentation listed in "Must Update" and check "Check If Affected"

## Completion
After all steps are done, tests pass, and docs are updated:
\`\`\`bash
Call \`task_done()\` to signal completion.`;

export interface TaskExecutorOptions {
  semaphore?: AgentSemaphore;
  /** Worktree pool for recycling idle worktrees across tasks. */
  pool?: WorktreePool;
  /** Usage limit pauser — triggers global pause when API limits are detected. */
  usageLimitPauser?: UsageLimitPauser;
  onStart?: (task: Task, worktreePath: string) => void;
  onComplete?: (task: Task) => void;
  onError?: (task: Task, error: Error) => void;
  onAgentText?: (taskId: string, delta: string) => void;
  onAgentTool?: (taskId: string, toolName: string) => void;
}

export class TaskExecutor {
  private activeWorktrees = new Map<string, string>();
  private executing = new Set<string>();
  /** Active agent sessions per task, used to terminate on pause. */
  private activeSessions = new Map<string, { dispose: () => void }>();
  /** Tasks that were paused mid-execution (to avoid marking them as "failed"). */
  private pausedAborted = new Set<string>();
  /** Tasks that had a dependency added mid-execution (abort + discard worktree). */
  private depAborted = new Set<string>();

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
    store.on("task:moved", ({ task, to }) => {
      if (to === "in-progress") {
        this.execute(task).catch((err) =>
          executorLog.error(`Failed to start ${task.id}:`, err),
        );
      }
    });

    // When a task is paused while executing, terminate the agent session.
    store.on("task:updated", (task) => {
      if (task.paused && this.activeSessions.has(task.id)) {
        executorLog.log(`Pausing ${task.id} — terminating agent session`);
        this.pausedAborted.add(task.id);
        const session = this.activeSessions.get(task.id);
        session?.dispose();
      }
    });

    // When globalPause transitions from false → true, terminate all active agent sessions.
    store.on("settings:updated", ({ settings, previous }) => {
      if (settings.globalPause && !previous.globalPause) {
        for (const [taskId, session] of this.activeSessions) {
          executorLog.log(`Global pause — terminating agent session for ${taskId}`);
          this.pausedAborted.add(taskId);
          session.dispose();
        }
      }
    });

  }

  /**
   * Resume orphaned in-progress tasks (e.g., after crash/restart).
   * Call once after engine startup.
   */
  async resumeOrphaned(): Promise<void> {
    const tasks = await this.store.listTasks();
    const inProgress = tasks.filter(
      (t) => t.column === "in-progress" && !this.executing.has(t.id) && !t.paused,
    );

    if (inProgress.length === 0) return;

    executorLog.log(`Found ${inProgress.length} orphaned in-progress task(s)`);
    for (const task of inProgress) {
      executorLog.log(`Resuming ${task.id}: ${task.title || task.description.slice(0, 60)}`);
      await this.store.logEntry(task.id, "Resumed after engine restart");
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
    if (this.executing.has(task.id)) return;
    this.executing.add(task.id);

    executorLog.log(`Starting ${task.id}: ${task.title || task.description.slice(0, 60)}`);

    // Hoist worktreePath so it's accessible in the catch block for dep-abort cleanup
    let worktreePath = task.worktree || join(this.rootDir, ".worktrees", generateWorktreeName(this.rootDir));

    try {
      // Check dependencies
      const allTasks = await this.store.listTasks();
      const unmetDeps = task.dependencies.filter((depId) => {
        const dep = allTasks.find((t) => t.id === depId);
        return dep && dep.column !== "done" && dep.column !== "in-review";
      });

      if (unmetDeps.length > 0) {
        executorLog.log(`${task.id} blocked by: ${unmetDeps.join(", ")} — deferring`);
        return;
      }

      // Create or reuse worktree — try pool first when recycling is enabled
      const branchName = `kb/${task.id.toLowerCase()}`;
      // Use generateWorktreeName for human-friendly directory names (adjective-noun pattern)
      // instead of task.id, so worktrees are named like ".worktrees/swift-falcon"
      let isResume = existsSync(worktreePath);
      let acquiredFromPool = false;
      const settings = await this.store.getSettings();

      // Resolve the base branch — set by the scheduler when a dep is in-review
      const baseBranch = task.baseBranch || null;

      if (!isResume) {

        // Try acquiring a warm worktree from the pool
        if (this.options.pool && settings.recycleWorktrees) {
          const pooled = this.options.pool.acquire();
          if (pooled) {
            this.options.pool.prepareForTask(pooled, branchName, baseBranch ?? undefined);
            worktreePath = pooled;
            acquiredFromPool = true;
            executorLog.log(`Acquired worktree from pool: ${pooled}`);
            await this.store.updateTask(task.id, { worktree: worktreePath });
            await this.store.logEntry(task.id, `Acquired worktree from pool: ${worktreePath}`);
          }
        }

        // Fall through to fresh worktree creation if pool had nothing
        if (!acquiredFromPool) {
          this.createWorktree(branchName, worktreePath, baseBranch ?? undefined);
          await this.store.updateTask(task.id, { worktree: worktreePath });

          if (baseBranch) {
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
        }
      } else {
        worktreePath = task.worktree || join(this.rootDir, ".worktrees", generateWorktreeName(this.rootDir));
        isResume = existsSync(worktreePath);
        this.createWorktree(branchName, worktreePath);
      }

      this.activeWorktrees.set(task.id, worktreePath);

      this.options.onStart?.(task, worktreePath);

      const detail = await this.store.getTask(task.id);

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
      // Mutable ref — populated after createKbAgent, tools access lazily via closure
      const sessionRef: { current: AgentSession | null } = { current: null };
      const stepCheckpoints = new Map<number, string>();

      const customTools = [
        this.createTaskUpdateTool(task.id, codeReviewVerdicts, sessionRef, stepCheckpoints),
        this.createTaskLogTool(task.id),
        this.createTaskCreateTool(),
        this.createTaskAddDepTool(task.id),
        this.createTaskDoneTool(task.id, () => { taskDone = true; }),
        this.createReviewStepTool(task.id, worktreePath, detail.prompt, codeReviewVerdicts, sessionRef, stepCheckpoints),
      ];

      const agentLogger = new AgentLogger({
        store: this.store,
        taskId: task.id,
        agent: "executor",
        onAgentText: this.options.onAgentText,
        onAgentTool: this.options.onAgentTool,
      });

      const agentWork = async () => {
        const { session } = await createKbAgent({
          cwd: worktreePath,
          systemPrompt: EXECUTOR_SYSTEM_PROMPT,
          tools: "coding",
          customTools,
          onText: agentLogger.onText,
          onThinking: agentLogger.onThinking,
          onToolStart: agentLogger.onToolStart,
          onToolEnd: agentLogger.onToolEnd,
          defaultProvider: settings.defaultProvider,
          defaultModelId: settings.defaultModelId,
          defaultThinkingLevel: settings.defaultThinkingLevel,
        });

        // Make session available to custom tools (task_update checkpoint capture, review_step rewind)
        sessionRef.current = session;

        // Register session so the pause listener can terminate it
        this.activeSessions.set(task.id, session);

        try {
          const agentPrompt = buildExecutionPrompt(detail, this.rootDir, settings);
          await session.prompt(agentPrompt);

          // Re-raise errors that pi-coding-agent swallowed after exhausting retries.
          // session.prompt() resolves normally even when retries are exhausted —
          // the error is stored on session.state.error instead of being thrown.
          checkSessionError(session);

          // If dependency was added during execution, discard worktree and move to triage
          if (this.depAborted.has(task.id)) {
            this.depAborted.delete(task.id);
            await this.handleDepAbortCleanup(task.id, worktreePath);
            return;
          }

          // If paused during execution, don't move to in-review
          if (this.pausedAborted.has(task.id)) {
            this.pausedAborted.delete(task.id);
            return;
          }

          if (taskDone) {
            await this.store.moveTask(task.id, "in-review");
            executorLog.log(`✓ ${task.id} completed → in-review`);
            this.options.onComplete?.(task);
          } else {
            await this.store.logEntry(task.id, "Agent finished without calling task_done — moved to in-review for inspection");
            await this.store.moveTask(task.id, "in-review");
            executorLog.log(`⚠ ${task.id} finished without task_done → in-review`);
            this.options.onComplete?.(task);
          }
        } finally {
          this.activeSessions.delete(task.id);
          await agentLogger.flush();
          session.dispose();
        }
      };

      if (this.options.semaphore) {
        await this.options.semaphore.run(agentWork, PRIORITY_EXECUTE);
      } else {
        await agentWork();
      }
    } catch (err: any) {
      if (this.depAborted.has(task.id)) {
        // Dependency added mid-execution — discard worktree and move to triage
        this.depAborted.delete(task.id);
        await this.handleDepAbortCleanup(task.id, worktreePath);
      } else if (this.pausedAborted.has(task.id)) {
        // Task was paused mid-execution — move to todo, don't mark as failed
        executorLog.log(`${task.id} paused — moving to todo`);
        this.pausedAborted.delete(task.id);
        await this.store.logEntry(task.id, "Execution paused — agent terminated, moved to todo");
        await this.store.moveTask(task.id, "todo");
      } else {
        // Check if the error is a usage-limit error and trigger global pause
        if (this.options.usageLimitPauser && isUsageLimitError(err.message)) {
          await this.options.usageLimitPauser.onUsageLimitHit("executor", task.id, err.message);
        }
        executorLog.error(`✗ ${task.id} execution failed:`, err.message);
        await this.store.logEntry(task.id, `Execution failed: ${err.message}`);
        await this.store.updateTask(task.id, { status: "failed" });
        this.options.onError?.(task, err);
      }
    } finally {
      this.executing.delete(task.id);
    }
  }

  // ── Custom tools for the worker agent ──────────────────────────────

  private createTaskUpdateTool(
    taskId: string,
    codeReviewVerdicts: Map<number, ReviewVerdict>,
    sessionRef: { current: AgentSession | null },
    stepCheckpoints: Map<number, string>,
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
        const session = this.activeSessions.get(taskId);
        session?.dispose();

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
        "Automatically marks all remaining steps as done.",
      parameters: Type.Object({}),
      execute: async () => {
        onDone();
        // Mark all pending/in-progress steps as done
        const task = await store.getTask(taskId);
        for (let i = 0; i < task.steps.length; i++) {
          if (task.steps[i].status !== "done" && task.steps[i].status !== "skipped") {
            await store.updateStep(taskId, i, "done");
          }
        }
        await store.logEntry(taskId, "Task marked done by agent");
        return {
          content: [{ type: "text" as const, text: "Task marked complete. All steps done. Moving to in-review." }],
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
              defaultThinkingLevel: settings.defaultThinkingLevel,
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

    // Delete the branch
    const branch = `kb/${taskId.toLowerCase()}`;
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

  // ── Worktree management ────────────────────────────────────────────

  /**
   * Create a git worktree at `path` on a new branch.
   *
   * @param branch — Branch name (e.g., `kb/kb-042`)
   * @param path — Absolute worktree directory path
   * @param startPoint — Optional git ref to branch from (e.g., `kb/kb-041`).
   *   When provided, the worktree starts from that ref instead of HEAD.
   */
  private createWorktree(branch: string, path: string, startPoint?: string): void {
    if (existsSync(path)) {
      executorLog.log(`Worktree already exists: ${path}`);
      return;
    }
    try {
      const cmd = startPoint
        ? `git worktree add -b "${branch}" "${path}" "${startPoint}"`
        : `git worktree add -b "${branch}" "${path}"`;
      execSync(cmd, { cwd: this.rootDir, stdio: "pipe" });
    } catch {
      try {
        execSync(`git worktree add "${path}" "${branch}"`, { cwd: this.rootDir, stdio: "pipe" });
      } catch (e: any) {
        throw new Error(`Failed to create worktree: ${e.message}`);
      }
    }
    executorLog.log(`Worktree created: ${path}${startPoint ? ` (from ${startPoint})` : ""}`);
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

  getWorktreePath(taskId: string): string | undefined {
    return this.activeWorktrees.get(taskId);
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
      const absPath = `${rootDir}/.kb/tasks/${task.id}/attachments/${att.filename}`;
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

  // Build steering comments section (last 10 comments only to avoid context bloat)
  let steeringSection = "";
  if (task.steeringComments && task.steeringComments.length > 0) {
    const recentComments = [...task.steeringComments].slice(-10);
    const lines = [
      "",
      "## Steering Comments",
      "",
      "The following steering comments were added by the user during execution. Consider adjusting your approach or replanning remaining steps based on this feedback.",
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
${attachmentsSection}${commandsSection}${progressSection}${steeringSection}
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
Use \`task_create\` if you find out-of-scope work that needs doing.
Commit at step boundaries: \`git commit -m "feat(${task.id}): complete Step N — description"\`
When all steps are complete: call \`task_done()\``;
}
