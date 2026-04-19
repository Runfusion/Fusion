import { Router, type Request, type Response } from "express";
import { badRequest, conflict, ApiError, sendErrorResponse } from "./api-error.js";
import { detectDevServerScripts } from "./dev-server-detect.js";
import { loadDevServerStore, resetDevServerStore, type DevServerStore } from "./dev-server-store.js";
import { DevServerProcessManager } from "./dev-server-process.js";

export interface DevServerRouterOptions {
  /** Root directory of the project */
  projectRoot: string;
}

interface DevServerRuntime {
  store: DevServerStore;
  manager: DevServerProcessManager;
}

const runtimes = new Map<string, DevServerRuntime>();

async function getRuntime(projectRoot: string): Promise<DevServerRuntime> {
  const key = projectRoot;
  const existing = runtimes.get(key);
  if (existing) {
    return existing;
  }

  const store = await loadDevServerStore(projectRoot);
  const manager = new DevServerProcessManager(store);
  const runtime = { store, manager };
  runtimes.set(key, runtime);
  return runtime;
}

function writeSSE(res: Response, chunk: string): boolean {
  if (res.writableEnded || res.destroyed) {
    return false;
  }

  try {
    res.write(chunk);
    return true;
  } catch {
    return false;
  }
}

export function createDevServerRouter(options: DevServerRouterOptions): Router {
  const router = Router();

  router.get("/detect", async (_req, res) => {
    try {
      const result = await detectDevServerScripts(options.projectRoot);
      res.json({ candidates: result.candidates });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to detect dev server scripts";
      res.status(500).json({ error: message });
    }
  });

  router.get("/status", async (_req, res) => {
    try {
      const { store, manager } = await getRuntime(options.projectRoot);
      const state = store.getState();
      res.json({ ...state, isRunning: manager.isRunning() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load dev server status";
      res.status(500).json({ error: message });
    }
  });

  router.post("/start", async (req, res) => {
    try {
      const command = typeof req.body?.command === "string" ? req.body.command.trim() : "";
      const cwd = typeof req.body?.cwd === "string" ? req.body.cwd.trim() : "";
      const scriptId = typeof req.body?.scriptId === "string" ? req.body.scriptId.trim() : undefined;
      const packagePath = typeof req.body?.packagePath === "string" ? req.body.packagePath.trim() : undefined;

      if (!command) {
        throw badRequest("command is required and must be a non-empty string");
      }

      if (!cwd) {
        throw badRequest("cwd is required and must be a non-empty string");
      }

      const { manager } = await getRuntime(options.projectRoot);
      if (manager.isRunning()) {
        throw conflict("Dev server is already running");
      }

      const state = await manager.start(command, cwd, { scriptId, packagePath });
      res.json(state);
    } catch (error) {
      if (error instanceof ApiError) {
        sendErrorResponse(res, error.statusCode, error.message, { details: error.details });
        return;
      }

      const message = error instanceof Error ? error.message : "Failed to start dev server";
      if (message.includes("already running")) {
        sendErrorResponse(res, 409, message);
        return;
      }

      sendErrorResponse(res, 500, message);
    }
  });

  router.post("/stop", async (_req, res) => {
    try {
      const { store, manager } = await getRuntime(options.projectRoot);
      if (!manager.isRunning()) {
        res.json(store.getState());
        return;
      }

      const state = await manager.stop();
      res.json(state);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to stop dev server";
      sendErrorResponse(res, 500, message);
    }
  });

  router.post("/restart", async (_req, res) => {
    try {
      const { store, manager } = await getRuntime(options.projectRoot);
      const state = store.getState();
      if (!state.command || !state.cwd) {
        throw badRequest("No previous command found to restart");
      }

      const restarted = await manager.restart();
      res.json(restarted);
    } catch (error) {
      if (error instanceof ApiError) {
        sendErrorResponse(res, error.statusCode, error.message, { details: error.details });
        return;
      }

      const message = error instanceof Error ? error.message : "Failed to restart dev server";
      sendErrorResponse(res, 500, message);
    }
  });

  router.put("/preview-url", async (req, res) => {
    try {
      const rawUrl = req.body?.url;
      if (rawUrl !== null && rawUrl !== undefined && typeof rawUrl !== "string") {
        throw badRequest("url must be a string, null, or undefined");
      }

      const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
      if (trimmed && !trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
        throw badRequest("preview URL must start with http:// or https://");
      }

      const { store } = await getRuntime(options.projectRoot);
      const state = await store.updateState({
        manualUrl: trimmed.length > 0 ? trimmed : undefined,
      });

      res.json(state);
    } catch (error) {
      if (error instanceof ApiError) {
        sendErrorResponse(res, error.statusCode, error.message, { details: error.details });
        return;
      }

      const message = error instanceof Error ? error.message : "Failed to update preview URL";
      sendErrorResponse(res, 500, message);
    }
  });

  router.get("/logs/stream", async (req, res) => {
    try {
      const { store, manager } = await getRuntime(options.projectRoot);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      res.write(": connected\n\n");

      const history = store.getState().logHistory;
      if (!writeSSE(res, `event: history\ndata: ${JSON.stringify({ lines: history })}\n\n`)) {
        res.end();
        return;
      }

      const onOutput = (payload: { line: string; timestamp: string }) => {
        writeSSE(res, `event: log\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      const onStopped = (state: unknown) => {
        writeSSE(res, `event: stopped\ndata: ${JSON.stringify(state)}\n\n`);
      };

      const onFailed = (payload: unknown) => {
        writeSSE(res, `event: failed\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      manager.on("output", onOutput);
      manager.on("stopped", onStopped);
      manager.on("failed", onFailed);

      const heartbeat = setInterval(() => {
        writeSSE(res, ": heartbeat\n\n");
      }, 30_000);

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) {
          return;
        }
        cleaned = true;
        clearInterval(heartbeat);
        manager.off("output", onOutput);
        manager.off("stopped", onStopped);
        manager.off("failed", onFailed);
      };

      req.on("close", cleanup);
      req.on("error", cleanup);
      res.on("close", cleanup);
    } catch (error) {
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : "Failed to stream logs";
        sendErrorResponse(res, 500, message);
      }
    }
  });

  return router;
}

export async function stopAllDevServers(): Promise<void> {
  for (const runtime of runtimes.values()) {
    try {
      if (runtime.manager.isRunning()) {
        await runtime.manager.stop();
      }
      runtime.manager.cleanup();
    } catch {
      runtime.manager.cleanup();
    }
  }
}

export async function destroyAllDevServerManagers(): Promise<void> {
  await stopAllDevServers();
  runtimes.clear();
  resetDevServerStore();
}

export function getActiveProcessManagers(): DevServerProcessManager[] {
  return [...runtimes.values()].map((runtime) => runtime.manager);
}
