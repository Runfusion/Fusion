import { execSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { TaskStore, Task, TaskDetail } from "@hai/core";
import { createHaiAgent } from "./pi.js";

const EXECUTOR_SYSTEM_PROMPT = `You are a task execution agent for "hai", an AI-orchestrated task board.

You are working in a git worktree isolated from the main branch. Your job is to implement the task described in the PROMPT.md specification you're given.

## How to work
1. Read the PROMPT.md carefully — it contains your mission, steps, file scope, and acceptance criteria
2. Work through each step in order
3. Write clean, production-quality code
4. Test your changes
5. Commit at meaningful boundaries (step completion)

## Reporting progress via CLI

Use \`hai task\` commands to report your progress. The board updates in real-time.

### Step lifecycle
Before starting a step:
\`\`\`bash
hai task update {TASK_ID} {STEP_NUMBER} in-progress
\`\`\`

After completing a step:
\`\`\`bash
hai task update {TASK_ID} {STEP_NUMBER} done
\`\`\`

If skipping a step:
\`\`\`bash
hai task update {TASK_ID} {STEP_NUMBER} skipped
\`\`\`

### Logging
Log important actions, decisions, or issues:
\`\`\`bash
hai task log {TASK_ID} "description of what happened"
\`\`\`

### Discoveries
When you find something unexpected that may affect future tasks:
\`\`\`bash
hai task discover {TASK_ID} "what you found" "what to do about it" "optional/file/location"
\`\`\`

## Git discipline
- Commit after completing each step (not after every file change)
- Use conventional commit messages prefixed with the task ID:
  - \`feat({TASK_ID}): complete Step N — description\`
  - \`fix({TASK_ID}): description\`
  - \`test({TASK_ID}): description\`
- Do NOT commit broken or half-implemented code

## Review levels (from PROMPT.md)
- **Level 0 (None):** Just implement
- **Level 1 (Plan Only):** Before coding, outline your plan and verify it makes sense
- **Level 2 (Plan + Code):** Plan first, then after implementation review your own code for issues
- **Level 3 (Full):** Plan review, code review, and test review

## Guardrails
- Stay within the file scope defined in PROMPT.md
- Read "Context to Read First" files before starting
- Follow the "Do NOT" section strictly
- If you discover work outside the task's scope, log it with \`hai task discover\` but don't do it
- Update documentation listed in "Must Update" and check "Check If Affected"

## Documentation
The PROMPT.md has Documentation Requirements sections:
- **Must Update** — docs you MUST modify as part of this task
- **Check If Affected** — docs to review and update if your changes affect them

## Completion
After all steps are done, tests pass, and docs are updated, create a \`.DONE\` file:
\`\`\`bash
echo "done" > .DONE
\`\`\``;

export interface TaskExecutorOptions {
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

      // Persist worktree path
      await this.store.updateTask(task.id, { worktree: worktreePath });
      await this.store.logEntry(task.id, `Worktree created at ${worktreePath}`);

      this.options.onStart?.(task, worktreePath);

      // Read the task's PROMPT.md
      const detail = await this.store.getTask(task.id);

      // Parse steps into task.json if not already there
      if (detail.steps.length === 0) {
        const steps = await this.store.parseStepsFromPrompt(task.id);
        if (steps.length > 0) {
          // Write steps back
          const taskData = await this.store.getTask(task.id);
          taskData.steps = steps;
          await this.store.updateTask(task.id, {});
          // Re-read to get updated task with steps written by parseSteps
          // Actually we need a better approach - let updateStep handle lazy init
        }
      }

      // Create pi agent session in the worktree
      const { session } = await createHaiAgent({
        cwd: worktreePath,
        systemPrompt: EXECUTOR_SYSTEM_PROMPT,
        tools: "coding",
        onText: (delta) => this.options.onAgentText?.(task.id, delta),
        onToolStart: (name) => this.options.onAgentTool?.(task.id, name),
      });

      try {
        const agentPrompt = buildExecutionPrompt(detail, this.rootDir);
        await session.prompt(agentPrompt);

        // Check completion
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
    } catch (err: any) {
      console.error(`[executor] ✗ ${task.id} execution failed:`, err.message);
      await this.store.logEntry(task.id, `Execution failed: ${err.message}`);
      this.options.onError?.(task, err);
    } finally {
      this.executing.delete(task.id);
    }
  }

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

function buildExecutionPrompt(task: TaskDetail, rootDir: string): string {
  return `Execute this task. Read the PROMPT.md specification below, then implement it.

## Task Info
- **ID:** ${task.id}
- **Title:** ${task.title || task.description.slice(0, 80)}
${task.dependencies.length > 0 ? `- **Dependencies:** ${task.dependencies.join(", ")}` : ""}

## PROMPT.md

${task.prompt}

## Instructions

1. Read "Context to Read First" files listed in the spec
2. Report progress using the \`hai task\` CLI:
   - \`hai task update ${task.id} 0 in-progress\` — when starting Step 0
   - \`hai task update ${task.id} 0 done\` — when Step 0 is complete
   - \`hai task log ${task.id} "what you did"\` — for important actions
   - \`hai task discover ${task.id} "finding" "disposition"\` — for discoveries
3. Implement each step in order, committing at step boundaries:
   \`git commit -m "feat(${task.id}): complete Step N — description"\`
4. Follow the review level guidance in the spec
5. Update documentation per "Must Update" and "Check If Affected"
6. When all steps pass: \`echo "done" > .DONE\`

Begin with Step 0 (Preflight).`;
}
