import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import {
  TaskStore,
  COLUMNS,
  COLUMN_LABELS,
  type Column,
  type Task,
} from "@fusion/core";
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
      "Create a new task on the Fusion task board. The task enters the triage column " +
      "where the AI triage agent will specify it into a full prompt with steps, " +
      "file scope, and acceptance criteria.",
    promptSnippet: "Create a task on the Fusion AI-orchestrated task board",
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
              `Path: .fusion/tasks/${task.id}/`,
          },
        ],
        details: { taskId: task.id, column: task.column, dependencies: task.dependencies },
      };
    },
  });

  // ── kb_task_update ────────────────────────────────────────────────

  pi.registerTool({
    name: "kb_task_update",
    label: "KB: Update Task",
    description:
      "Update fields on an existing task. Supports modifying the title, " +
      "description, and dependencies after task creation.",
    promptSnippet: "Update fields on an existing Fusion task",
    promptGuidelines: [
      "Use kb_task_update to modify task title, description, or dependencies after creation.",
      "At least one field must be provided to update.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID (e.g. KB-001)" }),
      title: Type.Optional(Type.String({ description: "New task title" })),
      description: Type.Optional(Type.String({ description: "New task description" })),
      depends: Type.Optional(
        Type.Array(Type.String(), {
          description: "New dependency list — replaces existing dependencies (e.g. ['KB-001', 'KB-002'])",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);

      // Validate task exists
      let task;
      try {
        task = await store.getTask(params.id);
      } catch {
        return {
          content: [{ type: "text", text: `Task ${params.id} not found` }],
          isError: true,
          details: { error: "Task not found" },
        };
      }

      // Build update payload
      const updates: Record<string, unknown> = {};
      const updatedFields: string[] = [];

      if (params.title !== undefined) {
        updates.title = params.title.trim();
        updatedFields.push("title");
      }
      if (params.description !== undefined) {
        updates.description = params.description.trim();
        updatedFields.push("description");
      }
      if (params.depends !== undefined) {
        updates.dependencies = params.depends;
        updatedFields.push("dependencies");
      }

      if (updatedFields.length === 0) {
        return {
          content: [{ type: "text", text: "No fields to update. Provide at least one of: title, description, depends." }],
          isError: true,
          details: { error: "No fields provided" },
        };
      }

      await store.updateTask(params.id, updates);

      return {
        content: [
          {
            type: "text",
            text: `Updated ${params.id}: ${updatedFields.join(", ")}`,
          },
        ],
        details: { taskId: params.id, updatedFields },
      };
    },
  });

  // ── kb_task_list ─────────────────────────────────────────────────

  pi.registerTool({
    name: "kb_task_list",
    label: "KB: List Tasks",
    description: "List all tasks on the Fusion board, grouped by column.",
    promptSnippet: "List all tasks on the Fusion board grouped by column",
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
    promptSnippet: "Show full details for a Fusion task",
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
    promptSnippet: "Attach a file to a Fusion task",
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
              `Path: .fusion/tasks/${params.id}/attachments/${attachment.filename}`,
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
    promptSnippet: "Pause a Fusion task (stops automation)",
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
    promptSnippet: "Unpause a Fusion task (resumes automation)",
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

  // ── kb_task_retry ────────────────────────────────────────────────

  pi.registerTool({
    name: "kb_task_retry",
    label: "KB: Retry Task",
    description:
      "Retry a failed task — clears the error state and moves it back to the todo column for re-execution.",
    promptSnippet: "Retry a failed Fusion task (clears error, moves to todo)",
    promptGuidelines: [
      "Use when a task has failed and needs to be retried from the beginning",
      "Only tasks in 'failed' state can be retried",
      "The task will be moved to the todo column with error state cleared",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to retry (e.g. KB-001). Must be in 'failed' state." }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      
      // Validate task exists
      let task;
      try {
        task = await store.getTask(params.id);
      } catch {
        return {
          content: [{ type: "text", text: `Task ${params.id} not found` }],
          isError: true,
          details: { error: "Task not found" },
        };
      }
      
      // Validate task is in a retryable state
      if (task.status !== 'failed' && task.status !== 'stuck-killed') {
        return {
          content: [{ type: "text", text: `Task ${params.id} is not in a retryable state (status: ${task.status || 'none'})` }],
          isError: true,
          details: { taskId: params.id, currentStatus: task.status },
        };
      }
      
      // Clear failure state
      await store.updateTask(params.id, { status: null, error: null });
      
      // Move to todo column
      await store.moveTask(params.id, 'todo');
      
      // Log the retry action
      await store.logEntry(params.id, "Retry requested via Pi extension", "Task reset to todo for retry");
      
      return {
        content: [{ type: "text", text: `Retried ${params.id} → todo (failure state cleared)` }],
        details: { taskId: params.id, newColumn: 'todo' },
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
    promptSnippet: "Duplicate a Fusion task (creates copy in triage)",
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

  // ── kb_task_refine ──────────────────────────────────────────────

  pi.registerTool({
    name: "kb_task_refine",
    label: "KB: Refine Task",
    description:
      "Request a refinement of a completed or in-review task. " +
      "Creates a new follow-up task in triage that references the original task as a dependency. " +
      "Use this when a done or in-review task needs additional work, improvements, or follow-up changes.",
    promptSnippet: "Create a refinement task for follow-up work on a completed task",
    promptGuidelines: [
      "Use when a completed or in-review task needs follow-up work or improvements",
      "The original task must be in 'done' or 'in-review' column",
      "The refinement task will be created in triage and depend on the original task",
      "Provide clear feedback about what needs to be refined or improved",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to refine (e.g. KB-001). Must be in 'done' or 'in-review' column." }),
      feedback: Type.String({ 
        description: "Description of what needs to be refined or improved",
        minLength: 1,
        maxLength: 2000,
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const newTask = await store.refineTask(params.id, params.feedback);

      return {
        content: [
          { type: "text", text: `Created refinement ${newTask.id} for ${params.id}` },
        ],
        details: { sourceId: params.id, newTaskId: newTask.id, feedback: params.feedback },
      };
    },
  });

  // ── kb_task_archive ───────────────────────────────────────────────

  pi.registerTool({
    name: "kb_task_archive",
    label: "KB: Archive Task",
    description:
      "Archive a done task (move from done → archived). " +
      "Archived tasks are preserved for historical reference but moved out of the main board view.",
    promptSnippet: "Archive a done Fusion task (moves to archived column)",
    promptGuidelines: [
      "Use to clean up old completed tasks from the done column",
      "Only tasks in the 'done' column can be archived",
      "Archived tasks can be unarchived later if needed",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to archive (e.g. KB-001). Must be in 'done' column." }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const task = await store.archiveTask(params.id);

      return {
        content: [{ type: "text", text: `Archived ${task.id} → ${COLUMN_LABELS[task.column]}` }],
        details: { taskId: task.id, column: task.column },
      };
    },
  });

  // ── kb_task_unarchive ─────────────────────────────────────────────

  pi.registerTool({
    name: "kb_task_unarchive",
    label: "KB: Unarchive Task",
    description:
      "Unarchive an archived task (move from archived → done). " +
      "Restores the task to the done column.",
    promptSnippet: "Unarchive a Fusion task (restores to done column)",
    promptGuidelines: [
      "Use to restore an archived task back to the done column",
      "Only tasks in the 'archived' column can be unarchived",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to unarchive (e.g. KB-001). Must be in 'archived' column." }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const task = await store.unarchiveTask(params.id);

      return {
        content: [{ type: "text", text: `Unarchived ${task.id} → ${COLUMN_LABELS[task.column]}` }],
        details: { taskId: task.id, column: task.column },
      };
    },
  });

  // ── kb_task_delete ─────────────────────────────────────────────────

  pi.registerTool({
    name: "kb_task_delete",
    label: "KB: Delete Task",
    description:
      "Permanently delete a task from the Fusion board. " +
      "Tasks are deleted immediately and cannot be recovered.",
    promptSnippet: "Delete a Fusion task",
    promptGuidelines: [
      "Use for cleaning up test tasks or tasks created in error",
      "Tasks are permanently deleted and cannot be recovered",
      "Consider archiving instead of deleting for completed work you may need to reference later",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to delete (e.g. KB-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const task = await store.deleteTask(params.id);

      return {
        content: [{ type: "text", text: `Deleted ${task.id}` }],
        details: { taskId: task.id },
      };
    },
  });

  // ── kb_task_import_github ─────────────────────────────────────────

  pi.registerTool({
    name: "kb_task_import_github",
    label: "KB: Import GitHub Issues",
    description:
      "Import GitHub issues as Fusion tasks. Fetches open issues from a repository " +
      "and creates tasks in the triage column. Each task includes the issue title " +
      "and body with a link to the source issue.",
    promptSnippet: "Import GitHub issues as Fusion tasks",
    promptGuidelines: [
      "Use for syncing GitHub issue backlog to Fusion board",
      "Uses gh CLI authentication when available (run 'gh auth login')",
      "Falls back to GITHUB_TOKEN env var for private repositories without gh CLI",
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
      "Import a specific GitHub issue as a Fusion task. Fetches the issue by number " +
      "and creates a single task in the triage column with the issue title and body.",
    promptSnippet: "Import a specific GitHub issue as a Fusion task",
    promptGuidelines: [
      "Use for importing a single known issue by its number",
      "Uses gh CLI authentication when available (run 'gh auth login')",
      "Falls back to GITHUB_TOKEN env var for private repositories without gh CLI",
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
        "User-Agent": "fusion-cli/1.0",
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
        "User-Agent": "fusion-cli/1.0",
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

  // ── kb_task_plan ────────────────────────────────────────────────
  // Create a task via AI-guided planning mode

  pi.registerTool({
    name: "kb_task_plan",
    label: "KB: Plan Task",
    description:
      "Create a task via AI-guided planning mode — interactive conversation to refine your idea into a well-specified task.",
    promptSnippet: "Create a task via AI-guided planning mode",
    promptGuidelines: [
      "Use for breaking down vague ideas into actionable tasks",
      "The AI will ask clarifying questions before creating the task",
    ],
    parameters: Type.Object({
      description: Type.Optional(
        Type.String({
          description: "Initial plan description (optional) — the AI will ask clarifying questions if not provided",
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Import the planning function dynamically to avoid circular dependencies
      const { runTaskPlan } = await import("./commands/task.js");

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
        await runTaskPlan(params.description, true); // Use --yes flag for non-interactive
      } catch (err: any) {
        console.error = originalError;
        console.log = originalLog;
        throw new Error(`Planning mode failed: ${err.message}`);
      } finally {
        console.error = originalError;
        console.log = originalLog;
      }

      // Parse created task ID from logs
      const createdMatch = logs.find((l) => l.match(/Created (KB-\d+):/));
      const taskId = createdMatch ? createdMatch.match(/Created (KB-\d+):/)?.[1] : undefined;

      // Get summary line
      const summaryLine = logs.find((l) => l.includes("✓ Created")) || "Task created";

      return {
        content: [
          {
            type: "text",
            text: summaryLine + (taskId ? `\n\nPlanning session completed. Task ${taskId} is now in triage and will be auto-specified by the AI triage agent.` : ""),
          },
        ],
        details: { taskId, logs },
      };
    },
  });

  // ── Mission Tools ───────────────────────────────────────────────
  // Mission hierarchy management for multi-phase project planning

  // ── kb_mission_create ───────────────────────────────────────────

  pi.registerTool({
    name: "kb_mission_create",
    label: "KB: Create Mission",
    description:
      "Create a new mission — a high-level objective that can span multiple milestones. " +
      "Missions contain milestones that break down work into phases.",
    promptSnippet: "Create a new mission for high-level project planning",
    promptGuidelines: [
      "Use for high-level project objectives that span multiple work phases",
      "Missions are broken down into milestones → slices → features → tasks",
      "Be descriptive so the mission purpose is clear",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Mission title — brief but descriptive" }),
      description: Type.Optional(
        Type.String({ description: "Detailed mission objectives and context" })
      ),
      autoAdvance: Type.Optional(
        Type.Boolean({ description: "Automatically activate the next pending slice when the current slice completes" })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const mission = missionStore.createMission({
        title: params.title.trim(),
        description: params.description?.trim(),
      });

      if (params.autoAdvance !== undefined) {
        missionStore.updateMission(mission.id, { autoAdvance: params.autoAdvance });
      }

      const createdMission = missionStore.getMission(mission.id)!;

      return {
        content: [
          {
            type: "text",
            text: `Created ${createdMission.id}: ${createdMission.title}\nStatus: ${createdMission.status}${createdMission.autoAdvance ? "\nAuto-advance: enabled" : ""}`,
          },
        ],
        details: {
          missionId: createdMission.id,
          title: createdMission.title,
          status: createdMission.status,
          autoAdvance: createdMission.autoAdvance ?? false,
        },
      };
    },
  });

  // ── kb_mission_list ──────────────────────────────────────────────

  pi.registerTool({
    name: "kb_mission_list",
    label: "KB: List Missions",
    description: "List all missions with their current status.",
    promptSnippet: "List all missions",
    promptGuidelines: [
      "Use to see all missions and their current status",
      "Missions are grouped by status (active, planning, complete, etc.)",
      "Use before kb_mission_show to find a specific mission ID",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const missions = missionStore.listMissions();

      if (missions.length === 0) {
        return {
          content: [{ type: "text", text: "No missions yet." }],
          details: { count: 0 },
        };
      }

      const summary = {
        planning: missions.filter((mission) => mission.status === "planning").length,
        active: missions.filter((mission) => mission.status === "active").length,
        blocked: missions.filter((mission) => mission.status === "blocked").length,
        complete: missions.filter((mission) => mission.status === "complete").length,
        archived: missions.filter((mission) => mission.status === "archived").length,
      };

      const lines: string[] = [];
      lines.push(`Missions (${missions.length})`);
      lines.push(
        `Summary: active ${summary.active}, planning ${summary.planning}, blocked ${summary.blocked}, complete ${summary.complete}, archived ${summary.archived}\n`,
      );

      for (const mission of missions) {
        const statusIcon = mission.status === "complete" ? "✓" : mission.status === "active" ? "●" : mission.status === "blocked" ? "⚠" : "○";
        const autoAdvance = mission.autoAdvance ? " · auto-advance" : "";
        lines.push(`  ${statusIcon} ${mission.id}: ${mission.title} (${mission.status}${autoAdvance})`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: missions.length, missions: missions.map((m) => ({ id: m.id, title: m.title, status: m.status })) },
      };
    },
  });

  // ── kb_mission_show ──────────────────────────────────────────────

  pi.registerTool({
    name: "kb_mission_show",
    label: "KB: Show Mission",
    description: "Show mission details with full hierarchy: milestones → slices → features.",
    promptSnippet: "Show mission details with hierarchy",
    promptGuidelines: [
      "Use to see the full mission structure before planning work",
      "Shows milestones, slices, and features in hierarchical order",
      "Check slice status to see if features can be linked to tasks",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Mission ID (e.g., M-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const mission = missionStore.getMissionWithHierarchy(params.id);
      if (!mission) {
        return {
          content: [{ type: "text", text: `Mission ${params.id} not found` }],
          isError: true,
          details: { error: "Mission not found" },
        };
      }

      const lines: string[] = [];
      lines.push(`${mission.id}: ${mission.title}`);
      lines.push(`Status: ${mission.status}`);
      if (mission.description) {
        lines.push(`Description: ${mission.description}`);
      }
      lines.push("");

      if (mission.milestones.length === 0) {
        lines.push("No milestones yet.");
      } else {
        lines.push("Milestones:");
        for (const milestone of mission.milestones) {
          const mIcon = milestone.status === "complete" ? "✓" : milestone.status === "active" ? "●" : "○";
          lines.push(`  ${mIcon} ${milestone.id}: ${milestone.title} (${milestone.status})`);

          for (const slice of milestone.slices) {
            const sIcon = slice.status === "complete" ? "✓" : slice.status === "active" ? "●" : "○";
            lines.push(`    ${sIcon} ${slice.id}: ${slice.title} (${slice.status})`);

            for (const feature of slice.features) {
              const fIcon = feature.status === "done" ? "✓" : feature.status === "in-progress" ? "▸" : feature.status === "triaged" ? "●" : "○";
              const taskLink = feature.taskId ? ` → ${feature.taskId}` : "";
              lines.push(`      ${fIcon} ${feature.id}: ${feature.title} (${feature.status})${taskLink}`);
            }
          }
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { mission },
      };
    },
  });

  // ── kb_mission_delete ───────────────────────────────────────────

  pi.registerTool({
    name: "kb_mission_delete",
    label: "KB: Delete Mission",
    description: "Delete a mission and all its milestones, slices, and features. Cannot be undone.",
    promptSnippet: "Delete a mission and all its contents",
    promptGuidelines: [
      "Use for cleaning up test missions or mistakenly created missions",
      "Permanently deletes all milestones, slices, and features within the mission",
      "Tasks linked to features are NOT deleted — only the feature links are removed",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Mission ID to delete (e.g., M-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const mission = missionStore.getMission(params.id);
      if (!mission) {
        return {
          content: [{ type: "text", text: `Mission ${params.id} not found` }],
          isError: true,
          details: { error: "Mission not found" },
        };
      }

      missionStore.deleteMission(params.id);

      return {
        content: [{ type: "text", text: `Deleted ${params.id}: "${mission.title}"` }],
        details: { missionId: params.id, title: mission.title },
      };
    },
  });

  // ── kb_milestone_add ────────────────────────────────────────────

  pi.registerTool({
    name: "kb_milestone_add",
    label: "KB: Add Milestone",
    description: "Add a milestone to a mission. Milestones represent phases of work.",
    promptSnippet: "Add a milestone to a mission",
    promptGuidelines: [
      "Use to break down a mission into manageable phases",
      "Milestones are ordered and contain slices (work units)",
    ],
    parameters: Type.Object({
      missionId: Type.String({ description: "Parent mission ID (e.g., M-001)" }),
      title: Type.String({ description: "Milestone title" }),
      description: Type.Optional(Type.String({ description: "Milestone description" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const mission = missionStore.getMission(params.missionId);
      if (!mission) {
        return {
          content: [{ type: "text", text: `Mission ${params.missionId} not found` }],
          isError: true,
          details: { error: "Mission not found" },
        };
      }

      const milestone = missionStore.addMilestone(params.missionId, {
        title: params.title.trim(),
        description: params.description?.trim(),
      });

      return {
        content: [
          { type: "text", text: `Added ${milestone.id}: "${milestone.title}" to ${params.missionId}` },
        ],
        details: { milestoneId: milestone.id, missionId: params.missionId, title: milestone.title },
      };
    },
  });

  // ── kb_slice_add ─────────────────────────────────────────────────

  pi.registerTool({
    name: "kb_slice_add",
    label: "KB: Add Slice",
    description: "Add a slice to a milestone. Slices are work units that can be activated for implementation.",
    promptSnippet: "Add a work slice to a milestone",
    promptGuidelines: [
      "Slices represent work units within a milestone",
      "Slices are activated for implementation, linking features to tasks",
      "Order slices by priority — they execute in sequence",
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Parent milestone ID (e.g., MS-001)" }),
      title: Type.String({ description: "Slice title" }),
      description: Type.Optional(Type.String({ description: "Slice description" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const milestone = missionStore.getMilestone(params.milestoneId);
      if (!milestone) {
        return {
          content: [{ type: "text", text: `Milestone ${params.milestoneId} not found` }],
          isError: true,
          details: { error: "Milestone not found" },
        };
      }

      const slice = missionStore.addSlice(params.milestoneId, {
        title: params.title.trim(),
        description: params.description?.trim(),
      });

      return {
        content: [
          { type: "text", text: `Added ${slice.id}: "${slice.title}" to ${params.milestoneId}` },
        ],
        details: { sliceId: slice.id, milestoneId: params.milestoneId, title: slice.title },
      };
    },
  });

  // ── kb_feature_add ────────────────────────────────────────────────

  pi.registerTool({
    name: "kb_feature_add",
    label: "KB: Add Feature",
    description: "Add a feature to a slice. Features are deliverables that can be linked to tasks.",
    promptSnippet: "Add a feature to a slice",
    promptGuidelines: [
      "Features represent deliverables within a slice",
      "Features start as 'defined' and progress through 'triaged' → 'in-progress' → 'done'",
      "Link features to tasks using kb_feature_link_task",
    ],
    parameters: Type.Object({
      sliceId: Type.String({ description: "Parent slice ID (e.g., SL-001)" }),
      title: Type.String({ description: "Feature title" }),
      description: Type.Optional(Type.String({ description: "Feature description" })),
      acceptanceCriteria: Type.Optional(
        Type.String({ description: "Acceptance criteria for completing the feature" })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const slice = missionStore.getSlice(params.sliceId);
      if (!slice) {
        return {
          content: [{ type: "text", text: `Slice ${params.sliceId} not found` }],
          isError: true,
          details: { error: "Slice not found" },
        };
      }

      const feature = missionStore.addFeature(params.sliceId, {
        title: params.title.trim(),
        description: params.description?.trim(),
        acceptanceCriteria: params.acceptanceCriteria?.trim(),
      });

      return {
        content: [
          { type: "text", text: `Added ${feature.id}: "${feature.title}" to ${params.sliceId}` },
        ],
        details: { featureId: feature.id, sliceId: params.sliceId, title: feature.title },
      };
    },
  });

  // ── kb_slice_activate ────────────────────────────────────────────

  pi.registerTool({
    name: "kb_slice_activate",
    label: "KB: Activate Slice",
    description:
      "Activate a pending slice for implementation. " +
      "Sets status to 'active' and enables task linking for its features.",
    promptSnippet: "Activate a slice for implementation",
    promptGuidelines: [
      "Activating a slice allows its features to be linked to tasks",
      "Only pending slices can be activated",
      "Slice activation triggers auto-advance when linked tasks complete",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Slice ID to activate (e.g., SL-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const slice = missionStore.getSlice(params.id);
      if (!slice) {
        return {
          content: [{ type: "text", text: `Slice ${params.id} not found` }],
          isError: true,
          details: { error: "Slice not found" },
        };
      }

      if (slice.status !== "pending") {
        return {
          content: [{ type: "text", text: `Slice ${params.id} is not pending (status: ${slice.status})` }],
          isError: true,
          details: { error: "Slice not pending", currentStatus: slice.status },
        };
      }

      const activated = missionStore.activateSlice(params.id);

      return {
        content: [
          {
            type: "text",
            text: `Activated ${activated.id}: "${activated.title}"\nStatus: ${activated.status}`,
          },
        ],
        details: { sliceId: activated.id, title: activated.title, status: activated.status },
      };
    },
  });

  // ── kb_feature_link_task ──────────────────────────────────────────

  pi.registerTool({
    name: "kb_feature_link_task",
    label: "KB: Link Feature to Task",
    description:
      "Link a feature to a kb task for implementation. " +
      "Updates the feature status to 'triaged' and associates it with the task.",
    promptSnippet: "Link a feature to a task",
    promptGuidelines: [
      "Use when a feature is ready for implementation and has a corresponding task",
      "The feature's slice must be active to link tasks",
      "Linking updates the feature status to 'triaged'",
      "When the linked task moves to 'done', the feature status becomes 'done'",
    ],
    parameters: Type.Object({
      featureId: Type.String({ description: "Feature ID to link (e.g., F-001)" }),
      taskId: Type.String({ description: "Task ID to link to (e.g., KB-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const feature = missionStore.getFeature(params.featureId);
      if (!feature) {
        return {
          content: [{ type: "text", text: `Feature ${params.featureId} not found` }],
          isError: true,
          details: { error: "Feature not found" },
        };
      }

      // Check if task exists
      try {
        await store.getTask(params.taskId);
      } catch {
        return {
          content: [{ type: "text", text: `Task ${params.taskId} not found` }],
          isError: true,
          details: { error: "Task not found" },
        };
      }

      const updated = missionStore.linkFeatureToTask(params.featureId, params.taskId);
      await store.updateTask(params.taskId, { sliceId: feature.sliceId });

      return {
        content: [
          {
            type: "text",
            text: `Linked ${updated.id}: "${updated.title}" → ${params.taskId}\nStatus: ${updated.status}`,
          },
        ],
        details: { featureId: updated.id, taskId: params.taskId, title: updated.title, status: updated.status },
      };
    },
  });

  // ── /fn command — start the dashboard + engine ───────────────────

  let dashboardProcess: ChildProcess | null = null;
  let dashboardPort: number | null = null;

  pi.registerCommand("fn", {
    description: "Start (or stop) the Fusion dashboard and AI engine",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();

      // /fn stop — kill the dashboard
      if (trimmed === "stop") {
        if (dashboardProcess) {
          dashboardProcess.kill("SIGINT");
          dashboardProcess = null;
          dashboardPort = null;
          ctx.ui.setStatus("fn", "");
          ctx.ui.notify("Fusion dashboard stopped", "info");
        } else {
          ctx.ui.notify("Fusion dashboard is not running", "warning");
        }
        return;
      }

      // /fn status
      if (trimmed === "status") {
        if (dashboardProcess && !dashboardProcess.killed) {
          ctx.ui.notify(`Fusion dashboard running on http://localhost:${dashboardPort}`, "info");
        } else {
          dashboardProcess = null;
          dashboardPort = null;
          ctx.ui.notify("Fusion dashboard is not running", "info");
        }
        return;
      }

      // /fn [port] — start the dashboard
      if (dashboardProcess && !dashboardProcess.killed) {
        ctx.ui.notify(
          `Fusion dashboard already running on http://localhost:${dashboardPort}. Use /fn stop first.`,
          "warning",
        );
        return;
      }

      const port = trimmed ? parseInt(trimmed, 10) || 4040 : 4040;

      // Find the fn binary: prefer local node_modules, then global
      const child = spawn("fn", ["dashboard", "--port", String(port)], {
        cwd: ctx.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        env: { ...process.env },
      });

      dashboardProcess = child;
      dashboardPort = port;

      // Watch for early exit (e.g. fn not found)
      child.on("error", (err) => {
        dashboardProcess = null;
        dashboardPort = null;
        ctx.ui.setStatus("fn", "");
        ctx.ui.notify(`Failed to start Fusion dashboard: ${err.message}`, "error");
      });

      child.on("exit", (code) => {
        if (dashboardProcess === child) {
          dashboardProcess = null;
          dashboardPort = null;
          ctx.ui.setStatus("fn", "");
          if (code !== 0 && code !== null) {
            ctx.ui.notify(`Fusion dashboard exited with code ${code}`, "warning");
          }
        }
      });

      // Wait briefly to see if it crashes immediately
      await new Promise((r) => setTimeout(r, 500));

      if (dashboardProcess && !dashboardProcess.killed) {
        const url = `http://localhost:${port}`;
        ctx.ui.notify(`Fusion dashboard started on ${url} (AI engine active)`, "info");
        const link = `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;
        ctx.ui.setStatus("fn", `Fusion ● ${link}`);
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
