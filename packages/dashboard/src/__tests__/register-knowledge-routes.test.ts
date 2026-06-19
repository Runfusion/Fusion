// @vitest-environment node

import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

import { Database } from "@fusion/core";
import type { TaskStore } from "@fusion/core";
import { request } from "../test-request.js";
import { ApiError } from "../api-error.js";
import { registerKnowledgeRoutes } from "../routes/register-knowledge-routes.js";
import { upsertKnowledgePage } from "../knowledge-index.js";
import type { ApiRoutesContext } from "../routes/types.js";

interface QueryResponse {
  query: string;
  pages: Array<{ sourceId: string }>;
  total: number;
}
interface RefreshResponse {
  page: { sourceId: string };
}

/** POST JSON helper over the bare `request` (which only accepts string bodies). */
function postJson(
  app: ReturnType<typeof buildApp>,
  path: string,
  body: unknown,
): ReturnType<typeof request> {
  return request(app, "POST", path, JSON.stringify(body), {
    "content-type": "application/json",
  });
}

/** A minimal TaskStore exposing getDatabase()/getTask(), which is all routes use. */
function storeFor(db: Database, tasks: Record<string, unknown> = {}): TaskStore {
  const store = new EventEmitter() as unknown as TaskStore & {
    getDatabase(): Database;
    getTask(id: string): Promise<unknown>;
  };
  store.getDatabase = () => db;
  store.getTask = async (id: string) => tasks[id] ?? null;
  return store;
}

function buildApp(stores: Record<string, TaskStore>, fallback: TaskStore) {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  const ctx = {
    router,
    getScopedStore: async (req: Request): Promise<TaskStore> => {
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
      return projectId && stores[projectId] ? stores[projectId] : fallback;
    },
    rethrowAsApiError: (error: unknown, fallbackMessage?: string): never => {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, fallbackMessage ?? "Internal error");
    },
  } as unknown as ApiRoutesContext;
  registerKnowledgeRoutes(ctx);
  app.use("/api", router);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: "Internal error" });
  });
  return app;
}

describe("register-knowledge-routes", () => {
  let tmpDir: string;
  let dbA: Database;
  let dbB: Database;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-knowledge-routes-"));
    dbA = new Database(join(tmpDir, "a", ".fusion"));
    dbA.init();
    dbB = new Database(join(tmpDir, "b", ".fusion"));
    dbB.init();

    upsertKnowledgePage(dbA, {
      sourceKind: "task",
      sourceId: "FN-A1",
      title: "Add OAuth login flow",
      content: "Implemented oauth login with token refresh in auth.ts",
      tags: ["auth.ts"],
    });
    upsertKnowledgePage(dbB, {
      sourceKind: "task",
      sourceId: "FN-B1",
      title: "Secret project-B widget",
      content: "Project B only — confidential widget rendering",
      tags: ["widget.ts"],
    });

    const storeA = storeFor(dbA, {
      "FN-A2": {
        id: "FN-A2",
        title: "Refactor payment module",
        description: "Cleaned up the stripe payment handler",
        modifiedFiles: ["payment.ts"],
        column: "done",
      },
    });
    const storeB = storeFor(dbB);
    app = buildApp({ "proj-a": storeA, "proj-b": storeB }, storeA);
  });

  afterEach(() => {
    dbA.close();
    dbB.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns relevant pages for a keyword query (fixture)", async () => {
    const res = await request(app, "GET", "/api/knowledge/query?q=oauth&projectId=proj-a");
    expect(res.status).toBe(200);
    const body = res.body as QueryResponse;
    expect(body.pages).toHaveLength(1);
    expect(body.pages[0].sourceId).toBe("FN-A1");
    expect(body.total).toBe(1);
  });

  it("returns empty for a non-matching keyword", async () => {
    const res = await request(app, "GET", "/api/knowledge/query?q=kubernetes&projectId=proj-a");
    expect(res.status).toBe(200);
    expect((res.body as QueryResponse).pages).toHaveLength(0);
  });

  it("returns empty for a blank query rather than the whole index", async () => {
    const res = await request(app, "GET", "/api/knowledge/query?q=&projectId=proj-a");
    expect(res.status).toBe(200);
    const body = res.body as QueryResponse;
    expect(body.pages).toHaveLength(0);
    expect(body.total).toBe(1);
  });

  it("project scoping — project-A query cannot read project-B pages", async () => {
    // The project-B-only term must never surface for project A.
    const leak = await request(app, "GET", "/api/knowledge/query?q=widget&projectId=proj-a");
    expect(leak.status).toBe(200);
    expect((leak.body as QueryResponse).pages).toHaveLength(0);

    // ...but is visible to project B.
    const ok = await request(app, "GET", "/api/knowledge/query?q=widget&projectId=proj-b");
    expect(ok.status).toBe(200);
    const okBody = ok.body as QueryResponse;
    expect(okBody.pages).toHaveLength(1);
    expect(okBody.pages[0].sourceId).toBe("FN-B1");
  });

  it("POST /refresh incrementally indexes a completed task, then it is queryable", async () => {
    const refresh = await postJson(app, "/api/knowledge/refresh?projectId=proj-a", {
      taskId: "FN-A2",
    });
    expect(refresh.status).toBe(200);
    expect((refresh.body as RefreshResponse).page.sourceId).toBe("FN-A2");

    const q = await request(app, "GET", "/api/knowledge/query?q=stripe&projectId=proj-a");
    expect(q.status).toBe(200);
    const qBody = q.body as QueryResponse;
    expect(qBody.pages).toHaveLength(1);
    expect(qBody.pages[0].sourceId).toBe("FN-A2");
  });

  it("POST /refresh returns 404 for an unknown task", async () => {
    const res = await postJson(app, "/api/knowledge/refresh?projectId=proj-a", {
      taskId: "does-not-exist",
    });
    expect(res.status).toBe(404);
  });

  it("POST /refresh requires a taskId", async () => {
    const res = await postJson(app, "/api/knowledge/refresh?projectId=proj-a", {});
    expect(res.status).toBe(400);
  });
});
