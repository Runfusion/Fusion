// @vitest-environment node

import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

import { Database, emitUsageEvent } from "@fusion/core";
import type { TaskStore } from "@fusion/core";
import { request } from "../test-request.js";
import { ApiError } from "../api-error.js";
import {
  registerCommandCenterRoutes,
  resolveRange,
  resolveGroupBy,
  DEFAULT_WINDOW_DAYS,
} from "../routes/register-command-center-routes.js";
import type { ApiRoutesContext } from "../routes/types.js";

/** Seed a temp DB with a token-bearing task and a tool-call usage event. */
function seedDb(db: Database, opts: { taskId: string; model: string; tokens: number }): void {
  db.prepare(
    `INSERT INTO tasks
       (id, description, "column", modelProvider, modelId,
        tokenUsageInputTokens, tokenUsageOutputTokens, tokenUsageTotalTokens,
        tokenUsageLastUsedAt, createdAt, updatedAt)
     VALUES (?, 'desc', 'todo', 'anthropic', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.taskId,
    opts.model,
    opts.tokens,
    opts.tokens,
    opts.tokens * 2,
    "2026-03-01T00:00:00.000Z",
    "2026-03-01T00:00:00.000Z",
    "2026-03-01T00:00:00.000Z",
  );
  emitUsageEvent(db, {
    kind: "tool_call",
    taskId: opts.taskId,
    agentId: "agent-1",
    nodeId: "node-1",
    category: "edit",
    ts: "2026-03-01T00:00:00.000Z",
  });
}

/**
 * Build an express app with the registrar mounted, backed by per-project real
 * DBs. The `getScopedStore` resolves the DB by the `projectId` query param,
 * proving project scoping at the route boundary.
 */
function buildApp(stores: Record<string, TaskStore>, fallback: TaskStore) {
  const app = express();
  app.use(express.json());

  const router = express.Router();
  const ctx = {
    router,
    getScopedStore: async (req: Request): Promise<TaskStore> => {
      const projectId =
        typeof req.query.projectId === "string" ? req.query.projectId : undefined;
      return projectId && stores[projectId] ? stores[projectId] : fallback;
    },
    rethrowAsApiError: (error: unknown, fallbackMessage?: string): never => {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, fallbackMessage ?? "Internal error");
    },
  } as unknown as ApiRoutesContext;

  registerCommandCenterRoutes(ctx);
  app.use("/api", router);

  // Minimal ApiError → HTTP status mapper (mirrors server.ts behaviour).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: "Internal error" });
  });

  return app;
}

/** A minimal TaskStore exposing only getDatabase(), which is all the routes use. */
function storeFor(db: Database): TaskStore {
  const store = new EventEmitter() as unknown as TaskStore & { getDatabase(): Database };
  store.getDatabase = () => db;
  return store;
}

describe("register-command-center-routes", () => {
  let tmpDir: string;
  let dbA: Database;
  let dbB: Database;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-cc-routes-"));
    dbA = new Database(join(tmpDir, "a", ".fusion"));
    dbA.init();
    dbB = new Database(join(tmpDir, "b", ".fusion"));
    dbB.init();

    // Project A: a known task + tool call. Project B: a *different* marker task.
    seedDb(dbA, { taskId: "FN-A1", model: "claude-sonnet-4-5", tokens: 100 });
    seedDb(dbB, { taskId: "FN-B1", model: "claude-opus-4-5", tokens: 999 });

    const storeA = storeFor(dbA);
    const storeB = storeFor(dbB);
    app = buildApp({ "proj-a": storeA, "proj-b": storeB }, storeA);
  });

  afterEach(() => {
    dbA.close();
    dbB.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the token aggregator shape for a fixture DB", async () => {
    const res = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z&groupBy=model&projectId=proj-a",
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty("totals");
    expect(body).toHaveProperty("cost");
    expect(body).toHaveProperty("groups");
    expect(body.groupBy).toBe("model");
    expect((body.totals as { totalTokens: number }).totalTokens).toBe(200);
  });

  it("returns the tools / activity / productivity aggregator shapes", async () => {
    const range = "from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z";
    const tools = await request(app, "GET", `/api/command-center/tools?${range}&projectId=proj-a`);
    expect(tools.status).toBe(200);
    expect(tools.body).toHaveProperty("autonomyRatio");
    expect((tools.body as { toolCalls: number }).toolCalls).toBe(1);

    const activity = await request(app, "GET", `/api/command-center/activity?${range}&projectId=proj-a`);
    expect(activity.status).toBe(200);
    expect(activity.body).toHaveProperty("stickiness");
    expect(activity.body).toHaveProperty("mttr");

    const prod = await request(app, "GET", `/api/command-center/productivity?${range}&projectId=proj-a`);
    expect(prod.status).toBe(200);
    expect(prod.body).toHaveProperty("loc");
    expect(prod.body).toHaveProperty("byLanguage");
  });

  it("returns the live snapshot shape", async () => {
    const res = await request(app, "GET", "/api/command-center/live?projectId=proj-a");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty("capturedAt");
    expect(body).toHaveProperty("activeSessions");
    expect(body).toHaveProperty("columns");
    // Project A seeded one 'todo' task.
    expect(body.columns).toContainEqual({ column: "todo", count: 1 });
  });

  it("invalid range params fall back to the default window, not a 500", async () => {
    const res = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=not-a-date&to=also-bad&projectId=proj-a",
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    // Defaulted window is recent (last 7d), so the 2026-03 fixture is out of
    // range → zeroed totals, but never a 500.
    expect(body).toHaveProperty("totals");
  });

  it("missing range params default rather than 500", async () => {
    const res = await request(app, "GET", "/api/command-center/tokens?projectId=proj-a");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("totals");
  });

  it("project scoping — project-A request cannot read project-B data (JSON)", async () => {
    const a = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z&projectId=proj-a",
    );
    const b = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z&projectId=proj-b",
    );
    // A's task had 100 input tokens (total 200); B's had 999 (total 1998).
    expect((a.body as { totals: { totalTokens: number } }).totals.totalTokens).toBe(200);
    expect((b.body as { totals: { totalTokens: number } }).totals.totalTokens).toBe(1998);
  });

  it("?format=csv returns well-formed CSV with attachment header", async () => {
    const res = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z&groupBy=model&projectId=proj-a&format=csv",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="command-center-tokens.csv"',
    );
    const csv = res.body as string;
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    // Header row + one model group row (claude-sonnet-4-5, total 200).
    expect(lines[0]).toContain("totalTokens");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("claude-sonnet-4-5");
    expect(lines[1]).toContain("200");
  });

  it("?format=csv empty result returns header-only CSV, not a 204", async () => {
    // Window with no data → header-only.
    const res = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=2020-01-01T00:00:00.000Z&to=2020-01-02T00:00:00.000Z&projectId=proj-a&format=csv",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const csv = res.body as string;
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    // No groupBy → always a single (total) row of zeros, plus the header.
    expect(lines[0]).toContain("totalTokens");
    expect(lines[1]).toContain("(total)");
    expect(lines[1]).toContain(",0,");
  });

  it("?format=csv RFC-4180 quotes values with commas/quotes/newlines", async () => {
    // Seed a task whose model id contains a comma + quote + newline so the
    // groupBy=model group key forces RFC-4180 quoting through the export path.
    const nasty = 'mod,el "x"\nline2';
    dbA.prepare(
      `INSERT INTO tasks
         (id, description, "column", modelProvider, modelId,
          tokenUsageInputTokens, tokenUsageOutputTokens, tokenUsageTotalTokens,
          tokenUsageLastUsedAt, createdAt, updatedAt)
       VALUES ('FN-A2', 'd', 'todo', 'anthropic', ?, 5, 5, 10,
               '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z',
               '2026-03-01T00:00:00.000Z')`,
    ).run(nasty);

    const res = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z&groupBy=model&projectId=proj-a&format=csv",
    );
    expect(res.status).toBe(200);
    const csv = res.body as string;
    // The nasty key must appear quoted with the embedded quote doubled.
    expect(csv).toContain('"mod,el ""x""\nline2"');
  });

  it("?format=csv is project-scoped — A cannot retrieve B's data", async () => {
    const a = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z&projectId=proj-a&format=csv",
    );
    const b = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z&projectId=proj-b&format=csv",
    );
    // A total = 200, B total = 1998. Neither CSV may contain the other's total.
    expect(a.body as string).toContain("200");
    expect(a.body as string).not.toContain("1998");
    expect(b.body as string).toContain("1998");
    expect(b.body as string).not.toContain(",200,");
  });

  it("?format=csv works for tools / activity / productivity endpoints", async () => {
    const range = "from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z";
    for (const [path, filename] of [
      ["tools", "command-center-tools.csv"],
      ["activity", "command-center-activity.csv"],
      ["productivity", "command-center-productivity.csv"],
    ]) {
      const res = await request(
        app,
        "GET",
        `/api/command-center/${path}?${range}&projectId=proj-a&format=csv`,
      );
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toBe(
        `attachment; filename="${filename}"`,
      );
      expect((res.body as string).split("\r\n")[0].length).toBeGreaterThan(0);
    }
  });

  it("project scoping — /live is scoped per project", async () => {
    // Add a distinguishing 'in-review' task only to project B.
    dbB.prepare(
      `INSERT INTO tasks (id, description, "column", createdAt, updatedAt)
       VALUES ('FN-B2', 'd', 'in-review', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')`,
    ).run();

    const a = await request(app, "GET", "/api/command-center/live?projectId=proj-a");
    const b = await request(app, "GET", "/api/command-center/live?projectId=proj-b");
    const aColumns = (a.body as { columns: { column: string }[] }).columns.map((c) => c.column);
    const bColumns = (b.body as { columns: { column: string }[] }).columns.map((c) => c.column);
    expect(aColumns).not.toContain("in-review");
    expect(bColumns).toContain("in-review");
  });
});

describe("resolveRange / resolveGroupBy (param parsing)", () => {
  const NOW = Date.parse("2026-06-15T00:00:00.000Z");

  it("uses valid, ordered ISO bounds as-is", () => {
    const r = resolveRange(
      { from: "2026-06-01T00:00:00.000Z", to: "2026-06-10T00:00:00.000Z" },
      NOW,
    );
    expect(r.defaulted).toBe(false);
    expect(r.from).toBe("2026-06-01T00:00:00.000Z");
    expect(r.to).toBe("2026-06-10T00:00:00.000Z");
  });

  it("defaults to the last-7d window for missing params", () => {
    const r = resolveRange({}, NOW);
    expect(r.defaulted).toBe(true);
    expect(r.to).toBe(new Date(NOW).toISOString());
    expect(r.from).toBe(
      new Date(NOW - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("defaults when from > to (inverted range)", () => {
    const r = resolveRange(
      { from: "2026-06-10T00:00:00.000Z", to: "2026-06-01T00:00:00.000Z" },
      NOW,
    );
    expect(r.defaulted).toBe(true);
  });

  it("defaults when a bound is unparseable", () => {
    const r = resolveRange({ from: "garbage", to: "2026-06-10T00:00:00.000Z" }, NOW);
    expect(r.defaulted).toBe(true);
  });

  it("accepts known groupBy values and ignores unknown ones", () => {
    expect(resolveGroupBy({ groupBy: "model" })).toBe("model");
    expect(resolveGroupBy({ groupBy: "provider" })).toBe("provider");
    expect(resolveGroupBy({ groupBy: "bogus" })).toBeUndefined();
    expect(resolveGroupBy({})).toBeUndefined();
  });
});

describe("vite /api proxy negative-lookahead (proxy verification)", () => {
  // The exact key from packages/dashboard/vite.config.ts's server.proxy. Real
  // /api endpoints must proxy to the backend; app source modules ending in a
  // .ts/.tsx (?import) suffix must stay on the Vite dev server.
  const PROXY_RE = new RegExp("^/api(?!/.*\\.[jt]sx?(?:\\?|$))(/|$)");

  it("proxies the real command-center endpoints to the backend", () => {
    expect(PROXY_RE.test("/api/command-center/tokens")).toBe(true);
    expect(PROXY_RE.test("/api/command-center/live")).toBe(true);
    expect(PROXY_RE.test("/api/command-center/activity?from=x&to=y")).toBe(true);
  });

  it("leaves .ts?import source module paths on Vite (not proxied)", () => {
    expect(PROXY_RE.test("/api/command-center/foo.ts?import")).toBe(false);
    expect(PROXY_RE.test("/api/command-center/Component.tsx?import")).toBe(false);
    expect(PROXY_RE.test("/api/something.ts")).toBe(false);
  });
});
