import { execSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { TaskStore, Task, MergeResult } from "@hai/core";
import { createHaiAgent } from "./pi.js";

const MERGE_SYSTEM_PROMPT = `You are a merge agent for "hai", an AI-orchestrated task board.

Your job is to finalize a git merge: resolve any conflicts and write a good commit message.

## Conflict resolution
If there are merge conflicts:
1. Run \`git diff --name-only --diff-filter=U\` to list conflicted files
2. Read each conflicted file — look for the <<<<<<< / ======= / >>>>>>> markers
3. Understand the intent of BOTH sides, then edit the file to produce the correct merged result
4. Remove ALL conflict markers — the result must be clean, compilable code
5. Run \`git add <file>\` for each resolved file
6. Do NOT change anything beyond what's needed to resolve the conflict

## Commit message
After all conflicts are resolved (or if there were none), write and execute the merge commit.

Look at the branch commits and diff to understand what was done, then run:
\`\`\`
git commit --no-edit -m "<type>(<scope>): <summary>" -m "<body>"
\`\`\`

Message format:
- **Type:** feat, fix, refactor, docs, test, chore
- **Scope:** the task ID (e.g., HAI-001)
- **Summary:** one line describing what the merge brings in (imperative mood)
- **Body:** 2-5 bullet points summarizing the key changes, each starting with "- "

Example:
\`\`\`
git commit --no-edit -m "feat(HAI-003): add user profile page" -m "- Add /profile route with avatar upload
- Create ProfileCard and EditProfileForm components
- Add profile image resizing via sharp
- Update nav bar with profile link
- Add profile e2e tests"
\`\`\`

Do NOT use generic messages like "merge branch" or "resolve conflicts".
Base the message on the ACTUAL work done in the commits.`;

export interface MergerOptions {
  /** Called with agent text output */
  onAgentText?: (delta: string) => void;
  /** Called with agent tool usage */
  onAgentTool?: (toolName: string) => void;
}

/**
 * AI-powered merge: resolves conflicts with a pi agent and
 * writes a commit message that summarizes the branch's work.
 */
export async function aiMergeTask(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  options: MergerOptions = {},
): Promise<MergeResult> {
  // 1. Validate task state
  const task = await store.getTask(taskId);
  if (task.column !== "in-review") {
    throw new Error(
      `Cannot merge ${taskId}: task is in '${task.column}', must be in 'in-review'`,
    );
  }

  const branch = `hai/${taskId.toLowerCase()}`;
  const worktreePath = task.worktree || join(rootDir, ".worktrees", taskId);
  const result: MergeResult = {
    task,
    branch,
    merged: false,
    worktreeRemoved: false,
    branchDeleted: false,
  };

  // 2. Check branch exists
  try {
    execSync(`git rev-parse --verify "${branch}"`, {
      cwd: rootDir,
      stdio: "pipe",
    });
  } catch {
    result.error = `Branch '${branch}' not found — moving to done without merge`;
    await completeTask(store, taskId, result);
    return result;
  }

  // 3. Gather context for the agent
  let commitLog = "";
  let diffStat = "";
  try {
    commitLog = execSync(`git log main..${branch} --format="- %s"`, {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();
  } catch {
    commitLog = "(unable to read commit log)";
  }
  try {
    diffStat = execSync(`git diff main..${branch} --stat`, {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();
  } catch {
    diffStat = "(unable to read diff)";
  }

  // 4. Start the merge (--no-commit so the agent controls the message)
  let hasConflicts = false;
  try {
    execSync(`git merge "${branch}" --no-commit --no-ff`, {
      cwd: rootDir,
      stdio: "pipe",
    });
  } catch {
    // Conflicts or other merge issue — check if it's conflicts
    try {
      const conflicted = execSync("git diff --name-only --diff-filter=U", {
        cwd: rootDir,
        encoding: "utf-8",
      }).trim();
      hasConflicts = conflicted.length > 0;

      if (!hasConflicts) {
        // Not conflicts — some other merge failure. Abort and throw.
        try {
          execSync("git merge --abort", { cwd: rootDir, stdio: "pipe" });
        } catch { /* */ }
        throw new Error(`Merge failed for branch '${branch}'`);
      }
    } catch (e: any) {
      if (e.message.includes("Merge failed")) throw e;
      // git diff itself failed — abort
      try {
        execSync("git merge --abort", { cwd: rootDir, stdio: "pipe" });
      } catch { /* */ }
      throw new Error(`Merge failed for branch '${branch}'`);
    }
  }

  // 5. Spawn pi agent to resolve conflicts (if any) and write commit message
  await store.updateTask(taskId, { status: "merging" });

  console.log(
    `[merger] ${taskId}: ${hasConflicts ? "resolving conflicts + " : ""}writing commit message`,
  );

  const { session } = await createHaiAgent({
    cwd: rootDir,
    systemPrompt: MERGE_SYSTEM_PROMPT,
    tools: "coding",
    onText: (delta) => options.onAgentText?.(delta),
    onToolStart: (name) => options.onAgentTool?.(name),
  });

  try {
    const prompt = buildMergePrompt(taskId, branch, commitLog, diffStat, hasConflicts);
    await session.prompt(prompt);

    // 6. Verify the commit happened — if MERGE_HEAD still exists, agent didn't commit
    let needsFallback = false;
    try {
      execSync("git rev-parse MERGE_HEAD", { cwd: rootDir, stdio: "pipe" });
      // If we get here, MERGE_HEAD exists = still uncommitted
      needsFallback = true;
    } catch {
      // MERGE_HEAD doesn't exist = commit was made successfully
    }

    if (needsFallback) {
      console.log("[merger] Agent didn't commit — committing with fallback message");
      execSync(
        `git commit --no-edit -m "feat(${taskId}): merge ${branch}" -m "${commitLog}"`,
        { cwd: rootDir, stdio: "pipe" },
      );
    }

    result.merged = true;
  } catch (err: any) {
    // Agent failed — try to abort the merge
    console.error(`[merger] Agent failed: ${err.message}`);
    try {
      execSync("git merge --abort", { cwd: rootDir, stdio: "pipe" });
    } catch { /* */ }
    throw new Error(`AI merge failed for ${taskId}: ${err.message}`);
  } finally {
    session.dispose();
  }

  // 7. Clean up worktree
  if (existsSync(worktreePath)) {
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: rootDir,
        stdio: "pipe",
      });
      result.worktreeRemoved = true;
    } catch { /* non-fatal */ }
  }

  // 8. Delete branch
  try {
    execSync(`git branch -d "${branch}"`, { cwd: rootDir, stdio: "pipe" });
    result.branchDeleted = true;
  } catch {
    try {
      execSync(`git branch -D "${branch}"`, { cwd: rootDir, stdio: "pipe" });
      result.branchDeleted = true;
    } catch { /* non-fatal */ }
  }

  // 9. Move task to done
  await completeTask(store, taskId, result);
  return result;
}

async function completeTask(
  store: TaskStore,
  taskId: string,
  result: MergeResult,
): Promise<void> {
  // Clear transient status before moving to done
  await store.updateTask(taskId, { status: null });
  // Use moveTask for proper event emission
  const task = await store.moveTask(taskId, "done");
  result.task = task;
  store.emit("task:merged", result);
}

function buildMergePrompt(
  taskId: string,
  branch: string,
  commitLog: string,
  diffStat: string,
  hasConflicts: boolean,
): string {
  const parts = [
    `Finalize the merge of branch \`${branch}\` for task ${taskId}.`,
    "",
    "## Branch commits",
    "```",
    commitLog,
    "```",
    "",
    "## Files changed",
    "```",
    diffStat,
    "```",
  ];

  if (hasConflicts) {
    parts.push(
      "",
      "## ⚠️ There are merge conflicts",
      "Run `git diff --name-only --diff-filter=U` to see which files.",
      "Resolve each conflict, then `git add` the resolved files.",
      "After resolving all conflicts, write and run the commit command.",
    );
  } else {
    parts.push(
      "",
      "## No conflicts",
      "The merge applied cleanly. All changes are staged.",
      "Write and run the `git commit` command with a good message summarizing the work.",
    );
  }

  return parts.join("\n");
}
