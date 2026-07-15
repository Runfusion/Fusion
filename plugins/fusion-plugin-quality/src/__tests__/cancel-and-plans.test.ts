import { describe, expect, it } from "vitest";
import { DatabaseSync } from "@fusion/core";
import { ensureQualitySchema } from "../quality-schema.js";
import { QualityStore } from "../store/quality-store.js";
import { cancelQualityRun, __clearActiveQualityRunsForTests } from "../runner/command-runner.js";
import { isQualityPresetId } from "../runner/command-presets.js";

describe("cancelQualityRun", () => {
  it("marks queued/running runs cancelled without overwriting terminal rows", () => {
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
    const cancelled = cancelQualityRun(store, "p1", run.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.errorMessage).toMatch(/Cancelled/);

    const again = cancelQualityRun(store, "p1", run.id);
    expect(again?.status).toBe("cancelled");
  });
});

describe("plan step validation", () => {
  it("rejects mixed valid and unknown steps (no silent filter)", () => {
    const stepsRaw = ["verify-fast", "not-a-preset", "test-gate"];
    const invalid = stepsRaw.filter((s) => !isQualityPresetId(s));
    expect(invalid).toEqual(["not-a-preset"]);
  });
});
