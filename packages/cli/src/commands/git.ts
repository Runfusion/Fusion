import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

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
 * Check if the current directory is a git repository.
 */
export function isGitRepo(): boolean {
  try {
    execSync("git rev-parse --git-dir", { encoding: "utf-8", timeout: 5000 });
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
export function getGitStatus(): GitStatus | null {
  try {
    // Get current branch (empty string means detached HEAD)
    const branchOutput = execSync("git branch --show-current", { encoding: "utf-8", timeout: 5000 }).trim();
    const branch = branchOutput || "HEAD detached";

    // Get current commit hash (short)
    const commit = execSync("git rev-parse --short HEAD", { encoding: "utf-8", timeout: 5000 }).trim();

    // Check if working directory is dirty
    const statusOutput = execSync("git status --porcelain", { encoding: "utf-8", timeout: 5000 }).trim();
    const isDirty = statusOutput.length > 0;

    // Get ahead/behind counts from upstream
    let ahead = 0;
    let behind = 0;
    try {
      const revListOutput = execSync("git rev-list --left-right --count HEAD...@{u}", { encoding: "utf-8", timeout: 5000 }).trim();
      const match = revListOutput.match(/(\d+)\s+(\d+)/);
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
export function getDirtyFileCount(): { added: number; modified: number; deleted: number } {
  try {
    const output = execSync("git status --porcelain", { encoding: "utf-8", timeout: 5000 }).trim();
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
export function fetchGitRemote(remote: string = "origin"): GitFetchResult {
  if (!isValidBranchName(remote)) {
    throw new Error("Invalid remote name");
  }
  try {
    const output = execSync(`git fetch ${remote}`, { encoding: "utf-8", timeout: 30000 });
    return { fetched: true, message: output.trim() || "Fetch completed" };
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
export function pullGitBranch(): GitPullResult {
  try {
    const output = execSync("git pull", { encoding: "utf-8", timeout: 30000 });
    return { success: true, message: output.trim() };
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
export function pushGitBranch(): GitPushResult {
  try {
    const output = execSync("git push", { encoding: "utf-8", timeout: 30000 });
    return { success: true, message: output.trim() || "Push completed" };
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
export async function runGitStatus(): Promise<void> {
  // Validate current directory is a git repo
  if (!isGitRepo()) {
    console.error("Error: Not a git repository");
    process.exit(1);
  }

  const status = getGitStatus();
  if (!status) {
    console.error("Error: Failed to get git status");
    process.exit(1);
  }

  console.log();
  console.log(`  Branch: ${status.branch}`);
  console.log(`  Commit: ${status.commit}`);

  // Status line
  if (status.isDirty) {
    const counts = getDirtyFileCount();
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
 */
export async function runGitFetch(remote?: string): Promise<void> {
  const targetRemote = remote || "origin";

  // Validate current directory is a git repo
  if (!isGitRepo()) {
    console.error("Error: Not a git repository");
    process.exit(1);
  }

  // Validate remote name
  if (!isValidBranchName(targetRemote)) {
    console.error(`Error: Invalid remote name: ${targetRemote}`);
    process.exit(1);
  }

  try {
    const result = fetchGitRemote(targetRemote);
    console.log();
    if (result.fetched && result.message && result.message !== "Fetch completed") {
      console.log(`  ✓ Fetched from ${targetRemote}`);
      if (result.message) {
        console.log(`    ${result.message}`);
      }
    } else {
      console.log(`  ✓ Fetched from ${targetRemote} (no new changes)`);
    }
    console.log();
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Run the git pull command.
 * @param options.skipConfirm - Skip confirmation when there are uncommitted changes
 */
export async function runGitPull(options: { skipConfirm?: boolean } = {}): Promise<void> {
  // Validate current directory is a git repo
  if (!isGitRepo()) {
    console.error("Error: Not a git repository");
    process.exit(1);
  }

  // Check for dirty state
  const status = getGitStatus();
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
    const result = pullGitBranch();
    console.log();
    
    if (result.conflict) {
      console.error("  ✗ Merge conflict detected. Resolve manually.");
      process.exit(1);
    }
    
    console.log(`  ✓ Pulled latest changes for ${status.branch}`);
    if (result.message && result.message !== "Already up to date.") {
      console.log(`    ${result.message}`);
    }
    console.log();
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Run the git push command.
 * @param options.skipConfirm - Skip confirmation prompt
 */
export async function runGitPush(options: { skipConfirm?: boolean } = {}): Promise<void> {
  // Validate current directory is a git repo
  if (!isGitRepo()) {
    console.error("Error: Not a git repository");
    process.exit(1);
  }

  // Get current branch
  const status = getGitStatus();
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
    execSync("git rev-parse --abbrev-ref --symbolic-full-name @{u}", { encoding: "utf-8", timeout: 5000 });
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
    const result = pushGitBranch();
    console.log();
    console.log(`  ✓ Pushed ${status.branch} to origin`);
    if (result.message && result.message !== "Push completed") {
      console.log(`    ${result.message}`);
    }
    console.log();
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
