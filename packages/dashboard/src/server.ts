import express from "express";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Task, TaskStore, MergeResult } from "@kb/core";
import type { AuthStorageLike, ModelRegistryLike } from "./routes.js";
import { createApiRoutes } from "./routes.js";
import { createSSE } from "./sse.js";
import { rateLimit, RATE_LIMITS } from "./rate-limit.js";
import { getTerminalService, type TerminalSession } from "./terminal-service.js";
import { WebSocketServer, type WebSocket } from "ws";
import { terminalSessionManager } from "./terminal.js";
import { getCurrentGitHubRepo } from "./github.js";
import { githubPoller as globalGithubPoller, GitHubPollingService, type TaskWatchInput } from "./github-poll.js";
import { WebSocketManager, type BadgeSnapshot } from "./websocket.js";
import type { BadgePubSub } from "./badge-pubsub.js";
import { createBadgePubSub, type BadgePubSubMessage } from "./badge-pubsub.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  /** Custom merge handler — when provided, used instead of store.mergeTask */
  onMerge?: (taskId: string) => Promise<MergeResult>;
  /** Maximum concurrent worktrees / execution slots (default 2) */
  maxConcurrent?: number;
  /** Optional GitHub token for PR operations — falls back to GITHUB_TOKEN env var */
  githubToken?: string;
  /** Optional AuthStorage instance for auth routes — if not provided, one is created internally */
  authStorage?: AuthStorageLike;
  /** Optional ModelRegistry instance for the models API — if not provided, the endpoint returns an empty list */
  modelRegistry?: ModelRegistryLike;
  /** Optional BadgePubSub adapter for cross-instance badge snapshot fan-out — if not provided, creates from env or falls back to in-memory */
  badgePubSub?: BadgePubSub;
  /** Optional GitHubPollingService instance for per-server poller isolation — if not provided, uses the global singleton */
  githubPoller?: GitHubPollingService;
}

type DashboardExpressApp = ReturnType<typeof express> & {
  terminalWsServer?: WebSocketServer | null;
  badgeWsServer?: WebSocketServer | null;
  badgeWsManager?: WebSocketManager | null;
  __kbWebSocketsAttached?: boolean;
};

export function createServer(store: TaskStore, options?: ServerOptions): ReturnType<typeof express> {
  const app = express();
  app.use(express.json());

  // Initialize terminal service with project root
  getTerminalService(store.getRootDir());

  // Serve built React app
  // Resolution order:
  //   1. KB_CLIENT_DIR env override (explicit)
  //   2. Next to process.execPath (bun-compiled binary: dist/kb + dist/client/)
  //   3. __dirname/../dist/client  (running from src/ via tsx/ts-node)
  //   4. __dirname/../client        (running from dist/ after tsc)
  const execDir = dirname(process.execPath);
  const clientDir = process.env.KB_CLIENT_DIR
    ? process.env.KB_CLIENT_DIR
    : existsSync(join(execDir, "client", "index.html"))
      ? join(execDir, "client")
      : existsSync(join(__dirname, "..", "dist", "client"))
        ? join(__dirname, "..", "dist", "client")
        : join(__dirname, "..", "client");

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

  // Legacy Terminal SSE endpoint (deprecated, use WebSocket instead)
  app.get("/api/terminal/sessions/:id/stream", rateLimit(RATE_LIMITS.sse), (req, res) => {
    const sessionId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    res.write(": connected\n\n");

    const session = terminalSessionManager.getSession(sessionId);

    // If session doesn't exist, send error and close
    if (!session) {
      res.write(`event: terminal:error\ndata: ${JSON.stringify({ message: "Session not found" })}\n\n`);
      res.end();
      return;
    }

    // Send existing output immediately
    if (session.output.length > 0) {
      const existingOutput = session.output.join("");
      res.write(`event: terminal:output\ndata: ${JSON.stringify({ type: "stdout", data: existingOutput })}\n\n`);
    }

    // If session has already exited, send exit event
    if (session.exitCode !== null) {
      res.write(`event: terminal:exit\ndata: ${JSON.stringify({ exitCode: session.exitCode })}\n\n`);
      res.end();
      return;
    }

    // Listen for new output
    const onOutput = (event: import("./terminal.js").TerminalOutputEvent) => {
      if (event.sessionId !== sessionId) return;

      if (event.type === "exit") {
        res.write(`event: terminal:exit\ndata: ${JSON.stringify({ exitCode: event.exitCode })}\n\n`);
        res.end();
      } else {
        res.write(`event: terminal:output\ndata: ${JSON.stringify({ type: event.type, data: event.data })}\n\n`);
      }
    };

    terminalSessionManager.on("output", onOutput);

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 30_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      terminalSessionManager.off("output", onOutput);
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

  const dashboardApp = app as DashboardExpressApp;
  dashboardApp.terminalWsServer = null;
  dashboardApp.badgeWsServer = null;
  dashboardApp.badgeWsManager = null;
  dashboardApp.__kbWebSocketsAttached = false;

  const originalListen = dashboardApp.listen.bind(dashboardApp);
  dashboardApp.listen = ((...args: Parameters<typeof dashboardApp.listen>) => {
    const server = originalListen(...args);

    if (!dashboardApp.__kbWebSocketsAttached) {
      dashboardApp.__kbWebSocketsAttached = true;
      setupTerminalWebSocket(dashboardApp, server);
      setupBadgeWebSocket(dashboardApp, server, store, options);
    }

    return server;
  }) as typeof dashboardApp.listen;

  return dashboardApp;
}

/**
 * Setup WebSocket terminal server
 * Call this after creating the HTTP server to attach WebSocket handling
 */
export function setupTerminalWebSocket(
  app: ReturnType<typeof express>,
  server: import("http").Server,
): void {
  const terminalService = getTerminalService();

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "", `http://${req.headers.host}`).pathname;
    if (pathname !== "/api/terminal/ws") {
      return;
    }

    wss.handleUpgrade(req, socket, head, (upgraded) => {
      wss.emit("connection", upgraded, req);
    });
  });

  // Store reference on app for access
  (app as DashboardExpressApp).terminalWsServer = wss;

  wss.on("connection", (ws: WebSocket, req) => {
    // Parse query params from URL
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("sessionId");

    if (!sessionId) {
      ws.close(4000, "Missing sessionId");
      return;
    }

    const session = terminalService.getSession(sessionId);
    if (!session) {
      ws.close(4004, "Session not found");
      return;
    }

    // Track if connection is alive
    let isAlive = true;
    let dataUnsub: (() => void) | null = null;
    let exitUnsub: (() => void) | null = null;

    // Send scrollback buffer first
    const scrollback = terminalService.getScrollbackAndClearPending(sessionId);
    if (scrollback) {
      ws.send(JSON.stringify({ type: "scrollback", data: scrollback }));
    }

    // Send connection info
    ws.send(JSON.stringify({
      type: "connected",
      shell: session.shell,
      cwd: session.cwd,
    }));

    // Subscribe to data events
    dataUnsub = terminalService.onData((id, data) => {
      if (id === sessionId && isAlive) {
        try {
          ws.send(JSON.stringify({ type: "data", data }));
        } catch {
          // WebSocket might be closing
        }
      }
    });

    // Subscribe to exit events
    exitUnsub = terminalService.onExit((id, exitCode) => {
      if (id === sessionId && isAlive) {
        try {
          ws.send(JSON.stringify({ type: "exit", exitCode }));
        } catch {
          // WebSocket might be closing
        }
      }
    });

    // Heartbeat ping/pong
    const pingInterval = setInterval(() => {
      if (!isAlive) {
        ws.terminate();
        return;
      }
      isAlive = false;
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch {
        ws.terminate();
      }
    }, 30000);

    ws.on("pong", () => {
      isAlive = true;
    });

    ws.on("message", (message: Buffer) => {
      try {
        const msg = JSON.parse(message.toString());

        switch (msg.type) {
          case "input":
            if (typeof msg.data === "string") {
              terminalService.write(sessionId, msg.data);
            }
            break;
          case "resize":
            if (typeof msg.cols === "number" && typeof msg.rows === "number") {
              terminalService.resize(sessionId, msg.cols, msg.rows);
            }
            break;
          case "ping":
            ws.send(JSON.stringify({ type: "pong" }));
            break;
          case "pong":
            isAlive = true;
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      isAlive = false;
      clearInterval(pingInterval);
      if (dataUnsub) dataUnsub();
      if (exitUnsub) exitUnsub();
      // Kill the PTY session to prevent session leaks
      try {
        terminalService.killSession(sessionId);
      } catch {
        // Ignore errors during cleanup — session may already be dead
      }
    });

    ws.on("error", () => {
      isAlive = false;
      clearInterval(pingInterval);
      if (dataUnsub) dataUnsub();
      if (exitUnsub) exitUnsub();
      // Kill the PTY session to prevent session leaks
      try {
        terminalService.killSession(sessionId);
      } catch {
        // Ignore errors during cleanup — session may already be dead
      }
    });
  });

  console.log("Terminal WebSocket server mounted at /api/terminal/ws");
}

export function setupBadgeWebSocket(
  app: ReturnType<typeof express>,
  server: import("http").Server,
  store: TaskStore,
  options?: ServerOptions,
): void {
  const dashboardApp = app as DashboardExpressApp;
  const wsManager = new WebSocketManager();
  
  // Structured badge snapshot cache for local subscriptions and pub/sub sync
  // Maps taskId -> BadgeSnapshot with timestamp
  const badgeSnapshots = new Map<string, BadgeSnapshot>();
  
  // Server instance ID for pub/sub deduplication
  const serverId = randomUUID();
  
  // Use injected badgePubSub or create from environment
  const badgePubSub = options?.badgePubSub ?? createBadgePubSub({ sourceId: serverId });
  void badgePubSub.start();
  
  const githubToken = options?.githubToken ?? process.env.GITHUB_TOKEN;
  const githubPoller = options?.githubPoller ?? globalGithubPoller;

  githubPoller.configure({
    store,
    token: githubToken,
  });

  // Prime cache with existing tasks
  void store.listTasks().then((tasks) => {
    for (const task of tasks) {
      badgeSnapshots.set(task.id, {
        prInfo: task.prInfo ?? null,
        issueInfo: task.issueInfo ?? null,
        timestamp: new Date().toISOString(),
      });
    }
  }).catch(() => {
    // Best-effort cache prime only
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "", `http://${req.headers.host}`).pathname;
    if (pathname !== "/api/ws") {
      return;
    }

    wss.handleUpgrade(req, socket, head, (upgraded) => {
      wss.emit("connection", upgraded, req);
    });
  });

  dashboardApp.badgeWsServer = wss;
  dashboardApp.badgeWsManager = wsManager;

  const syncPollerTask = async (taskId: string): Promise<void> => {
    if (wsManager.getSubscriptionCount(taskId) === 0) {
      githubPoller.unwatchTask(taskId);
      return;
    }

    try {
      const task = await store.getTask(taskId);
      const watches: TaskWatchInput[] = [];

      if (task.prInfo) {
        const repo = resolveBadgeRepo(task.prInfo.url, store);
        if (repo) {
          watches.push({
            taskId: task.id,
            type: "pr",
            owner: repo.owner,
            repo: repo.repo,
            number: task.prInfo.number,
          });
        }
      }

      if (task.issueInfo) {
        const repo = resolveBadgeRepo(task.issueInfo.url, store);
        if (repo) {
          watches.push({
            taskId: task.id,
            type: "issue",
            owner: repo.owner,
            repo: repo.repo,
            number: task.issueInfo.number,
          });
        }
      }

      githubPoller.replaceTaskWatches(task.id, watches);
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        githubPoller.unwatchTask(taskId);
      }
    }
  };

  const broadcastBadgeSnapshot = (taskId: string, snapshot: BadgeSnapshot): void => {
    wsManager.broadcastBadgeUpdate(taskId, snapshot);
  };

  const onTaskUpdated = (task: Task) => {
    const previousSnapshot = badgeSnapshots.get(task.id);
    const nextSnapshot: BadgeSnapshot = {
      prInfo: task.prInfo ?? null,
      issueInfo: task.issueInfo ?? null,
      timestamp: new Date().toISOString(),
    };
    
    // Update local cache immediately
    badgeSnapshots.set(task.id, nextSnapshot);

    // Check if badge data actually changed
    if (snapshotsEqual(previousSnapshot, nextSnapshot)) {
      return;
    }

    // Always publish to shared bus (even if no local subscribers)
    // This ensures other instances receive the update
    const pubSubMessage: BadgePubSubMessage = {
      sourceId: serverId,
      taskId: task.id,
      timestamp: nextSnapshot.timestamp,
      prInfo: nextSnapshot.prInfo,
      issueInfo: nextSnapshot.issueInfo,
    };
    void badgePubSub.publish(pubSubMessage);

    // Broadcast to local websocket subscribers if any
    if (wsManager.getSubscriptionCount(task.id) > 0) {
      broadcastBadgeSnapshot(task.id, nextSnapshot);
      void syncPollerTask(task.id);
    }
  };

  const onTaskCreated = (task: Task) => {
    badgeSnapshots.set(task.id, {
      prInfo: task.prInfo ?? null,
      issueInfo: task.issueInfo ?? null,
      timestamp: new Date().toISOString(),
    });
  };

  const onTaskDeleted = (task: Task) => {
    badgeSnapshots.delete(task.id);
    githubPoller.unwatchTask(task.id);
  };

  store.on("task:updated", onTaskUpdated);
  store.on("task:created", onTaskCreated);
  store.on("task:deleted", onTaskDeleted);

  // Handle remote badge updates from other instances via pub/sub
  badgePubSub.on("message", (message: BadgePubSubMessage) => {
    // Update local cache with remote snapshot
    const remoteSnapshot: BadgeSnapshot = {
      prInfo: message.prInfo,
      issueInfo: message.issueInfo,
      timestamp: message.timestamp,
    };
    badgeSnapshots.set(message.taskId, remoteSnapshot);

    // Rebroadcast to local websocket subscribers
    // (No need to check for echo - pub/sub adapter already filtered our own messages)
    if (wsManager.getSubscriptionCount(message.taskId) > 0) {
      broadcastBadgeSnapshot(message.taskId, remoteSnapshot);
    }
  });

  wsManager.on("client:connected", (_clientId, totalClients) => {
    if (totalClients === 1) {
      githubPoller.start();
    }
  });

  wsManager.on("client:disconnected", (_clientId, totalClients) => {
    if (totalClients === 0) {
      githubPoller.stop();
    }
  });

  wsManager.on("subscription:changed", (taskId, subscriberCount) => {
    if (subscriberCount === 0) {
      githubPoller.unwatchTask(taskId);
      return;
    }

    // Send cached snapshot to late subscriber if available
    // This ensures a client subscribing after a remote update still sees the latest state
    const cachedSnapshot = badgeSnapshots.get(taskId);
    if (cachedSnapshot) {
      broadcastBadgeSnapshot(taskId, cachedSnapshot);
    }

    void syncPollerTask(taskId);
  });

  wss.on("connection", (ws: WebSocket) => {
    wsManager.addClient(ws, randomUUID());
  });

  server.once("close", () => {
    store.off("task:updated", onTaskUpdated);
    store.off("task:created", onTaskCreated);
    store.off("task:deleted", onTaskDeleted);

    for (const client of wss.clients) {
      client.terminate();
    }

    wsManager.dispose();
    void badgePubSub.dispose();
    githubPoller.reset();
    wss.close();
    dashboardApp.terminalWsServer = null;
    dashboardApp.badgeWsServer = null;
    dashboardApp.badgeWsManager = null;
    dashboardApp.__kbWebSocketsAttached = false;
  });
}

/** Compare two badge snapshots for equality */
function snapshotsEqual(a: BadgeSnapshot | undefined, b: BadgeSnapshot | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  
  // Compare prInfo
  if (a.prInfo?.url !== b.prInfo?.url) return false;
  if (a.prInfo?.status !== b.prInfo?.status) return false;
  if (a.prInfo?.number !== b.prInfo?.number) return false;
  if (a.prInfo?.title !== b.prInfo?.title) return false;
  
  // Compare issueInfo
  if (a.issueInfo?.url !== b.issueInfo?.url) return false;
  if (a.issueInfo?.state !== b.issueInfo?.state) return false;
  if (a.issueInfo?.number !== b.issueInfo?.number) return false;
  if (a.issueInfo?.title !== b.issueInfo?.title) return false;
  
  return true;
}

function resolveBadgeRepo(url: string, store: TaskStore): { owner: string; repo: string } | null {
  const parsedUrl = parseGitHubBadgeUrl(url);
  if (parsedUrl) {
    return parsedUrl;
  }

  const envRepo = process.env.GITHUB_REPOSITORY;
  if (envRepo) {
    const [owner, repo] = envRepo.split("/");
    if (owner && repo) {
      return { owner, repo };
    }
  }

  return getCurrentGitHubRepo(store.getRootDir());
}

function parseGitHubBadgeUrl(url: string): { owner: string; repo: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") {
      return null;
    }

    const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !repo) {
      return null;
    }

    return { owner, repo };
  } catch {
    return null;
  }
}
