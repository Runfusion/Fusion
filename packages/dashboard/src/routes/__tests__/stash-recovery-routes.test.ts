// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { request as REQUEST } from "../../test-request.js";

const engineMocks = vi.hoisted(() => ({
  listAutostashOrphans: vi.fn(),
  getAutostashDiff: vi.fn(),
  applyAutostashBySha: vi.fn(),
  dropAutostashBySha: vi.fn(),
  notifyAutostashOrphans: vi.fn(),
}));

vi.mock("@fusion/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/engine")>();
  return {
    ...actual,
    ...engineMocks,
  };
});

import { createApiRoutes } from "../../routes.js";

function createMockStore(): TaskStore {
  return {
    getRootDir: vi.fn(() => "/tmp/project"),
  } as unknown as TaskStore;
}

function buildApp(store: TaskStore) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return app;
}

describe("stash recovery routes", () => {
  beforeEach(() => {
    Object.values(engineMocks).forEach((mockFn) => mockFn.mockReset());
  });

  it("returns orphan records", async () => {
    engineMocks.listAutostashOrphans.mockResolvedValue([
      {
        sha: "abcdef1",
        ref: "stash@{0}",
        label: "fusion-merger-autostash:FN-1:1",
        sourceTaskId: "FN-1",
        createdAt: null,
        changedPaths: ["file.txt"],
        classification: "live",
        sourcePhase: "finalize-reset",
        detectedByTaskId: "FN-1234",
        detectedAt: "2026-05-10T00:00:00.000Z",
      },
    ]);

    const res = await REQUEST(buildApp(createMockStore()), "GET", "/api/stash-recovery/orphans");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.records[0].sha).toBe("abcdef1");
    expect(res.body.records[0].sourcePhase).toBe("finalize-reset");
  });

  it("returns diff + truncated flag", async () => {
    engineMocks.getAutostashDiff.mockResolvedValue("diff text\n… (diff truncated)");
    const res = await REQUEST(buildApp(createMockStore()), "GET", "/api/stash-recovery/orphans/abcdef1/diff");
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
  });

  it("applies stash with success and conflict responses", async () => {
    engineMocks.applyAutostashBySha.mockResolvedValueOnce({ ok: true });
    let res = await REQUEST(
      buildApp(createMockStore()),
      "POST",
      "/api/stash-recovery/orphans/abcdef1/apply",
      JSON.stringify({}),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    engineMocks.applyAutostashBySha.mockResolvedValueOnce({ ok: false, reason: "conflict", stderr: "CONFLICT" });
    res = await REQUEST(
      buildApp(createMockStore()),
      "POST",
      "/api/stash-recovery/orphans/abcdef1/apply",
      JSON.stringify({}),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.reason).toBe("conflict");
  });

  it("requires confirm for drop", async () => {
    const app = buildApp(createMockStore());
    let res = await REQUEST(
      app,
      "POST",
      "/api/stash-recovery/orphans/abcdef1/drop",
      JSON.stringify({}),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(400);

    engineMocks.dropAutostashBySha.mockResolvedValueOnce({ dropped: true });
    res = await REQUEST(
      app,
      "POST",
      "/api/stash-recovery/orphans/abcdef1/drop",
      JSON.stringify({ confirm: true }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(200);
    expect(engineMocks.dropAutostashBySha).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid sha before calling engine", async () => {
    const res = await REQUEST(buildApp(createMockStore()), "GET", "/api/stash-recovery/orphans/not-valid/diff");
    expect(res.status).toBe(400);
    expect(engineMocks.getAutostashDiff).not.toHaveBeenCalled();
  });
});
