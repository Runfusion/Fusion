import type { PluginContext, PluginRouteDefinition } from "@fusion/plugin-sdk";
import { AsyncQualityStore } from "../store/async-quality-store.js";
import { isQualityPresetId, listPresetCatalog, resolvePresetCommand } from "../runner/command-presets.js";
import { cancelQualityRun, defaultTimeoutMs, executeQualityRun } from "../runner/command-runner.js";
import { getAllowRootFallback, getDefaultPreviewScript, getLogTruncateKb, getRunRetentionCount } from "../settings.js";
import { buildHeuristicSuggestedCases } from "../suggestions/heuristic-cases.js";
import type { QualityPresetId } from "../store/quality-types.js";
import { createPreviewSessionManager } from "../preview/preview-sessions.js";
import { resolveTaskCodeCwd } from "../preview/task-code-worktree.js";

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

const qualityStoreCache = new WeakMap<object, AsyncQualityStore>();

function getStore(ctx: PluginContext): AsyncQualityStore {
  const key = ctx.taskStore as object;
  const cached = qualityStoreCache.get(key);
  if (cached) return cached;
  const asyncLayer = ctx.taskStore.getAsyncLayer();
  if (!asyncLayer) throw new Error("Quality plugin requires ctx.taskStore.getAsyncLayer() / PostgreSQL AsyncDataLayer");
  const store = new AsyncQualityStore(asyncLayer);
  qualityStoreCache.set(key, store);
  return store;
}

function httpError(status: number, message: string): never {
  const err = new Error(message) as Error & { statusCode?: number };
  err.statusCode = status;
  throw err;
}

const previewManager = createPreviewSessionManager();

const QUALITY_EXPERIMENTAL_FLAG = "qualityPlugin";

/*
FNXC:Quality 2026-07-15-23:17:
TaskStore.getSettings() is always async and returns merged global+project settings
(including global experimentalFeatures). Calling it without await made the return
value a Promise; experimentalFeatures was always undefined, so every Quality route
hard-failed even after the operator enabled Settings → Experimental → Quality Plugin.
*/
export async function loadTaskStoreSettings(ctx: PluginContext): Promise<Record<string, unknown>> {
  const getSettings = (ctx.taskStore as { getSettings?: () => unknown }).getSettings;
  if (typeof getSettings !== "function") return {};
  try {
    const result = getSettings.call(ctx.taskStore);
    if (result != null && typeof (result as PromiseLike<unknown>).then === "function") {
      const resolved = await (result as Promise<unknown>);
      return resolved && typeof resolved === "object" && !Array.isArray(resolved)
        ? (resolved as Record<string, unknown>)
        : {};
    }
    return result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function requireQualityExperimental(ctx: PluginContext): Promise<void> {
  const settings = await loadTaskStoreSettings(ctx);
  const features = settings.experimentalFeatures;
  const enabled =
    features && typeof features === "object" && !Array.isArray(features)
      ? (features as Record<string, unknown>)[QUALITY_EXPERIMENTAL_FLAG] === true
      : false;
  if (!enabled) {
    httpError(404, "Quality plugin is experimental; enable experimentalFeatures.qualityPlugin to use it");
  }
}

function asHttpError(err: unknown): { statusCode: number; message: string } | null {
  if (!(err instanceof Error)) return null;
  const statusCode = (err as Error & { statusCode?: unknown }).statusCode;
  if (typeof statusCode !== "number" || !Number.isFinite(statusCode)) return null;
  return { statusCode, message: err.message };
}

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
  const routes: PluginRouteDefinition[] = [
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
        return { runs: await store.listRuns(projectId, { taskId, limit }) };
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
        const run = await getStore(ctx).getRun(projectId, runId);
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
        const active = await store.findActiveRun(projectId, taskId);
        if (active) {
          httpError(409, `A run is already active (${active.id})`);
        }

        // Resolve cwd server-side
        const rootDir = ctx.taskStore.getRootDir?.() ?? process.cwd();
        let cwd = rootDir;
        let cwdKind: "project-root" | "worktree" | "qa-worktree" = "project-root";
        let filePaths: string[] = [];

        if (taskId) {
          let task: {
            id: string;
            worktree?: string;
            branch?: string;
            modifiedFiles?: string[];
            title?: string;
            mergeDetails?: { commitSha?: string };
          };
          try {
            task = (await ctx.taskStore.getTask(taskId)) as {
              id: string;
              worktree?: string;
              branch?: string;
              modifiedFiles?: string[];
              title?: string;
              mergeDetails?: { commitSha?: string };
            };
          } catch {
            httpError(404, "Task not found");
          }
          /*
          FNXC:Quality 2026-07-15-23:23:
          Task-scoped runs (including done tasks) must execute in the task's code.
          Prefer the live worktree; otherwise create a disposable QA worktree at
          the task branch/merge commit. Project-root fallback remains opt-in only.
          */
          try {
            const resolvedCwd = await resolveTaskCodeCwd({ task, projectRoot: rootDir });
            cwd = resolvedCwd.cwd;
            cwdKind = resolvedCwd.cwdKind;
          } catch (err) {
            if (getAllowRootFallback(ctx.settings as Record<string, unknown>)) {
              cwd = rootDir;
              cwdKind = "project-root";
            } else {
              const message = err instanceof Error ? err.message : String(err);
              const status =
                err instanceof Error && typeof (err as Error & { statusCode?: number }).statusCode === "number"
                  ? (err as Error & { statusCode: number }).statusCode
                  : 400;
              httpError(status, message);
            }
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

        const settings = await loadTaskStoreSettings(ctx);
        const testCommand = typeof settings.testCommand === "string" ? settings.testCommand : undefined;
        const verificationCommandTimeoutMs =
          typeof settings.verificationCommandTimeoutMs === "number"
            ? settings.verificationCommandTimeoutMs
            : undefined;
        const resolved = resolvePresetCommand({
          preset,
          testCommand,
          projectRoot: rootDir,
          filePaths,
          confirmFullSuite,
        });
        if (!resolved.ok) {
          const status = resolved.code === "confirm_required" ? 400 : 400;
          httpError(status, resolved.reason);
        }

        const timeoutMs = defaultTimeoutMs(verificationCommandTimeoutMs);
        const run = await store.createRun({
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
          .then(async () => {
            await store.pruneRuns(projectId, getRunRetentionCount(ctx.settings as Record<string, unknown>));
          })
          .catch(async (err) => {
            ctx.logger?.warn?.(
              `Quality run ${run.id} failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            await store.updateRun(projectId, run.id, {
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
        const run = await store.getRun(projectId, runId);
        if (!run) httpError(404, "Run not found");
        if (run.status !== "queued" && run.status !== "running") {
          return { run };
        }
        const updated = await cancelQualityRun(store, projectId, runId);
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
        return { plans: await getStore(ctx).listPlans(projectId) };
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
        const plan = await getStore(ctx).createPlan({ projectId, name, steps });
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
        const existing = await getStore(ctx).getSuggestedCases(projectId, taskId);
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
        const snapshot = await getStore(ctx).saveSuggestedCases({
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
        let task: {
          id?: string;
          worktree?: string;
          branch?: string;
          mergeDetails?: { commitSha?: string };
        };
        try {
          task = (await ctx.taskStore.getTask(taskId)) as {
            id?: string;
            worktree?: string;
            branch?: string;
            mergeDetails?: { commitSha?: string };
          };
        } catch {
          httpError(404, "Task not found");
        }
        /*
        FNXC:Quality 2026-07-15-23:23:
        Done tasks usually have no live worktree. Create/reuse a disposable QA
        worktree checked out at the task branch or merge commit so the preview
        server runs the done task's code, not project root/mainline.
        */
        const projectRoot = ctx.taskStore.getRootDir?.() ?? process.cwd();
        const resolvedCwd = await resolveTaskCodeCwd({
          task: { id: task.id ?? taskId, worktree: task.worktree, branch: task.branch, mergeDetails: task.mergeDetails },
          projectRoot,
        });
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
          cwd: resolvedCwd.cwd,
          cwdKind: resolvedCwd.cwdKind,
          ref: resolvedCwd.ref,
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
  return routes.map((route) => ({
    ...route,
    handler: async (req, ctx) => {
      /*
      FNXC:Quality 2026-07-15-14:10:
      The Quality plugin is an opt-in experiment. Gate every route at the
      server boundary so installed bundles cannot run commands until a global
      operator explicitly enables experimentalFeatures.qualityPlugin.

      FNXC:Quality 2026-07-15-23:17:
      Await the experimental gate (async settings) and map statusCode-bearing
      errors to PluginRouteResponse. Dashboard catchHandler only preserves status
      for ApiError instances; plain Error+statusCode was collapsed to HTTP 500,
      so every gated Quality call looked like a hard failure.
      */
      try {
        await requireQualityExperimental(ctx);
        return await route.handler(req, ctx);
      } catch (err) {
        const http = asHttpError(err);
        if (http) {
          return { status: http.statusCode, body: { error: http.message } };
        }
        throw err;
      }
    },
  }));
}
