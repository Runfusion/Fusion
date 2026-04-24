import { TaskStore, COLUMNS, COLUMN_LABELS, type Column, type StepStatus, type AgentLogType, type AgentLogEntry } from "@fusion/core";
import { aiMergeTask } from "@fusion/engine";
import { createInterface } from "node:readline/promises";
import type { PlanningQuestion, PlanningSummary } from "@fusion/core";
import { createSession, submitResponse, RateLimitError, SessionNotFoundError, InvalidSessionStateError } from "@fusion/dashboard/planning";
import { watchFile, unwatchFile, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GitHubClient } from "@fusion/dashboard";
import {
  getGhErrorMessage,
  getCurrentRepo,
  isGhAuthenticated,
  isGhAvailable,
  runGhJsonAsync,
} from "@fusion/core/gh-cli";
import { resolveProject, type ProjectContext } from "../project-context.js";

const STEP_STATUSES: StepStatus[] = ["pending", "in-progress", "done", "skipped"];

interface CommandContext {
  store: TaskStore;
  projectPath: string;
  projectName?: string;
  explicit: boolean;
}

function asLocalProjectContext(store: TaskStore): ProjectContext {
  const cwd = process.cwd();
  return {
    projectId: cwd,
    projectPath: cwd,
    projectName: cwd.split("/").filter(Boolean).at(-1) ?? "current-project",
    isRegistered: false,
    store,
  };
}

async function getCommandContext(projectName?: string): Promise<CommandContext> {
  if (projectName) {
    const context = await resolveProject(projectName);
    if (!context) {
      throw new Error(`Project ${projectName} not found`);
    }
    return {
      store: context.store,
      projectPath: context.projectPath,
      projectName: context.projectName,
      explicit: true,
    };
  }

  try {
    const context = await resolveProject(undefined);
    if (!context) {
      throw new Error("No project context");
    }
    return {
      store: context.store,
      projectPath: context.projectPath,
      projectName: context.projectName,
      explicit: false,
    };
  } catch {
    const store = new TaskStore(process.cwd());
    await store.init();
    return {
      store,
      projectPath: process.cwd(),
      projectName: undefined,
      explicit: false,
    };
  }
}

async function getStore(projectName?: string): Promise<TaskStore> {
  return (await getCommandContext(projectName)).store;
}

async function getProjectContext(projectName?: string): Promise<ProjectContext | undefined> {
  if (projectName) {
    return resolveProject(projectName);
  }

  try {
    return await resolveProject(undefined);
  } catch {
    const store = await getStore();
    return asLocalProjectContext(store);
  }
}

async function getProjectPath(projectName?: string): Promise<string> {
  return (await getCommandContext(projectName)).projectPath;
}

export async function runTaskCreate(descriptionArg?: string, attachFiles?: string[], depends?: string[], projectName?: string) {
  let description = descriptionArg;
  const projectContext = await getProjectContext(projectName);

  if (!description) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    description = await rl.question("Task description: ");
    rl.close();
  }

  if (!description?.trim()) {
    console.error("Description is required");
    process.exit(1);
  }

  const store = projectContext?.store ?? await getStore(projectName);
  const task = await store.createTask({ description: description.trim(), dependencies: depends });

  const label = task.description.length > 60
    ? task.description.slice(0, 60) + "…"
    : task.description;

  console.log();
  if (projectContext) {
    console.log(`  Project: ${projectContext.projectName}`);
  }
  console.log(`  ✓ Created ${task.id}: ${label}`);
  console.log(`    Column: triage`);
  if (task.dependencies.length > 0) {
    console.log(`    Dependencies: ${task.dependencies.join(", ")}`);
  }
  console.log(`    Path:   .fusion/tasks/${task.id}/`);

  if (attachFiles && attachFiles.length > 0) {
    const { readFile } = await import("node:fs/promises");
    const { basename, extname, resolve } = await import("node:path");

    for (const filePath of attachFiles) {
      const resolvedPath = resolve(filePath);
      const filename = basename(resolvedPath);
      const ext = extname(filename).toLowerCase();
      const mimeType = MIME_TYPES[ext];

      if (!mimeType) {
        console.error(`    ✗ Unsupported file type: ${ext} (${filename})`);
        continue;
      }

      let content: Buffer;
      try {
        content = await readFile(resolvedPath);
      } catch {
        console.error(`    ✗ Cannot read file: ${filePath}`);
        continue;
      }

      const attachment = await store.addAttachment(task.id, filename, content, mimeType);
      const sizeKB = (attachment.size / 1024).toFixed(1);
      console.log(`    📎 Attached: ${attachment.originalName} (${sizeKB} KB)`);
    }
  }

  console.log();
}

export async function runTaskList(projectName?: string) {
  const projectContext = await getProjectContext(projectName);
  const store = projectContext?.store ?? await getStore(projectName);
  const tasks = await store.listTasks({ slim: true });

  if (tasks.length === 0) {
    console.log("\n  No tasks yet. Create one with: fn task create\n");
    process.exit(0);
  }

  console.log();
  if (projectContext && projectName) {
    console.log(`  Tasks for project '${projectContext.projectName}':`);
    console.log();
  }

  for (const col of COLUMNS) {
    const colTasks = tasks.filter((t) => t.column === col);
    if (colTasks.length === 0) continue;

    const label = COLUMN_LABELS[col];
    const dot =
      col === "triage" ? "●" :
      col === "todo" ? "●" :
      col === "in-progress" ? "●" :
      col === "in-review" ? "●" : "○";

    console.log(`  ${dot} ${label} (${colTasks.length})`);
    for (const t of colTasks) {
      const deps = t.dependencies.length ? ` [deps: ${t.dependencies.join(", ")}]` : "";
      const label = t.title || t.description.slice(0, 60) + (t.description.length > 60 ? "…" : "");
      console.log(`    ${t.id}  ${label}${deps}`);
    }
    console.log();
  }

  process.exit(0);
}

export async function runTaskUpdate(id: string, stepStr: string, status: string, projectName?: string) {
  const stepIndex = parseInt(stepStr, 10);
  if (isNaN(stepIndex)) {
    console.error(`Invalid step number: ${stepStr}`);
    process.exit(1);
  }
  if (!STEP_STATUSES.includes(status as StepStatus)) {
    console.error(`Invalid status: ${status}`);
    console.error(`Valid statuses: ${STEP_STATUSES.join(", ")}`);
    process.exit(1);
  }

  const store = await getStore(projectName);
  const task = await store.updateStep(id, stepIndex, status as StepStatus);

  const step = task.steps[stepIndex];
  console.log();
  console.log(`  ✓ ${task.id} Step ${stepIndex} (${step.name}) → ${status}`);
  console.log(`    Progress: ${task.steps.filter((s) => s.status === "done").length}/${task.steps.length} steps done`);
  console.log();
}

export async function runTaskLog(id: string, message: string, outcome?: string, projectName?: string) {
  const store = await getStore(projectName);
  await store.logEntry(id, message, outcome);

  console.log();
  console.log(`  ✓ ${id}: logged "${message}"`);
  console.log();
}

export interface LogsOptions {
  follow?: boolean;
  limit?: number;
  type?: AgentLogType;
}

// ANSI color codes for terminal output
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

/**
 * Format a timestamp for display (locale time string)
 */
function formatTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString();
}

/**
 * Format a single agent log entry for display
 */
function formatLogEntry(entry: AgentLogEntry): string {
  const ts = formatTimestamp(entry.timestamp);
  const agent = entry.agent ? `[${entry.agent.toUpperCase()}] ` : "";

  switch (entry.type) {
    case "text":
      return `  ${ts} ${agent}${entry.text}`;
    case "thinking":
      return `${ANSI.dim}${ANSI.gray}  ${ts} ${agent}[THINK] ${entry.text}${ANSI.reset}`;
    case "tool":
      return `  ${ts} ${agent}[TOOL] ${entry.text}${entry.detail ? ` (${entry.detail})` : ""}`;
    case "tool_result":
      return `  ${ts} ${agent}[RESULT] ${entry.text}${entry.detail ? ` (${entry.detail})` : ""}`;
    case "tool_error":
      return `${ANSI.red}  ${ts} ${agent}[ERROR] ${entry.text}${entry.detail ? ` (${entry.detail})` : ""}${ANSI.reset}`;
    default:
      return `  ${ts} ${agent}${entry.text}`;
  }
}

/**
 * Print log entries to console
 */
function printEntries(entries: AgentLogEntry[]): void {
  for (const entry of entries) {
    console.log(formatLogEntry(entry));
  }
}

/**
 * Filter and limit entries based on options
 */
function filterEntries(entries: AgentLogEntry[], options: LogsOptions): AgentLogEntry[] {
  let result = entries;

  // Filter by type if specified
  if (options.type) {
    result = result.filter((e) => e.type === options.type);
  }

  // Apply limit (default 100, max 1000)
  const limit = Math.min(options.limit ?? 100, 1000);
  if (result.length > limit) {
    result = result.slice(-limit);
  }

  return result;
}

export async function runTaskLogs(id: string, options: LogsOptions = {}, projectName?: string) {
  const projectContext = await getProjectContext(projectName);
  const store = projectContext?.store ?? await getStore(projectName);

  // Verify task exists
  try {
    await store.getTask(id);
  } catch {
    console.error(`Task ${id} not found`);
    process.exit(1);
  }

  // Get agent logs
  const entries = await store.getAgentLogs(id);

  if (entries.length === 0 && !options.follow) {
    console.log(`No agent logs found for ${id}`);
    return;
  }

  if (projectContext && projectName) {
    console.log(`  Logs for project '${projectContext.projectName}':`);
  }

  // Print existing entries (filtered)
  const filteredEntries = filterEntries(entries, options);
  printEntries(filteredEntries);

  // Follow mode: watch for new entries
  if (options.follow) {
    const projectPath = projectContext?.projectPath ?? process.cwd();
    const logPath = join(projectPath, ".fusion", "tasks", id, "agent.log");

    if (!existsSync(logPath)) {
      console.log(`\n  Waiting for log file to be created...`);
    }

    let lastPosition = 0;
    let lastSize = 0;

    // Try to get initial file size
    try {
      const stats = statSync(logPath);
      lastSize = stats.size;
      lastPosition = lastSize;
    } catch {
      // File doesn't exist yet, will watch for creation
    }

    // Track if we're shutting down
    let isShuttingDown = false;

    // Set up SIGINT handler for clean exit
    const sigintHandler = () => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      unwatchFile(logPath);
      console.log("\n  (stopped following logs)");
      process.exit(0);
    };

    process.on("SIGINT", sigintHandler);

    // Start watching the file
    watchFile(logPath, { interval: 1000 }, () => {
      if (isShuttingDown) return;

      try {
        const stats = statSync(logPath);

        // File was truncated or recreated
        if (stats.size < lastPosition) {
          lastPosition = 0;
        }

        // New content available
        if (stats.size > lastPosition) {
          const content = readFileSync(logPath, "utf-8");
          const lines = content.slice(lastPosition).split("\n");

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line) as AgentLogEntry;
              // Apply type filter if specified
              if (!options.type || entry.type === options.type) {
                console.log(formatLogEntry(entry));
              }
            } catch {
              // Skip malformed lines
            }
          }

          lastPosition = stats.size;
        }

        lastSize = stats.size;
      } catch {
        // File may have been deleted, ignore
      }
    });

    // Keep process alive
    await new Promise(() => {
      // Infinite wait - SIGINT handler will exit
    });
  }
}

export async function runTaskShow(id: string, projectName?: string) {
  const store = await getStore(projectName);
  const task = await store.getTask(id);

  console.log();
  console.log(`  ${task.id}: ${task.title || task.description}`);
  console.log(`  Column: ${COLUMN_LABELS[task.column]}${task.size ? ` · Size: ${task.size}` : ""}${task.reviewLevel !== undefined ? ` · Review: ${task.reviewLevel}` : ""}`);
  if (task.dependencies.length) {
    console.log(`  Dependencies: ${task.dependencies.join(", ")}`);
  }
  console.log();

  // Steps
  if (task.steps.length > 0) {
    console.log(`  Steps (${task.steps.filter((s) => s.status === "done").length}/${task.steps.length}):`);
    for (let i = 0; i < task.steps.length; i++) {
      const s = task.steps[i];
      const icon = s.status === "done" ? "✓"
        : s.status === "in-progress" ? "▸"
        : s.status === "skipped" ? "–"
        : " ";
      const marker = i === task.currentStep && s.status !== "done" ? " ◀" : "";
      console.log(`    [${icon}] ${i}: ${s.name}${marker}`);
    }
    console.log();
  }

  // Recent log
  if (task.log.length > 0) {
    const recent = task.log.slice(-5);
    console.log(`  Log (last ${recent.length}):`);
    for (const l of recent) {
      const ts = new Date(l.timestamp).toLocaleTimeString();
      console.log(`    ${ts}  ${l.action}${l.outcome ? ` → ${l.outcome}` : ""}`);
    }
    console.log();
  }
}

export async function runTaskMerge(id: string, projectName?: string) {
  const store = await getStore(projectName);
  const projectPath = await getProjectPath(projectName);

  console.log(`\n  Merging ${id} with AI...\n`);

  try {
    const result = await aiMergeTask(store, projectPath, id, {
      onAgentText: (delta) => process.stdout.write(delta),
    });

    console.log();
    if (result.merged) {
      console.log(`  ✓ Merged ${result.task.id}`);
      console.log(`    Branch:   ${result.branch}`);
      console.log(`    Worktree: ${result.worktreeRemoved ? "removed" : "not found"}`);
      console.log(`    Branch:   ${result.branchDeleted ? "deleted" : "kept"}`);
    } else {
      console.log(`  ✓ Closed ${result.task.id} (${result.error})`);
    }
    console.log(`    Status:   done`);
    console.log();
  } catch (err: any) {
    console.error(`\n  ✗ ${err.message}\n`);
    process.exit(1);
  }
}

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/x-toml",
  ".csv": "text/csv",
  ".xml": "application/xml",
};

export async function runTaskAttach(id: string, filePath: string, projectName?: string) {
  const { readFile } = await import("node:fs/promises");
  const { basename, extname } = await import("node:path");
  const { resolve } = await import("node:path");

  const resolvedPath = resolve(filePath);
  const filename = basename(resolvedPath);
  const ext = extname(filename).toLowerCase();
  const mimeType = MIME_TYPES[ext];

  if (!mimeType) {
    console.error(`Unsupported file type: ${ext}`);
    console.error(`Supported: ${Object.keys(MIME_TYPES).join(", ")}`);
    process.exit(1);
  }

  let content: Buffer;
  try {
    content = await readFile(resolvedPath);
  } catch {
    console.error(`Cannot read file: ${filePath}`);
    process.exit(1);
  }

  const store = await getStore(projectName);
  const attachment = await store.addAttachment(id, filename, content, mimeType);

  const sizeKB = (attachment.size / 1024).toFixed(1);
  console.log();
  console.log(`  ✓ Attached to ${id}: ${attachment.originalName}`);
  console.log(`    File: ${attachment.filename} (${sizeKB} KB)`);
  console.log(`    Path: .fusion/tasks/${id}/attachments/${attachment.filename}`);
  console.log();
}

export async function runTaskPause(id: string, projectName?: string) {
  const store = await getStore(projectName);
  const task = await store.pauseTask(id, true);

  console.log();
  console.log(`  ✓ Paused ${task.id}`);
  console.log();
}

export async function runTaskUnpause(id: string, projectName?: string) {
  const store = await getStore(projectName);
  const task = await store.pauseTask(id, false);

  console.log();
  console.log(`  ✓ Unpaused ${task.id}`);
  console.log();
}

export async function runTaskMove(id: string, column: string, projectName?: string) {
  if (!COLUMNS.includes(column as Column)) {
    console.error(`Invalid column: ${column}`);
    console.error(`Valid columns: ${COLUMNS.join(", ")}`);
    process.exit(1);
  }

  const store = await getStore(projectName);
  const task = await store.moveTask(id, column as Column);

  console.log();
  console.log(`  ✓ Moved ${task.id} → ${COLUMN_LABELS[task.column as Column]}`);
  console.log();
}

export async function runTaskDuplicate(id: string, projectName?: string) {
  const store = await getStore(projectName);
  const newTask = await store.duplicateTask(id);

  console.log();
  console.log(`  ✓ Duplicated ${id} → ${newTask.id}`);
  console.log(`    Path: .fusion/tasks/${newTask.id}/`);
  console.log();
}

export async function runTaskRefine(id: string, feedbackArg?: string, projectName?: string) {
  const store = await getStore(projectName);
  
  // Get feedback interactively only if not provided (undefined)
  let feedback = feedbackArg;
  if (feedback === undefined) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    feedback = await rl.question("What needs to be refined? ");
    rl.close();
  }

  if (!feedback?.trim()) {
    console.error("Feedback is required");
    process.exit(1);
  }

  // Validate length (matches API validation)
  if (feedback.length > 2000) {
    console.error("Feedback must be 2000 characters or less");
    process.exit(1);
  }

  const newTask = await store.refineTask(id, feedback.trim());

  console.log();
  console.log(`  ✓ Created refinement ${newTask.id} for ${id}`);
  console.log(`    Column: triage`);
  console.log(`    Dependency: ${id}`);
  console.log(`    Path: .fusion/tasks/${newTask.id}/`);
  console.log();
}

export async function runTaskArchive(id: string, projectName?: string) {
  const store = await getStore(projectName);
  const task = await store.archiveTask(id);

  console.log();
  console.log(`  ✓ Archived ${task.id} → ${COLUMN_LABELS[task.column]}`);
  console.log();
}

export async function runTaskUnarchive(id: string, projectName?: string) {
  const store = await getStore(projectName);
  const task = await store.unarchiveTask(id);

  console.log();
  console.log(`  ✓ Unarchived ${task.id} → ${COLUMN_LABELS[task.column]}`);
  console.log();
}

export async function runTaskRetry(id: string, projectName?: string) {
  const store = await getStore(projectName);
  
  // Fetch task and validate it exists
  let task;
  try {
    task = await store.getTask(id);
  } catch {
    throw new Error(`Task ${id} not found`);
  }
  
  // Validate task is in a retryable state
  if (task.status !== 'failed' && task.status !== 'stuck-killed') {
    throw new Error(`Task ${id} is not in a retryable state (status: ${task.status || 'none'})`);
  }
  
  // Clear failure state and stale branch refs so retry can choose a fresh base.
  await store.updateTask(id, {
    status: null,
    error: null,
    worktree: null,
    branch: null,
    baseBranch: null,
    baseCommitSha: null,
    recoveryRetryCount: null,
    nextRecoveryAt: null,
  });
  
  // Move to todo column
  await store.moveTask(id, 'todo');
  
  // Log the retry action
  await store.logEntry(id, "Retry requested from CLI", "Task reset to todo for retry");
  
  console.log();
  console.log(`  ✓ Retried ${id} → todo (failure state cleared)`);
  console.log();
}

export async function runTaskDelete(id: string, force?: boolean, projectName?: string) {
  const store = await getStore(projectName);

  // Check if task exists first
  try {
    await store.getTask(id);
  } catch {
    console.error(`✗ Task ${id} not found`);
    process.exit(1);
    return;
  }

  // Prompt for confirmation unless force is used
  if (!force) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Are you sure you want to delete ${id}? [y/N] `);
    rl.close();

    const trimmed = answer.trim().toLowerCase();
    if (trimmed !== "y" && trimmed !== "yes") {
      console.log("Cancelled.");
      process.exit(0);
      return;
    }
  }

  try {
    await store.deleteTask(id);
    console.log();
    console.log(`  ✓ Deleted ${id}`);
    console.log();
  } catch (err: any) {
    console.error(`✗ Failed to delete ${id}: ${err.message}`);
    process.exit(1);
    return;
  }
}

export async function runTaskImportGitHubInteractive(
  ownerRepo: string,
  options: TaskImportOptions = {},
  projectName?: string
): Promise<void> {
  // Parse owner/repo
  const match = ownerRepo.match(/^([^/]+)\/([^/]+)$/);
  if (!match) {
    console.error(`Invalid owner/repo format: ${ownerRepo}`);
    console.error(`Expected format: owner/repo (e.g., dustinbyrne/fusion)`);
    process.exit(1);
  }

  const [, owner, repo] = match;
  const { limit = 30, labels } = options;

  console.log(`\n  Fetching issues from ${owner}/${repo}...\n`);

  const store = await getStore(projectName);
  const existingTasks = await store.listTasks({ slim: true });

  // Build a set of already-imported issue URLs
  const importedUrls = new Map<string, string>();
  for (const task of existingTasks) {
    // Match Source URL anywhere in description (more robust than end-of-string anchor)
    const sourceMatch = task.description.match(/Source: (https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+)/);
    if (sourceMatch) {
      importedUrls.set(sourceMatch[1], task.id);
    }
  }

  let issues: GitHubIssue[];
  try {
    issues = await fetchGitHubIssues(owner, repo, { limit, labels });
  } catch (err: any) {
    console.error(`  ✗ ${err.message}\n`);
    process.exit(1);
  }

  if (issues.length === 0) {
    console.log(`  No open issues found in ${owner}/${repo}.\n`);
    return;
  }

  // Display issues with numbers
  console.log(`  Found ${issues.length} issues:\n`);
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    const alreadyImported = importedUrls.has(issue.html_url);
    const status = alreadyImported ? ` [Imported as ${importedUrls.get(issue.html_url)}]` : "";
    console.log(`  ${i + 1}. #${issue.number} ${issue.title.slice(0, 80)}${issue.title.length > 80 ? "…" : ""}${status}`);
  }

  console.log();

  // Create readline interface for interactive selection
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let selectedIndices: number[] = [];
  let validInput = false;

  while (!validInput) {
    const answer = await rl.question('  Enter numbers to import (comma-separated) or "all": ');
    const trimmed = answer.trim().toLowerCase();

    if (trimmed === "all") {
      selectedIndices = issues.map((_, i) => i);
      validInput = true;
    } else {
      const nums = trimmed
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));

      if (nums.length === 0) {
        console.log("  Please enter at least one number or 'all'");
        continue;
      }

      const outOfRange = nums.filter((n) => n < 1 || n > issues.length);
      if (outOfRange.length > 0) {
        console.log(`  Invalid selection: ${outOfRange.join(", ")} (range: 1-${issues.length})`);
        continue;
      }

      selectedIndices = nums.map((n) => n - 1); // Convert to 0-based
      validInput = true;
    }
  }

  rl.close();

  console.log();

  let created = 0;
  let skipped = 0;

  for (const idx of selectedIndices) {
    const issue = issues[idx];

    // Check if already imported
    if (importedUrls.has(issue.html_url)) {
      const existingId = importedUrls.get(issue.html_url)!;
      console.log(`  → Skipping #${issue.number}: already imported as ${existingId}`);
      skipped++;
      continue;
    }

    // Prepare title (truncate to 200 chars)
    const title = issue.title.slice(0, 200);

    // Prepare description
    const body = issue.body?.trim() || "(no description)";
    const description = `${body}\n\nSource: ${issue.html_url}`;

    // Create the task
    const task = await store.createTask({
      title: title || undefined,
      description,
      column: "triage",
      dependencies: [],
    });

    const label = task.title || task.description.slice(0, 60) + (task.description.length > 60 ? "…" : "");
    console.log(`  ✓ Created ${task.id}: ${label}`);
    created++;
  }

  console.log();
  console.log(`  ✓ Imported ${created} tasks from ${owner}/${repo}${skipped > 0 ? ` (${skipped} skipped)` : ""}`);
  console.log();
}

// ── GitHub Issue Import ───────────────────────────────────────────

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
}

export interface FetchGitHubIssuesOptions {
  limit?: number;
  labels?: string[];
  since?: string;
}

export async function fetchGitHubIssues(
  owner: string,
  repo: string,
  options: FetchGitHubIssuesOptions = {}
): Promise<GitHubIssue[]> {
  const { limit = 30, labels, since } = options;

  if (!isGhAvailable() || !isGhAuthenticated()) {
    throw new Error("GitHub CLI (gh) is not available or not authenticated. Run 'gh auth login'.");
  }

  // Build query parameters - only open issues, no PRs
  const params = new URLSearchParams();
  params.append("state", "open");
  params.append("per_page", String(Math.min(limit, 100)));
  if (labels && labels.length > 0) {
    params.append("labels", labels.join(","));
  }
  if (since) {
    params.append("since", since);
  }

  const path = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${params.toString()}`;

  try {
    const issues = await runGhJsonAsync<Array<GitHubIssue & { pull_request?: unknown }>>(["api", path]);
    return issues.filter((issue) => !issue.pull_request).slice(0, limit);
  } catch (error) {
    throw new Error(getGhErrorMessage(error));
  }
}

export interface TaskImportOptions {
  limit?: number;
  labels?: string[];
}

export async function runTaskImportFromGitHub(
  ownerRepo: string,
  options: TaskImportOptions = {},
  projectName?: string
): Promise<void> {
  // Parse owner/repo
  const match = ownerRepo.match(/^([^/]+)\/([^/]+)$/);
  if (!match) {
    console.error(`Invalid owner/repo format: ${ownerRepo}`);
    console.error(`Expected format: owner/repo (e.g., dustinbyrne/fusion)`);
    process.exit(1);
  }

  const [, owner, repo] = match;
  const { limit = 30, labels } = options;

  console.log(`\n  Importing issues from ${owner}/${repo}...\n`);

  const store = await getStore(projectName);
  const existingTasks = await store.listTasks({ slim: true });

  // Build a set of already-imported issue URLs
  const importedUrls = new Map<string, string>();
  for (const task of existingTasks) {
    // Match Source URL anywhere in description (more robust than end-of-string anchor)
    const sourceMatch = task.description.match(/Source: (https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+)/);
    if (sourceMatch) {
      importedUrls.set(sourceMatch[1], task.id);
    }
  }

  let issues: GitHubIssue[];
  try {
    issues = await fetchGitHubIssues(owner, repo, { limit, labels });
  } catch (err: any) {
    console.error(`  ✗ ${err.message}\n`);
    process.exit(1);
  }

  if (issues.length === 0) {
    console.log(`  No open issues found in ${owner}/${repo}.\n`);
    return;
  }

  let created = 0;
  let skipped = 0;

  for (const issue of issues) {
    // Check if already imported
    if (importedUrls.has(issue.html_url)) {
      const existingId = importedUrls.get(issue.html_url)!;
      console.log(`  → Skipping #${issue.number}: already imported as ${existingId}`);
      skipped++;
      continue;
    }

    // Prepare title (truncate to 200 chars)
    const title = issue.title.slice(0, 200);

    // Prepare description
    const body = issue.body?.trim() || "(no description)";
    const description = `${body}\n\nSource: ${issue.html_url}`;

    // Create the task
    const task = await store.createTask({
      title: title || undefined,
      description,
      column: "triage",
      dependencies: [],
    });

    const label = task.title || task.description.slice(0, 60) + (task.description.length > 60 ? "…" : "");
    console.log(`  ✓ Created ${task.id}: ${label}`);
    created++;
  }

  console.log();
  console.log(`  ✓ Imported ${created} tasks from ${owner}/${repo}${skipped > 0 ? ` (${skipped} skipped)` : ""}`);
  console.log();
}

export async function runTaskComment(id: string, message?: string, author = "user", projectName?: string) {
  const store = await getStore(projectName);

  let text = message;
  if (text === undefined) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    text = await rl.question("Comment: ");
    rl.close();
  }

  if (!text || text.trim().length === 0) {
    console.error("Error: Comment is required");
    process.exit(1);
  }

  const trimmed = text.trim();
  if (trimmed.length > 2000) {
    console.error("Error: Comment must be between 1 and 2000 characters");
    process.exit(1);
  }

  const task = await store.addTaskComment(id, trimmed, author || "user");
  const latestComment = task.comments?.[task.comments.length - 1];

  console.log();
  console.log(`  ✓ Comment added to ${task.id}`);
  if (latestComment) {
    console.log(`    ID: ${latestComment.id}`);
  }
  console.log();
}

export async function runTaskComments(id: string, projectName?: string) {
  const store = await getStore(projectName);
  const task = await store.getTask(id);
  const comments = task.comments || [];

  console.log();
  if (comments.length === 0) {
    console.log(`  No comments on ${id}`);
    console.log();
    return;
  }

  console.log(`  Comments for ${id}:`);
  for (const comment of comments) {
    console.log(`    ${comment.id} · ${comment.author} · ${new Date(comment.updatedAt || comment.createdAt).toLocaleString()}`);
    console.log(`    ${comment.text}`);
  }
  console.log();
}

export async function runTaskSteer(id: string, message?: string, projectName?: string) {
  const store = await getStore(projectName);

  // Get message interactively if not provided as argument
  let text = message;
  if (text === undefined) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    text = await rl.question("Message: ");
    rl.close();
  }

  // Validate message
  if (!text || text.trim().length === 0) {
    console.error("Error: Message is required");
    process.exit(1);
  }

  const trimmed = text.trim();
  if (trimmed.length > 2000) {
    console.error("Error: Message must be between 1 and 2000 characters");
    process.exit(1);
  }

  // Add steering comment
  let task;
  try {
    task = await store.addSteeringComment(id, trimmed, "user");
  } catch (err: any) {
    if (err.code === "ENOENT") {
      console.error(`Error: Task not found: ${id}`);
      process.exit(1);
    }
    throw err;
  }

  // Show success with preview
  const preview = trimmed.length > 60 ? trimmed.slice(0, 60) + "…" : trimmed;
  console.log();
  console.log(`  ✓ Steering comment added to ${task.id}`);
  console.log(`    "${preview}"`);
  console.log();
}

// ── PR Creation ─────────────────────────────────────────────────────────────

export interface PrCreateOptions {
  title?: string;
  base?: string;
  body?: string;
}

export async function runTaskPrCreate(id: string, options: PrCreateOptions = {}, projectName?: string) {
  const store = await getStore(projectName);

  // Fetch task and validate it exists
  let task;
  try {
    task = await store.getTask(id);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      console.error(`Error: Task ${id} not found`);
      process.exit(1);
    }
    throw err;
  }

  // Validate task is in 'in-review' column
  if (task.column !== "in-review") {
    console.error(`Error: Task must be in 'in-review' column to create a PR (current: ${task.column})`);
    process.exit(1);
  }

  // Check if task already has PR info
  if (task.prInfo) {
    console.error(`Error: Task already has PR #${task.prInfo.number}: ${task.prInfo.url}`);
    process.exit(1);
  }

  // Determine owner/repo from GITHUB_REPOSITORY env or git remote
  let owner: string;
  let repo: string;

  const envRepo = process.env.GITHUB_REPOSITORY;
  if (envRepo) {
    const [o, r] = envRepo.split("/");
    if (!o || !r) {
      console.error("Error: GITHUB_REPOSITORY format is invalid (expected: owner/repo)");
      process.exit(1);
    }
    owner = o;
    repo = r;
  } else {
    const projectPath = await getProjectPath(projectName);
    const gitRepo = getCurrentRepo(projectPath);
    if (!gitRepo) {
      console.error("Error: Could not determine GitHub repository. Set GITHUB_REPOSITORY env var or configure git remote.");
      process.exit(1);
    }
    owner = gitRepo.owner;
    repo = gitRepo.repo;
  }

  // Validate GitHub auth
  if (!isGhAvailable() || !isGhAuthenticated()) {
    console.error("Error: GitHub CLI (gh) is not available or not authenticated. Run 'gh auth login'.");
    process.exit(1);
  }

  // Build branch name using the established project convention
  const branchName = `fusion/${id.toLowerCase()}`;

  // Build PR title
  let title: string;
  if (options.title) {
    title = options.title;
  } else if (task.title) {
    title = task.title;
  } else {
    // Generate from description (first 50 chars, sentence case)
    const desc = task.description.trim();
    title = desc.charAt(0).toUpperCase() + desc.slice(1, 50);
    if (desc.length > 50) {
      title += "…";
    }
  }

  // Create PR via GitHubClient
  const client = new GitHubClient();

  try {
    const prInfo = await client.createPr({
      owner,
      repo,
      title,
      body: options.body,
      head: branchName,
      base: options.base,
    });

    // Store PR info
    await store.updatePrInfo(task.id, prInfo);
    await store.logEntry(task.id, "Created PR", `PR #${prInfo.number}: ${prInfo.url}`);

    console.log();
    console.log(`  ✓ Created PR for ${task.id}`);
    console.log(`    PR #${prInfo.number}: ${prInfo.url}`);
    console.log(`    Branch: ${branchName} → ${prInfo.baseBranch}`);
    console.log();
  } catch (err: any) {
    // Handle specific error cases
    if (err.message?.includes("already exists")) {
      console.error(`Error: A pull request already exists for ${owner}/${repo}:${branchName}`);
      process.exit(1);
    } else if (err.message?.includes("No commits between")) {
      console.error(`Error: No commits between ${options.base || "default base"} and ${branchName}. Push changes before creating PR.`);
      process.exit(1);
    } else {
      console.error(`Error: ${err.message || "Failed to create PR"}`);
      process.exit(1);
    }
  }
}

// ── Planning Mode ───────────────────────────────────────────────────────────

/** Helper to display thinking indicator */
function showThinking(): void {
  process.stdout.write("  AI is thinking...");
}

/** Helper to clear thinking indicator */
function clearThinking(): void {
  process.stdout.write("\r" + " ".repeat(20) + "\r");
}

/** Prompt for text (multi-line) question */
async function promptText(question: PlanningQuestion): Promise<string> {
  console.log(`\n  ${question.question}`);
  if (question.description) {
    console.log(`  ${question.description}`);
  }
  console.log("  (Enter your response. Type DONE on its own line when finished):\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines: string[] = [];

  return new Promise((resolve) => {
    const askLine = () => {
      rl.question("  ").then((line) => {
        if (line.trim() === "DONE") {
          rl.close();
          resolve(lines.join("\n"));
        } else {
          lines.push(line);
          askLine();
        }
      });
    };
    askLine();
  });
}

/** Prompt for single_select question */
async function promptSingleSelect(question: PlanningQuestion): Promise<string> {
  console.log(`\n  ${question.question}`);
  if (question.description) {
    console.log(`  ${question.description}`);
  }
  console.log();

  if (!question.options || question.options.length === 0) {
    throw new Error("Single select question has no options");
  }

  for (let i = 0; i < question.options.length; i++) {
    const opt = question.options[i];
    console.log(`  ${i + 1}. ${opt.label}`);
    if (opt.description) {
      console.log(`     ${opt.description}`);
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    const answer = await rl.question("\n  Select (1-" + question.options.length + "): ");
    const num = parseInt(answer.trim(), 10);

    if (!isNaN(num) && num >= 1 && num <= question.options.length) {
      rl.close();
      return question.options[num - 1].id;
    }

    console.log(`  Invalid selection. Please enter a number between 1 and ${question.options.length}`);
  }
}

/** Prompt for multi_select question */
async function promptMultiSelect(question: PlanningQuestion): Promise<string[]> {
  console.log(`\n  ${question.question}`);
  if (question.description) {
    console.log(`  ${question.description}`);
  }
  console.log("  (Enter comma-separated numbers, e.g., 1,3,4):\n");

  if (!question.options || question.options.length === 0) {
    throw new Error("Multi select question has no options");
  }

  for (let i = 0; i < question.options.length; i++) {
    const opt = question.options[i];
    console.log(`  ${i + 1}. ${opt.label}`);
    if (opt.description) {
      console.log(`     ${opt.description}`);
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    const answer = await rl.question("\n  Select (comma-separated): ");
    const nums = answer
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));

    if (nums.length === 0) {
      console.log("  Please select at least one option");
      continue;
    }

    const invalid = nums.filter((n) => n < 1 || n > question.options!.length);
    if (invalid.length > 0) {
      console.log(`  Invalid selection: ${invalid.join(", ")}. Range: 1-${question.options.length}`);
      continue;
    }

    rl.close();
    return nums.map((n) => question.options![n - 1].id);
  }
}

/** Prompt for confirm question */
async function promptConfirm(question: PlanningQuestion): Promise<boolean> {
  console.log(`\n  ${question.question}`);
  if (question.description) {
    console.log(`  ${question.description}`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("\n  [Y/n]: ");
  rl.close();

  const trimmed = answer.trim().toLowerCase();
  return trimmed === "" || trimmed === "y" || trimmed === "yes";
}

/** Display planning summary */
function displaySummary(summary: PlanningSummary): void {
  console.log();
  console.log("  ╔══════════════════════════════════════════════════════════════╗");
  console.log("  ║                    Planning Summary                            ║");
  console.log("  ╠══════════════════════════════════════════════════════════════╣");
  console.log(`  ║ Title: ${summary.title.slice(0, 55).padEnd(55)} ║`);
  console.log("  ╠══════════════════════════════════════════════════════════════╣");

  // Description (wrapped to box width)
  const descLines = wrapText(summary.description, 58);
  for (const line of descLines.slice(0, 10)) {
    console.log(`  ║ ${line.padEnd(58)} ║`);
  }
  if (descLines.length > 10) {
    console.log(`  ║ ... (${descLines.length - 10} more lines) ...`.padEnd(62) + " ║");
  }

  console.log("  ╠══════════════════════════════════════════════════════════════╣");
  console.log(`  ║ Size: ${summary.suggestedSize.padEnd(52)} ║`);

  if (summary.suggestedDependencies.length > 0) {
    console.log(`  ║ Dependencies: ${summary.suggestedDependencies.join(", ").slice(0, 45).padEnd(45)} ║`);
  } else {
    console.log(`  ║ Dependencies: none`.padEnd(62) + " ║");
  }

  console.log("  ╠══════════════════════════════════════════════════════════════╣");
  console.log("  ║ Key Deliverables:                                              ║");
  for (const deliverable of summary.keyDeliverables) {
    console.log(`  ║   • ${deliverable.slice(0, 54).padEnd(54)} ║`);
  }
  console.log("  ╚══════════════════════════════════════════════════════════════╝");
  console.log();
}

/** Wrap text to specified width */
function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split("\n");

  for (const paragraph of paragraphs) {
    if (paragraph.trim() === "") {
      lines.push("");
      continue;
    }

    let remaining = paragraph.trim();
    while (remaining.length > 0) {
      if (remaining.length <= width) {
        lines.push(remaining);
        break;
      }

      let breakPoint = width;
      while (breakPoint > 0 && remaining[breakPoint] !== " ") {
        breakPoint--;
      }

      if (breakPoint === 0) {
        // No space found, force break
        breakPoint = width;
      }

      lines.push(remaining.slice(0, breakPoint));
      remaining = remaining.slice(breakPoint).trim();
    }
  }

  return lines;
}

/** Run the planning mode */
export async function runTaskPlan(initialPlanArg?: string, yesFlag = false, projectName?: string): Promise<string | undefined> {
  let initialPlan = initialPlanArg;

  // If no initial plan, prompt interactively
  if (!initialPlan) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log("\n  Let's plan your task. What would you like to accomplish?\n");
    initialPlan = await rl.question("  Describe your idea: ");
    rl.close();

    if (!initialPlan?.trim()) {
      console.error("\n  Description is required");
      process.exit(1);
    }
  }

  const store = await getStore(projectName);

  // Create planning session
  let sessionId: string;
  let firstQuestion: PlanningQuestion;

  try {
    showThinking();
    const projectPath = await getProjectPath(projectName);
    const result = await createSession("127.0.0.1", initialPlan.trim(), store, projectPath);
    clearThinking();
    sessionId = result.sessionId;
    firstQuestion = result.firstQuestion;
  } catch (err) {
    clearThinking();

    if (err instanceof RateLimitError) {
      console.error("\n  Rate limit exceeded. Maximum 5 planning sessions per hour.\n");
      process.exit(1);
    }

    console.error(`\n  Failed to start planning session: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  // Interactive Q&A loop
  let currentQuestion = firstQuestion;
  let cancelled = false;

  // Handle Ctrl+C gracefully
  const handleSigint = () => {
    cancelled = true;
    console.log("\n\n  Planning session cancelled.\n");
    process.exit(0);
  };

  process.on("SIGINT", handleSigint);

  try {
    while (!cancelled) {
      // Get user response based on question type
      let response: Record<string, unknown>;

      try {
        switch (currentQuestion.type) {
          case "text": {
            const textResponse = await promptText(currentQuestion);
            response = { [currentQuestion.id]: textResponse };
            break;
          }
          case "single_select": {
            const selectResponse = await promptSingleSelect(currentQuestion);
            response = { [currentQuestion.id]: selectResponse };
            break;
          }
          case "multi_select": {
            const multiResponse = await promptMultiSelect(currentQuestion);
            response = { [currentQuestion.id]: multiResponse };
            break;
          }
          case "confirm": {
            const confirmResponse = await promptConfirm(currentQuestion);
            response = { [currentQuestion.id]: confirmResponse };
            break;
          }
          default: {
            console.error(`\n  Unknown question type: ${(currentQuestion as any).type}`);
            process.exit(1);
          }
        }
      } catch (promptErr) {
        // Prompt was cancelled (Ctrl+C handled above)
        if (cancelled) {
          return undefined;
        }
        throw promptErr;
      }

      // Submit response and get next question or summary
      let result: { type: "question"; data: PlanningQuestion } | { type: "complete"; data: PlanningSummary };

      try {
        showThinking();
        result = await submitResponse(sessionId, response) as typeof result;
        clearThinking();
      } catch (err) {
        clearThinking();

        if (err instanceof SessionNotFoundError) {
          console.error("\n  Session expired. Please start again.\n");
          process.exit(1);
        }
        if (err instanceof InvalidSessionStateError) {
          console.error(`\n  Invalid session state: ${err.message}\n`);
          process.exit(1);
        }

        console.error(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }

      if (result.type === "complete") {
        // Display summary
        displaySummary(result.data);

        // Ask for confirmation (unless --yes flag)
        let confirmed = yesFlag;
        if (!yesFlag) {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await rl.question("  Create this task? [Y/n]: ");
          rl.close();
          const trimmed = answer.trim().toLowerCase();
          confirmed = trimmed === "" || trimmed === "y" || trimmed === "yes";
        }

        if (confirmed) {
          // Create the task
          const task = await store.createTask({
            title: result.data.title,
            description: result.data.description,
            column: "triage",
            dependencies: result.data.suggestedDependencies,
          });

          console.log();
          console.log(`  ✓ Created ${task.id}: ${task.title || task.description.slice(0, 60)}${task.description.length > 60 ? "…" : ""}`);
          console.log(`    Column: triage`);
          if (task.dependencies.length > 0) {
            console.log(`    Dependencies: ${task.dependencies.join(", ")}`);
          }
          console.log(`    Path:   .fusion/tasks/${task.id}/`);
          console.log();

          return task.id;
        }

        console.log("\n  Task creation cancelled.\n");
        return undefined;
      }

      // Next question
      currentQuestion = result.data;
    }
  } finally {
    process.off("SIGINT", handleSigint);
  }
}
