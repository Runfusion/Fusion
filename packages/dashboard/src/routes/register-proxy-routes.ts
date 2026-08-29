import { type Request, type Response, type Router } from "express";
import type { TaskStore } from "@fusion/core";
import type { RuntimeLogger } from "../runtime-logger.js";
import { ApiError, badRequest, internalError, notFound } from "../api-error.js";
import { emitRemoteRouteDiagnostic } from "./context.js";

export interface ProxyRoutesDeps {
  store: TaskStore;
  runtimeLogger: RuntimeLogger;
}

function rethrowAsApiError(error: unknown, fallbackMessage = "Internal server error"): never {
  if (error instanceof ApiError) {
    throw error;
  }

  if (error instanceof Error) {
    throw internalError(error.message || fallbackMessage);
  }

  throw internalError(fallbackMessage);
}

async function proxyToRemoteNode(
  req: Request,
  res: Response,
  remotePath: string,
  deps: ProxyRoutesDeps,
  proxyOptions?: { timeoutMs?: number },
): Promise<void> {
  const { store, runtimeLogger } = deps;
  const proxyLogger = runtimeLogger.child("proxy");
  const nodeId = req.params.nodeId as string;
  const timeoutMs = proxyOptions?.timeoutMs ?? 10_000;

  const { CentralCore } = await import("@fusion/core");
  // FNXC:GlobalDirGuard 2026-06-25-22:40: Node proxy state is GLOBAL — use getGlobalSettingsDir(), never getFusionDir() (project .fusion/), which spawns a stray per-project central DB and resets global settings. See register-settings-sync-inbound-routes.ts for full rationale.
  const central = new CentralCore(store.getGlobalSettingsDir());

  try {
    await central.init();

    const node = await central.getNode(nodeId);
    if (!node) throw notFound("Node not found");
    if (node.type === "local") throw badRequest("Cannot proxy to local node");
    if (!node.url) throw badRequest("Node has no URL configured");

    const parsedUrl = new URL(req.url, "http://localhost");
    const queryString = parsedUrl.search;
    const targetPath = `/api${remotePath}${queryString}`;
    const targetUrl = new URL(targetPath, node.url).toString();

    const headers: Record<string, string> = {};
    if (node.apiKey) {
      headers.Authorization = `Bearer ${node.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(targetUrl, { headers, signal: controller.signal });
    clearTimeout(timeout);

    const hopByHopHeaders = new Set([
      "transfer-encoding",
      "connection",
      "keep-alive",
      "upgrade",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailers",
    ]);

    response.headers.forEach((value, key) => {
      if (!hopByHopHeaders.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    res.status(response.status);

    if (!response.body) {
      res.end();
      return;
    }

    const { Readable } = await import("node:stream");
    const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);

    nodeStream.on("data", (chunk: Buffer) => {
      res.write(chunk);
    });

    nodeStream.on("end", () => {
      res.end();
    });

    nodeStream.on("error", (err: Error) => {
      proxyLogger.error(`Stream error for node ${nodeId}`, { error: err.message });
      if (!res.writableEnded) {
        res.end();
      }
    });
  } catch (err: unknown) {
    if (res.headersSent) {
      return;
    }
    if (err instanceof Error && err.name === "AbortError") {
      res.status(504).json({ error: "Remote node timeout" });
    } else if (err instanceof TypeError) {
      res.status(502).json({ error: "Remote node unreachable" });
    } else if (err instanceof ApiError) {
      throw err;
    } else if (err instanceof Error && err.message) {
      throw new ApiError(500, err.message);
    } else {
      throw new ApiError(500, "Proxy request failed");
    }
  } finally {
    await central.close();
  }
}

/**
 * Registers remote-node proxy forwarding routes.
 *
 * Route order is required behavior: specific proxy endpoints must remain ahead of the
 * wildcard proxy catch-all, and the SSE proxy retains explicit timeout/cleanup semantics.
 */
export function registerProxyRoutes(router: Router, deps: ProxyRoutesDeps): void {
  const { store, runtimeLogger } = deps;

  /** GET /api/proxy/:nodeId/health — Forward health check to remote node */
  router.get("/proxy/:nodeId/health", async function (req, res) {
    try {
      await proxyToRemoteNode(req, res, "/health", deps);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /** GET /api/proxy/:nodeId/projects — Forward projects list to remote node */
  router.get("/proxy/:nodeId/projects", async function (req, res) {
    try {
      await proxyToRemoteNode(req, res, "/projects", deps);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /** GET /api/proxy/:nodeId/tasks — Forward tasks list to remote node (forwards projectId, q query params) */
  router.get("/proxy/:nodeId/tasks", async function (req, res) {
    try {
      await proxyToRemoteNode(req, res, "/tasks", deps);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /** GET /api/proxy/:nodeId/project-health — Forward project health to remote node (forwards projectId query param) */
  router.get("/proxy/:nodeId/project-health", async function (req, res) {
    try {
      await proxyToRemoteNode(req, res, "/project-health", deps);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/proxy/:nodeId/events — SSE proxy to remote node events stream.
   * Uses a 30-second timeout since SSE connections are long-lived.
   * Handles client disconnect gracefully.
   */
  router.get("/proxy/:nodeId/events", async function (req, res) {
    const nodeId = req.params.nodeId as string;

    const { CentralCore } = await import("@fusion/core");
    const central = new CentralCore(store.getGlobalSettingsDir());

    try {
      await central.init();

      const node = await central.getNode(nodeId);
      if (!node) {
        res.status(404).json({ error: "Node not found" });
        return;
      }

      if (node.type === "local") {
        res.status(400).json({ error: "Cannot proxy to local node" });
        return;
      }

      if (!node.url) {
        res.status(400).json({ error: "Node has no URL configured" });
        return;
      }

      const parsedUrl = new URL(req.url, "http://localhost");
      const queryString = parsedUrl.search;
      const upstreamPath = `/api/events${queryString}`;
      const targetUrl = new URL(upstreamPath, node.url).toString();

      const headers: Record<string, string> = {};
      if (node.apiKey) {
        headers["Authorization"] = `Bearer ${node.apiKey}`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      const response = await fetch(targetUrl, {
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        res.status(response.status).json({ error: "Remote node events unavailable" });
        return;
      }

      if (!response.body) {
        res.status(502).json({ error: "Remote node unreachable" });
        return;
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      res.write(": connected\n\n");

      const { Readable } = await import("node:stream");
      const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);

      let destroyed = false;

      req.on("close", () => {
        if (!destroyed) {
          destroyed = true;
          emitRemoteRouteDiagnostic(runtimeLogger, {
            route: "proxy-sse",
            message: "Closing SSE proxy stream after client disconnect",
            nodeId,
            upstreamPath,
            stage: "client-disconnect",
            level: "info",
          });
          controller.abort();
          nodeStream.destroy();
        }
      });

      nodeStream.on("data", (chunk: Buffer) => {
        if (!res.writableEnded) {
          res.write(chunk);
        }
      });

      nodeStream.on("end", () => {
        if (!res.writableEnded) {
          res.end();
        }
      });

      nodeStream.on("error", (err: Error) => {
        emitRemoteRouteDiagnostic(runtimeLogger, {
          route: "proxy-sse",
          message: "SSE proxy stream error",
          nodeId,
          upstreamPath,
          stage: "upstream-stream",
          error: err,
        });
        if (!res.writableEnded) {
          res.end();
        }
      });
    } catch (err: unknown) {
      const parsedUrl = new URL(req.url, "http://localhost");
      const queryString = parsedUrl.search;
      const upstreamPath = `/api/events${queryString}`;

      if (err instanceof Error && err.name === "AbortError") {
        emitRemoteRouteDiagnostic(runtimeLogger, {
          route: "proxy-sse",
          message: "SSE proxy request timed out",
          nodeId,
          upstreamPath,
          stage: "fetch",
          error: err,
          level: "warn",
        });
        if (!res.headersSent) {
          res.status(504).json({ error: "Remote node timeout" });
        } else if (!res.writableEnded) {
          res.end();
        }
      } else if (err instanceof TypeError) {
        emitRemoteRouteDiagnostic(runtimeLogger, {
          route: "proxy-sse",
          message: "SSE proxy transport failure",
          nodeId,
          upstreamPath,
          stage: "fetch",
          error: err,
          level: "warn",
        });
        if (!res.headersSent) {
          res.status(502).json({ error: "Remote node unreachable" });
        } else if (!res.writableEnded) {
          res.end();
        }
      } else {
        emitRemoteRouteDiagnostic(runtimeLogger, {
          route: "proxy-sse",
          message: "SSE proxy unexpected failure",
          nodeId,
          upstreamPath,
          stage: "fetch",
          error: err,
        });
        if (!res.headersSent) {
          if (err instanceof ApiError) {
            throw err;
          }
          rethrowAsApiError(err);
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    } finally {
      await central.close();
    }
  });

  /**
   * Generic wildcard proxy route — forwards any HTTP request to a remote node.
   * Keep this after specific /proxy routes so they retain precedence.
   * Matches /api/proxy/:nodeId/*
   */
  router.all("/proxy/:nodeId/{*splat}", async (req: Request, res: Response) => {
    const nodeId = req.params.nodeId as string;
    const splat = req.params.splat as string | string[];
    const remainingPath = Array.isArray(splat) ? splat.join("/") : splat;

    const { CentralCore } = await import("@fusion/core");
    const central = new CentralCore(store.getGlobalSettingsDir());

    try {
      await central.init();

      const node = await central.getNode(nodeId);
      if (!node) {
        res.status(404).json({ error: "Node not found" });
        return;
      }

      if (node.type === "local") {
        res.status(400).json({ error: "Cannot proxy to local node" });
        return;
      }

      if (!node.url) {
        res.status(400).json({ error: "Node has no URL" });
        return;
      }

      const parsedUrl = new URL(req.url ?? "/", "http://localhost");
      const queryString = parsedUrl.search;
      const targetPath = `/${remainingPath}${queryString}`;
      const targetUrl = new URL(targetPath, node.url).toString();

      const headers: Record<string, string> = {};
      if (typeof req.headers["content-type"] === "string") {
        headers["Content-Type"] = req.headers["content-type"];
      }
      if (node.apiKey) {
        headers["Authorization"] = `Bearer ${node.apiKey}`;
      }

      let body: Buffer | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const chunks: Buffer[] = [];
        if (req.rawBody && req.rawBody.length > 0) {
          body = req.rawBody;
        } else {
          await new Promise<void>((resolve, reject) => {
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", resolve);
            req.on("error", reject);
          });
          if (chunks.length > 0) {
            body = Buffer.concat(chunks);
          }
        }
      }

      const response = await fetch(targetUrl, {
        method: req.method,
        headers,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        body: body as any,
        signal: AbortSignal.timeout(30_000),
      });

      const hopByHopHeaders = new Set([
        "connection",
        "keep-alive",
        "transfer-encoding",
        "upgrade",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
      ]);

      response.headers.forEach((value, key) => {
        if (!hopByHopHeaders.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });

      res.status(response.status);

      if (!response.body) {
        res.end();
        return;
      }

      const { Readable } = await import("node:stream");
      const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);

      nodeStream.on("data", (chunk: Buffer) => {
        res.write(chunk);
      });

      nodeStream.on("end", () => {
        res.end();
      });

      nodeStream.on("error", (err: Error) => {
        emitRemoteRouteDiagnostic(runtimeLogger, {
          route: "proxy-wildcard",
          message: "Wildcard proxy stream error",
          nodeId,
          upstreamPath: targetPath,
          stage: "upstream-stream",
          error: err,
        });
        if (!res.writableEnded) {
          res.end();
        }
      });
    } catch (err: unknown) {
      const parsedUrl = new URL(req.url ?? "/", "http://localhost");
      const queryString = parsedUrl.search;
      const targetPath = `/${remainingPath}${queryString}`;

      const errorObj = err as { name?: string } | null;
      const isAbortError = errorObj?.name === "AbortError";
      if (isAbortError) {
        emitRemoteRouteDiagnostic(runtimeLogger, {
          route: "proxy-wildcard",
          message: "Wildcard proxy request timed out",
          nodeId,
          upstreamPath: targetPath,
          stage: "fetch",
          error: err,
          level: "warn",
        });
        if (res.headersSent) {
          return;
        }
        res.status(504).json({ error: "Gateway Timeout" });
      } else if (err instanceof TypeError) {
        emitRemoteRouteDiagnostic(runtimeLogger, {
          route: "proxy-wildcard",
          message: "Wildcard proxy transport failure",
          nodeId,
          upstreamPath: targetPath,
          stage: "fetch",
          error: err,
          level: "warn",
        });
        if (res.headersSent) {
          return;
        }
        res.status(502).json({ error: "Bad Gateway" });
      } else {
        emitRemoteRouteDiagnostic(runtimeLogger, {
          route: "proxy-wildcard",
          message: "Wildcard proxy unexpected failure",
          nodeId,
          upstreamPath: targetPath,
          stage: "fetch",
          error: err,
        });
        if (res.headersSent) {
          return;
        }
        res.status(502).json({ error: "Bad Gateway" });
      }
    } finally {
      await central.close();
    }
  });
}
