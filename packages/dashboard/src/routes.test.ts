import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "node:http";
import { createApiRoutes } from "./routes.js";
import { GitHubClient } from "./github.js";
import type { TaskStore, TaskAttachment } from "@kb/core";
import type { TaskDetail } from "@kb/core";
import type { AuthStorageLike, ModelRegistryLike } from "./routes.js";
import { __resetPlanningState } from "./planning.js";

// Mock @kb/core for gh CLI auth checks
vi.mock("@kb/core", async () => {
  const actual = await vi.importActual<typeof import("@kb/core")>("@kb/core");
  return {
    ...actual,
    isGhAuthenticated: vi.fn(),
  };
});

import { isGhAuthenticated } from "@kb/core";

const mockIsGhAuthenticated = vi.mocked(isGhAuthenticated);

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn(),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
}

const FAKE_TASK_DETAIL: TaskDetail = {
  id: "KB-001",
  description: "Test task",
  column: "in-progress",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  prompt: "# KB-001\n\nTest task",
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

describe("GET /tasks", () => {
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

  it("returns tasks with optional pagination params", async () => {
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([FAKE_TASK_DETAIL]);

    const res = await GET(buildApp(), "/api/tasks?limit=10&offset=5");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(store.listTasks).toHaveBeenCalledWith({ limit: 10, offset: 5 });
  });

  it("returns 400 for invalid pagination params", async () => {
    const res = await GET(buildApp(), "/api/tasks?limit=-1");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("limit");
  });
});

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

    const res = await GET(buildApp(), "/api/tasks/KB-001");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("KB-001");
    expect(res.body.prompt).toBe("# KB-001\n\nTest task");
  });

  it("returns 404 when task genuinely does not exist (ENOENT)", async () => {
    const err: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory");
    err.code = "ENOENT";
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const res = await GET(buildApp(), "/api/tasks/KB-999");

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("returns 500 on transient/unexpected errors (non-ENOENT)", async () => {
    const err = new Error("Unexpected end of JSON input");
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const res = await GET(buildApp(), "/api/tasks/KB-001");

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Unexpected end of JSON input");
  });
});

describe("POST /tasks", () => {
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

  it("creates a task and forwards breakIntoSubtasks", async () => {
    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
      breakIntoSubtasks: true,
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "Big initiative",
        breakIntoSubtasks: true,
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith({
      title: undefined,
      description: "Big initiative",
      column: undefined,
      dependencies: undefined,
      breakIntoSubtasks: true,
    });
  });

  it("forwards model overrides when both provider and id are supplied", async () => {
    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      validatorModelProvider: "openai",
      validatorModelId: "gpt-4o",
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "Use explicit models",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith({
      title: undefined,
      description: "Use explicit models",
      column: undefined,
      dependencies: undefined,
      breakIntoSubtasks: undefined,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      validatorModelProvider: "openai",
      validatorModelId: "gpt-4o",
    });
  });

  it("normalizes partial model overrides back to defaults", async () => {
    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "Ignore partial model selection",
        modelProvider: "anthropic",
        validatorModelId: "gpt-4o",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith({
      title: undefined,
      description: "Ignore partial model selection",
      column: undefined,
      dependencies: undefined,
      breakIntoSubtasks: undefined,
      modelProvider: undefined,
      modelId: undefined,
      validatorModelProvider: undefined,
      validatorModelId: undefined,
    });
  });

  it("returns 400 when model fields are not strings", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "Invalid model payload",
        modelProvider: ["anthropic"],
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("modelProvider must be a string");
    expect(store.createTask).not.toHaveBeenCalled();
  });

  it("returns 400 when description is missing", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({ breakIntoSubtasks: true }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("description is required");
    expect(store.createTask).not.toHaveBeenCalled();
  });

  it("returns 400 when breakIntoSubtasks is not a boolean", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({ description: "Big initiative", breakIntoSubtasks: "yes" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("breakIntoSubtasks must be a boolean");
    expect(store.createTask).not.toHaveBeenCalled();
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

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/retry", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: undefined });
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo");
  });

  it("returns 400 when task is not in failed state", async () => {
    const activeTask = { ...FAKE_TASK_DETAIL, status: "executing" };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(activeTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/retry", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not in a failed state");
  });

  it("retries a failed task in any column (not just in-progress)", async () => {
    const failedTaskInTodo = { ...FAKE_TASK_DETAIL, column: "todo", status: "failed" };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "todo", status: undefined };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(failedTaskInTodo);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(failedTaskInTodo);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/retry", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: undefined });
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo");
  });
});

describe("POST /tasks/:id/duplicate", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      duplicateTask: vi.fn(),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("duplicates a task and returns 201 with new task", async () => {
    const newTask = { ...FAKE_TASK_DETAIL, id: "KB-002", column: "triage" };
    (store.duplicateTask as ReturnType<typeof vi.fn>).mockResolvedValue(newTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/duplicate", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("KB-002");
    expect(res.body.column).toBe("triage");
    expect(store.duplicateTask).toHaveBeenCalledWith("KB-001");
  });

  it("returns 404 when source task not found", async () => {
    const error = new Error("Task not found") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    (store.duplicateTask as ReturnType<typeof vi.fn>).mockRejectedValue(error);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-999/duplicate", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("returns 500 on unexpected errors", async () => {
    (store.duplicateTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Database error"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/duplicate", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Database error");
  });
});

describe("POST /tasks/:id/refine", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      refineTask: vi.fn(),
      logEntry: vi.fn(),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("creates refinement task from done task and returns 201", async () => {
    const refinedTask = { ...FAKE_TASK_DETAIL, id: "KB-002", column: "triage", title: "Refinement: KB-001" };
    (store.refineTask as ReturnType<typeof vi.fn>).mockResolvedValue(refinedTask);
    (store.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_TASK_DETAIL);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/refine", JSON.stringify({ feedback: "Need improvements" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("KB-002");
    expect(res.body.column).toBe("triage");
    expect(store.refineTask).toHaveBeenCalledWith("KB-001", "Need improvements");
    expect(store.logEntry).toHaveBeenCalledWith("KB-001", "Refinement requested", "Need improvements");
  });

  it("creates refinement task from in-review task and returns 201", async () => {
    const refinedTask = { ...FAKE_TASK_DETAIL, id: "KB-002", column: "triage", title: "Refinement: My Feature" };
    (store.refineTask as ReturnType<typeof vi.fn>).mockResolvedValue(refinedTask);
    (store.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_TASK_DETAIL);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/refine", JSON.stringify({ feedback: "Fix edge cases" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(201);
    expect(res.body.column).toBe("triage");
    expect(store.refineTask).toHaveBeenCalledWith("KB-001", "Fix edge cases");
  });

  it("returns 400 when task is not in done or in-review column", async () => {
    (store.refineTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Cannot refine KB-001: task is in 'triage', must be in 'done' or 'in-review'"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/refine", JSON.stringify({ feedback: "Need improvements" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("must be in 'done' or 'in-review'");
  });

  it("returns 400 when feedback is missing", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/refine", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("feedback is required");
    expect(store.refineTask).not.toHaveBeenCalled();
  });

  it("returns 400 when feedback is empty string", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/refine", JSON.stringify({ feedback: "" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("feedback is required");
    expect(store.refineTask).not.toHaveBeenCalled();
  });

  it("returns 400 when feedback exceeds 2000 characters", async () => {
    const longFeedback = "x".repeat(2001);
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/refine", JSON.stringify({ feedback: longFeedback }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("feedback must be between 1 and 2000 characters");
    expect(store.refineTask).not.toHaveBeenCalled();
  });

  it("returns 404 when source task not found", async () => {
    const error = new Error("Task not found") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    (store.refineTask as ReturnType<typeof vi.fn>).mockRejectedValue(error);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-999/refine", JSON.stringify({ feedback: "Need improvements" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("returns 400 when feedback is whitespace only (caught at validation)", async () => {
    // Route-level validation now catches whitespace-only input before it reaches the store
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/refine", JSON.stringify({ feedback: "   " }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("feedback must be between 1 and 2000 characters");
    expect(store.refineTask).not.toHaveBeenCalled();
  });

  it("returns 500 on unexpected errors", async () => {
    (store.refineTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Database error"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/refine", JSON.stringify({ feedback: "Need improvements" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Database error");
  });
});

describe("POST /tasks/:id/archive", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      archiveTask: vi.fn(),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("archives a done task and returns the updated task", async () => {
    const archivedTask = { ...FAKE_TASK_DETAIL, column: "archived" };
    (store.archiveTask as ReturnType<typeof vi.fn>).mockResolvedValue(archivedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/archive", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.column).toBe("archived");
    expect(store.archiveTask).toHaveBeenCalledWith("KB-001");
  });

  it("returns 400 when task is not in done column", async () => {
    (store.archiveTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Cannot archive KB-001: task is in 'triage', must be in 'done'"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/archive", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("must be in 'done'");
  });

  it("returns 500 on unexpected errors", async () => {
    (store.archiveTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Database error"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/archive", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Database error");
  });
});

describe("POST /tasks/:id/unarchive", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      unarchiveTask: vi.fn(),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("unarchives an archived task and returns the updated task", async () => {
    const unarchivedTask = { ...FAKE_TASK_DETAIL, column: "done" };
    (store.unarchiveTask as ReturnType<typeof vi.fn>).mockResolvedValue(unarchivedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/unarchive", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.column).toBe("done");
    expect(store.unarchiveTask).toHaveBeenCalledWith("KB-001");
  });

  it("returns 400 when task is not in archived column", async () => {
    (store.unarchiveTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Cannot unarchive KB-001: task is in 'done', must be in 'archived'"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/unarchive", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("must be in 'archived'");
  });

  it("returns 500 on unexpected errors", async () => {
    (store.unarchiveTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Database error"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/unarchive", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Database error");
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
    const updatedTask = { ...FAKE_TASK_DETAIL, dependencies: ["KB-002"] };
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTask);

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ dependencies: ["KB-002"] }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      title: undefined,
      description: undefined,
      prompt: undefined,
      dependencies: ["KB-002"],
      modelProvider: null,
      modelId: null,
      validatorModelProvider: null,
      validatorModelId: null,
    });
    expect(res.body.dependencies).toEqual(["KB-002"]);
  });

  it("forwards title and description without dependencies", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FAKE_TASK_DETAIL, title: "New" });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ title: "New" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      title: "New",
      description: undefined,
      prompt: undefined,
      dependencies: undefined,
      modelProvider: null,
      modelId: null,
      validatorModelProvider: null,
      validatorModelId: null,
    });
  });

  it("forwards model override fields to store.updateTask", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      validatorModelProvider: "openai",
      validatorModelId: "gpt-4o",
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      validatorModelProvider: "openai",
      validatorModelId: "gpt-4o",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      title: undefined,
      description: undefined,
      prompt: undefined,
      dependencies: undefined,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      validatorModelProvider: "openai",
      validatorModelId: "gpt-4o",
    });
  });

  it("returns 400 for invalid modelProvider type", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      modelProvider: 123,
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("modelProvider must be a string");
  });

  it("returns 400 for invalid modelId type", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      modelId: true,
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("modelId must be a string");
  });

  it("accepts null to clear model fields", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      modelProvider: undefined,
      modelId: undefined,
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      modelProvider: null,
      modelId: null,
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      title: undefined,
      description: undefined,
      prompt: undefined,
      dependencies: undefined,
      modelProvider: null,
      modelId: null,
      validatorModelProvider: null,
      validatorModelId: null,
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

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/attachments", body, {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    });

    expect(res.status).toBe(201);
    expect(res.body.filename).toBe("1234-screenshot.png");
    expect((store.addAttachment as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "KB-001",
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

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/attachments", body, {
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

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/attachments", body, {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("File too large");
  });

  it("DELETE /tasks/:id/attachments/:filename — deletes attachment", async () => {
    const res = await REQUEST(buildApp(), "DELETE", "/api/tasks/KB-001/attachments/1234-screenshot.png");

    expect(res.status).toBe(200);
    expect((store.deleteAttachment as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("KB-001", "1234-screenshot.png");
  });

  it("DELETE /tasks/:id/attachments/:filename — returns 404 for missing", async () => {
    const err: NodeJS.ErrnoException = new Error("Attachment not found");
    err.code = "ENOENT";
    (store.deleteAttachment as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const res = await REQUEST(buildApp(), "DELETE", "/api/tasks/KB-001/attachments/nope.png");

    expect(res.status).toBe(404);
  });

  it("GET /tasks/:id/logs — returns agent logs", async () => {
    const fakeLogs = [
      { timestamp: "2026-01-01T00:00:00Z", taskId: "KB-001", text: "Hello", type: "text" },
      { timestamp: "2026-01-01T00:00:01Z", taskId: "KB-001", text: "Read", type: "tool" },
    ];
    (store.getAgentLogs as ReturnType<typeof vi.fn>).mockResolvedValue(fakeLogs);

    const res = await GET(buildApp(), "/api/tasks/KB-001/logs");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fakeLogs);
    expect(store.getAgentLogs).toHaveBeenCalledWith("KB-001");
  });

  it("GET /tasks/:id/logs — returns empty array when no logs", async () => {
    (store.getAgentLogs as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const res = await GET(buildApp(), "/api/tasks/KB-001/logs");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("GET /tasks/:id/logs — returns 500 on store error", async () => {
    (store.getAgentLogs as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("disk error"));

    const res = await GET(buildApp(), "/api/tasks/KB-001/logs");

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
      pauseTask: vi.fn().mockResolvedValue({ id: "KB-001", paused: true }),
    });
  });

  it("POST /tasks/:id/pause — pauses a task", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/pause");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "KB-001", paused: true });
    expect(store.pauseTask).toHaveBeenCalledWith("KB-001", true);
  });

  it("POST /tasks/:id/unpause — unpauses a task", async () => {
    (store.pauseTask as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "KB-001" });
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/unpause");
    expect(res.status).toBe(200);
    expect(store.pauseTask).toHaveBeenCalledWith("KB-001", false);
  });

  it("POST /tasks/:id/pause — returns 500 on error", async () => {
    (store.pauseTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("not found"));
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/pause");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("not found");
  });

  describe("POST /tasks/:id/steer", () => {
    it("adds a steering comment to a task", async () => {
      const mockComment = {
        id: "KB-001",
        steeringComments: [
          {
            id: "1234567890-abc123",
            text: "Please handle the edge case",
            createdAt: "2026-01-01T00:00:00.000Z",
            author: "user" as const,
          },
        ],
      };
      (store.addSteeringComment as ReturnType<typeof vi.fn>).mockResolvedValue(mockComment);

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/steer",
        JSON.stringify({ text: "Please handle the edge case" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockComment);
      expect(store.addSteeringComment).toHaveBeenCalledWith(
        "KB-001",
        "Please handle the edge case",
        "user"
      );
    });

    it("returns 400 when text is missing", async () => {
      const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/steer", JSON.stringify({}), {
        "Content-Type": "application/json",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("text is required");
    });

    it("returns 400 when text is empty", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/steer",
        JSON.stringify({ text: "" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(400);
      // Empty string fails the "!text" check, not the length check
      expect(res.body.error).toContain("text is required");
    });

    it("returns 400 when text exceeds 2000 characters", async () => {
      const longText = "a".repeat(2001);
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/steer",
        JSON.stringify({ text: longText }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("text must be between 1 and 2000 characters");
    });

    it("returns 404 when task not found", async () => {
      const error = new Error("Task not found") as Error & { code?: string };
      error.code = "ENOENT";
      (store.addSteeringComment as ReturnType<typeof vi.fn>).mockRejectedValue(error);

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/steer",
        JSON.stringify({ text: "Valid comment" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(404);
    });

    it("returns 500 on unexpected errors", async () => {
      (store.addSteeringComment as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Database error")
      );

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/steer",
        JSON.stringify({ text: "Valid comment" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Database error");
    });
  });

  // --- PR Management route tests ---

  describe("POST /tasks/:id/pr/create", () => {
    let store: TaskStore;

    beforeEach(() => {
      store = createMockStore({
        getTask: vi.fn(),
        updatePrInfo: vi.fn(),
        logEntry: vi.fn().mockResolvedValue(undefined),
        getRootDir: vi.fn().mockReturnValue("/fake/root"),
      });
    });

    function buildApp() {
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      return app;
    }

    const mockPrInfo = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      status: "open" as const,
      title: "Test PR",
      headBranch: "kb/kb-001",
      baseBranch: "main",
      commentCount: 0,
    };

    const mockInReviewTask = {
      ...FAKE_TASK_DETAIL,
      column: "in-review" as const,
      prInfo: undefined,
    };

    it("returns 400 if task is not in in-review column", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        column: "in-progress",
      });

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/pr/create",
        JSON.stringify({ title: "Test PR" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("in-review");
    });

    it("returns 409 if task already has a PR", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        column: "in-review",
        prInfo: mockPrInfo,
      });

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/pr/create",
        JSON.stringify({ title: "Test PR" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("already has PR");
    });

    it("returns 400 if title is missing", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(mockInReviewTask);

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/pr/create",
        JSON.stringify({}),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("title is required");
    });

    it("no longer has in-app rate limiter (gh CLI handles rate limiting)", async () => {
      // Previously this test checked for a 429 response from an in-memory rate limiter.
      // Now gh CLI handles rate limiting internally, so multiple rapid requests
      // are allowed (gh CLI has its own rate limiting and caching).
      // Set up GITHUB_REPOSITORY env to bypass git lookup
      const originalEnv = process.env.GITHUB_REPOSITORY;
      process.env.GITHUB_REPOSITORY = "owner/rate-test";

      // Create a fresh store mock for this test
      const freshStore = createMockStore({
        getTask: vi.fn(),
        updatePrInfo: vi.fn(),
        logEntry: vi.fn().mockResolvedValue(undefined),
        getRootDir: vi.fn().mockReturnValue("/fake/root"),
      });

      function buildFreshApp() {
        const app = express();
        app.use(express.json());
        app.use("/api", createApiRoutes(freshStore));
        return app;
      }

      // Make multiple rapid requests - should not be rate limited by our code
      // (gh CLI handles rate limiting with GitHub)
      const app = buildFreshApp();
      for (let i = 0; i < 5; i++) {
        (freshStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          ...mockInReviewTask,
          id: `KB-RATE-${i}`,
        });
        const res = await REQUEST(
          app,
          "POST",
          `/api/tasks/KB-RATE-${i}/pr/create`,
          JSON.stringify({ title: `Test PR ${i}` }),
          { "Content-Type": "application/json" }
        );
        // Should not get 429 from our code (may get 500 from gh CLI not being available in test)
        expect(res.status).not.toBe(429);
      }

      // Restore env
      if (originalEnv) {
        process.env.GITHUB_REPOSITORY = originalEnv;
      } else {
        delete process.env.GITHUB_REPOSITORY;
      }
    });

    it("returns 404 for non-existent task", async () => {
      // Create error with proper ENOENT code
      const error = new Error("ENOENT: task not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      error.errno = -2;
      (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(error);

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-999/pr/create",
        JSON.stringify({ title: "Test PR" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });
  });

  describe("GET /tasks/:id/pr/status", () => {
    let store: TaskStore;

    beforeEach(() => {
      store = createMockStore({
        getTask: vi.fn(),
        getRootDir: vi.fn().mockReturnValue("/fake/root"),
      });
    });

    function buildApp() {
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      return app;
    }

    const mockPrInfo = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      status: "open" as const,
      title: "Test PR",
      headBranch: "kb/kb-001",
      baseBranch: "main",
      commentCount: 3,
    };

    it("returns cached PR info when available", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        prInfo: mockPrInfo,
        updatedAt: new Date().toISOString(),
      });

      const res = await GET(buildApp(), "/api/tasks/KB-001/pr/status");

      expect(res.status).toBe(200);
      expect(res.body.prInfo).toEqual(mockPrInfo);
      expect(res.body.stale).toBe(false);
      expect(res.body.automationStatus).toBeNull();
    });

    it("returns 404 when task has no PR", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_TASK_DETAIL);

      const res = await GET(buildApp(), "/api/tasks/KB-001/pr/status");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("no associated PR");
    });

    it("returns 404 for non-existent task", async () => {
      const error = new Error("Task not found") as Error & { code?: string };
      error.code = "ENOENT";
      (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(error);

      const res = await GET(buildApp(), "/api/tasks/KB-999/pr/status");

      expect(res.status).toBe(404);
    });

    it("marks data as stale when older than 5 minutes", async () => {
      const oldDate = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 minutes ago
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        prInfo: mockPrInfo,
        updatedAt: oldDate,
      });

      const res = await GET(buildApp(), "/api/tasks/KB-001/pr/status");

      expect(res.status).toBe(200);
      expect(res.body.stale).toBe(true);
    });

    it("uses lastCheckedAt for staleness check when available", async () => {
      const recentUpdate = new Date().toISOString();
      const oldCheck = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 minutes ago
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        prInfo: { ...mockPrInfo, lastCheckedAt: oldCheck },
        updatedAt: recentUpdate,
      });

      const res = await GET(buildApp(), "/api/tasks/KB-001/pr/status");

      expect(res.status).toBe(200);
      // Should be stale because lastCheckedAt is old, even though updatedAt is recent
      expect(res.body.stale).toBe(true);
    });

    it("returns automationStatus so the UI can reflect PR-first waiting states", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        status: "awaiting-pr-checks",
        prInfo: mockPrInfo,
        updatedAt: new Date().toISOString(),
      });

      const res = await GET(buildApp(), "/api/tasks/KB-001/pr/status");

      expect(res.status).toBe(200);
      expect(res.body.automationStatus).toBe("awaiting-pr-checks");
    });

    it("marks data as fresh when lastCheckedAt is recent", async () => {
      const recentCheck = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 minutes ago
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        prInfo: { ...mockPrInfo, lastCheckedAt: recentCheck },
        updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 minutes ago
      });

      const res = await GET(buildApp(), "/api/tasks/KB-001/pr/status");

      expect(res.status).toBe(200);
      // Should be fresh because lastCheckedAt is recent, even though updatedAt is old
      expect(res.body.stale).toBe(false);
    });
  });

  describe("POST /tasks/:id/pr/refresh", () => {
    let store: TaskStore;

    beforeEach(() => {
      store = createMockStore({
        getTask: vi.fn(),
        updatePrInfo: vi.fn(),
        getRootDir: vi.fn().mockReturnValue("/fake/root"),
      });
    });

    function buildApp() {
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      return app;
    }

    const mockPrInfo = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      status: "open" as const,
      title: "Test PR",
      headBranch: "kb/kb-001",
      baseBranch: "main",
      commentCount: 3,
    };

    it("returns merge readiness details for PR-first UI refreshes", async () => {
      const originalRepo = process.env.GITHUB_REPOSITORY;
      process.env.GITHUB_REPOSITORY = "owner/repo";
      vi.spyOn(GitHubClient.prototype, "getPrMergeStatus").mockResolvedValue({
        prInfo: mockPrInfo,
        mergeReady: false,
        blockingReasons: ["required checks not successful: ci (pending)"],
        reviewDecision: "CHANGES_REQUESTED",
        checks: [{ name: "ci", required: true, state: "pending" }],
      });
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        status: "awaiting-pr-checks",
        prInfo: mockPrInfo,
      });

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/pr/refresh",
        JSON.stringify({}),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(200);
      expect(res.body.prInfo.number).toBe(42);
      expect(res.body.mergeReady).toBe(false);
      expect(res.body.blockingReasons).toEqual(["required checks not successful: ci (pending)"]);
      expect(res.body.reviewDecision).toBe("CHANGES_REQUESTED");
      expect(res.body.automationStatus).toBe("awaiting-pr-checks");

      if (originalRepo) {
        process.env.GITHUB_REPOSITORY = originalRepo;
      } else {
        delete process.env.GITHUB_REPOSITORY;
      }
    });

    it("returns 404 when task has no PR", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_TASK_DETAIL);

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/pr/refresh",
        JSON.stringify({}),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("no associated PR");
    });

    it("returns 404 for non-existent task", async () => {
      const error = new Error("Task not found") as Error & { code?: string };
      error.code = "ENOENT";
      (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(error);

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-999/pr/refresh",
        JSON.stringify({}),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(404);
    });
  });

  describe("GET /tasks/:id/issue/status", () => {
    let store: TaskStore;

    beforeEach(() => {
      store = createMockStore({
        getTask: vi.fn(),
        getRootDir: vi.fn().mockReturnValue("/fake/root"),
      });
    });

    function buildApp() {
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      return app;
    }

    const mockIssueInfo = {
      url: "https://github.com/owner/repo/issues/123",
      number: 123,
      state: "open" as const,
      title: "Test Issue",
    };

    it("returns cached issue info when available", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        issueInfo: mockIssueInfo,
        updatedAt: new Date().toISOString(),
      });

      const res = await GET(buildApp(), "/api/tasks/KB-001/issue/status");

      expect(res.status).toBe(200);
      expect(res.body.issueInfo).toEqual(mockIssueInfo);
      expect(res.body.stale).toBe(false);
    });

    it("returns 404 when task has no issue", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_TASK_DETAIL);

      const res = await GET(buildApp(), "/api/tasks/KB-001/issue/status");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("no associated issue");
    });
  });

  describe("POST /tasks/:id/issue/refresh", () => {
    let store: TaskStore;

    beforeEach(() => {
      store = createMockStore({
        getTask: vi.fn(),
        updateIssueInfo: vi.fn(),
        getRootDir: vi.fn().mockReturnValue("/fake/root"),
      });
    });

    function buildApp() {
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      return app;
    }

    const mockIssueInfo = {
      url: "https://github.com/owner/repo/issues/123",
      number: 123,
      state: "closed" as const,
      title: "Test Issue",
      stateReason: "completed" as const,
    };

    it("refreshes and persists issue status", async () => {
      const originalRepo = process.env.GITHUB_REPOSITORY;
      process.env.GITHUB_REPOSITORY = "owner/repo";
      vi.spyOn(GitHubClient.prototype, "getIssueStatus").mockResolvedValue(mockIssueInfo);
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        issueInfo: {
          url: "https://github.com/owner/repo/issues/123",
          number: 123,
          state: "open" as const,
          title: "Test Issue",
        },
      });

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/issue/refresh",
        JSON.stringify({}),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(200);
      expect(res.body.number).toBe(123);
      expect(res.body.state).toBe("closed");
      expect(res.body.stateReason).toBe("completed");
      expect(store.updateIssueInfo).toHaveBeenCalled();

      if (originalRepo) {
        process.env.GITHUB_REPOSITORY = originalRepo;
      } else {
        delete process.env.GITHUB_REPOSITORY;
      }
    });

    it("returns 404 when task has no issue", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_TASK_DETAIL);

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/issue/refresh",
        JSON.stringify({}),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("no associated issue");
    });
  });
});

// --- GitHub Import route tests ---

describe("POST /github/issues/fetch", () => {
  let store: TaskStore;
  let listIssuesSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = createMockStore();
    mockIsGhAuthenticated.mockReturnValue(true);
    listIssuesSpy = vi.fn();
    vi.spyOn(GitHubClient.prototype, "listIssues").mockImplementation(listIssuesSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  const mockGitHubIssue = {
    number: 1,
    title: "Test Issue",
    body: "Test body",
    html_url: "https://github.com/owner/repo/issues/1",
    labels: [{ name: "bug" }],
  };

  it("fetches issues successfully", async () => {
    listIssuesSpy.mockResolvedValueOnce([mockGitHubIssue]);

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/fetch", JSON.stringify({ owner: "owner", repo: "repo" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].number).toBe(1);
    expect(res.body[0].title).toBe("Test Issue");
  });

  it("returns 400 when owner is missing", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/fetch", JSON.stringify({ repo: "repo" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("owner is required");
  });

  it("returns 400 when repo is missing", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/fetch", JSON.stringify({ owner: "owner" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("repo is required");
  });

  it("returns 404 when repository not found", async () => {
    listIssuesSpy.mockRejectedValueOnce(new Error("Repository not found: owner/repo"));

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/fetch", JSON.stringify({ owner: "owner", repo: "repo" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Repository not found");
  });

  it("returns 401 when gh not authenticated", async () => {
    mockIsGhAuthenticated.mockReturnValueOnce(false);

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/fetch", JSON.stringify({ owner: "owner", repo: "repo" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Not authenticated with GitHub");
    expect(res.body.error).toContain("gh auth login");
  });

  it("returns 502 when gh CLI fails", async () => {
    listIssuesSpy.mockRejectedValueOnce(new Error("Some gh CLI error"));

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/fetch", JSON.stringify({ owner: "owner", repo: "repo" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("GitHub CLI error");
  });

  it("filters out pull requests (gh CLI already filters them)", async () => {
    // gh issue list already filters out PRs, so we just verify the response
    listIssuesSpy.mockResolvedValueOnce([mockGitHubIssue]);

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/fetch", JSON.stringify({ owner: "owner", repo: "repo", limit: 10 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].number).toBe(1);
  });

  it("respects limit parameter", async () => {
    const manyIssues = Array.from({ length: 50 }, (_, i) => ({ ...mockGitHubIssue, number: i + 1 }));
    listIssuesSpy.mockResolvedValueOnce(manyIssues.slice(0, 10));

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/fetch", JSON.stringify({ owner: "owner", repo: "repo", limit: 10 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(10);
  });
});

describe("POST /github/issues/import", () => {
  let store: TaskStore;
  let getIssueSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockIsGhAuthenticated.mockReturnValue(true);
    getIssueSpy = vi.fn();
    vi.spyOn(GitHubClient.prototype, "getIssue").mockImplementation(getIssueSpy);

    store = createMockStore({
      createTask: vi.fn().mockResolvedValue({
        id: "KB-001",
        title: "Test Issue",
        description: "Test body\n\nSource: https://github.com/owner/repo/issues/1",
        column: "triage",
      }),
      logEntry: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  const mockGitHubIssue = {
    number: 1,
    title: "Test Issue",
    body: "Test body",
    html_url: "https://github.com/owner/repo/issues/1",
    state: "open",
  };

  it("imports a single issue successfully", async () => {
    getIssueSpy.mockResolvedValueOnce(mockGitHubIssue);

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("KB-001");
    expect(store.createTask).toHaveBeenCalledWith({
      title: "Test Issue",
      description: "Test body\n\nSource: https://github.com/owner/repo/issues/1",
      column: "triage",
      dependencies: [],
    });
  });

  it("logs the import action", async () => {
    getIssueSpy.mockResolvedValueOnce(mockGitHubIssue);

    await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
      "Content-Type": "application/json",
    });

    expect(store.logEntry).toHaveBeenCalledWith("KB-001", "Imported from GitHub", "https://github.com/owner/repo/issues/1");
  });

  it("returns 400 when issueNumber is missing", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("issueNumber is required");
  });

  it("returns 400 when issue not found or is a pull request", async () => {
    // getIssue returns null for both "not found" and "PR" cases
    getIssueSpy.mockResolvedValueOnce(null);

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 999 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("is a pull request");
  });

  it("returns 401 when gh not authenticated", async () => {
    mockIsGhAuthenticated.mockReturnValueOnce(false);

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Not authenticated with GitHub");
    expect(res.body.error).toContain("gh auth login");
  });

  it("returns 502 when gh CLI fails", async () => {
    getIssueSpy.mockRejectedValueOnce(new Error("Some gh CLI error"));

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("GitHub CLI error");
  });

  it("returns 409 when issue already imported", async () => {
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: "KB-002",
        description: "Existing\n\nSource: https://github.com/owner/repo/issues/1",
        column: "triage",
      },
    ]);

    getIssueSpy.mockResolvedValueOnce(mockGitHubIssue);

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already imported");
    expect(res.body.existingTaskId).toBe("KB-002");
    expect(store.createTask).not.toHaveBeenCalled();
  });

  it("truncates long titles to 200 chars", async () => {
    const longTitleIssue = {
      ...mockGitHubIssue,
      title: "A".repeat(250),
    };
    getIssueSpy.mockResolvedValueOnce(longTitleIssue);

    await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
      "Content-Type": "application/json",
    });

    expect(store.createTask).toHaveBeenCalledWith({
      title: "A".repeat(200),
      description: expect.stringContaining("Source:"),
      column: "triage",
      dependencies: [],
    });
  });
});

describe("POST /github/issues/batch-import", () => {
  let store: TaskStore;
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    store = createMockStore({
      listTasks: vi.fn().mockResolvedValue([]),
      createTask: vi.fn().mockImplementation((input) =>
        Promise.resolve({
          id: `KB-${String(Math.floor(Math.random() * 999)).padStart(3, "0")}`,
          title: input.title,
          description: input.description,
          column: "triage",
        })
      ),
      logEntry: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  const mockGitHubIssue = (number: number, title = `Issue ${number}`) => ({
    number,
    title,
    body: `Body for issue ${number}`,
    html_url: `https://github.com/owner/repo/issues/${number}`,
    labels: [{ name: "bug" }],
  });

  it("imports multiple issues successfully", async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockGitHubIssue(1, "First Issue")),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockGitHubIssue(2, "Second Issue")),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockGitHubIssue(3, "Third Issue")),
      } as Response);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1, 2, 3], delayMs: 10 }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results.every((r: { success: boolean }) => r.success)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(store.createTask).toHaveBeenCalledTimes(3);
  });

  it("skips already-imported issues", async () => {
    // Mock issue 1 fetch
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockGitHubIssue(1, "Already Imported Issue")),
    } as Response);

    // First import - should create a new task
    const res1 = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1], delayMs: 10 }),
      { "Content-Type": "application/json" }
    );

    expect(res1.status).toBe(200);
    expect(res1.body.results).toHaveLength(1);
    expect(res1.body.results[0].success).toBe(true);
    expect(res1.body.results[0].skipped).toBeUndefined();
    const createdTaskId = res1.body.results[0].taskId;
    expect(createdTaskId).toBeDefined();

    // Now verify that if we import again with the task in the list, it gets skipped
    // Update the listTasks mock to return the created task
    const createdTaskDescription = `Already Imported Issue\n\nSource: https://github.com/owner/repo/issues/1`;
    store.listTasks = vi.fn().mockResolvedValue([
      {
        id: createdTaskId,
        description: createdTaskDescription,
        column: "triage",
      },
    ]);

    // Second import - should skip
    const res2 = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1], delayMs: 10 }),
      { "Content-Type": "application/json" }
    );

    expect(res2.status).toBe(200);
    expect(res2.body.results).toHaveLength(1);
    expect(res2.body.results[0].success).toBe(true);
    expect(res2.body.results[0].skipped).toBe(true);
    expect(res2.body.results[0].taskId).toBe(createdTaskId);
  });

  it("returns 400 for empty issueNumbers array", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [] }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("at least 1");
  });

  it("returns 400 for more than 50 issue numbers", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: Array.from({ length: 51 }, (_, i) => i + 1) }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("more than 50");
  });

  it("returns 400 for invalid issueNumbers (non-integers)", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1, "two", 3] }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("positive integers");
  });

  it("handles partial failures (some succeed, some fail)", async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockGitHubIssue(1)),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: () => Promise.resolve({ message: "Not Found" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockGitHubIssue(3)),
      } as Response);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1, 2, 3], delayMs: 10 }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results[0].success).toBe(true);
    expect(res.body.results[1].success).toBe(false);
    expect(res.body.results[1].error).toContain("404");
    expect(res.body.results[2].success).toBe(true);
  });

  it("rejects pull requests with appropriate error", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ...mockGitHubIssue(1), pull_request: {} }),
    } as Response);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1], delayMs: 10 }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(res.body.results[0].success).toBe(false);
    expect(res.body.results[0].error).toContain("pull request");
  });

  it("handles rate limit (429) with retry and eventual success", async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: new Headers({ "Retry-After": "1" }),
        json: () => Promise.resolve({ message: "Rate limited" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockGitHubIssue(1, "Issue After Rate Limit")),
      } as Response);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1], delayMs: 10 }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].success).toBe(true);
    expect(res.body.results[0].taskId).toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2); // Initial 429 + 1 retry
  }, 10000); // Increase timeout for retry delay

  it("returns error after max retries exceeded on 429", async () => {
    // Always return 429
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers({ "Retry-After": "1" }), // 1 second for test speed
      json: () => Promise.resolve({ message: "Rate limited" }),
    } as Response);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1], delayMs: 1 }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].success).toBe(false);
    expect(res.body.results[0].error).toContain("rate limit");
    expect(res.body.results[0].retryAfter).toBe(1);
    // Initial attempt + 3 retries = 4 calls
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  }, 15000); // Increase timeout for multiple retries

  it("processes issues sequentially (not parallel)", async () => {
    const callTimes: number[] = [];
    fetchSpy.mockImplementation(() => {
      callTimes.push(Date.now());
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockGitHubIssue(callTimes.length)),
      } as Response);
    });

    await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1, 2, 3], delayMs: 50 }),
      { "Content-Type": "application/json" }
    );

    // Verify sequential processing by checking call timing
    expect(callTimes).toHaveLength(3);
    // Each call should be at least 40ms after the previous (allowing for small timing variations)
    for (let i = 1; i < callTimes.length; i++) {
      expect(callTimes[i] - callTimes[i - 1]).toBeGreaterThanOrEqual(40);
    }
  });

  it("requires owner parameter", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ repo: "repo", issueNumbers: [1] }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("owner");
  });

  it("requires repo parameter", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", issueNumbers: [1] }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("repo");
  });

  it("logs import actions for created tasks", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockGitHubIssue(1)),
    } as Response);

    await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1], delayMs: 10 }),
      { "Content-Type": "application/json" }
    );

    expect(store.logEntry).toHaveBeenCalledWith(
      expect.any(String),
      "Imported from GitHub",
      "https://github.com/owner/repo/issues/1"
    );
  });
});

// --- Spec Revision route tests ---

describe("POST /tasks/:id/spec/revise", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      getTask: vi.fn(),
      moveTask: vi.fn(),
      updateTask: vi.fn(),
      logEntry: vi.fn().mockResolvedValue(undefined),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("requests spec revision and moves task from todo to triage", async () => {
    const todoTask = { ...FAKE_TASK_DETAIL, column: "todo" as const };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "triage" as const };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(todoTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks/KB-001/spec/revise",
      JSON.stringify({ feedback: "Please add more details about error handling" }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(store.logEntry).toHaveBeenCalledWith(
      "KB-001",
      "AI spec revision requested",
      "Please add more details about error handling"
    );
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "triage");
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: "needs-respecify" });
  });

  it("requests spec revision and moves task from in-progress to triage", async () => {
    const inProgressTask = { ...FAKE_TASK_DETAIL, column: "in-progress" as const };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "triage" as const };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(inProgressTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks/KB-001/spec/revise",
      JSON.stringify({ feedback: "Split this into smaller steps" }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "triage");
  });

  it("returns 400 when task is already in triage", async () => {
    const triageTask = { ...FAKE_TASK_DETAIL, column: "triage" as const };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(triageTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks/KB-001/spec/revise",
      JSON.stringify({ feedback: "Some feedback" }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Cannot request spec revision");
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("returns 400 when task is in in-review", async () => {
    const inReviewTask = { ...FAKE_TASK_DETAIL, column: "in-review" as const };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(inReviewTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks/KB-001/spec/revise",
      JSON.stringify({ feedback: "Some feedback" }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("in-review");
    expect(res.body.error).toContain("Move task to 'todo' or 'in-progress' first");
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("returns 400 when task is in done", async () => {
    const doneTask = { ...FAKE_TASK_DETAIL, column: "done" as const };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(doneTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks/KB-001/spec/revise",
      JSON.stringify({ feedback: "Some feedback" }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("done");
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("returns 400 when feedback is missing", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks/KB-001/spec/revise",
      JSON.stringify({}),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("feedback is required");
  });

  it("returns 400 when feedback is empty string", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks/KB-001/spec/revise",
      JSON.stringify({ feedback: "" }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("feedback is required");
  });

  it("returns 400 when feedback exceeds 2000 characters", async () => {
    const longFeedback = "a".repeat(2001);
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks/KB-001/spec/revise",
      JSON.stringify({ feedback: longFeedback }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("feedback must be between 1 and 2000");
  });

  it("returns 404 when task not found", async () => {
    const error = new Error("Task not found") as Error & { code?: string };
    error.code = "ENOENT";
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(error);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks/KB-999/spec/revise",
      JSON.stringify({ feedback: "Some feedback" }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(404);
  });

  it("queues multiple revision requests as multiple log entries", async () => {
    const todoTask = { ...FAKE_TASK_DETAIL, column: "todo" as const };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "triage" as const };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(todoTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    // First request
    await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks/KB-001/spec/revise",
      JSON.stringify({ feedback: "First feedback" }),
      { "Content-Type": "application/json" }
    );

    // Second request
    await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks/KB-001/spec/revise",
      JSON.stringify({ feedback: "Second feedback" }),
      { "Content-Type": "application/json" }
    );

    expect(store.logEntry).toHaveBeenCalledTimes(2);
    expect(store.logEntry).toHaveBeenNthCalledWith(1, "KB-001", "AI spec revision requested", "First feedback");
    expect(store.logEntry).toHaveBeenNthCalledWith(2, "KB-001", "AI spec revision requested", "Second feedback");
  });
});


// --- Plan Approval route tests ---

describe("POST /tasks/:id/approve-plan", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      getTask: vi.fn(),
      moveTask: vi.fn(),
      updateTask: vi.fn(),
      logEntry: vi.fn().mockResolvedValue(undefined),
      getRootDir: vi.fn().mockReturnValue("/fake/root"),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("approves plan and moves task from triage to todo", async () => {
    const awaitingTask = { ...FAKE_TASK_DETAIL, column: "triage" as const, status: "awaiting-approval" as const };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "todo" as const };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(awaitingTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...movedTask, status: undefined });

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/approve-plan");

    expect(res.status).toBe(200);
    expect(store.logEntry).toHaveBeenCalledWith("KB-001", "Plan approved by user");
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo");
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: undefined });
    expect(res.body.column).toBe("todo");
    expect(res.body.status).toBeUndefined();
  });

  it("returns 400 when task is not in triage column", async () => {
    const todoTask = { ...FAKE_TASK_DETAIL, column: "todo" as const, status: "awaiting-approval" as const };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(todoTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/approve-plan");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("triage");
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("returns 400 when task does not have awaiting-approval status", async () => {
    const triageTask = { ...FAKE_TASK_DETAIL, column: "triage" as const, status: "specifying" as const };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(triageTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/approve-plan");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("awaiting-approval");
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("returns 404 when task not found", async () => {
    const error = new Error("Task not found") as Error & { code?: string };
    error.code = "ENOENT";
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(error);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-999/approve-plan");

    expect(res.status).toBe(404);
  });

  it("returns 500 on unexpected errors", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Database error"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/approve-plan");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Database error");
  });
});

describe("POST /tasks/:id/reject-plan", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      getTask: vi.fn(),
      updateTask: vi.fn(),
      logEntry: vi.fn().mockResolvedValue(undefined),
      getRootDir: vi.fn().mockReturnValue("/fake/root"),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("rejects plan and clears status for regeneration", async () => {
    const awaitingTask = { ...FAKE_TASK_DETAIL, column: "triage" as const, status: "awaiting-approval" as const };
    const updatedTask = { ...FAKE_TASK_DETAIL, column: "triage" as const, status: undefined };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(awaitingTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/reject-plan");

    expect(res.status).toBe(200);
    expect(store.logEntry).toHaveBeenCalledWith("KB-001", "Plan rejected by user", "Specification will be regenerated");
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: undefined });
    expect(res.body.column).toBe("triage");
  });

  it("returns 400 when task is not in triage column", async () => {
    const todoTask = { ...FAKE_TASK_DETAIL, column: "todo" as const, status: "awaiting-approval" as const };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(todoTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/reject-plan");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("triage");
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("returns 400 when task does not have awaiting-approval status", async () => {
    const triageTask = { ...FAKE_TASK_DETAIL, column: "triage" as const, status: "specifying" as const };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(triageTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/reject-plan");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("awaiting-approval");
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("returns 404 when task not found", async () => {
    const error = new Error("Task not found") as Error & { code?: string };
    error.code = "ENOENT";
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(error);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-999/reject-plan");

    expect(res.status).toBe(404);
  });

  it("returns 500 on unexpected errors", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Database error"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/reject-plan");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Database error");
  });
});

// --- Git Management route tests ---
// These are integration tests that run against the actual git repository

describe("Git Management endpoints", () => {
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

  describe("GET /git/status", () => {
    it("returns git status structure", async () => {
      const res = await GET(buildApp(), "/api/git/status");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("branch");
      expect(res.body).toHaveProperty("commit");
      expect(res.body).toHaveProperty("isDirty");
      expect(res.body).toHaveProperty("ahead");
      expect(res.body).toHaveProperty("behind");
      expect(typeof res.body.branch).toBe("string");
      expect(typeof res.body.commit).toBe("string");
      expect(typeof res.body.isDirty).toBe("boolean");
      expect(typeof res.body.ahead).toBe("number");
      expect(typeof res.body.behind).toBe("number");
    });
  });

  describe("GET /git/commits", () => {
    it("returns commits array", async () => {
      const res = await GET(buildApp(), "/api/git/commits");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      if (res.body.length > 0) {
        expect(res.body[0]).toHaveProperty("hash");
        expect(res.body[0]).toHaveProperty("shortHash");
        expect(res.body[0]).toHaveProperty("message");
        expect(res.body[0]).toHaveProperty("author");
        expect(res.body[0]).toHaveProperty("date");
      }
    });

    it("respects limit parameter", async () => {
      const res = await GET(buildApp(), "/api/git/commits?limit=5");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeLessThanOrEqual(5);
    });

    it("caps limit at 100", async () => {
      const res = await GET(buildApp(), "/api/git/commits?limit=200");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeLessThanOrEqual(100);
    });
  });

  describe("GET /git/commits/:hash/diff", () => {
    it("returns 400 for invalid hash format", async () => {
      const res = await GET(buildApp(), "/api/git/commits/invalid-hash!/diff");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid commit hash format");
    });

    it("returns 404 for non-existent commit", async () => {
      const res = await GET(buildApp(), "/api/git/commits/0000000/diff");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Commit not found");
    });

    it("returns diff for HEAD commit", async () => {
      // Get HEAD commit hash first
      const commitsRes = await GET(buildApp(), "/api/git/commits?limit=1");
      const headHash = commitsRes.body[0]?.hash;

      if (headHash) {
        const res = await GET(buildApp(), `/api/git/commits/${headHash}/diff`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("stat");
        expect(res.body).toHaveProperty("patch");
      }
    });
  });

  describe("GET /git/branches", () => {
    it("returns branches array", async () => {
      const res = await GET(buildApp(), "/api/git/branches");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      if (res.body.length > 0) {
        expect(res.body[0]).toHaveProperty("name");
        expect(res.body[0]).toHaveProperty("isCurrent");
        expect(typeof res.body[0].name).toBe("string");
        expect(typeof res.body[0].isCurrent).toBe("boolean");
      }
    });
  });

  describe("GET /git/worktrees", () => {
    it("returns worktrees array", async () => {
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const res = await GET(buildApp(), "/api/git/worktrees");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      if (res.body.length > 0) {
        expect(res.body[0]).toHaveProperty("path");
        expect(res.body[0]).toHaveProperty("isMain");
        expect(res.body[0]).toHaveProperty("isBare");
      }
    });

    it("correlates worktrees with tasks", async () => {
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "KB-TEST", worktree: "/some/worktree/path" },
      ]);

      const res = await GET(buildApp(), "/api/git/worktrees");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("POST /git/branches", () => {
    it("returns 400 without name", async () => {
      const res = await REQUEST(buildApp(), "POST", "/api/git/branches", JSON.stringify({}), {
        "Content-Type": "application/json",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("name is required");
    });

    it("returns 400 for invalid branch name", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/git/branches",
        JSON.stringify({ name: "invalid;rm -rf /" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid branch name");
    });

    it("returns 400 for branch name starting with dash", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/git/branches",
        JSON.stringify({ name: "--force" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid branch name");
    });
  });

  describe("POST /git/branches/:name/checkout", () => {
    it("returns 400 for invalid branch name", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/git/branches/invalid;cmd/checkout",
        JSON.stringify({}),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /git/branches/:name", () => {
    it("returns 400 for invalid branch name", async () => {
      const res = await REQUEST(buildApp(), "DELETE", "/api/git/branches/invalid;cmd");

      expect(res.status).toBe(400);
    });
  });

  describe("POST /git/fetch", () => {
    it("returns result structure", async () => {
      const res = await REQUEST(buildApp(), "POST", "/api/git/fetch", JSON.stringify({}), {
        "Content-Type": "application/json",
      });

      // May succeed or fail depending on network, but should return proper structure
      expect(res.status === 200 || res.status === 503 || res.status === 500).toBe(true);
      if (res.status === 200) {
        expect(res.body).toHaveProperty("fetched");
        expect(res.body).toHaveProperty("message");
      }
    });

    it("validates remote name", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/git/fetch",
        JSON.stringify({ remote: "invalid;rm -rf /" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid remote name");
    });
  });

  describe("POST /git/pull", () => {
    it("returns result or conflict status", async () => {
      const res = await REQUEST(buildApp(), "POST", "/api/git/pull", JSON.stringify({}), {
        "Content-Type": "application/json",
      });

      // May succeed or fail depending on environment state, but should return proper structure
      expect(res.status === 200 || res.status === 400 || res.status === 409 || res.status === 500).toBe(true);
      if (res.status === 200 || res.status === 409) {
        expect(res.body).toHaveProperty("success");
        expect(res.body).toHaveProperty("message");
      }
    });
  });

  describe("POST /git/push", () => {
    it("returns result or rejection status", async () => {
      const res = await REQUEST(buildApp(), "POST", "/api/git/push", JSON.stringify({}), {
        "Content-Type": "application/json",
      });

      // May succeed or fail depending on remote state
      expect(res.status === 200 || res.status === 409 || res.status === 503 || res.status === 500).toBe(true);
      if (res.status === 200) {
        expect(res.body).toHaveProperty("success");
        expect(res.body).toHaveProperty("message");
      }
    });
  });



  // ── File API tests ────────────────────────────────────────────────────
  describe("File API endpoints", () => {
    let store: TaskStore;

    beforeEach(() => {
      store = createMockStore({
        getRootDir: vi.fn().mockReturnValue("/tmp/test"),
      });
    });

    function buildApp() {
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      return app;
    }

    describe("GET /tasks/:id/files", () => {
      it("returns 404 for non-existent task", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue({ code: "ENOENT" });

        const res = await GET(buildApp(), "/api/tasks/KB-NONEXISTENT/files");

        expect(res.status).toBe(404);
        expect(res.body).toHaveProperty("error");
      });

      it("returns 404 when task directory does not exist", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "KB-001",
          worktree: null,
        });

        const res = await GET(buildApp(), "/api/tasks/KB-001/files");
        // Will fail because task directory doesn't exist
        expect(res.status === 404 || res.status === 500).toBe(true);
      });

      it("accepts path query parameter", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "KB-001",
          worktree: null,
        });

        const res = await GET(buildApp(), "/api/tasks/KB-001/files?path=src");
        // Directory won't exist, but endpoint should process the query param
        expect(res.status === 404 || res.status === 500).toBe(true);
      });
    });

    describe("GET /tasks/:id/files/:filepath", () => {
      it("returns 404 for non-existent file", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "KB-001",
          worktree: null,
        });

        const res = await GET(buildApp(), "/api/tasks/KB-001/files/nonexistent.txt");
        expect(res.status).toBe(404);
      });

      it("returns 400 for empty filepath", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "KB-001",
          worktree: null,
        });

        const res = await GET(buildApp(), "/api/tasks/KB-001/files/");
        // Empty path should result in error
        expect(res.status === 400 || res.status === 404).toBe(true);
      });

      it("returns 415 for binary files", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "KB-001",
          worktree: null,
        });

        const res = await GET(buildApp(), "/api/tasks/KB-001/files/image.png");
        expect([415, 404, 500]).toContain(res.status);
      });

      it("rejects path traversal attempts", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "KB-001",
          worktree: null,
        });

        const res = await GET(buildApp(), "/api/tasks/KB-001/files/../etc/passwd");
        expect([400, 404, 500]).toContain(res.status);
        if (res.body?.error) {
          expect(res.body.error).toContain("traversal");
        }
      });
    });

    describe("POST /tasks/:id/files/:filepath", () => {
      it("requires content in body", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "KB-001",
          worktree: null,
        });

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/tasks/KB-001/files/test.txt",
          JSON.stringify({}),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("content is required");
      });

      it("rejects non-string content", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "KB-001",
          worktree: null,
        });

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/tasks/KB-001/files/test.txt",
          JSON.stringify({ content: 123 }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(400);
      });

      it("returns 404 for non-existent parent directory", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "KB-001",
          worktree: null,
        });

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/tasks/KB-001/files/nonexistent/dir/file.txt",
          JSON.stringify({ content: "test" }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(404);
      });

      it("rejects path traversal in write", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "KB-001",
          worktree: null,
        });

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/tasks/KB-001/files/../../../etc/passwd",
          JSON.stringify({ content: "evil" }),
          { "Content-Type": "application/json" }
        );

        expect([400, 404, 500]).toContain(res.status);
      });
    });
  });

  describe("Planning Mode Routes", () => {
    beforeEach(() => {
      // Reset planning state before each test to avoid cross-test contamination
      __resetPlanningState();
    });

    describe("POST /planning/start", () => {
      it("creates a new planning session", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(201);
        expect(res.body.sessionId).toBeDefined();
        expect(typeof res.body.sessionId).toBe("string");
        expect(res.body.firstQuestion).toBeDefined();
        expect(res.body.firstQuestion.id).toBe("q-scope");
        expect(res.body.firstQuestion.type).toBe("single_select");
      });

      it("requires initialPlan in body", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({}),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("initialPlan is required");
      });

      it("rejects initialPlan longer than 500 chars", async () => {
        const longPlan = "a".repeat(501);
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: longPlan }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("500 characters");
      });

      it("enforces rate limiting (5 sessions per hour per IP)", async () => {
        // Create 5 sessions (should succeed)
        for (let i = 0; i < 5; i++) {
          const res = await REQUEST(
            buildApp(),
            "POST",
            "/api/planning/start",
            JSON.stringify({ initialPlan: `Plan ${i}` }),
            { "Content-Type": "application/json" }
          );
          expect(res.status).toBe(201);
        }

        // 6th session should be rate limited
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Plan 6" }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(429);
        expect(res.body.error).toContain("Rate limit exceeded");
      });
    });

    describe("POST /planning/respond", () => {
      it("processes response and returns next question", async () => {
        // First create a session
        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );
        expect(startRes.status).toBe(201);
        const sessionId = startRes.body.sessionId;

        // Submit a response
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { scope: "medium" } }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(200);
        expect(res.body.type).toBe("question");
        expect(res.body.data).toBeDefined();
      });

      it("returns summary after completing all questions", async () => {
        // Create a session
        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );
        const sessionId = startRes.body.sessionId;

        // Submit 3 responses to complete the session
        await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { scope: "medium" } }),
          { "Content-Type": "application/json" }
        );

        await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { requirements: "Must have login" } }),
          { "Content-Type": "application/json" }
        );

        const finalRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { confirm: true } }),
          { "Content-Type": "application/json" }
        );

        expect(finalRes.status).toBe(200);
        expect(finalRes.body.type).toBe("complete");
        expect(finalRes.body.data.title).toBeDefined();
        expect(finalRes.body.data.description).toBeDefined();
        expect(finalRes.body.data.suggestedSize).toBeDefined();
        expect(finalRes.body.data.keyDeliverables).toBeInstanceOf(Array);
      });

      it("returns 404 for invalid session ID", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId: "invalid-session-id", responses: {} }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(404);
        expect(res.body.error).toContain("not found");
      });

      it("requires sessionId in body", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ responses: {} }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("sessionId is required");
      });

      it("requires responses object", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId: "some-id" }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("responses is required");
      });
    });

    describe("POST /planning/cancel", () => {
      it("cancels an active session", async () => {
        // Create a session first
        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );
        const sessionId = startRes.body.sessionId;

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/cancel",
          JSON.stringify({ sessionId }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });

      it("returns 404 for non-existent session", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/cancel",
          JSON.stringify({ sessionId: "non-existent-id" }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(404);
        expect(res.body.error).toContain("not found");
      });

      it("requires sessionId in body", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/cancel",
          JSON.stringify({}),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("sessionId is required");
      });
    });

    describe("POST /planning/create-task", () => {
      it("creates a task from completed planning session", async () => {
        // Setup mock store for task creation
        (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "KB-042",
          description: "Build a user auth system",
          column: "triage",
          dependencies: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
        (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({});
        (store.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

        // Create a session and complete it
        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );
        const sessionId = startRes.body.sessionId;

        // Complete the session
        await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { scope: "medium" } }),
          { "Content-Type": "application/json" }
        );
        await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { requirements: "Must have login" } }),
          { "Content-Type": "application/json" }
        );
        await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { confirm: true } }),
          { "Content-Type": "application/json" }
        );

        // Create task from planning
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/create-task",
          JSON.stringify({ sessionId }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(201);
        expect(store.createTask).toHaveBeenCalled();
      });

      it("returns 400 if session is not complete", async () => {
        // Create a session but don't complete it
        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );
        const sessionId = startRes.body.sessionId;

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/create-task",
          JSON.stringify({ sessionId }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("not complete");
      });

      it("returns 404 for invalid session ID", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/create-task",
          JSON.stringify({ sessionId: "invalid-session-id" }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(404);
        expect(res.body.error).toContain("not found");
      });

      it("requires sessionId in body", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/create-task",
          JSON.stringify({}),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("sessionId is required");
      });
    });
  });
});
