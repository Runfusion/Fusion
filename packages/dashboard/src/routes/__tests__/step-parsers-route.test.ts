// @vitest-environment node
//
// KTD-12: HTTP coverage for GET /api/step-parsers — the parse-steps node
// inspector's parser catalog. Mirrors GET /api/traits: registry-backed,
// read-only, session-scoped. Exercises the route end-to-end against a REAL
// TaskStore via createApiRoutes:
//   - built-ins (step-headings, json-steps) are always present
//   - a registered plugin parser (plugin:<id>:<parser>) surfaces in the list

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, registerStepParser, unregisterStepParser } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

const PLUGIN_PARSER_ID = "plugin:acme:yaml-steps";

describe("GET /api/step-parsers", () => {
  let store: TaskStore;
  let rootDir: string;
  let globalDir: string;
  let app: express.Express;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "sp-route-root-"));
    globalDir = mkdtempSync(join(tmpdir(), "sp-route-global-"));
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();

    app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
  });

  afterEach(() => {
    // Tear down the plugin parser registered in the relevant test (idempotent).
    unregisterStepParser(PLUGIN_PARSER_ID);
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  const get = (path: string) => REQUEST(app, "GET", path);

  it("returns the built-in parsers", async () => {
    const res = await get("/api/step-parsers");
    expect(res.status).toBe(200);
    const body = res.body as { parsers: Array<{ id: string }> };
    const ids = body.parsers.map((p) => p.id);
    expect(ids).toContain("step-headings");
    expect(ids).toContain("json-steps");
  });

  it("includes a registered plugin parser", async () => {
    registerStepParser({ id: PLUGIN_PARSER_ID, parse: () => ({ steps: [] }) });
    const res = await get("/api/step-parsers");
    expect(res.status).toBe(200);
    const ids = (res.body as { parsers: Array<{ id: string }> }).parsers.map((p) => p.id);
    expect(ids).toContain(PLUGIN_PARSER_ID);
    expect(ids).toContain("step-headings");
  });
});
