import type { PluginContext, PluginRouteDefinition } from "@fusion/plugin-sdk";
import type { Database } from "@fusion/core";
import { ensureQualitySchema } from "../quality-schema.js";
import { QualityStore } from "../store/quality-store.js";
import { isQualityPresetId, listPresetCatalog, resolvePresetCommand } from "../runner/command-presets.js";
import { cancelQualityRun, defaultTimeoutMs, executeQualityRun } from "../runner/command-runner.js";
import { getAllowRootFallback, getDefaultPreviewScript, getLogTruncateKb, getRunRetentionCount } from "../settings.js";
import { buildHeuristicSuggestedCases } from "../suggestions/heuristic-cases.js";
import type { QualityPresetId } from "../store/quality-types.js";
import { createPreviewSessionManager } from "../preview/preview-sessions.js";

/*
FNXC:Quality 2026-07-14-21:45:
Plugin routes under /api/plugins/fusion-plugin-quality/*.
Security: require projectId; server-only preset resolution; reject client command/cwd/argv.
*/

type Req = {
  method?: string;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
};

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function requireProjectId(req: Req): string {
  const q = typeof req.query?.projectId === "string" ? req.query.projectId.trim() : "";
  const body = asRecord(req.body);
  const b = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const id = q || b;
  if (!id) {
    const err = new Error("projectId is required") as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }
  return id;
}

function getDb(ctx: PluginContext): Database {
  // Prefer sync database when available (SQLite / sync facade).
  return ctx.taskStore.getDatabase();
}

function getStore(ctx: PluginContext): QualityStore {
  const db = getDb(ctx);
  ensureQualitySchema(db);
  return new QualityStore(db);
}

function httpError(status: number, message: string): never {
  const err = new Error(message) as Error & { statusCode?: number };
  err.statusCode = status;
  throw err;
}

const previewManager = createPreviewSessionManager();

/*
FNXC:Quality 2026-07-15-13:05:
Test plans are execution contracts: silently dropping an unknown requested
preset makes a successful API response misrepresent the plan that was saved.
Reject the entire request unless every supplied step is allowlisted.
*/
export function validatePlanSteps(stepsRaw: unknown[]): QualityPresetId[] {
  if (stepsRaw.length === 0) httpError(400, "steps must include at least one known preset");
  const invalid = stepsRaw.filter((step) => !isQualityPresetId(step));
  if (invalid.length > 0) {
    httpError(400, `Unknown plan steps: ${invalid.map(String).join(", ")}`);
  }
  return stepsRaw as QualityPresetId[];
}

export function createQualityRoutes(): PluginRouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/presets",
      description: "List allowlisted Quality test presets",
      handler: async () => ({ presets: listPresetCatalog() }),
    },
    {
      method: "GET",
      path: "/runs",
      description: "List Quality test runs for a project",
      handler: async (req, ctx) => {
        const r = req as Req;
        const projectId = requireProjectId(r);
        const store = getStore(ctx);
        const taskId = typeof r.query?.taskId === "string" ? r.query.taskId : undefined;
        const limit = typeof r.query?.limit === "string" ? Number(r.query.limit) : 50;
        return { runs: store.listRuns(projectId, { taskId, limit }) };
      },
    },
    {
      method: "GET",
      path: "/runs/:runId",
      description: "Get a single Quality test run",
      handler: async (req, ctx) => {
        const r = req as Req;
        const projectId = requireProjectId(r);
        const runId = r.params?.runId;
        if (!runId) httpError(400, "runId required");
        const run = getStore(ctx).getRun(projectId, runId);
        if (!run) httpError(404, "Run not found");
        return { run };
      },
    },
    {
      method: "POST",
      path: "/runs",
      description: "Start an allowlisted Quality test run",
      handler: async (req, ctx) => {
        const r = req as Req;
        const body = asRecord(r.body);
        // Reject free-form execution inputs
        if ("command" in body || "argv" in body || "cwd" in body || "shell" in body) {
          httpError(400, "command/argv/cwd/shell overrides are not allowed");
        }
        const projectId = requireProjectId(r);
        if (!isQualityPresetId(body.preset)) {
          httpError(400, "preset must be a known Quality preset id");
        }
        const preset = body.preset as QualityPresetId;
        const taskId = typeof body.taskId === "string" ? body.taskId.trim() : undefined;
        const confirmFullSuite = body.confirmFullSuite === true;
        const source = body.source === "hub" ? "hub" : "task-tab";

        const store = getStore(ctx);
        const active = store.findActiveRun(projectId, taskId);
        if (active) {
          httpError(409, `A run is already active (${active.id})`);
        }

        // Resolve cwd server-side
        const rootDir = ctx.taskStore.getRootDir?.() ?? process.cwd();
        let cwd = rootDir;
        let cwdKind: "project-root" | "worktree" = "project-root";
        let filePaths: string[] = [];

        if (taskId) {
          let task: { id: string; worktree?: string; modifiedFiles?: string[]; title?: string };
          try {
            task = (await ctx.taskStore.getTask(taskId)) as {
              id: string;
              worktree?: string;
              modifiedFiles?: string[];
              title?: string;
            };
          } catch {
            httpError(404, "Task not found");
          }
          const worktree = typeof task.worktree === "string" ? task.worktree.trim() : "";
          if (worktree) {
            cwd = worktree;
            cwdKind = "worktree";
          } else if (!getAllowRootFallback(ctx.settings as Record<string, unknown>)) {
            httpError(400, "Task has no worktree; start/checkout the task first");
          }
          filePaths = Array.isArray(task.modifiedFiles)
            ? task.modifiedFiles.filter((p): p is string => typeof p === "string")
            : [];
        } else if (source === "task-tab") {
          httpError(400, "taskId is required for task-tab runs");
        }

        // Optional filePaths only for server enrichment when provided as string[] of relative paths
        if (Array.isArray(body.filePaths) && filePaths.length === 0) {
          filePaths = body.filePaths.filter((p): p is string => typeof p === "string");
        }

        const settings = (typeof (ctx.taskStore as { getSettings?: () => unknown }).getSettings === "function"
          ? (ctx.taskStore as { getSettings: () => unknown }).getSettings()
          : {}) as { testCommand?: string; verificationCommandTimeoutMs?: number };
        const resolved = resolvePresetCommand({
          preset,
          testCommand: settings.testCommand,
          projectRoot: rootDir,
          filePaths,
          confirmFullSuite,
        });
        if (!resolved.ok) {
          const status = resolved.code === "confirm_required" ? 400 : 400;
          httpError(status, resolved.reason);
        }

        const timeoutMs = defaultTimeoutMs(settings.verificationCommandTimeoutMs);
        const run = store.createRun({
          projectId,
          taskId,
          source,
          presetId: preset,
          command: resolved.command,
          cwd,
          cwdKind,
          timeoutMs,
          triggeredBy: "operator",
        });

        // Detach execution — do not block the HTTP response on full suite runtime
        void executeQualityRun({
          store,
          projectId,
          runId: run.id,
          command: resolved.command,
          cwd,
          timeoutMs,
          logTruncateKb: getLogTruncateKb(ctx.settings as Record<string, unknown>),
        })
          .then(() => {
            store.pruneRuns(projectId, getRunRetentionCount(ctx.settings as Record<string, unknown>));
          })
          .catch((err) => {
            ctx.logger?.warn?.(
              `Quality run ${run.id} failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            store.updateRun(projectId, run.id, {
              status: "error",
              errorMessage: err instanceof Error ? err.message : String(err),
              finishedAt: new Date().toISOString(),
            });
          });

        return { run, detached: true };
      },
    },
    {
      method: "POST",
      path: "/runs/:runId/cancel",
      description: "Mark a queued/running run cancelled (best-effort)",
      handler: async (req, ctx) => {
        const r = req as Req;
        const projectId = requireProjectId(r);
        const runId = r.params?.runId;
        if (!runId) httpError(400, "runId required");
        const store = getStore(ctx);
        const run = store.getRun(projectId, runId);
        if (!run) httpError(404, "Run not found");
        if (run.status !== "queued" && run.status !== "running") {
          return { run };
        }
        const updated = cancelQualityRun(store, projectId, runId);
        return { run: updated };
      },
    },
    {
      method: "GET",
      path: "/plans",
      description: "List test plans",
      handler: async (req, ctx) => {
        const r = req as Req;
        const projectId = requireProjectId(r);
        return { plans: getStore(ctx).listPlans(projectId) };
      },
    },
    {
      method: "POST",
      path: "/plans",
      description: "Create a test plan",
      handler: async (req, ctx) => {
        const r = req as Req;
        const projectId = requireProjectId(r);
        const body = asRecord(r.body);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) httpError(400, "name is required");
        const steps = validatePlanSteps(Array.isArray(body.steps) ? body.steps : []);
        const plan = getStore(ctx).createPlan({ projectId, name, steps });
        return { plan };
      },
    },
    {
      method: "GET",
      path: "/suggestions/:taskId",
      description: "Get suggested test cases for a task",
      handler: async (req, ctx) => {
        const r = req as Req;
        const projectId = requireProjectId(r);
        const taskId = r.params?.taskId;
        if (!taskId) httpError(400, "taskId required");
        const existing = getStore(ctx).getSuggestedCases(projectId, taskId);
        return { suggestions: existing };
      },
    },
    {
      method: "POST",
      path: "/suggestions/:taskId/generate",
      description: "Generate heuristic suggested test cases",
      handler: async (req, ctx) => {
        const r = req as Req;
        const projectId = requireProjectId(r);
        const taskId = r.params?.taskId;
        if (!taskId) httpError(400, "taskId required");
        let task: { title?: string; prompt?: string; description?: string; modifiedFiles?: string[] };
        try {
          task = (await ctx.taskStore.getTask(taskId)) as {
            title?: string;
            prompt?: string;
            description?: string;
            modifiedFiles?: string[];
          };
        } catch {
          httpError(404, "Task not found");
        }
        const body = asRecord(r.body);
        const prompt =
          typeof body.prompt === "string"
            ? body.prompt
            : (task.prompt ?? task.description ?? "");
        const cases = buildHeuristicSuggestedCases({
          title: task.title,
          prompt,
          filePaths: Array.isArray(task.modifiedFiles)
            ? task.modifiedFiles.filter((p): p is string => typeof p === "string")
            : [],
        });
        const snapshot = getStore(ctx).saveSuggestedCases({
          projectId,
          taskId,
          cases,
          generatedAt: new Date().toISOString(),
          method: "heuristic",
        });
        return { suggestions: snapshot };
      },
    },
    {
      method: "GET",
      path: "/preview/:taskId",
      description: "Get task preview server session",
      handler: async (req) => {
        const r = req as Req;
        const projectId = requireProjectId(r);
        const taskId = r.params?.taskId;
        if (!taskId) httpError(400, "taskId required");
        return { session: previewManager.get(projectId, taskId) };
      },
    },
    {
      method: "POST",
      path: "/preview/:taskId/start",
      description: "Start task-scoped preview server",
      handler: async (req, ctx) => {
        const r = req as Req;
        const projectId = requireProjectId(r);
        const taskId = r.params?.taskId;
        if (!taskId) httpError(400, "taskId required");
        let task: { worktree?: string };
        try {
          task = (await ctx.taskStore.getTask(taskId)) as { worktree?: string };
        } catch {
          httpError(404, "Task not found");
        }
        const worktree = typeof task.worktree === "string" ? task.worktree.trim() : "";
        if (!worktree) httpError(400, "Task has no worktree");
        const body = asRecord(r.body);
        if ("command" in body && typeof body.command === "string") {
          // Only allow simple package script names, not free shell
          if (!/^[a-zA-Z0-9:_-]+$/.test(body.command.trim())) {
            httpError(400, "preview command must be a package script name");
          }
        }
        const script =
          typeof body.command === "string" && body.command.trim()
            ? body.command.trim()
            : getDefaultPreviewScript(ctx.settings as Record<string, unknown>);
        const session = await previewManager.start({
          projectId,
          taskId,
          cwd: worktree,
          script,
        });
        return { session };
      },
    },
    {
      method: "POST",
      path: "/preview/:taskId/stop",
      description: "Stop task-scoped preview server",
      handler: async (req) => {
        const r = req as Req;
        const projectId = requireProjectId(r);
        const taskId = r.params?.taskId;
        if (!taskId) httpError(400, "taskId required");
        const session = await previewManager.stop(projectId, taskId);
        return { session };
      },
    },
  ];
}
