import { execSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { TaskStore, Task, TaskDetail, StepStatus, Settings } from "@hai/core";
import { findWorktreeUser } from "./merger.js";
import { generateWorktreeName } from "./worktree-names.js";
import { Type, type Static } from "@mariozechner/pi-ai";
import { createHaiAgent } from "./pi.js";
import { reviewStep } from "./reviewer.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentSemaphore } from "./concurrency.js";
import type { WorktreePool } from "./worktree-pool.js";
import { AgentLogger } from "./agent-logger.js";

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
    Type.Array(Type.String(), { description: "Task IDs this new task depends on (e.g. [\"HAI-001\"])" }),
  ),
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

const EXECUTOR_SYSTEM_PROMPT = `You are a task execution agent for "hai", an AI-orchestrated task board.

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
- **REVISE** → read the feedback, fix the issues, commit again, then proceed
- **RETHINK** → reconsider your approach, adjust plan, then implement

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

  constructor(
    private store: TaskStore,
    private rootDir: string,
    private options: TaskExecutorOptions = {},
  ) {
    store.on("task:moved", ({ task, to }) => {
      if (to === "in-progress") {
        this.execute(task).catch((err) =>
          console.error(`[executor] Failed to start ${task.id}:`, err),
        );
      }
    });

    // When a task is paused while executing, terminate the agent session.
    store.on("task:updated", (task) => {
      if (task.paused && this.activeSessions.has(task.id)) {
        console.log(`[executor] Pausing ${task.id} — terminating agent session`);
        this.pausedAborted.add(task.id);
        const session = this.activeSessions.get(task.id);
        session?.dispose();
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

    console.log(`[executor] Found ${inProgress.length} orphaned in-progress task(s)`);
    for (const task of inProgress) {
      console.log(`[executor] Resuming ${task.id}: ${task.title || task.description.slice(0, 60)}`);
      await this.store.logEntry(task.id, "Resumed after engine restart");
      this.execute(task).catch((err) =>
        console.error(`[executor] Failed to resume ${task.id}:`, err),
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
    console.log(`[executor] Reused worktree at ${worktreePath}, created branch ${branch}`);
  }

  /**
   * Execute a task in an isolated git worktree.
   *
   * **Worktree assignment:** New worktrees get humanized random names
   * (e.g., `.worktrees/swift-falcon/`) via `generateWorktreeName()` rather
   * than being named after the task ID. This decouples directory names from
   * tasks, enabling worktree reuse across dependency chains. When resuming
   * a task that already has `task.worktree` set, the existing path is used
   * as-is. Branches remain task-scoped (`hai/{task-id}`).
   */
  async execute(task: Task): Promise<void> {
    if (this.executing.has(task.id)) return;
    this.executing.add(task.id);

    console.log(`[executor] Starting ${task.id}: ${task.title || task.description.slice(0, 60)}`);

    try {
      // Check dependencies
      const allTasks = await this.store.listTasks();
      const unmetDeps = task.dependencies.filter((depId) => {
        const dep = allTasks.find((t) => t.id === depId);
        return dep && dep.column !== "done" && dep.column !== "in-review";
      });

      if (unmetDeps.length > 0) {
        console.log(`[executor] ${task.id} blocked by: ${unmetDeps.join(", ")} — deferring`);
        return;
      }

      // Create or reuse worktree — try pool first when recycling is enabled
      const branchName = `hai/${task.id.toLowerCase()}`;
      // Use generateWorktreeName for human-friendly directory names (adjective-noun pattern)
      // instead of task.id, so worktrees are named like ".worktrees/swift-falcon"
      let worktreePath = task.worktree || join(this.rootDir, ".worktrees", generateWorktreeName(this.rootDir));
      let isResume = existsSync(worktreePath);
      let acquiredFromPool = false;
      const settings = await this.store.getSettings();

      if (!isResume) {

        // Try acquiring a warm worktree from the pool
        if (this.options.pool && settings.recycleWorktrees) {
          const pooled = this.options.pool.acquire();
          if (pooled) {
            this.options.pool.prepareForTask(pooled, branchName);
            worktreePath = pooled;
            acquiredFromPool = true;
            console.log(`[executor] Acquired worktree from pool: ${pooled}`);
            await this.store.updateTask(task.id, { worktree: worktreePath });
            await this.store.logEntry(task.id, `Acquired worktree from pool: ${worktreePath}`);
          }
        }

        // Fall through to fresh worktree creation if pool had nothing
        if (!acquiredFromPool) {
          this.createWorktree(branchName, worktreePath);
          await this.store.updateTask(task.id, { worktree: worktreePath });
          await this.store.logEntry(task.id, `Worktree created at ${worktreePath}`);

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
      let taskDone = false;
      const customTools = [
        this.createTaskUpdateTool(task.id),
        this.createTaskLogTool(task.id),
        this.createTaskCreateTool(),
        this.createTaskDoneTool(task.id, () => { taskDone = true; }),
        this.createReviewStepTool(task.id, worktreePath, detail.prompt),
      ];

      const agentLogger = new AgentLogger({
        store: this.store,
        taskId: task.id,
        onAgentText: this.options.onAgentText,
        onAgentTool: this.options.onAgentTool,
      });

      const agentWork = async () => {
        const { session } = await createHaiAgent({
          cwd: worktreePath,
          systemPrompt: EXECUTOR_SYSTEM_PROMPT,
          tools: "coding",
          customTools,
          onText: agentLogger.onText,
          onToolStart: agentLogger.onToolStart,
          defaultProvider: settings.defaultProvider,
          defaultModelId: settings.defaultModelId,
        });

        // Register session so the pause listener can terminate it
        this.activeSessions.set(task.id, session);

        try {
          const agentPrompt = buildExecutionPrompt(detail, this.rootDir, settings);
          await session.prompt(agentPrompt);

          // If paused during execution, don't move to in-review
          if (this.pausedAborted.has(task.id)) {
            this.pausedAborted.delete(task.id);
            return;
          }

          if (taskDone) {
            await this.store.moveTask(task.id, "in-review");
            console.log(`[executor] ✓ ${task.id} completed → in-review`);
            this.options.onComplete?.(task);
          } else {
            await this.store.logEntry(task.id, "Agent finished without calling task_done — moved to in-review for inspection");
            await this.store.moveTask(task.id, "in-review");
            console.log(`[executor] ⚠ ${task.id} finished without task_done → in-review`);
            this.options.onComplete?.(task);
          }
        } finally {
          this.activeSessions.delete(task.id);
          await agentLogger.flush();
          session.dispose();
        }
      };

      if (this.options.semaphore) {
        await this.options.semaphore.run(agentWork);
      } else {
        await agentWork();
      }
    } catch (err: any) {
      if (this.pausedAborted.has(task.id)) {
        // Task was paused mid-execution — move to todo, don't mark as failed
        console.log(`[executor] ${task.id} paused — moving to todo`);
        this.pausedAborted.delete(task.id);
        await this.store.logEntry(task.id, "Execution paused — agent terminated, moved to todo");
        await this.store.moveTask(task.id, "todo");
      } else {
        console.error(`[executor] ✗ ${task.id} execution failed:`, err.message);
        await this.store.logEntry(task.id, `Execution failed: ${err.message}`);
        await this.store.updateTask(task.id, { status: "failed" });
        this.options.onError?.(task, err);
      }
    } finally {
      this.executing.delete(task.id);
    }
  }

  // ── Custom tools for the worker agent ──────────────────────────────

  private createTaskUpdateTool(taskId: string): ToolDefinition {
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

  private createReviewStepTool(
    taskId: string,
    worktreePath: string,
    promptContent: string,
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

        console.log(`[reviewer] ${taskId}: ${reviewType} review for Step ${step} (${step_name})`);
        await store.logEntry(taskId, `${reviewType} review requested for Step ${step} (${step_name})`);

        try {
          const result = await reviewStep(
            worktreePath, taskId, step, step_name,
            reviewType, promptContent, baseline,
            { onText: (delta) => options.onAgentText?.(taskId, delta) },
          );

          await store.logEntry(
            taskId,
            `${reviewType} review Step ${step}: ${result.verdict}`,
            result.summary,
          );
          console.log(`[reviewer] ${taskId}: Step ${step} ${reviewType} → ${result.verdict}`);

          let text: string;
          switch (result.verdict) {
            case "APPROVE": text = "APPROVE"; break;
            case "REVISE": text = `REVISE\n\n${result.review}`; break;
            case "RETHINK": text = `RETHINK\n\n${result.review}`; break;
            default: text = "UNAVAILABLE — reviewer did not produce a usable verdict.";
          }

          return { content: [{ type: "text" as const, text }], details: {} };
        } catch (err: any) {
          console.error(`[reviewer] ${taskId}: review failed: ${err.message}`);
          await store.logEntry(taskId, `${reviewType} review failed: ${err.message}`);
          return {
            content: [{ type: "text" as const, text: `UNAVAILABLE — reviewer error: ${err.message}` }],
            details: {},
          };
        }
      },
    };
  }

  // ── Worktree management ────────────────────────────────────────────

  private createWorktree(branch: string, path: string): void {
    if (existsSync(path)) {
      console.log(`[executor] Worktree already exists: ${path}`);
      return;
    }
    try {
      execSync(`git worktree add -b "${branch}" "${path}"`, { cwd: this.rootDir, stdio: "pipe" });
    } catch {
      try {
        execSync(`git worktree add "${path}" "${branch}"`, { cwd: this.rootDir, stdio: "pipe" });
      } catch (e: any) {
        throw new Error(`Failed to create worktree: ${e.message}`);
      }
    }
    console.log(`[executor] Worktree created: ${path}`);
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
      console.log(`[executor] Worktree retained for ${taskId} — still needed by ${otherUser}`);
      return;
    }

    try {
      execSync(`git worktree remove "${worktreePath}" --force`, { cwd: this.rootDir, stdio: "pipe" });
      console.log(`[executor] Cleaned up worktree for ${taskId}`);
    } catch (err: any) {
      console.error(`[executor] Failed to clean up worktree for ${taskId}:`, err.message);
    }
  }

  getWorktreePath(taskId: string): string | undefined {
    return this.activeWorktrees.get(taskId);
  }
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
      const absPath = `${rootDir}/.hai/tasks/${task.id}/attachments/${att.filename}`;
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

  return `Execute this task.

## Task: ${task.id}
${task.title ? `**${task.title}**` : ""}
${task.dependencies.length > 0 ? `Dependencies: ${task.dependencies.join(", ")}` : ""}

## PROMPT.md

${task.prompt}
${attachmentsSection}${commandsSection}${progressSection}
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
