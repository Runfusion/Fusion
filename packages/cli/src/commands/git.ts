import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
import { createInterface } from "node:readline/promises";
import { resolveProject } from "../project-context.js";

async function resolveGitCwd(projectName?: string): Promise<string> {
  if (projectName) {
    return (await resolveProject(projectName)).projectPath;
  }

  try {
    return (await resolveProject(undefined)).projectPath;
  } catch {
    return process.cwd();
  }
}

// ── Types ────────────────────────────────────────────────────────────────

/** Git status data structure */
export type GitStatus = {
  branch: string;
  commit: string;
  isDirty: boolean;
  ahead: number;
  behind: number;
};

/** Result of a fetch operation */
export type GitFetchResult = {
  fetched: boolean;
  message: string;
};

/** Result of a pull operation */
export type GitPullResult = {
  success: boolean;
  message: string;
  conflict?: boolean;
};

/** Result of a push operation */
export type GitPushResult = {
  success: boolean;
  message: string;
};

// ── Core Git Functions ─────────────────────────────────────────────────

/**
 * Check if a directory is a git repository.
 */
export async function isGitRepo(cwd: string = process.cwd()): Promise<boolean> {
  try {
    await execAsync("git rev-parse --git-dir", { encoding: "utf-8", timeout: 5000, cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates a branch name (or remote name) to prevent command injection.
 * Branch names must not contain spaces, special shell characters, or start with dashes.
 */
export function isValidBranchName(name: string): boolean {
  // Must not be empty
  if (!name || name.length === 0) return false;
  // Must not start with a dash (could be interpreted as an option)
  if (name.startsWith("-")) return false;
  // Must not contain shell metacharacters
  if (/[;<>&|`$(){}[\]\r\n]/.test(name)) return false;
  // Must be valid git ref format (no spaces, no double dots, etc)
  if (/\s/.test(name)) return false;
  if (name.includes("..")) return false;
  if (name.includes("~")) return false;
  if (name.includes("^")) return false;
  if (name.includes(":")) return false;
  // Must not be a reserved git ref name
  const reserved = ["HEAD", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD"];
  if (reserved.includes(name)) return false;
  return true;
}

/**
 * Get the current git status including branch, commit hash, and dirty state.
 * Returns structured data for CLI display.
 */
export async function getGitStatus(cwd: string = process.cwd()): Promise<GitStatus | null> {
  try {
    // Get current branch (empty string means detached HEAD)
    const { stdout: branchOutput } = await execAsync("git branch --show-current", { encoding: "utf-8", timeout: 5000, cwd });
    const branch = branchOutput.trim() || "HEAD detached";

    // Get current commit hash (short)
    const { stdout: commitOut } = await execAsync("git rev-parse --short HEAD", { encoding: "utf-8", timeout: 5000, cwd });
    const commit = commitOut.trim();

    // Check if working directory is dirty
    const { stdout: statusOutput } = await execAsync("git status --porcelain", { encoding: "utf-8", timeout: 5000, cwd });
    const isDirty = statusOutput.trim().length > 0;

    // Get ahead/behind counts from upstream
    let ahead = 0;
    let behind = 0;
    try {
      const { stdout: revListOutput } = await execAsync("git rev-list --left-right --count HEAD...@{u}", { encoding: "utf-8", timeout: 5000, cwd });
      const match = revListOutput.trim().match(/(\d+)\s+(\d+)/);
      if (match) {
        ahead = parseInt(match[1], 10);
        behind = parseInt(match[2], 10);
      }
    } catch {
      // No upstream or other error - leave as 0
    }

    return { branch, commit, isDirty, ahead, behind };
  } catch {
    return null;
  }
}

/**
 * Count dirty files by parsing git status output.
 */
export async function getDirtyFileCount(cwd: string = process.cwd()): Promise<{ added: number; modified: number; deleted: number }> {
  try {
    const { stdout } = await execAsync("git status --porcelain", { encoding: "utf-8", timeout: 5000, cwd });
    const output = stdout.trim();
    if (!output) return { added: 0, modified: 0, deleted: 0 };

    const lines = output.split("\n").filter(Boolean);
    let added = 0;
    let modified = 0;
    let deleted = 0;

    for (const line of lines) {
      const status = line.slice(0, 2);
      // First character is index status, second is working tree status
      if (status.includes("A") || status === "??") added++;
      else if (status.includes("D")) deleted++;
      else modified++;
    }

    return { added, modified, deleted };
  } catch {
    return { added: 0, modified: 0, deleted: 0 };
  }
}

/**
 * Fetch from origin or specified remote.
 */
export async function fetchGitRemote(remote: string = "origin", cwd: string = process.cwd()): Promise<GitFetchResult> {
  if (!isValidBranchName(remote)) {
    throw new Error("Invalid remote name");
  }
  try {
    const { stdout } = await execAsync(`git fetch ${remote}`, { encoding: "utf-8", timeout: 30000, cwd });
    return { fetched: true, message: stdout.trim() || "Fetch completed" };
  } catch (err: any) {
    const message = err.message || String(err);
    if (message.includes("Could not resolve host") || message.includes("Connection refused")) {
      throw new Error("Failed to connect to remote");
    }
    // No updates is not an error
    return { fetched: false, message: message || "No updates" };
  }
}

/**
 * Pull the current branch.
 */
export async function pullGitBranch(cwd: string = process.cwd()): Promise<GitPullResult> {
  try {
    const { stdout } = await execAsync("git pull", { encoding: "utf-8", timeout: 30000, cwd });
    return { success: true, message: stdout.trim() };
  } catch (err: any) {
    const message = err.message || String(err);
    if (message.includes("CONFLICT") || message.includes("Merge conflict")) {
      return { success: false, message: "Merge conflict detected. Resolve manually.", conflict: true };
    }
    throw new Error(message || "Pull failed");
  }
}

/**
 * Push the current branch.
 */
export async function pushGitBranch(cwd: string = process.cwd()): Promise<GitPushResult> {
  try {
    const { stdout } = await execAsync("git push", { encoding: "utf-8", timeout: 30000, cwd });
    return { success: true, message: stdout.trim() || "Push completed" };
  } catch (err: any) {
    const message = err.message || String(err);
    if (message.includes("rejected") || message.includes("non-fast-forward")) {
      throw new Error("Push rejected. Pull latest changes first.");
    }
    if (message.includes("Could not resolve host") || message.includes("Connection refused")) {
      throw new Error("Failed to connect to remote");
    }
    throw new Error(message || "Push failed");
  }
}

// ── CLI Command Runners ──────────────────────────────────────────────────

/**
 * Run the git status command and display formatted output.
 */
export async function runGitStatus(projectName?: string): Promise<void> {
  const projectPath = await resolveGitCwd(projectName);

  // Validate directory is a git repo
  if (!(await isGitRepo(projectPath))) {
    console.error("Error: Not a git repository");
    process.exit(1);
  }

  const status = await getGitStatus(projectPath);
  if (!status) {
    console.error("Error: Failed to get git status");
    process.exit(1);
  }

  console.log();
  console.log(`  Branch: ${status.branch}`);
  console.log(`  Commit: ${status.commit}`);

  // Status line
  if (status.isDirty) {
    const counts = await getDirtyFileCount(projectPath);
    const parts: string[] = [];
    if (counts.added) parts.push(`+${counts.added}`);
    if (counts.modified) parts.push(`~${counts.modified}`);
    if (counts.deleted) parts.push(`-${counts.deleted}`);
    console.log(`  Status: dirty (${parts.join(" ")})`);
  } else {
    console.log(`  Status: clean`);
  }

  // Remote status
  if (status.ahead > 0 || status.behind > 0) {
    const parts: string[] = [];
    if (status.ahead > 0) parts.push(`↑${status.ahead}`);
    if (status.behind > 0) parts.push(`↓${status.behind}`);
    console.log(`  Remote: ${parts.join(" ")} (${status.ahead > 0 ? `ahead ${status.ahead}` : ""}${status.ahead > 0 && status.behind > 0 ? ", " : ""}${status.behind > 0 ? `behind ${status.behind}` : ""})`);
  } else if (!status.branch.includes("detached")) {
    console.log(`  Remote: up to date`);
  }

  console.log();
}

/**
 * Run the git fetch command.
 * @param remote - The remote to fetch from (default: "origin")
 * @param projectName - Optional project name to target
 */
export async function runGitFetch(remote?: string, projectName?: string): Promise<void> {
  const targetRemote = remote || "origin";

  const projectPath = await resolveGitCwd(projectName);

  // Validate directory is a git repo
  if (!(await isGitRepo(projectPath))) {
    console.error("Error: Not a git repository");
    process.exit(1);
  }

  // Validate remote name
  if (!isValidBranchName(targetRemote)) {
    console.error(`Error: Invalid remote name: ${targetRemote}`);
    process.exit(1);
  }

  try {
    await execAsync(`git fetch ${targetRemote}`, { encoding: "utf-8", timeout: 30000, cwd: projectPath });
    console.log();
    console.log(`  ✓ Fetched from ${targetRemote}`);
    console.log();
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Run the git pull command.
 * @param options.skipConfirm - Skip confirmation when there are uncommitted changes
 * @param options.projectName - Optional project name to target
 */
export async function runGitPull(options: { skipConfirm?: boolean; projectName?: string } = {}): Promise<void> {
  const projectPath = await resolveGitCwd(options.projectName);

  // Validate directory is a git repo
  if (!(await isGitRepo(projectPath))) {
    console.error("Error: Not a git repository");
    process.exit(1);
  }

  // Check for dirty state
  const status = await getGitStatus(projectPath);
  if (!status) {
    console.error("Error: Failed to get git status");
    process.exit(1);
  }

  // Warn about uncommitted changes
  if (status.isDirty && !options.skipConfirm) {
    console.log();
    console.log("  ⚠ Warning: You have uncommitted changes.");
    console.log(`  Branch: ${status.branch}`);

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("  Continue with pull? [y/N] ");
    rl.close();

    const trimmed = answer.trim().toLowerCase();
    if (trimmed !== "y" && trimmed !== "yes") {
      console.log("  Cancelled.");
      process.exit(0);
    }
  }

  try {
    const { stdout } = await execAsync("git pull", { encoding: "utf-8", timeout: 30000, cwd: projectPath });
    console.log();
    console.log(`  ✓ Pulled latest changes for ${status.branch}`);
    if (stdout.trim() && stdout.trim() !== "Already up to date.") {
      console.log(`    ${stdout.trim()}`);
    }
    console.log();
  } catch (err: any) {
    const message = err.message || String(err);
    if (message.includes("CONFLICT") || message.includes("Merge conflict")) {
      console.error("  ✗ Merge conflict detected. Resolve manually.");
      process.exit(1);
    }
    console.error(`Error: ${message || "Pull failed"}`);
    process.exit(1);
  }
}

/**
 * Run the git push command.
 * @param options.skipConfirm - Skip confirmation prompt
 * @param options.projectName - Optional project name to target
 */
export async function runGitPush(options: { skipConfirm?: boolean; projectName?: string } = {}): Promise<void> {
  const projectPath = await resolveGitCwd(options.projectName);

  // Validate directory is a git repo
  if (!(await isGitRepo(projectPath))) {
    console.error("Error: Not a git repository");
    process.exit(1);
  }

  // Get current branch
  const status = await getGitStatus(projectPath);
  if (!status) {
    console.error("Error: Failed to get git status");
    process.exit(1);
  }

  if (status.branch === "HEAD detached") {
    console.error("Error: Cannot push in detached HEAD state");
    process.exit(1);
  }

  // Check for upstream
  try {
    await execAsync("git rev-parse --abbrev-ref --symbolic-full-name @{u}", { encoding: "utf-8", timeout: 5000, cwd: projectPath });
  } catch {
    console.error("Error: No upstream configured for current branch");
    console.error(`  Run: git push -u origin ${status.branch}`);
    process.exit(1);
  }

  // Confirmation prompt
  if (!options.skipConfirm) {
    console.log();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`  Push branch ${status.branch} to remote? [Y/n] `);
    rl.close();

    const trimmed = answer.trim().toLowerCase();
    if (trimmed !== "" && trimmed !== "y" && trimmed !== "yes") {
      console.log("  Cancelled.");
      process.exit(0);
    }
  }

  try {
    const { stdout } = await execAsync("git push", { encoding: "utf-8", timeout: 30000, cwd: projectPath });
    console.log();
    console.log(`  ✓ Pushed ${status.branch} to origin`);
    if (stdout.trim()) {
      console.log(`    ${stdout.trim()}`);
    }
    console.log();
  } catch (err: any) {
    const message = err.message || String(err);
    if (message.includes("rejected") || message.includes("non-fast-forward")) {
      console.error("Error: Push rejected. Pull latest changes first.");
    } else if (message.includes("Could not resolve host") || message.includes("Connection refused")) {
      console.error("Error: Failed to connect to remote");
    } else {
      console.error(`Error: ${message || "Push failed"}`);
    }
    process.exit(1);
  }
}
