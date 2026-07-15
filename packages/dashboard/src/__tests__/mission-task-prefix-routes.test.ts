// @vitest-environment node
/*
FNXC:MissionTaskPrefix 2026-07-14-12:00:
Route regression for greptile P1 on PR #1930: PATCH with taskPrefix null/empty must clear a stored mission override so triage inherits the project prefix; omitting the key must leave it unchanged.
*/

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@fusion/core";
import { createMissionRouter } from "../mission-routes.js";
import { request } from "../test-request.js";

async function createFixture() {
  const rootDir = mkdtempSync(join(tmpdir(), "kb-mission-task-prefix-"));
  const globalDir = join(rootDir, ".fusion-global-settings");
  const store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
  await store.init();

  const app = express();
  app.use(express.json());
  app.use("/api/missions", createMissionRouter(store));

  return { app, store, rootDir };
}

describe("mission taskPrefix routes", () => {
  let rootDir: string;
  let app: express.Express;
  let store: TaskStore;

  beforeEach(async () => {
    ({ app, store, rootDir } = await createFixture());
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("clears a stored taskPrefix when PATCH sends null", async () => {
    const mission = store.getMissionStore().createMission({ title: "Prefixed", taskPrefix: "ERR" });
    expect(store.getMissionStore().getMission(mission.id)?.taskPrefix).toBe("ERR");

    const response = await request(
      app,
      "PATCH",
      `/api/missions/${mission.id}`,
      JSON.stringify({ taskPrefix: null }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect((response.body as { taskPrefix?: string }).taskPrefix).toBeUndefined();
    expect(store.getMissionStore().getMission(mission.id)?.taskPrefix).toBeUndefined();
  });

  it("clears a stored taskPrefix when PATCH sends an empty string", async () => {
    const mission = store.getMissionStore().createMission({ title: "Prefixed", taskPrefix: "BUG" });

    const response = await request(
      app,
      "PATCH",
      `/api/missions/${mission.id}`,
      JSON.stringify({ taskPrefix: "   " }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(store.getMissionStore().getMission(mission.id)?.taskPrefix).toBeUndefined();
  });

  it("leaves taskPrefix unchanged when the PATCH body omits the key", async () => {
    const mission = store.getMissionStore().createMission({ title: "Prefixed", taskPrefix: "ERR" });

    const response = await request(
      app,
      "PATCH",
      `/api/missions/${mission.id}`,
      JSON.stringify({ title: "Renamed only" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect((response.body as { title: string; taskPrefix?: string }).title).toBe("Renamed only");
    expect((response.body as { taskPrefix?: string }).taskPrefix).toBe("ERR");
    expect(store.getMissionStore().getMission(mission.id)?.taskPrefix).toBe("ERR");
  });

  it("uppercases a non-empty taskPrefix on PATCH", async () => {
    const mission = store.getMissionStore().createMission({ title: "Plain" });

    const ok = await request(
      app,
      "PATCH",
      `/api/missions/${mission.id}`,
      JSON.stringify({ taskPrefix: "err2" }),
      { "content-type": "application/json" },
    );
    expect(ok.status).toBe(200);
    expect((ok.body as { taskPrefix?: string }).taskPrefix).toBe("ERR2");
    expect(store.getMissionStore().getMission(mission.id)?.taskPrefix).toBe("ERR2");
  });
});

