import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Request, Response } from "express";
import { superviseSpawn, AgentStore } from "@fusion/core";
import { ApiError, badRequest, notFound } from "../api-error.js";
import { writeSSEEvent } from "../sse-buffer.js";
import type { ApiRoutesContext } from "./types.js";
import type { SystemLogEntry } from "../server.js";

/*
FNXC:SystemPanel 2026-07-12-11:20:
Operator "System panel" API (Command Center → System tab). Gives operators
in-dashboard debug/maintenance controls:
  - GET  /system/info                 capability discovery (what the host process supports)
  - POST /system/restart              graceful process restart via the supervising parent
  - POST /system/rebuild              workspace/plugin rebuild job with streamed output,
                                      optional restart-on-success
  - GET  /system/rebuild/current      snapshot of the active/last rebuild job
  - GET  /system/jobs/:id/stream      SSE live output of a rebuild job (replays buffered lines)
  - GET  /system/logs                 recent host-process log entries (ring buffer)
  - GET  /system/logs/stream          SSE live tail of host-process logs
  - POST /system/engine/restart       bounce all running project engines in-process
  - POST /system/agents/restart-all   pause+resume every active agent (stops active runs)
  - POST /system/plugins/reload-all   hot-reload every started plugin

Restart/rebuild only work when the host CLI injected `systemControl`
(supervised process + source checkout); every route degrades to an explicit
409 with a reason instead of failing silently, so the UI can disable controls.
Rebuild jobs are serialized — one at a time — because concurrent workspace
builds would corrupt each other's dist output.
*/

const JOB_LINE_CAP = 4_000;
const REBUILD_MAX_LIFETIME_MS = 30 * 60_000;

/*
FNXC:SystemPanel 2026-07-12-14:05:
SSE heartbeat interval. The shared client sse-bus force-reconnects a stream
that goes silent for ~45s; each reconnect re-runs the route's replay-on-connect
(the last N log lines / job lines), which surfaced as the log tail duplicating
every entry. A periodic comment-frame heartbeat keeps the stream "live" so
steady-state reconnects don't happen. Cleared on client disconnect / job end.
*/
const SSE_HEARTBEAT_MS = 25_000;

/*
FNXC:SystemPanel 2026-07-12-14:05:
Same-origin CSRF guard for the mutating /system/* POSTs. These are privileged
operator actions (restart, rebuild, engine/agent bounce, plugin reload) and must
stay safe even when bearer auth is off — `--no-auth`, and the desktop embedded
server which runs unauthenticated on a random localhost port where a malicious
web page can reach it via DNS-rebinding / localhost port-scan. A same-origin
dashboard fetch sends an Origin matching Host; a cross-origin browser attack
sends a mismatched Origin; a CLI/curl call sends none. Reject only a present,
mismatched Origin so legitimate same-origin and non-browser callers pass.
Returns true (and responds 403) when the request was rejected.
*/
function rejectCrossOrigin(req: Request, res: Response): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    res.status(403).json({ error: "Invalid Origin header" });
    return true;
  }
  if (originHost !== req.headers.host) {
    res.status(403).json({ error: "Cross-origin request rejected" });
    return true;
  }
  return false;
}

function startSseHeartbeat(res: Response): () => void {
  const timer = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      // Stream already closed; the close handler clears this timer.
    }
  }, SSE_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

type RebuildScope = "app" | "full" | "plugins";

interface SystemJobLine {
  i: number;
  ts: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

interface SystemJob {
  id: string;
  kind: "rebuild";
  scope: RebuildScope;
  restartAfter: boolean;
  status: "running" | "succeeded" | "failed";
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  error?: string;
  restartScheduled?: boolean;
  pluginsReloaded?: string[];
  droppedLines: number;
  lines: SystemJobLine[];
  subscribers: Set<Response>;
}

let activeJob: SystemJob | null = null;
let lastJob: SystemJob | null = null;
const jobsById = new Map<string, SystemJob>();

/** Test-only: clear module-level job state between tests. */
export function __resetSystemJobsForTests(): void {
  activeJob = null;
  lastJob = null;
  jobsById.clear();
}

function jobSnapshot(job: SystemJob, includeLines: boolean): Record<string, unknown> {
  return {
    id: job.id,
    kind: job.kind,
    scope: job.scope,
    restartAfter: job.restartAfter,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    error: job.error,
    restartScheduled: job.restartScheduled,
    pluginsReloaded: job.pluginsReloaded,
    droppedLines: job.droppedLines,
    lineCount: job.droppedLines + job.lines.length,
    ...(includeLines ? { lines: job.lines } : {}),
  };
}

function appendJobLine(job: SystemJob, stream: SystemJobLine["stream"], text: string): void {
  const line: SystemJobLine = {
    i: job.droppedLines + job.lines.length,
    ts: Date.now(),
    stream,
    text,
  };
  job.lines.push(line);
  if (job.lines.length > JOB_LINE_CAP) {
    job.droppedLines += job.lines.length - JOB_LINE_CAP;
    job.lines.splice(0, job.lines.length - JOB_LINE_CAP);
  }
  for (const res of job.subscribers) {
    writeSSEEvent(res, "line", JSON.stringify(line), line.i);
  }
}

function finishJob(job: SystemJob, status: "succeeded" | "failed", extra: Partial<SystemJob> = {}): void {
  job.status = status;
  job.finishedAt = Date.now();
  Object.assign(job, extra);
  if (activeJob === job) {
    activeJob = null;
    lastJob = job;
  }
  for (const res of job.subscribers) {
    writeSSEEvent(res, "end", JSON.stringify(jobSnapshot(job, false)));
    try {
      res.end();
    } catch {
      // Already closed.
    }
  }
  job.subscribers.clear();
}

/** Split a chunked stream into lines, keeping partials until the next chunk. */
function createLineSplitter(onLine: (text: string) => void): { push(chunk: Buffer | string): void; flush(): void } {
  let partial = "";
  return {
    push(chunk) {
      partial += chunk.toString();
      const parts = partial.split(/\r?\n/);
      partial = parts.pop() ?? "";
      for (const part of parts) onLine(part);
    },
    flush() {
      if (partial.length > 0) {
        onLine(partial);
        partial = "";
      }
    },
  };
}

interface SystemRouteDeps {
  hasHeartbeatExecutor: boolean;
  heartbeatMonitor: import("../server.js").ServerOptions["heartbeatMonitor"];
  isHeartbeatMonitorForProject: (scopedStore: import("@fusion/core").TaskStore) => boolean;
  resolveHeartbeatMonitor: (scopedStore: import("@fusion/core").TaskStore) => import("../server.js").ServerOptions["heartbeatMonitor"];
}

interface AgentLifecycleMonitor {
  pauseAgent?: (agentId: string, options?: { pauseReason?: string; stopActiveRun?: boolean }) => Promise<unknown>;
  resumeAgent?: (agentId: string, options?: { triggerDetail?: string; triggerSource?: string; clearPauseReason?: boolean }) => Promise<unknown>;
}

export function registerSystemRoutes(ctx: ApiRoutesContext, deps: SystemRouteDeps): void {
  const { router, options, runtimeLogger, getProjectContext, rethrowAsApiError } = ctx;
  const log = runtimeLogger.child("system");
  const systemControl = options?.systemControl;
  const systemLogs = options?.systemLogs;

  const rebuildScopes: Record<RebuildScope, { args: string[]; label: string }> = {
    // Keep in sync with the `pnpm dev dashboard` client prebuild — same scripts.
    app: { args: ["scripts/dev-prebuild-client.mjs"], label: "core + engine + dashboard + changed plugins" },
    full: { args: ["scripts/build-workspace.mjs"], label: "full workspace" },
    plugins: { args: ["scripts/build-workspace.mjs", "--plugins-only"], label: "changed plugins" },
  };

  const reloadStartedPlugins = async (): Promise<{ reloaded: string[]; failed: Array<{ id: string; error: string }> }> => {
    const pluginStore = ctx.store.getPluginStore();
    const reloadPlugin = options?.pluginRunner?.reloadPlugin;
    if (!reloadPlugin) {
      throw new ApiError(409, "Plugin runner not available in this mode");
    }
    const plugins = await pluginStore.listPlugins();
    const reloaded: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const plugin of plugins) {
      if (plugin.state !== "started") continue;
      try {
        await reloadPlugin(plugin.id);
        reloaded.push(plugin.id);
      } catch (err) {
        failed.push({ id: plugin.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { reloaded, failed };
  };

  /** GET /api/system/info — capability discovery for the System panel. */
  router.get("/system/info", (_req, res) => {
    res.json({
      supervised: systemControl?.supervised ?? false,
      restartSupported: systemControl?.supervised ?? false,
      rebuildSupported: Boolean(systemControl?.sourceWorkspaceRoot),
      sourceWorkspaceRoot: systemControl?.sourceWorkspaceRoot,
      logsSupported: Boolean(systemLogs),
      // Engine restart needs both the manager and CentralCore (see the
      // /system/engine/restart guard), so advertise availability on both.
      engineAvailable: Boolean(options?.engineManager) && Boolean(options?.centralCore),
      pluginReloadSupported: Boolean(options?.pluginRunner?.reloadPlugin),
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      memoryRssBytes: process.memoryUsage().rss,
      activeRebuild: activeJob ? jobSnapshot(activeJob, false) : null,
      lastRebuild: lastJob ? jobSnapshot(lastJob, false) : null,
    });
  });

  /** POST /api/system/restart — graceful restart via the supervising parent. */
  router.post("/system/restart", (req, res) => {
    if (rejectCrossOrigin(req, res)) return;
    if (!systemControl) {
      throw new ApiError(409, "Restart is not available: host process did not wire system control");
    }
    // Sanitize the client-supplied reason before it reaches host logs: strip
    // control chars/newlines (log injection) and bound the length.
    const rawReason = (req.body as { reason?: unknown })?.reason;
    const reason = (typeof rawReason === "string" ? rawReason : "operator-request")
      // eslint-disable-next-line no-control-regex -- deliberately strip C0 control chars (log injection)
      .replace(/[\r\n -]+/g, " ")
      .slice(0, 200);
    const accepted = systemControl.requestRestart(reason);
    if (!accepted) {
      throw new ApiError(
        409,
        "Restart is not available: no supervising parent. Start via `pnpm dev` or `fn dashboard --supervise`.",
      );
    }
    log.info("System restart scheduled", { reason });
    res.status(202).json({ scheduled: true });
  });

  /** POST /api/system/rebuild — start a rebuild job. Body: { scope?, restart? } */
  router.post("/system/rebuild", (req, res) => {
    if (rejectCrossOrigin(req, res)) return;
    const root = systemControl?.sourceWorkspaceRoot;
    if (!root) {
      throw new ApiError(409, "Rebuild is only available when running from a Fusion source checkout");
    }
    if (activeJob) {
      throw new ApiError(409, `A ${activeJob.scope} rebuild is already running`);
    }

    const body = (req.body ?? {}) as { scope?: unknown; restart?: unknown };
    const scope = (body.scope ?? "app") as RebuildScope;
    // Object.hasOwn (not `in`) so prototype keys like "constructor"/"toString"
    // are rejected instead of passing validation and crashing on lookup.
    if (typeof scope !== "string" || !Object.hasOwn(rebuildScopes, scope)) {
      throw badRequest(`Invalid scope "${String(body.scope)}". Expected one of: app, full, plugins.`);
    }
    const restartAfter = body.restart !== false && scope !== "plugins";
    const { args, label } = rebuildScopes[scope];
    const scriptPath = join(root, args[0]);
    if (!existsSync(scriptPath)) {
      throw new ApiError(409, `Build script missing: ${scriptPath}`);
    }

    const job: SystemJob = {
      id: randomUUID(),
      kind: "rebuild",
      scope,
      restartAfter,
      status: "running",
      startedAt: Date.now(),
      droppedLines: 0,
      lines: [],
      subscribers: new Set(),
    };
    activeJob = job;
    jobsById.set(job.id, job);
    // Bound the job registry — keep only the most recent handful.
    if (jobsById.size > 5) {
      const oldest = jobsById.keys().next().value;
      if (oldest && oldest !== job.id) jobsById.delete(oldest);
    }

    appendJobLine(job, "system", `Starting ${label} build (${scope})…`);
    log.info("System rebuild started", { jobId: job.id, scope, restartAfter });

    let child: ReturnType<typeof superviseSpawn>;
    try {
      child = superviseSpawn(process.execPath, args.map((a, i) => (i === 0 ? scriptPath : a)), {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        maxLifetimeMs: REBUILD_MAX_LIFETIME_MS,
        env: { ...process.env, FUSION_SKIP_STARTUP_UPDATE_PREFLIGHT: "1", FORCE_COLOR: "0" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendJobLine(job, "system", `Failed to spawn build: ${message}`);
      finishJob(job, "failed", { error: message });
      rethrowAsApiError(err, "Failed to start rebuild");
      return; // unreachable — rethrowAsApiError always throws
    }

    const stdout = createLineSplitter((text) => appendJobLine(job, "stdout", text));
    const stderr = createLineSplitter((text) => appendJobLine(job, "stderr", text));
    child.child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    void child.waitExit().then(async (exit) => {
      stdout.flush();
      stderr.flush();
      const code = exit.code ?? (exit.signal ? 1 : 0);
      if (code !== 0) {
        appendJobLine(job, "system", `Build failed (exit ${exit.code ?? exit.signal ?? "unknown"})`);
        finishJob(job, "failed", { exitCode: exit.code, error: `Build exited with ${exit.code ?? exit.signal}` });
        log.warn("System rebuild failed", { jobId: job.id, scope, exitCode: exit.code, signal: exit.signal ?? undefined });
        return;
      }

      appendJobLine(job, "system", "Build succeeded.");

      if (scope === "plugins") {
        try {
          const result = await reloadStartedPlugins();
          appendJobLine(
            job,
            "system",
            `Reloaded ${result.reloaded.length} plugin(s)${result.failed.length ? `, ${result.failed.length} failed` : ""}.`,
          );
          for (const failure of result.failed) {
            appendJobLine(job, "system", `Plugin reload failed: ${failure.id} — ${failure.error}`);
          }
          finishJob(job, "succeeded", { exitCode: 0, pluginsReloaded: result.reloaded });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          appendJobLine(job, "system", `Plugin reload unavailable: ${message}`);
          finishJob(job, "succeeded", { exitCode: 0, pluginsReloaded: [] });
        }
        return;
      }

      let restartScheduled = false;
      if (restartAfter && systemControl) {
        restartScheduled = systemControl.requestRestart(`rebuild:${scope}`);
        appendJobLine(
          job,
          "system",
          restartScheduled
            ? "Restarting server…"
            : "Restart not available (no supervising parent) — restart manually to pick up the build.",
        );
      }
      finishJob(job, "succeeded", { exitCode: 0, restartScheduled });
      log.info("System rebuild succeeded", { jobId: job.id, scope, restartScheduled });
    }).catch((err) => {
      // Never let an unexpected throw in the completion chain strand activeJob
      // (which would 409 every subsequent rebuild until process restart).
      const message = err instanceof Error ? err.message : String(err);
      appendJobLine(job, "system", `Rebuild post-processing failed: ${message}`);
      finishJob(job, "failed", { error: message });
      log.error("System rebuild post-processing failed", { jobId: job.id, scope, error: message });
    });

    res.status(202).json(jobSnapshot(job, false));
  });

  /** GET /api/system/rebuild/current — active job, falling back to the last finished one. */
  router.get("/system/rebuild/current", (_req, res) => {
    const job = activeJob ?? lastJob;
    res.json({ job: job ? jobSnapshot(job, true) : null });
  });

  /** GET /api/system/jobs/:id/stream — SSE output stream with Last-Event-ID replay. */
  router.get("/system/jobs/:id/stream", (req, res) => {
    const job = jobsById.get(req.params.id as string);
    if (!job) {
      throw notFound("Unknown system job");
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // Disable proxy buffering (nginx / Tailscale Serve) so live output streams
    // in real time instead of appearing to hang — parity with the other SSE
    // endpoints (routes.ts makeRunStreamHandler).
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(": connected\n\n");

    const lastEventId = Number.parseInt(String(req.headers["last-event-id"] ?? ""), 10);
    const replayFrom = Number.isFinite(lastEventId) ? lastEventId + 1 : 0;
    for (const line of job.lines) {
      if (line.i >= replayFrom) {
        writeSSEEvent(res, "line", JSON.stringify(line), line.i);
      }
    }

    if (job.status !== "running") {
      writeSSEEvent(res, "end", JSON.stringify(jobSnapshot(job, false)));
      res.end();
      return;
    }

    const stopHeartbeat = startSseHeartbeat(res);
    job.subscribers.add(res);
    req.on("close", () => {
      job.subscribers.delete(res);
      stopHeartbeat();
    });
  });

  /** GET /api/system/logs?limit=500 — recent host-process log entries. */
  router.get("/system/logs", (req, res) => {
    if (!systemLogs) {
      throw new ApiError(409, "Host-process logs are not available in this mode");
    }
    const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 1000) : 500;
    res.json({ entries: systemLogs.getRecent(limit) });
  });

  /** GET /api/system/logs/stream — SSE live tail of host-process logs. */
  router.get("/system/logs/stream", (req, res) => {
    if (!systemLogs) {
      throw new ApiError(409, "Host-process logs are not available in this mode");
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(": connected\n\n");

    for (const entry of systemLogs.getRecent(200)) {
      writeSSEEvent(res, "log", JSON.stringify(entry));
    }
    const unsubscribe = systemLogs.subscribe((entry: SystemLogEntry) => {
      writeSSEEvent(res, "log", JSON.stringify(entry));
    });
    const stopHeartbeat = startSseHeartbeat(res);
    req.on("close", () => {
      unsubscribe();
      stopHeartbeat();
    });
  });

  /** POST /api/system/engine/restart — bounce all running project engines. */
  router.post("/system/engine/restart", async (req, res) => {
    if (rejectCrossOrigin(req, res)) return;
    const engineManager = options?.engineManager;
    const centralCore = options?.centralCore;
    if (!engineManager || !centralCore) {
      throw new ApiError(409, "Engine manager is unavailable");
    }
    try {
      const projects = await centralCore.listProjects();
      const runningIds = projects.filter((p) => engineManager.getEngine(p.id)).map((p) => p.id);
      const restarted: string[] = [];
      const failed: Array<{ projectId: string; error: string }> = [];
      for (const projectId of runningIds) {
        try {
          // pause+resume is the only manager path that cleanly tears down the
          // engine (map removal + singleton lock release) before restarting.
          await engineManager.pauseProject(projectId);
          await engineManager.resumeProject(projectId);
          restarted.push(projectId);
        } catch (err) {
          // resumeProject flips CentralCore status to "active" BEFORE
          // ensureEngine(); a throw there would leave the project reading
          // online while its engine is dead. Park it paused so status matches
          // reality (best-effort — never mask the original failure).
          try {
            await engineManager.pauseProject(projectId);
          } catch {
            // Ignore — the primary failure below is what the operator needs.
          }
          failed.push({ projectId, error: err instanceof Error ? err.message : String(err) });
        }
      }
      log.info("Engine restart completed", { restartedCount: restarted.length, failedCount: failed.length });
      res.json({ restarted, failed });
    } catch (err) {
      rethrowAsApiError(err, "Failed to restart engines");
    }
  });

  /** POST /api/system/agents/restart-all — pause+resume every active agent. */
  router.post("/system/agents/restart-all", async (req, res) => {
    if (rejectCrossOrigin(req, res)) return;
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const monitor =
        deps.hasHeartbeatExecutor && deps.heartbeatMonitor && deps.isHeartbeatMonitorForProject(scopedStore)
          ? deps.heartbeatMonitor
          : deps.resolveHeartbeatMonitor(scopedStore);
      const lifecycle = monitor as AgentLifecycleMonitor | undefined;
      if (!lifecycle?.pauseAgent || !lifecycle?.resumeAgent) {
        throw new ApiError(409, "Agent lifecycle control is unavailable in this mode");
      }

      // Only bounce agents that are currently active — an operator-paused or
      // disabled agent must stay exactly as the operator left it.
      const agents = await agentStore.listAgents({ includeEphemeral: false });
      const restarted: string[] = [];
      const failed: Array<{ agentId: string; error: string }> = [];
      for (const agent of agents) {
        if (agent.state !== "active") continue;
        try {
          await lifecycle.pauseAgent(agent.id, { pauseReason: "system-restart-all", stopActiveRun: true });
          await lifecycle.resumeAgent(agent.id, {
            triggerDetail: "Restarted from the System panel",
            triggerSource: "system-restart-all",
            clearPauseReason: true,
          });
          restarted.push(agent.id);
        } catch (err) {
          failed.push({ agentId: agent.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      log.info("Agent restart-all completed", { restartedCount: restarted.length, failedCount: failed.length });
      res.json({ restarted, failed });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to restart agents");
    }
  });

  /** POST /api/system/plugins/reload-all — hot-reload every started plugin. */
  router.post("/system/plugins/reload-all", async (req, res) => {
    if (rejectCrossOrigin(req, res)) return;
    try {
      const result = await reloadStartedPlugins();
      log.info("Plugin reload-all completed", { reloadedCount: result.reloaded.length, failedCount: result.failed.length });
      res.json(result);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to reload plugins");
    }
  });
}
