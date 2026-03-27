import { Router } from "express";
import multer from "multer";
import { createReadStream } from "node:fs";
import type { TaskStore, Column, MergeResult } from "@hai/core";
import { COLUMNS } from "@hai/core";
import type { ServerOptions } from "./server.js";

/**
 * Minimal interface matching pi-coding-agent's ModelRegistry API surface
 * used by the models route. Avoids a direct dependency on the pi-coding-agent package.
 */
export interface ModelRegistryLike {
  /** Reload models from disk to pick up changes. */
  refresh(): void;
  /** Get models that have auth configured. */
  getAvailable(): Array<{ id: string; name: string; provider: string; reasoning: boolean; contextWindow: number }>;
}

/**
 * Minimal interface matching pi-coding-agent's AuthStorage API surface
 * used by the auth routes. Avoids a direct dependency on the pi-coding-agent package.
 */
export interface AuthStorageLike {
  reload(): void;
  getOAuthProviders(): Array<{ id: string; name: string }>;
  hasAuth(provider: string): boolean;
  login(
    providerId: string,
    callbacks: {
      onAuth: (info: { url: string; instructions?: string }) => void;
      onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
      onProgress?: (message: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<void>;
  logout(provider: string): void;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

export function createApiRoutes(store: TaskStore, options?: ServerOptions): Router {
  const router = Router();

  // Scheduler config (includes persisted settings)
  router.get("/config", async (_req, res) => {
    try {
      const settings = await store.getSettings();
      res.json({
        maxConcurrent: settings.maxConcurrent ?? options?.maxConcurrent ?? 2,
        maxWorktrees: settings.maxWorktrees ?? 4,
      });
    } catch {
      res.json({ maxConcurrent: options?.maxConcurrent ?? 2, maxWorktrees: 4 });
    }
  });

  // Settings CRUD
  router.get("/settings", async (_req, res) => {
    try {
      const settings = await store.getSettings();
      res.json(settings);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/settings", async (req, res) => {
    try {
      const settings = await store.updateSettings(req.body);
      res.json(settings);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Models
  registerModelsRoute(router, options?.modelRegistry);

  // List all tasks
  router.get("/tasks", async (_req, res) => {
    try {
      const tasks = await store.listTasks();
      res.json(tasks);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create task
  router.post("/tasks", async (req, res) => {
    try {
      const { title, description, column, dependencies } = req.body;
      if (!description || typeof description !== "string") {
        res.status(400).json({ error: "description is required" });
        return;
      }
      const task = await store.createTask({
        title,
        description,
        column,
        dependencies,
      });
      res.status(201).json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Move task to column
  router.post("/tasks/:id/move", async (req, res) => {
    try {
      const { column } = req.body;
      if (!column || !COLUMNS.includes(column as Column)) {
        res.status(400).json({
          error: `Invalid column. Must be one of: ${COLUMNS.join(", ")}`,
        });
        return;
      }
      const task = await store.moveTask(req.params.id, column as Column);
      res.json(task);
    } catch (err: any) {
      const status = err.message.includes("Invalid transition") ? 400 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Merge task (in-review → done, merges branch + cleans worktree)
  // Uses AI merge handler if provided, falls back to store.mergeTask
  router.post("/tasks/:id/merge", async (req, res) => {
    try {
      const merge = options?.onMerge ?? ((id: string) => store.mergeTask(id));
      const result = await merge(req.params.id);
      res.json(result);
    } catch (err: any) {
      const status = err.message.includes("Cannot merge") ? 400
        : err.message.includes("conflict") ? 409
        : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Retry failed task
  router.post("/tasks/:id/retry", async (req, res) => {
    try {
      const task = await store.getTask(req.params.id);
      if (task.column !== "in-progress" || task.status !== "failed") {
        res.status(400).json({ error: "Task is not in a failed state" });
        return;
      }
      await store.updateTask(req.params.id, { status: undefined });
      await store.logEntry(req.params.id, "Retry requested from dashboard");
      const updated = await store.moveTask(req.params.id, "todo");
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Upload attachment
  router.post("/tasks/:id/attachments", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "No file provided" });
        return;
      }
      const attachment = await store.addAttachment(
        req.params.id as string,
        req.file.originalname,
        req.file.buffer,
        req.file.mimetype,
      );
      res.status(201).json(attachment);
    } catch (err: any) {
      const status = err.message.includes("Invalid mime type") || err.message.includes("File too large") ? 400 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Download attachment
  router.get("/tasks/:id/attachments/:filename", async (req, res) => {
    try {
      const { path, mimeType } = await store.getAttachment(req.params.id, req.params.filename);
      res.setHeader("Content-Type", mimeType);
      createReadStream(path).pipe(res);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        res.status(404).json({ error: "Attachment not found" });
      } else {
        res.status(500).json({ error: err.message });
      }
    }
  });

  // Delete attachment
  router.delete("/tasks/:id/attachments/:filename", async (req, res) => {
    try {
      const task = await store.deleteAttachment(req.params.id, req.params.filename);
      res.json(task);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        res.status(404).json({ error: "Attachment not found" });
      } else {
        res.status(500).json({ error: err.message });
      }
    }
  });

  // Get historical agent logs for a task
  router.get("/tasks/:id/logs", async (req, res) => {
    try {
      const logs = await store.getAgentLogs(req.params.id);
      res.json(logs);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        res.status(404).json({ error: `Task ${req.params.id} not found` });
      } else {
        res.status(500).json({ error: err.message });
      }
    }
  });

  // Get single task with prompt content
  router.get("/tasks/:id", async (req, res) => {
    try {
      const task = await store.getTask(req.params.id);
      res.json(task);
    } catch (err: any) {
      // ENOENT means the task directory/file genuinely doesn't exist → 404.
      // Any other error (e.g. JSON parse failure from a concurrent partial write,
      // or a transient FS error) should surface as 500 so clients can retry.
      if (err.code === "ENOENT") {
        res.status(404).json({ error: `Task ${req.params.id} not found` });
      } else {
        res.status(500).json({ error: err.message || "Internal server error" });
      }
    }
  });

  // Pause task
  router.post("/tasks/:id/pause", async (req, res) => {
    try {
      const task = await store.pauseTask(req.params.id, true);
      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Unpause task
  router.post("/tasks/:id/unpause", async (req, res) => {
    try {
      const task = await store.pauseTask(req.params.id, false);
      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update task
  router.patch("/tasks/:id", async (req, res) => {
    try {
      const { title, description, prompt, dependencies } = req.body;
      const task = await store.updateTask(req.params.id, {
        title,
        description,
        prompt,
        dependencies,
      });
      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete task
  router.delete("/tasks/:id", async (req, res) => {
    try {
      const task = await store.deleteTask(req.params.id);
      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- Auth routes ----------
  registerAuthRoutes(router, options?.authStorage);

  return router;
}

/**
 * Register the GET /api/models route.
 * Returns available AI models from the ModelRegistry for the UI model selector.
 * If no ModelRegistry is provided, returns an empty array.
 */
function registerModelsRoute(router: Router, modelRegistry?: ModelRegistryLike): void {
  router.get("/models", (_req, res) => {
    try {
      if (!modelRegistry) {
        res.json([]);
        return;
      }
      modelRegistry.refresh();
      const models = modelRegistry.getAvailable().map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
      }));
      res.json(models);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}

/**
 * Register authentication status, login, and logout routes.
 * Uses pi-coding-agent's AuthStorage for credential management.
 * If no AuthStorage is provided, creates one internally (reads from ~/.pi/agent/auth.json).
 */
function registerAuthRoutes(router: Router, authStorage?: AuthStorageLike): void {
  // Use injected AuthStorage or fail gracefully if not provided.
  // When running via the CLI/engine, AuthStorage is passed in via ServerOptions.
  function getAuthStorage(): AuthStorageLike {
    if (!authStorage) {
      throw new Error("Authentication is not configured");
    }
    return authStorage;
  }

  /**
   * Track in-progress login flows to prevent concurrent logins for the same provider.
   * Maps provider ID → AbortController for the active login.
   */
  const loginInProgress = new Map<string, AbortController>();

  /**
   * GET /api/auth/status
   * Returns list of OAuth providers with their authentication status.
   * Response: { providers: [{ id: string, name: string, authenticated: boolean }] }
   */
  router.get("/auth/status", (_req, res) => {
    try {
      const storage = getAuthStorage();
      storage.reload();
      const oauthProviders = storage.getOAuthProviders();
      const providers = oauthProviders.map((p) => ({
        id: p.id,
        name: p.name,
        authenticated: storage.hasAuth(p.id),
      }));
      res.json({ providers });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/auth/login
   * Initiates OAuth login for a provider.
   * Body: { provider: string }
   * Response: { url: string, instructions?: string }
   *
   * The endpoint starts the OAuth flow and returns the auth URL from the
   * onAuth callback. The client should open this URL in a new tab and
   * poll GET /api/auth/status to detect completion.
   */
  router.post("/auth/login", async (req, res) => {
    try {
      const { provider } = req.body;
      if (!provider || typeof provider !== "string") {
        res.status(400).json({ error: "provider is required" });
        return;
      }

      // Prevent concurrent logins for the same provider
      if (loginInProgress.has(provider)) {
        res.status(409).json({ error: `Login already in progress for ${provider}` });
        return;
      }

      const storage = getAuthStorage();
      const oauthProviders = storage.getOAuthProviders();
      const found = oauthProviders.find((p) => p.id === provider);
      if (!found) {
        res.status(400).json({ error: `Unknown provider: ${provider}` });
        return;
      }

      const abortController = new AbortController();
      loginInProgress.set(provider, abortController);

      // We need to get the URL from the onAuth callback before responding.
      // The login() call continues in the background until the user completes OAuth.
      let authResolve: (info: { url: string; instructions?: string }) => void;
      let authReject: (err: Error) => void;
      const authUrlPromise = new Promise<{ url: string; instructions?: string }>((resolve, reject) => {
        authResolve = resolve;
        authReject = reject;
      });

      // Start login flow in background — don't await the full login
      const loginPromise = storage.login(provider, {
        onAuth: (info) => {
          authResolve({ url: info.url, instructions: info.instructions });
        },
        onPrompt: async (prompt) => {
          // Web UI cannot interactively prompt — return empty string if allowed
          if (prompt.allowEmpty) return "";
          return prompt.placeholder || "";
        },
        onProgress: () => {}, // no-op for web UI
        signal: abortController.signal,
      });

      // Race: either we get the auth URL or the login completes/fails first
      const timeout = setTimeout(() => {
        authReject(new Error("Login initiation timed out"));
      }, 30_000);

      loginPromise
        .then(() => {
          // Login completed (user finished OAuth in browser)
        })
        .catch((err) => {
          // Login failed — also reject auth URL if not yet received
          authReject(err);
        })
        .finally(() => {
          clearTimeout(timeout);
          loginInProgress.delete(provider);
        });

      const authInfo = await authUrlPromise;
      clearTimeout(timeout);
      res.json({ url: authInfo.url, instructions: authInfo.instructions });
    } catch (err: any) {
      // Clean up on error
      const provider = req.body?.provider;
      if (provider) loginInProgress.delete(provider);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/auth/logout
   * Removes credentials for a provider.
   * Body: { provider: string }
   * Response: { success: true }
   */
  router.post("/auth/logout", (req, res) => {
    try {
      const { provider } = req.body;
      if (!provider || typeof provider !== "string") {
        res.status(400).json({ error: "provider is required" });
        return;
      }

      const storage = getAuthStorage();
      storage.logout(provider);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
