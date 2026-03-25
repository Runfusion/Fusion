import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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

## Git discipline
- Commit after completing each major step
- Use conventional commit messages prefixed with the task ID
  - \`feat(HAI-001): implement user profile page\`
  - \`test(HAI-001): add profile page tests\`
  - \`fix(HAI-001): handle edge case in validation\`
- Do NOT commit broken or half-implemented code

## Guardrails
- Stay within the file scope defined in PROMPT.md
- Do not modify files outside the task's scope without good reason
- If you discover work that doesn't fit the task, note it but don't do it
- If a step is blocked or unclear, document why and move on

## Completion
When all steps are complete and tests pass, create a \`.DONE\` file in the task directory to signal completion.`;

export interface TaskExecutorOptions {
  /** Called when task execution starts */
  onStart?: (task: Task, worktreePath: string) => void;
  /** Called when task execution completes */
  onComplete?: (task: Task) => void;
  /** Called on execution failure */
  onError?: (task: Task, error: Error) => void;
  /** Called with agent text output */
  onAgentText?: (taskId: string, delta: string) => void;
  /** Called with agent tool usage */
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
    // Listen for tasks moving to in-progress
    store.on("task:moved", ({ task, to }) => {
      if (to === "in-progress") {
        this.execute(task).catch((err) =>
          console.error(`[executor] Failed to start ${task.id}:`, err),
        );
      }
    });
  }

  /**
   * Execute a task: create worktree, run pi agent, move to in-review.
   */
  async execute(task: Task): Promise<void> {
    if (this.executing.has(task.id)) return;
    this.executing.add(task.id);

    console.log(`[executor] Starting ${task.id}: ${task.title || task.id}`);

    try {
      // Check dependencies
      const allTasks = await this.store.listTasks();
      const unmetDeps = task.dependencies.filter((depId) => {
        const dep = allTasks.find((t) => t.id === depId);
        return dep && dep.column !== "done" && dep.column !== "in-review";
      });

      if (unmetDeps.length > 0) {
        console.log(
          `[executor] ${task.id} blocked by: ${unmetDeps.join(", ")} — deferring`,
        );
        return;
      }

      // Create worktree
      const branchName = `hai/${task.id.toLowerCase()}`;
      const worktreePath = join(this.rootDir, ".worktrees", task.id);
      await this.createWorktree(branchName, worktreePath);
      this.activeWorktrees.set(task.id, worktreePath);

      // Persist worktree path to task.json so merge can find it
      await this.store.updateTask(task.id, { worktree: worktreePath });

      this.options.onStart?.(task, worktreePath);

      // Read the task's PROMPT.md
      const detail = await this.store.getTask(task.id);

      // Create a pi agent session in the worktree
      const { session } = await createHaiAgent({
        cwd: worktreePath,
        systemPrompt: EXECUTOR_SYSTEM_PROMPT,
        tools: "coding",
        onText: (delta) => this.options.onAgentText?.(task.id, delta),
        onToolStart: (name) => {
          this.options.onAgentTool?.(task.id, name);
        },
      });

      try {
        const agentPrompt = buildExecutionPrompt(detail);
        await session.prompt(agentPrompt);

        // Check if the agent signaled completion (.DONE file)
        const doneFile = join(
          worktreePath,
          ".hai",
          "tasks",
          task.id,
          ".DONE",
        );
        const doneCwd = join(worktreePath, ".DONE");

        if (existsSync(doneFile) || existsSync(doneCwd)) {
          await this.store.moveTask(task.id, "in-review");
          console.log(`[executor] ✓ ${task.id} completed → in-review`);
          this.options.onComplete?.(task);
        } else {
          // Agent finished but didn't create .DONE — still move to review
          // so a human can inspect
          await this.store.moveTask(task.id, "in-review");
          console.log(
            `[executor] ⚠ ${task.id} agent finished without .DONE → in-review for inspection`,
          );
          this.options.onComplete?.(task);
        }
      } finally {
        session.dispose();
      }
    } catch (err: any) {
      console.error(`[executor] ✗ ${task.id} execution failed:`, err.message);
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
      // Try creating with new branch
      execSync(`git worktree add -b "${branch}" "${path}"`, {
        cwd: this.rootDir,
        stdio: "pipe",
      });
    } catch {
      // Branch might already exist — try attaching
      try {
        execSync(`git worktree add "${path}" "${branch}"`, {
          cwd: this.rootDir,
          stdio: "pipe",
        });
      } catch (e: any) {
        throw new Error(`Failed to create worktree: ${e.message}`);
      }
    }
    console.log(`[executor] Worktree created: ${path}`);
  }

  /**
   * Clean up worktree after merge (called when task moves to done).
   */
  async cleanup(taskId: string): Promise<void> {
    const worktreePath = this.activeWorktrees.get(taskId);
    if (!worktreePath) return;

    try {
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: this.rootDir,
        stdio: "pipe",
      });
      this.activeWorktrees.delete(taskId);
      console.log(`[executor] Cleaned up worktree for ${taskId}`);
    } catch (err: any) {
      console.error(
        `[executor] Failed to clean up worktree for ${taskId}:`,
        err.message,
      );
    }
  }

  getWorktreePath(taskId: string): string | undefined {
    return this.activeWorktrees.get(taskId);
  }
}

function buildExecutionPrompt(task: TaskDetail): string {
  return `Execute this task. The PROMPT.md specification follows.

## Task Info
- **ID:** ${task.id}
- **Title:** ${task.title || task.id}
${task.dependencies.length > 0 ? `- **Dependencies:** ${task.dependencies.join(", ")}` : ""}

## PROMPT.md
\`\`\`markdown
${task.prompt}
\`\`\`

## Instructions
1. Read and understand the specification above
2. Explore the codebase to understand the current state
3. Implement each step in order
4. Commit after completing each step using: \`git commit -m "feat(${task.id}): <description>"\`
5. When all steps pass, create a \`.DONE\` file: \`echo "done" > .DONE\`

Begin implementation now.`;
}
