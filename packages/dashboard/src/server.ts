import express from "express";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TaskStore, MergeResult } from "@hai/core";
import type { AuthStorageLike, ModelRegistryLike } from "./routes.js";
import { createApiRoutes } from "./routes.js";
import { createSSE } from "./sse.js";
import { rateLimit, RATE_LIMITS } from "./rate-limit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  /** Custom merge handler — when provided, used instead of store.mergeTask */
  onMerge?: (taskId: string) => Promise<MergeResult>;
  /** Maximum concurrent worktrees / execution slots (default 2) */
  maxConcurrent?: number;
  /** Optional AuthStorage instance for auth routes — if not provided, one is created internally */
  authStorage?: AuthStorageLike;
  /** Optional ModelRegistry instance for the models API — if not provided, the endpoint returns an empty list */
  modelRegistry?: ModelRegistryLike;
}

export function createServer(store: TaskStore, options?: ServerOptions): ReturnType<typeof express> {
  const app = express();
  app.use(express.json());

  // Serve built React app
  // Resolution order:
  //   1. HAI_CLIENT_DIR env override (explicit)
  //   2. Next to process.execPath (bun-compiled binary: dist/hai + dist/client/)
  //   3. __dirname/../dist/client  (running from src/ via tsx/ts-node)
  //   4. __dirname/../client        (running from dist/ after tsc)
  //   5. __dirname/../public        (fallback for dev)
  const execDir = dirname(process.execPath);
  const clientDir = process.env.HAI_CLIENT_DIR
    ? process.env.HAI_CLIENT_DIR
    : existsSync(join(execDir, "client", "index.html"))
      ? join(execDir, "client")
      : existsSync(join(__dirname, "..", "dist", "client"))
        ? join(__dirname, "..", "dist", "client")
        : existsSync(join(__dirname, "..", "client"))
          ? join(__dirname, "..", "client")
          : join(__dirname, "..", "public");

  app.use(express.static(clientDir));

  // Rate limiting — stricter limit on SSE connections
  app.get("/api/events", rateLimit(RATE_LIMITS.sse), createSSE(store));

  // Per-task SSE endpoint for live agent log streaming
  app.get("/api/tasks/:id/logs/stream", (req, res) => {
    const taskId = req.params.id;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    res.write(": connected\n\n");

    const onAgentLog = (entry: { taskId: string; text: string; type: string; timestamp: string }) => {
      if (entry.taskId !== taskId) return;
      res.write(`event: agent:log\ndata: ${JSON.stringify(entry)}\n\n`);
    };

    store.on("agent:log", onAgentLog);

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 30_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      store.off("agent:log", onAgentLog);
    });
  });

  // Rate limiting — mutation endpoints (POST/PUT/PATCH/DELETE)
  app.use("/api", rateLimit(RATE_LIMITS.api));

  // REST API
  app.use("/api", createApiRoutes(store, options));

  // SPA fallback
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(join(clientDir, "index.html"));
  });

  return app;
}
