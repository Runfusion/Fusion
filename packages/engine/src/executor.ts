import { execSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { TaskStore, Task, TaskDetail, StepStatus } from "@hai/core";
import { Type } from "@mariozechner/pi-ai";
import { createHaiAgent } from "./pi.js";
import { reviewStep } from "./reviewer.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentSemaphore } from "./concurrency.js";

const STEP_STATUSES: StepStatus[] = ["pending", "in-progress", "done", "skipped"];

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
echo "done" > .DONE
\`\`\``;

export interface TaskExecutorOptions {
  semaphore?: AgentSemaphore;
  onStart?: (task: Task, worktreePath: string) => void;
  onComplete?: (task: Task) => void;
  onError?: (task: Task, error: Error) => void;
  onAgentText?: (taskId: string, delta: string) => void;
  onAgentTool?: (taskId: string, toolName: string) => void;
}

export class TaskExecutor {
  private activeWorktrees = new Map<string, string>();
  private executing = new Set<string>();

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
  }

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

      // Create worktree
      const branchName = `hai/${task.id.toLowerCase()}`;
      const worktreePath = join(this.rootDir, ".worktrees", task.id);
      this.createWorktree(branchName, worktreePath);
      this.activeWorktrees.set(task.id, worktreePath);

      await this.store.updateTask(task.id, { worktree: worktreePath });
      await this.store.logEntry(task.id, `Worktree created at ${worktreePath}`);

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
      const customTools = [
        this.createTaskUpdateTool(task.id),
        this.createTaskLogTool(task.id),
        this.createTaskCreateTool(),
        this.createReviewStepTool(task.id, worktreePath, detail.prompt),
      ];

      const agentWork = async () => {
        const { session } = await createHaiAgent({
          cwd: worktreePath,
          systemPrompt: EXECUTOR_SYSTEM_PROMPT,
          tools: "coding",
          customTools,
          onText: (delta) => this.options.onAgentText?.(task.id, delta),
          onToolStart: (name) => this.options.onAgentTool?.(task.id, name),
        });

        try {
          const agentPrompt = buildExecutionPrompt(detail);
          await session.prompt(agentPrompt);

          const doneCwd = join(worktreePath, ".DONE");
          if (existsSync(doneCwd)) {
            await this.store.logEntry(task.id, "Execution complete — .DONE created");
            await this.store.moveTask(task.id, "in-review");
            console.log(`[executor] ✓ ${task.id} completed → in-review`);
            this.options.onComplete?.(task);
          } else {
            await this.store.logEntry(task.id, "Agent finished without .DONE — moved to in-review for inspection");
            await this.store.moveTask(task.id, "in-review");
            console.log(`[executor] ⚠ ${task.id} agent finished without .DONE → in-review`);
            this.options.onComplete?.(task);
          }
        } finally {
          session.dispose();
        }
      };

      if (this.options.semaphore) {
        await this.options.semaphore.run(agentWork);
      } else {
        await agentWork();
      }
    } catch (err: any) {
      console.error(`[executor] ✗ ${task.id} execution failed:`, err.message);
      await this.store.logEntry(task.id, `Execution failed: ${err.message}`);
      this.options.onError?.(task, err);
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
      parameters: Type.Object({
        step: Type.Number({ description: "Step number (0-indexed)" }),
        status: Type.Union(
          STEP_STATUSES.map((s) => Type.Literal(s)),
          { description: "New status: pending, in-progress, done, or skipped" },
        ),
      }),
      execute: async (_id, params) => {
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
      parameters: Type.Object({
        message: Type.String({ description: "What happened" }),
        outcome: Type.Optional(Type.String({ description: "Result or consequence (optional)" })),
      }),
      execute: async (_id, params) => {
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
      parameters: Type.Object({
        description: Type.String({ description: "What needs to be done" }),
        dependencies: Type.Optional(
          Type.Array(Type.String(), { description: "Task IDs this new task depends on (e.g. [\"HAI-001\"])" }),
        ),
      }),
      execute: async (_id, params) => {
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
      parameters: Type.Object({
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
      }),
      execute: async (_toolCallId, params) => {
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

  async cleanup(taskId: string): Promise<void> {
    const worktreePath = this.activeWorktrees.get(taskId);
    if (!worktreePath) return;
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, { cwd: this.rootDir, stdio: "pipe" });
      this.activeWorktrees.delete(taskId);
      console.log(`[executor] Cleaned up worktree for ${taskId}`);
    } catch (err: any) {
      console.error(`[executor] Failed to clean up worktree for ${taskId}:`, err.message);
    }
  }

  getWorktreePath(taskId: string): string | undefined {
    return this.activeWorktrees.get(taskId);
  }
}

function buildExecutionPrompt(task: TaskDetail): string {
  const reviewMatch = task.prompt.match(/##\s*Review Level[:\s]*(\d)/);
  const reviewLevel = reviewMatch ? parseInt(reviewMatch[1], 10) : 0;

  return `Execute this task.

## Task: ${task.id}
${task.title ? `**${task.title}**` : ""}
${task.dependencies.length > 0 ? `Dependencies: ${task.dependencies.join(", ")}` : ""}

## PROMPT.md

${task.prompt}

## Review level: ${reviewLevel}

${reviewLevel === 0 ? "No reviews required. Implement directly." : ""}
${reviewLevel >= 1 ? `Before implementing each step (except Step 0 and the final step), call:
\`review_step(step=N, type="plan", step_name="...")\`` : ""}
${reviewLevel >= 2 ? `After implementing + committing each step, call:
\`review_step(step=N, type="code", step_name="...", baseline="<SHA from before step>")\`` : ""}
${reviewLevel >= 3 ? `After tests, also call review_step with type="code" for test review.` : ""}

## Begin

Start with Step 0 (Preflight). Work through each step in order.
Use \`task_update\` to report progress on every step transition.
Use \`task_log\` for important actions and decisions.
Use \`task_create\` if you find out-of-scope work that needs doing.
Commit at step boundaries: \`git commit -m "feat(${task.id}): complete Step N — description"\`
When done: \`echo "done" > .DONE\``;
}
