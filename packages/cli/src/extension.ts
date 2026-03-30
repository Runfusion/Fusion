import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import {
  TaskStore,
  COLUMNS,
  COLUMN_LABELS,
  type Column,
  type Task,
} from "@kb/core";
import { resolve, basename, extname } from "node:path";
import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";

// ── Helpers ────────────────────────────────────────────────────────

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

/** Cache stores per cwd to avoid re-init on every tool call. */
const storeCache = new Map<string, TaskStore>();

async function getStore(cwd: string): Promise<TaskStore> {
  const existing = storeCache.get(cwd);
  if (existing) return existing;

  const store = new TaskStore(cwd);
  await store.init();
  storeCache.set(cwd, store);
  return store;
}

function formatTaskLine(t: Task): string {
  const label =
    t.title || t.description.slice(0, 60) + (t.description.length > 60 ? "…" : "");
  const deps = t.dependencies.length ? ` [deps: ${t.dependencies.join(", ")}]` : "";
  const paused = t.paused ? " (paused)" : "";
  return `${t.id}  ${label}${deps}${paused}`;
}

// ── Extension entry point ──────────────────────────────────────────

export default function kbExtension(pi: ExtensionAPI) {
  // ── kb_task_create ───────────────────────────────────────────────

  pi.registerTool({
    name: "kb_task_create",
    label: "KB: Create Task",
    description:
      "Create a new task on the kb task board. The task enters the triage column " +
      "where the AI triage agent will specify it into a full prompt with steps, " +
      "file scope, and acceptance criteria.",
    promptSnippet: "Create a task on the kb AI-orchestrated task board",
    promptGuidelines: [
      "Use kb_task_create for task tracking — be descriptive so the triage agent can write a good spec.",
      "Include the problem AND desired outcome. For bugs, describe current vs expected behavior.",
    ],
    parameters: Type.Object({
      description: Type.String({ description: "What needs to be done — be descriptive" }),
      depends: Type.Optional(
        Type.Array(Type.String(), {
          description: "Task IDs this depends on (e.g. ['KB-001', 'KB-002'])",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const task = await store.createTask({
        description: params.description.trim(),
        dependencies: params.depends,
      });

      const label =
        task.description.length > 80
          ? task.description.slice(0, 80) + "…"
          : task.description;

      return {
        content: [
          {
            type: "text",
            text:
              `Created ${task.id}: ${label}\n` +
              `Column: triage\n` +
              (task.dependencies.length
                ? `Dependencies: ${task.dependencies.join(", ")}\n`
                : "") +
              `Path: .kb/tasks/${task.id}/`,
          },
        ],
        details: { taskId: task.id, column: task.column, dependencies: task.dependencies },
      };
    },
  });

  // ── kb_task_list ─────────────────────────────────────────────────

  pi.registerTool({
    name: "kb_task_list",
    label: "KB: List Tasks",
    description: "List all tasks on the kb board, grouped by column.",
    promptSnippet: "List all tasks on the kb board grouped by column",
    parameters: Type.Object({
      column: Type.Optional(
        StringEnum([...COLUMNS] as unknown as string[], {
          description: "Filter to a specific column",
        }) as any,
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Max tasks to show per column (default: 10)",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const tasks = await store.listTasks();

      if (tasks.length === 0) {
        return {
          content: [{ type: "text", text: "No tasks yet." }],
          details: { count: 0 },
        };
      }

      const perColumn = params.limit ?? 10;
      const lines: string[] = [];
      for (const col of COLUMNS) {
        if (params.column && params.column !== col) continue;

        const colTasks = tasks.filter((t) => t.column === col);
        if (colTasks.length === 0) continue;

        lines.push(`${COLUMN_LABELS[col]} (${colTasks.length}):`);
        const shown = colTasks.slice(0, perColumn);
        for (const t of shown) {
          lines.push(`  ${formatTaskLine(t)}`);
        }
        const hidden = colTasks.length - shown.length;
        if (hidden > 0) {
          lines.push(`  ... and ${hidden} more`);
        }
        lines.push("");
      }

      return {
        content: [{ type: "text", text: lines.join("\n").trimEnd() }],
        details: { count: tasks.length },
      };
    },
  });

  // ── kb_task_show ─────────────────────────────────────────────────

  pi.registerTool({
    name: "kb_task_show",
    label: "KB: Show Task",
    description: "Show full details for a task including steps, progress, and log entries.",
    promptSnippet: "Show full details for a kb task",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID (e.g. KB-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const task = await store.getTask(params.id);

      const lines: string[] = [];
      lines.push(`${task.id}: ${task.title || task.description}`);
      lines.push(
        `Column: ${COLUMN_LABELS[task.column]}` +
          (task.size ? ` · Size: ${task.size}` : "") +
          (task.reviewLevel !== undefined ? ` · Review: ${task.reviewLevel}` : ""),
      );
      if (task.dependencies.length) {
        lines.push(`Dependencies: ${task.dependencies.join(", ")}`);
      }
      if (task.paused) lines.push("Status: PAUSED");
      lines.push("");

      // Steps
      if (task.steps.length > 0) {
        const done = task.steps.filter((s) => s.status === "done").length;
        lines.push(`Steps (${done}/${task.steps.length}):`);
        for (let i = 0; i < task.steps.length; i++) {
          const s = task.steps[i];
          const icon =
            s.status === "done"
              ? "✓"
              : s.status === "in-progress"
                ? "▸"
                : s.status === "skipped"
                  ? "–"
                  : " ";
          const marker =
            i === task.currentStep && s.status !== "done" ? " ◀" : "";
          lines.push(`  [${icon}] ${i}: ${s.name}${marker}`);
        }
        lines.push("");
      }

      // Prompt (truncated)
      if (task.prompt) {
        const promptPreview =
          task.prompt.length > 500
            ? task.prompt.slice(0, 500) + "\n... (truncated)"
            : task.prompt;
        lines.push("Prompt:");
        lines.push(promptPreview);
        lines.push("");
      }

      // Recent log
      if (task.log.length > 0) {
        const recent = task.log.slice(-5);
        lines.push(`Log (last ${recent.length}):`);
        for (const l of recent) {
          const ts = new Date(l.timestamp).toLocaleTimeString();
          lines.push(
            `  ${ts}  ${l.action}${l.outcome ? ` → ${l.outcome}` : ""}`,
          );
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n").trimEnd() }],
        details: { task },
      };
    },
  });

  // ── kb_task_attach ───────────────────────────────────────────────

  pi.registerTool({
    name: "kb_task_attach",
    label: "KB: Attach File",
    description:
      "Attach a file to a task. Supports images (png, jpg, gif, webp) and " +
      "text files (txt, log, json, yaml, yml, toml, csv, xml).",
    promptSnippet: "Attach a file to a kb task",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID (e.g. KB-001)" }),
      path: Type.String({ description: "Path to the file to attach" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const filePath = resolve(ctx.cwd, params.path.replace(/^@/, ""));
      const filename = basename(filePath);
      const ext = extname(filename).toLowerCase();
      const mimeType = MIME_TYPES[ext];

      if (!mimeType) {
        throw new Error(
          `Unsupported file type: ${ext}. Supported: ${Object.keys(MIME_TYPES).join(", ")}`,
        );
      }

      let content: Buffer;
      try {
        content = await readFile(filePath);
      } catch {
        throw new Error(`Cannot read file: ${params.path}`);
      }

      const store = await getStore(ctx.cwd);
      const attachment = await store.addAttachment(params.id, filename, content, mimeType);
      const sizeKB = (attachment.size / 1024).toFixed(1);

      return {
        content: [
          {
            type: "text",
            text:
              `Attached to ${params.id}: ${attachment.originalName} (${sizeKB} KB)\n` +
              `Path: .kb/tasks/${params.id}/attachments/${attachment.filename}`,
          },
        ],
        details: { taskId: params.id, attachment },
      };
    },
  });

  // ── kb_task_pause ────────────────────────────────────────────────

  pi.registerTool({
    name: "kb_task_pause",
    label: "KB: Pause Task",
    description:
      "Pause a task — stops all automated agent and scheduler interaction for this task.",
    promptSnippet: "Pause a kb task (stops automation)",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID (e.g. KB-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const task = await store.pauseTask(params.id, true);

      return {
        content: [{ type: "text", text: `Paused ${task.id}` }],
        details: { taskId: task.id },
      };
    },
  });

  // ── kb_task_unpause ──────────────────────────────────────────────

  pi.registerTool({
    name: "kb_task_unpause",
    label: "KB: Unpause Task",
    description:
      "Unpause a task — resumes automated agent and scheduler interaction.",
    promptSnippet: "Unpause a kb task (resumes automation)",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID (e.g. KB-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const task = await store.pauseTask(params.id, false);

      return {
        content: [{ type: "text", text: `Unpaused ${task.id}` }],
        details: { taskId: task.id },
      };
    },
  });

  // ── kb_task_duplicate ─────────────────────────────────────────────

  pi.registerTool({
    name: "kb_task_duplicate",
    label: "KB: Duplicate Task",
    description:
      "Duplicate an existing task, creating a fresh copy in triage. " +
      "Copies the title and description but resets all execution state. " +
      "The AI triage agent will re-specify the new task.",
    promptSnippet: "Duplicate a kb task (creates copy in triage)",
    promptGuidelines: [
      "Use when a task needs to be re-done, split, or used as a template",
      "The duplicated task will be placed in triage for re-specification",
      "Dependencies, attachments, and execution state are NOT copied",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Source task ID to duplicate (e.g. KB-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const newTask = await store.duplicateTask(params.id);

      return {
        content: [{ type: "text", text: `Duplicated ${params.id} → ${newTask.id}` }],
        details: { sourceId: params.id, newTaskId: newTask.id },
      };
    },
  });

  // ── kb_task_import_github ─────────────────────────────────────────

  pi.registerTool({
    name: "kb_task_import_github",
    label: "KB: Import GitHub Issues",
    description:
      "Import GitHub issues as kb tasks. Fetches open issues from a repository " +
      "and creates tasks in the triage column. Each task includes the issue title " +
      "and body with a link to the source issue.",
    promptSnippet: "Import GitHub issues as kb tasks",
    promptGuidelines: [
      "Use for syncing GitHub issue backlog to kb board",
      "Requires GITHUB_TOKEN env var for private repositories",
      "Use --limit to control how many issues to import (default: 30)",
      "Use --labels to filter by specific labels",
    ],
    parameters: Type.Object({
      ownerRepo: Type.String({
        description: "Repository in owner/repo format (e.g., 'dustinbyrne/kb')",
        pattern: "^[^/]+/[^/]+$",
      }),
      limit: Type.Optional(
        Type.Number({
          description: "Max issues to import (default: 30, max: 100)",
          minimum: 1,
          maximum: 100,
        })
      ),
      labels: Type.Optional(
        Type.Array(Type.String(), {
          description: "Label names to filter by",
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Import the function dynamically to avoid circular dependencies
      const { runTaskImportFromGitHub } = await import("./commands/task.js");

      const limit = params.limit ?? 30;
      const labels = params.labels;

      // Capture console output
      const originalLog = console.log;
      const originalError = console.error;
      const logs: string[] = [];

      console.log = (...args: unknown[]) => {
        const line = args.map(String).join(" ");
        logs.push(line);
        originalLog.apply(console, args);
      };
      console.error = (...args: unknown[]) => {
        const line = args.map(String).join(" ");
        logs.push(line);
        originalError.apply(console, args);
      };

      try {
        await runTaskImportFromGitHub(params.ownerRepo, { limit, labels });
      } finally {
        console.log = originalLog;
        console.error = originalError;
      }

      // Parse created task IDs from logs
      const createdTasks: Array<{ id: string; title: string }> = [];
      for (const line of logs) {
        const match = line.match(/Created (KB-\d+):\s*(.+)$/);
        if (match) {
          createdTasks.push({ id: match[1], title: match[2].trim() });
        }
      }

      const summary = logs.find((l) => l.includes("✓ Imported")) || "Import complete";

      return {
        content: [
          {
            type: "text",
            text: `${summary}\n\nCreated tasks:\n${createdTasks.map((t) => `  ${t.id}: ${t.title}`).join("\n") || "  None"}`,
          },
        ],
        details: { createdTasks, summary },
      };
    },
  });

  // ── kb_task_import_github_issue ───────────────────────────────────
  // Import a single GitHub issue by its issue number

  pi.registerTool({
    name: "kb_task_import_github_issue",
    label: "KB: Import GitHub Issue",
    description:
      "Import a specific GitHub issue as a kb task. Fetches the issue by number " +
      "and creates a single task in the triage column with the issue title and body.",
    promptSnippet: "Import a specific GitHub issue as a kb task",
    promptGuidelines: [
      "Use for importing a single known issue by its number",
      "Requires GITHUB_TOKEN env var for private repositories",
      "Skips import if the issue is already imported (checks for existing Source URL)",
    ],
    parameters: Type.Object({
      owner: Type.String({
        description: "Repository owner (e.g., 'dustinbyrne')",
      }),
      repo: Type.String({
        description: "Repository name (e.g., 'kb')",
      }),
      issueNumber: Type.Number({
        description: "GitHub issue number to import",
        minimum: 1,
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { owner, repo, issueNumber } = params;
      const token = process.env.GITHUB_TOKEN;

      // Build URL for single issue
      const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`;

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

      let issue: { number: number; title: string; body: string | null; html_url: string };

      try {
        const response = await fetch(url, {
          headers,
          signal: controller.signal,
        });

        if (!response.ok) {
          if (response.status === 404) {
            throw new Error(`Issue #${issueNumber} not found in ${owner}/${repo}`);
          }
          if (response.status === 401 || response.status === 403) {
            throw new Error(
              `Authentication failed. ${token ? "Check your GITHUB_TOKEN." : "Set GITHUB_TOKEN env var."}`
            );
          }
          throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
        }

        issue = await response.json() as typeof issue;

        // Check if it's a pull request
        if ("pull_request" in issue && issue.pull_request) {
          throw new Error(`#${issueNumber} is a pull request, not an issue`);
        }
      } finally {
        clearTimeout(timeoutId);
      }

      // Check if already imported
      const store = await getStore(ctx.cwd);
      const existingTasks = await store.listTasks();
      const sourceUrl = issue.html_url;

      for (const task of existingTasks) {
        if (task.description.includes(sourceUrl)) {
          return {
            content: [
              {
                type: "text",
                text: `Issue #${issueNumber} already imported as ${task.id}\nSource: ${sourceUrl}`,
              },
            ],
            details: { skipped: true, existingTaskId: task.id, sourceUrl },
          };
        }
      }

      // Create the task
      const title = issue.title.slice(0, 200);
      const body = issue.body?.trim() || "(no description)";
      const description = `${body}\n\nSource: ${sourceUrl}`;

      const task = await store.createTask({
        title: title || undefined,
        description,
        column: "triage",
        dependencies: [],
      });

      return {
        content: [
          {
            type: "text",
            text: `Imported ${task.id} from GitHub\n${sourceUrl}`,
          },
        ],
        details: { taskId: task.id, sourceUrl },
      };
    },
  });

  // ── kb_task_browse_github_issues ──────────────────────────────────
  // Browse available GitHub issues before importing

  pi.registerTool({
    name: "kb_task_browse_github_issues",
    label: "KB: Browse GitHub Issues",
    description:
      "List open GitHub issues from a repository to browse before importing. " +
      "Returns issue numbers, titles, and URLs for selection. Use with kb_task_import_github_issue " +
      "to import specific issues by number.",
    promptSnippet: "Browse open GitHub issues in a repository",
    promptGuidelines: [
      "Use to preview available issues before importing",
      "Returns a list you can reference when importing specific issues",
      "Use --limit to control how many issues to show (default: 30)",
      "Use --labels to filter by specific labels",
      "Requires GITHUB_TOKEN env var for private repositories",
    ],
    parameters: Type.Object({
      owner: Type.String({
        description: "Repository owner (e.g., 'dustinbyrne')",
      }),
      repo: Type.String({
        description: "Repository name (e.g., 'kb')",
      }),
      limit: Type.Optional(
        Type.Number({
          description: "Max issues to show (default: 30, max: 100)",
          minimum: 1,
          maximum: 100,
        })
      ),
      labels: Type.Optional(
        Type.Array(Type.String(), {
          description: "Label names to filter by",
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { owner, repo, limit = 30, labels } = params;
      const token = process.env.GITHUB_TOKEN;

      // Build query parameters
      const queryParams = new URLSearchParams();
      queryParams.append("state", "open");
      queryParams.append("per_page", String(Math.min(limit, 100)));
      if (labels && labels.length > 0) {
        queryParams.append("labels", labels.join(","));
      }

      const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${queryParams}`;

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

      let issues: Array<{ number: number; title: string; html_url: string; labels: Array<{ name: string }> }>;

      try {
        const response = await fetch(url, {
          headers,
          signal: controller.signal,
        });

        if (!response.ok) {
          if (response.status === 404) {
            throw new Error(`Repository not found: ${owner}/${repo}`);
          }
          if (response.status === 401 || response.status === 403) {
            throw new Error(
              `Authentication failed. ${token ? "Check your GITHUB_TOKEN." : "Set GITHUB_TOKEN env var."}`
            );
          }
          throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
        }

        const allIssues = await response.json() as typeof issues;
        // Filter out pull requests
        issues = allIssues.filter((i) => !("pull_request" in i && i.pull_request)).slice(0, limit);
      } finally {
        clearTimeout(timeoutId);
      }

      if (issues.length === 0) {
        return {
          content: [{ type: "text", text: `No open issues found in ${owner}/${repo}.` }],
          details: { count: 0, issues: [] },
        };
      }

      // Check which issues are already imported
      const store = await getStore(ctx.cwd);
      const existingTasks = await store.listTasks();
      const importedUrls = new Set<string>();

      for (const task of existingTasks) {
        const match = task.description.match(/Source: (https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+)/);
        if (match) {
          importedUrls.add(match[1]);
        }
      }

      const lines: string[] = [];
      lines.push(`Found ${issues.length} open issues in ${owner}/${repo}:\n`);

      for (const issue of issues) {
        const isImported = importedUrls.has(issue.html_url);
        const labelStr = issue.labels.length > 0 ? ` [${issue.labels.map((l) => l.name).join(", ")}]` : "";
        const importedStr = isImported ? " ✓ Imported" : "";
        lines.push(`  #${issue.number}: ${issue.title.slice(0, 80)}${issue.title.length > 80 ? "…" : ""}${labelStr}${importedStr}`);
        lines.push(`     ${issue.html_url}`);
      }

      lines.push("\nUse kb_task_import_github_issue to import a specific issue by number.");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          count: issues.length,
          issues: issues.map((i) => ({
            number: i.number,
            title: i.title,
            url: i.html_url,
            labels: i.labels.map((l) => l.name),
            imported: importedUrls.has(i.html_url),
          })),
        },
      };
    },
  });

  // ── /kb command — start the dashboard + engine ───────────────────

  let dashboardProcess: ChildProcess | null = null;
  let dashboardPort: number | null = null;

  pi.registerCommand("kb", {
    description: "Start (or stop) the kb dashboard and AI engine",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();

      // /kb stop — kill the dashboard
      if (trimmed === "stop") {
        if (dashboardProcess) {
          dashboardProcess.kill("SIGINT");
          dashboardProcess = null;
          dashboardPort = null;
          ctx.ui.setStatus("kb", "");
          ctx.ui.notify("kb dashboard stopped", "info");
        } else {
          ctx.ui.notify("kb dashboard is not running", "warning");
        }
        return;
      }

      // /kb status
      if (trimmed === "status") {
        if (dashboardProcess && !dashboardProcess.killed) {
          ctx.ui.notify(`kb dashboard running on http://localhost:${dashboardPort}`, "info");
        } else {
          dashboardProcess = null;
          dashboardPort = null;
          ctx.ui.notify("kb dashboard is not running", "info");
        }
        return;
      }

      // /kb [port] — start the dashboard
      if (dashboardProcess && !dashboardProcess.killed) {
        ctx.ui.notify(
          `kb dashboard already running on http://localhost:${dashboardPort}. Use /kb stop first.`,
          "warning",
        );
        return;
      }

      const port = trimmed ? parseInt(trimmed, 10) || 4040 : 4040;

      // Find the kb binary: prefer local node_modules, then global
      const child = spawn("kb", ["dashboard", "--port", String(port), "--no-open"], {
        cwd: ctx.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        env: { ...process.env },
      });

      dashboardProcess = child;
      dashboardPort = port;

      // Watch for early exit (e.g. kb not found)
      child.on("error", (err) => {
        dashboardProcess = null;
        dashboardPort = null;
        ctx.ui.setStatus("kb", "");
        ctx.ui.notify(`Failed to start kb dashboard: ${err.message}`, "error");
      });

      child.on("exit", (code) => {
        if (dashboardProcess === child) {
          dashboardProcess = null;
          dashboardPort = null;
          ctx.ui.setStatus("kb", "");
          if (code !== 0 && code !== null) {
            ctx.ui.notify(`kb dashboard exited with code ${code}`, "warning");
          }
        }
      });

      // Wait briefly to see if it crashes immediately
      await new Promise((r) => setTimeout(r, 500));

      if (dashboardProcess && !dashboardProcess.killed) {
        const url = `http://localhost:${port}`;
        ctx.ui.notify(`kb dashboard started on ${url} (AI engine active)`, "info");
        const link = `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;
        ctx.ui.setStatus("kb", `kb ● ${link}`);
      }
    },
  });

  // ── Cleanup on session end ───────────────────────────────────────

  pi.on("session_shutdown", async () => {
    if (dashboardProcess) {
      dashboardProcess.kill("SIGINT");
      dashboardProcess = null;
      dashboardPort = null;
    }
    storeCache.clear();
  });
}
