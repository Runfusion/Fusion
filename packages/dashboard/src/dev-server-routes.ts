import { Router, type Request, type Response } from "express";
import { badRequest, conflict, ApiError, sendErrorResponse } from "./api-error.js";
import { detectDevServerScripts } from "./dev-server-detect.js";
import {
  loadDevServerStore,
  resetDevServerStore,
  type DevServerConfig,
  type DevServerState,
  type DevServerStore,
} from "./dev-server-store.js";
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

const DEV_SERVER_CONFIG_FIELDS: Array<keyof DevServerConfig> = [
  "selectedScript",
  "selectedSource",
  "selectedCommand",
  "previewUrlOverride",
  "detectedPreviewUrl",
  "selectedAt",
];

function normalizeNullableStringField(
  raw: unknown,
  fieldName: keyof DevServerConfig,
  options: { requiredNonEmpty?: boolean; requireHttpUrl?: boolean } = {},
): string | null {
  if (raw === null) {
    return null;
  }

  if (typeof raw !== "string") {
    throw badRequest(`${fieldName} must be a string or null`);
  }

  const trimmed = raw.trim();

  if (options.requiredNonEmpty && trimmed.length === 0) {
    throw badRequest(`${fieldName} must be a non-empty string when provided`);
  }

  if (trimmed.length === 0) {
    return null;
  }

  if (options.requireHttpUrl && !trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    throw badRequest(`${fieldName} must start with http:// or https://`);
  }

  return trimmed;
}

function parseConfigUpdateBody(body: unknown): Partial<DevServerConfig> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Request body must be a JSON object");
  }

  const source = body as Record<string, unknown>;
  const partial: Partial<DevServerConfig> = {};

  for (const field of DEV_SERVER_CONFIG_FIELDS) {
    if (Object.hasOwn(source, field)) {
      partial[field] = source[field] as DevServerConfig[typeof field];
    }
  }

  if (Object.keys(partial).length === 0) {
    throw badRequest("At least one dev server config field is required");
  }

  if (Object.hasOwn(partial, "selectedScript")) {
    partial.selectedScript = normalizeNullableStringField(partial.selectedScript, "selectedScript", {
      requiredNonEmpty: true,
    });
  }

  if (Object.hasOwn(partial, "selectedSource")) {
    partial.selectedSource = normalizeNullableStringField(partial.selectedSource, "selectedSource");
  }

  if (Object.hasOwn(partial, "selectedCommand")) {
    partial.selectedCommand = normalizeNullableStringField(partial.selectedCommand, "selectedCommand");
  }

  if (Object.hasOwn(partial, "previewUrlOverride")) {
    partial.previewUrlOverride = normalizeNullableStringField(partial.previewUrlOverride, "previewUrlOverride", {
      requireHttpUrl: true,
    });
  }

  if (Object.hasOwn(partial, "detectedPreviewUrl")) {
    partial.detectedPreviewUrl = normalizeNullableStringField(partial.detectedPreviewUrl, "detectedPreviewUrl", {
      requireHttpUrl: true,
    });
  }

  if (Object.hasOwn(partial, "selectedAt")) {
    partial.selectedAt = normalizeNullableStringField(partial.selectedAt, "selectedAt");
  }

  return partial;
}

function buildStatusResponse(state: DevServerState, isRunning: boolean) {
  const manualPreviewUrl = state.manualUrl ?? null;
  const detectedPreviewUrl = state.detectedUrl ?? null;

  return {
    ...state,
    previewUrl: manualPreviewUrl ?? detectedPreviewUrl,
    detectedPort: state.detectedPort ?? null,
    manualPreviewUrl,
    isRunning,
  };
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

  router.get("/config", async (_req, res) => {
    try {
      const { store } = await getRuntime(options.projectRoot);
      res.json(store.getConfig());
    } catch (error) {
      if (error instanceof ApiError) {
        sendErrorResponse(res, error.statusCode, error.message, { details: error.details });
        return;
      }

      const message = error instanceof Error ? error.message : "Failed to load dev server config";
      sendErrorResponse(res, 500, message);
    }
  });

  router.put("/config", async (req, res) => {
    try {
      const partial = parseConfigUpdateBody(req.body);
      const { store } = await getRuntime(options.projectRoot);
      const updated = await store.updateConfig(partial);
      res.json(updated);
    } catch (error) {
      if (error instanceof ApiError) {
        sendErrorResponse(res, error.statusCode, error.message, { details: error.details });
        return;
      }

      const message = error instanceof Error ? error.message : "Failed to update dev server config";
      sendErrorResponse(res, 500, message);
    }
  });

  router.get("/status", async (_req, res) => {
    try {
      const { store, manager } = await getRuntime(options.projectRoot);
      const state = store.getState();

      res.json(buildStatusResponse(state, manager.isRunning()));
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

      const onOutput = (payload: { line: string; stream: "stdout" | "stderr"; timestamp: string }) => {
        writeSSE(res, `event: log\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      const onStopped = (state: unknown) => {
        writeSSE(res, `event: stopped\ndata: ${JSON.stringify(state)}\n\n`);
      };

      const onFailed = (payload: unknown) => {
        writeSSE(res, `event: failed\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      const onUrlDetected = (payload: { url: string; port: number; source: string; detectedAt: string }) => {
        writeSSE(res, `event: dev-server:url-detected\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      manager.on("output", onOutput);
      manager.on("stopped", onStopped);
      manager.on("failed", onFailed);
      manager.on("url-detected", onUrlDetected);

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
        manager.off("url-detected", onUrlDetected);
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
