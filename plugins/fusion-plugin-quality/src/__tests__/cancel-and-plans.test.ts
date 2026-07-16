import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as core from "@fusion/core";
import { DatabaseSync } from "@fusion/core";
import { ensureQualitySchema } from "../quality-schema.js";
import { QualityStore } from "../store/quality-store.js";
import {
  __clearActiveQualityRunsForTests,
  __registerActiveQualityRunForTests,
  cancelQualityRun,
  executeQualityRun,
} from "../runner/command-runner.js";
import { validatePlanSteps } from "../routes/create-routes.js";

describe("cancelQualityRun", () => {
  afterEach(() => {
    __clearActiveQualityRunsForTests();
    vi.restoreAllMocks();
  });

  it("kills the supervised child and marks queued/running runs cancelled", async () => {
    __clearActiveQualityRunsForTests();
    const db = new DatabaseSync(":memory:");
    ensureQualitySchema(db as never);
    const store = new QualityStore(db as never);
    const run = store.createRun({
      projectId: "p1",
      source: "hub",
      command: "echo hi",
      cwd: "/tmp",
      cwdKind: "project-root",
      timeoutMs: 1000,
      triggeredBy: "test",
    });
    store.updateRun("p1", run.id, { status: "running", startedAt: new Date().toISOString() });
    const kill = vi.fn();
    __registerActiveQualityRunForTests("p1", run.id, { kill });
    const cancelled = await cancelQualityRun(store, "p1", run.id);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.errorMessage).toMatch(/Cancelled/);

    const again = await cancelQualityRun(store, "p1", run.id);
    expect(again?.status).toBe("cancelled");
  });

  it("retains cancelled when the terminated child later closes", async () => {
    const db = new DatabaseSync(":memory:");
    ensureQualitySchema(db as never);
    const store = new QualityStore(db as never);
    const run = store.createRun({
      projectId: "p1",
      source: "hub",
      command: "safe-command",
      cwd: "/tmp",
      cwdKind: "project-root",
      timeoutMs: 1_000,
      triggeredBy: "test",
    });
    const child = new EventEmitter();
    const kill = vi.fn(() => queueMicrotask(() => child.emit("close", null, "SIGTERM")));
    vi.spyOn(core, "superviseSpawn").mockReturnValue({ child, kill } as never);

    const execution = executeQualityRun({
      store,
      projectId: "p1",
      runId: run.id,
      command: "safe-command",
      cwd: "/tmp",
      timeoutMs: 1_000,
      logTruncateKb: 1,
    });
    await cancelQualityRun(store, "p1", run.id);

    await expect(execution).resolves.toMatchObject({ status: "cancelled", errorMessage: "Cancelled by operator" });
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });
});

describe("plan step validation", () => {
  it("rejects mixed valid and unknown steps without silently filtering", () => {
    expect(() => validatePlanSteps(["verify-fast", "not-a-preset", "test-gate"])).toThrow("Unknown plan steps: not-a-preset");
  });
});
