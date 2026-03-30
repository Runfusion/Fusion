import { TaskStore, COLUMNS, COLUMN_LABELS, type Column, type MergeResult, type StepStatus } from "@kb/core";
import { aiMergeTask } from "@kb/engine";
import { createInterface } from "node:readline/promises";

const STEP_STATUSES: StepStatus[] = ["pending", "in-progress", "done", "skipped"];

async function getStore(): Promise<TaskStore> {
  const store = new TaskStore(process.cwd());
  await store.init();
  return store;
}

export async function runTaskCreate(descriptionArg?: string, attachFiles?: string[], depends?: string[]) {
  let description = descriptionArg;

  if (!description) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    description = await rl.question("Task description: ");
    rl.close();
  }

  if (!description?.trim()) {
    console.error("Description is required");
    process.exit(1);
  }

  const store = await getStore();
  const task = await store.createTask({ description: description.trim(), dependencies: depends });

  const label = task.description.length > 60
    ? task.description.slice(0, 60) + "…"
    : task.description;

  console.log();
  console.log(`  ✓ Created ${task.id}: ${label}`);
  console.log(`    Column: triage`);
  if (task.dependencies.length > 0) {
    console.log(`    Dependencies: ${task.dependencies.join(", ")}`);
  }
  console.log(`    Path:   .kb/tasks/${task.id}/`);

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

export async function runTaskList() {
  const store = await getStore();
  const tasks = await store.listTasks();

  if (tasks.length === 0) {
    console.log("\n  No tasks yet. Create one with: kb task create\n");
    return;
  }

  console.log();

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
}

export async function runTaskUpdate(id: string, stepStr: string, status: string) {
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

  const store = await getStore();
  const task = await store.updateStep(id, stepIndex, status as StepStatus);

  const step = task.steps[stepIndex];
  console.log();
  console.log(`  ✓ ${task.id} Step ${stepIndex} (${step.name}) → ${status}`);
  console.log(`    Progress: ${task.steps.filter((s) => s.status === "done").length}/${task.steps.length} steps done`);
  console.log();
}

export async function runTaskLog(id: string, message: string, outcome?: string) {
  const store = await getStore();
  await store.logEntry(id, message, outcome);

  console.log();
  console.log(`  ✓ ${id}: logged "${message}"`);
  console.log();
}

export async function runTaskShow(id: string) {
  const store = await getStore();
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

export async function runTaskMerge(id: string) {
  const cwd = process.cwd();
  const store = await getStore();

  console.log(`\n  Merging ${id} with AI...\n`);

  try {
    const result = await aiMergeTask(store, cwd, id, {
      onAgentText: (delta) => process.stdout.write(delta),
      onAgentTool: (name) => console.log(`  [merge] tool: ${name}`),
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

export async function runTaskAttach(id: string, filePath: string) {
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

  const store = await getStore();
  const attachment = await store.addAttachment(id, filename, content, mimeType);

  const sizeKB = (attachment.size / 1024).toFixed(1);
  console.log();
  console.log(`  ✓ Attached to ${id}: ${attachment.originalName}`);
  console.log(`    File: ${attachment.filename} (${sizeKB} KB)`);
  console.log(`    Path: .kb/tasks/${id}/attachments/${attachment.filename}`);
  console.log();
}

export async function runTaskPause(id: string) {
  const store = await getStore();
  const task = await store.pauseTask(id, true);

  console.log();
  console.log(`  ✓ Paused ${task.id}`);
  console.log();
}

export async function runTaskUnpause(id: string) {
  const store = await getStore();
  const task = await store.pauseTask(id, false);

  console.log();
  console.log(`  ✓ Unpaused ${task.id}`);
  console.log();
}

export async function runTaskMove(id: string, column: string) {
  if (!COLUMNS.includes(column as Column)) {
    console.error(`Invalid column: ${column}`);
    console.error(`Valid columns: ${COLUMNS.join(", ")}`);
    process.exit(1);
  }

  const store = await getStore();
  const task = await store.moveTask(id, column as Column);

  console.log();
  console.log(`  ✓ Moved ${task.id} → ${COLUMN_LABELS[task.column as Column]}`);
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
  const token = process.env.GITHUB_TOKEN;

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

  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${params}`;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "kb-cli/1.0",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Repository not found or not accessible: ${owner}/${repo}`);
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Authentication failed or rate limited. ${
            token ? "Check your GITHUB_TOKEN." : "Set GITHUB_TOKEN env var."
          }`
        );
      }
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    // Filter out pull requests (they have a pull_request property)
    const issues = (await response.json()) as GitHubIssue[];
    return issues.filter((issue) => !("pull_request" in issue && issue.pull_request)).slice(0, limit);
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface TaskImportOptions {
  limit?: number;
  labels?: string[];
}

export async function runTaskImportFromGitHub(
  ownerRepo: string,
  options: TaskImportOptions = {}
): Promise<void> {
  // Parse owner/repo
  const match = ownerRepo.match(/^([^/]+)\/([^/]+)$/);
  if (!match) {
    console.error(`Invalid owner/repo format: ${ownerRepo}`);
    console.error(`Expected format: owner/repo (e.g., dustinbyrne/kb)`);
    process.exit(1);
  }

  const [, owner, repo] = match;
  const { limit = 30, labels } = options;

  console.log(`\n  Importing issues from ${owner}/${repo}...\n`);

  const store = await getStore();
  const existingTasks = await store.listTasks();

  // Build a set of already-imported issue URLs
  const importedUrls = new Map<string, string>();
  for (const task of existingTasks) {
    const sourceMatch = task.description.match(/Source: (https:\/\/github\.com\/[^\/]+\/[^\/]+\/issues\/\d+)$/m);
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
