import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import { createApiRoutes } from "./routes.js";
import type { TaskStore, TaskAttachment } from "@hai/core";
import type { TaskDetail } from "@hai/core";
import type { AuthStorageLike, ModelRegistryLike } from "./routes.js";

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn(),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as TaskStore;
}

const FAKE_TASK_DETAIL: TaskDetail = {
  id: "HAI-001",
  description: "Test task",
  column: "in-progress",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  prompt: "# HAI-001\n\nTest task",
};

/** Helper: send GET and return { status, body } */
async function GET(app: express.Express, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      http.get(`http://127.0.0.1:${addr.port}${path}`, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          server.close();
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, body: data });
          }
        });
      }).on("error", (err) => { server.close(); reject(err); });
    });
  });
}

/** Helper: send a request with method/body and return { status, body } */
async function REQUEST(
  app: express.Express,
  method: string,
  path: string,
  body?: Buffer | string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const url = new URL(`http://127.0.0.1:${addr.port}${path}`);
      const req = http.request(
        { hostname: url.hostname, port: url.port, path: url.pathname, method, headers },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            server.close();
            try {
              resolve({ status: res.statusCode!, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode!, body: data });
            }
          });
        },
      );
      req.on("error", (err) => { server.close(); reject(err); });
      if (body) req.write(body);
      req.end();
    });
  });
}

/** Build a minimal multipart/form-data body */
function buildMultipart(fieldName: string, filename: string, contentType: string, content: Buffer): { body: Buffer; boundary: string } {
  const boundary = "----TestBoundary" + Date.now();
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(header), content, Buffer.from(footer)]);
  return { body, boundary };
}

describe("GET /tasks/:id", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("returns task detail on success", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_TASK_DETAIL);

    const res = await GET(buildApp(), "/api/tasks/HAI-001");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("HAI-001");
    expect(res.body.prompt).toBe("# HAI-001\n\nTest task");
  });

  it("returns 404 when task genuinely does not exist (ENOENT)", async () => {
    const err: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory");
    err.code = "ENOENT";
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const res = await GET(buildApp(), "/api/tasks/HAI-999");

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("returns 500 on transient/unexpected errors (non-ENOENT)", async () => {
    const err = new Error("Unexpected end of JSON input");
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const res = await GET(buildApp(), "/api/tasks/HAI-001");

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Unexpected end of JSON input");
  });
});

describe("POST /tasks/:id/retry", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("retries a failed task and moves it to todo", async () => {
    const failedTask = { ...FAKE_TASK_DETAIL, status: "failed" };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "todo", status: undefined };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(failedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(failedTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/HAI-001/retry", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("HAI-001", { status: undefined });
    expect(store.moveTask).toHaveBeenCalledWith("HAI-001", "todo");
  });

  it("returns 400 when task is not in failed state", async () => {
    const activeTask = { ...FAKE_TASK_DETAIL, status: "executing" };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(activeTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/HAI-001/retry", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not in a failed state");
  });

  it("returns 400 when task is not in in-progress column", async () => {
    const doneTask = { ...FAKE_TASK_DETAIL, column: "done", status: "failed" };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(doneTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/HAI-001/retry", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not in a failed state");
  });
});

describe("PATCH /tasks/:id", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("forwards dependencies to store.updateTask", async () => {
    const updatedTask = { ...FAKE_TASK_DETAIL, dependencies: ["HAI-002"] };
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTask);

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/HAI-001", JSON.stringify({ dependencies: ["HAI-002"] }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("HAI-001", {
      title: undefined,
      description: undefined,
      prompt: undefined,
      dependencies: ["HAI-002"],
    });
    expect(res.body.dependencies).toEqual(["HAI-002"]);
  });

  it("forwards title and description without dependencies", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FAKE_TASK_DETAIL, title: "New" });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/HAI-001", JSON.stringify({ title: "New" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("HAI-001", {
      title: "New",
      description: undefined,
      prompt: undefined,
      dependencies: undefined,
    });
  });
});

describe("Attachment routes", () => {
  const FAKE_ATTACHMENT: TaskAttachment = {
    filename: "1234-screenshot.png",
    originalName: "screenshot.png",
    mimeType: "image/png",
    size: 100,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      addAttachment: vi.fn().mockResolvedValue(FAKE_ATTACHMENT),
      getAttachment: vi.fn(),
      deleteAttachment: vi.fn().mockResolvedValue({ ...FAKE_TASK_DETAIL, attachments: [] }),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("POST /tasks/:id/attachments — uploads a valid image", async () => {
    const content = Buffer.from("fake png content");
    const { body, boundary } = buildMultipart("file", "screenshot.png", "image/png", content);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/HAI-001/attachments", body, {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    });

    expect(res.status).toBe(201);
    expect(res.body.filename).toBe("1234-screenshot.png");
    expect((store.addAttachment as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "HAI-001",
      "screenshot.png",
      expect.any(Buffer),
      "image/png",
    );
  });

  it("POST /tasks/:id/attachments — returns 400 for invalid mime type", async () => {
    (store.addAttachment as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Invalid mime type 'text/plain'. Allowed: image/png, image/jpeg, image/gif, image/webp"),
    );

    const content = Buffer.from("not an image");
    const { body, boundary } = buildMultipart("file", "file.txt", "text/plain", content);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/HAI-001/attachments", body, {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid mime type");
  });

  it("POST /tasks/:id/attachments — returns 400 for oversized file", async () => {
    (store.addAttachment as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("File too large"),
    );

    const content = Buffer.from("small but store rejects");
    const { body, boundary } = buildMultipart("file", "big.png", "image/png", content);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/HAI-001/attachments", body, {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("File too large");
  });

  it("DELETE /tasks/:id/attachments/:filename — deletes attachment", async () => {
    const res = await REQUEST(buildApp(), "DELETE", "/api/tasks/HAI-001/attachments/1234-screenshot.png");

    expect(res.status).toBe(200);
    expect((store.deleteAttachment as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("HAI-001", "1234-screenshot.png");
  });

  it("DELETE /tasks/:id/attachments/:filename — returns 404 for missing", async () => {
    const err: NodeJS.ErrnoException = new Error("Attachment not found");
    err.code = "ENOENT";
    (store.deleteAttachment as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const res = await REQUEST(buildApp(), "DELETE", "/api/tasks/HAI-001/attachments/nope.png");

    expect(res.status).toBe(404);
  });

  it("GET /tasks/:id/logs — returns agent logs", async () => {
    const fakeLogs = [
      { timestamp: "2026-01-01T00:00:00Z", taskId: "HAI-001", text: "Hello", type: "text" },
      { timestamp: "2026-01-01T00:00:01Z", taskId: "HAI-001", text: "Read", type: "tool" },
    ];
    (store.getAgentLogs as ReturnType<typeof vi.fn>).mockResolvedValue(fakeLogs);

    const res = await GET(buildApp(), "/api/tasks/HAI-001/logs");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fakeLogs);
    expect(store.getAgentLogs).toHaveBeenCalledWith("HAI-001");
  });

  it("GET /tasks/:id/logs — returns empty array when no logs", async () => {
    (store.getAgentLogs as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const res = await GET(buildApp(), "/api/tasks/HAI-001/logs");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("GET /tasks/:id/logs — returns 500 on store error", async () => {
    (store.getAgentLogs as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("disk error"));

    const res = await GET(buildApp(), "/api/tasks/HAI-001/logs");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("disk error");
  });
});

// --- Models route tests ---

function createMockModelRegistry(overrides: Partial<ModelRegistryLike> = {}): ModelRegistryLike {
  return {
    refresh: vi.fn(),
    getAvailable: vi.fn().mockReturnValue([
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", reasoning: true, contextWindow: 200000 },
      { id: "gpt-4o", name: "GPT-4o", provider: "openai", reasoning: false, contextWindow: 128000 },
    ]),
    ...overrides,
  };
}

describe("GET /models", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore();
  });

  function buildApp(modelRegistry?: ModelRegistryLike) {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { modelRegistry }));
    return app;
  }

  it("returns available models from registry", async () => {
    const modelRegistry = createMockModelRegistry();
    const res = await GET(buildApp(modelRegistry), "/api/models");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ]);
    expect(modelRegistry.refresh).toHaveBeenCalled();
  });

  it("returns empty array when no model registry is provided", async () => {
    const res = await GET(buildApp(), "/api/models");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns empty array when registry has no available models", async () => {
    const modelRegistry = createMockModelRegistry({
      getAvailable: vi.fn().mockReturnValue([]),
    });
    const res = await GET(buildApp(modelRegistry), "/api/models");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 500 when registry throws", async () => {
    const modelRegistry = createMockModelRegistry({
      getAvailable: vi.fn().mockImplementation(() => {
        throw new Error("registry error");
      }),
    });
    const res = await GET(buildApp(modelRegistry), "/api/models");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("registry error");
  });
});

// --- Auth route tests ---

function createMockAuthStorage(overrides: Partial<AuthStorageLike> = {}): AuthStorageLike {
  return {
    reload: vi.fn(),
    getOAuthProviders: vi.fn().mockReturnValue([
      { id: "anthropic", name: "Anthropic" },
    ]),
    hasAuth: vi.fn().mockReturnValue(false),
    login: vi.fn().mockImplementation((_provider: string, callbacks: any) => {
      // Simulate onAuth callback with a URL, then resolve
      callbacks.onAuth({ url: "https://auth.example.com/login", instructions: "Open in browser" });
      return Promise.resolve();
    }),
    logout: vi.fn(),
    ...overrides,
  } as unknown as AuthStorageLike;
}

describe("GET /auth/status", () => {
  let store: TaskStore;
  let authStorage: AuthStorageLike;

  beforeEach(() => {
    store = createMockStore();
    authStorage = createMockAuthStorage();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { authStorage }));
    return app;
  }

  it("returns provider list with auth status", async () => {
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const res = await GET(buildApp(), "/api/auth/status");

    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual([
      { id: "anthropic", name: "Anthropic", authenticated: true },
    ]);
    expect(authStorage.reload).toHaveBeenCalled();
  });

  it("returns unauthenticated status", async () => {
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const res = await GET(buildApp(), "/api/auth/status");

    expect(res.status).toBe(200);
    expect(res.body.providers[0].authenticated).toBe(false);
  });

  it("returns 500 on error", async () => {
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("storage error");
    });

    const res = await GET(buildApp(), "/api/auth/status");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("storage error");
  });
});

describe("POST /auth/login", () => {
  let store: TaskStore;
  let authStorage: AuthStorageLike;

  beforeEach(() => {
    store = createMockStore();
    authStorage = createMockAuthStorage();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { authStorage }));
    return app;
  }

  it("returns auth URL for valid provider", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/login", JSON.stringify({ provider: "anthropic" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://auth.example.com/login");
    expect(res.body.instructions).toBe("Open in browser");
  });

  it("returns 400 when provider is missing", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/login", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("provider is required");
  });

  it("returns 400 for unknown provider", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/login", JSON.stringify({ provider: "unknown" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unknown provider");
  });

  it("returns 500 when login fails", async () => {
    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation((_provider: string, callbacks: any) => {
      return Promise.reject(new Error("OAuth failed"));
    });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/login", JSON.stringify({ provider: "anthropic" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("OAuth failed");
  });
});

describe("POST /auth/logout", () => {
  let store: TaskStore;
  let authStorage: AuthStorageLike;

  beforeEach(() => {
    store = createMockStore();
    authStorage = createMockAuthStorage();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { authStorage }));
    return app;
  }

  it("removes credentials for a provider", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/logout", JSON.stringify({ provider: "anthropic" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(authStorage.logout).toHaveBeenCalledWith("anthropic");
  });

  it("returns 400 when provider is missing", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/logout", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("provider is required");
  });

  it("returns 500 on error", async () => {
    (authStorage.logout as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("logout failed");
    });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/logout", JSON.stringify({ provider: "anthropic" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("logout failed");
  });
});

describe("Pause/Unpause endpoints", () => {
  let store: TaskStore;
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  beforeEach(() => {
    store = createMockStore({
      pauseTask: vi.fn().mockResolvedValue({ id: "HAI-001", paused: true }),
    });
  });

  it("POST /tasks/:id/pause — pauses a task", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/HAI-001/pause");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "HAI-001", paused: true });
    expect(store.pauseTask).toHaveBeenCalledWith("HAI-001", true);
  });

  it("POST /tasks/:id/unpause — unpauses a task", async () => {
    (store.pauseTask as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "HAI-001" });
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/HAI-001/unpause");
    expect(res.status).toBe(200);
    expect(store.pauseTask).toHaveBeenCalledWith("HAI-001", false);
  });

  it("POST /tasks/:id/pause — returns 500 on error", async () => {
    (store.pauseTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("not found"));
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/HAI-001/pause");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("not found");
  });
});
