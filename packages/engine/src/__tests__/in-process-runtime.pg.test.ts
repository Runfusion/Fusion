/*
FNXC:PostgresRuntimeComposition 2026-07-14-18:49:
The production InProcessRuntime must compose one owned PostgreSQL backend across TaskStore, central claims, and missions, then release that backend exactly once. This real-database lifecycle test guards the wiring seam that component-only tests cannot cover.
*/

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({ shutdownCalls: 0 }));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    createTaskStoreForBackend: async (
      options: Parameters<typeof actual.createTaskStoreForBackend>[0],
    ) => {
      const boot = await actual.createTaskStoreForBackend(options);
      const shutdown = boot.shutdown;
      return {
        ...boot,
        shutdown: async () => {
          lifecycle.shutdownCalls += 1;
          await shutdown();
        },
      };
    },
  };
});

import { CentralCore, type AsyncCentralClaimStore } from "@fusion/core";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";

const PG_TEST_URL_BASE = process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const pgDescribe = process.env.FUSION_PG_TEST_SKIP === "1" ? describe.skip : describe;

function adminExec(statement: string): void {
  execFileSync("psql", [
    `${PG_TEST_URL_BASE}/postgres`,
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    statement,
  ], { stdio: "pipe", env: process.env });
}

pgDescribe("InProcessRuntime PostgreSQL composition", () => {
  let projectDir = "";
  let globalDir = "";
  let dbName = "";
  let priorDatabaseUrl: string | undefined;

  afterEach(async () => {
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    if (dbName) adminExec(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await Promise.all([
      projectDir ? rm(projectDir, { recursive: true, force: true }) : Promise.resolve(),
      globalDir ? rm(globalDir, { recursive: true, force: true }) : Promise.resolve(),
    ]);
    lifecycle.shutdownCalls = 0;
  });

  it("shares its PostgreSQL layer with claims and missions and shuts it down once", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "fusion-runtime-pg-project-"));
    globalDir = await mkdtemp(join(tmpdir(), "fusion-runtime-pg-global-"));
    execFileSync("git", ["init", "-q", projectDir], { stdio: "pipe" });
    dbName = `fusion_runtime_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    adminExec(`CREATE DATABASE "${dbName}"`);
    priorDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `${PG_TEST_URL_BASE}/${dbName}`;

    const central = new CentralCore(globalDir);
    const runtime = new InProcessRuntime({
      projectId: "runtime-composition",
      workingDirectory: projectDir,
      isolationMode: "in-process",
      maxConcurrent: 1,
      maxWorktrees: 1,
    }, central);
    runtime.on("error", () => undefined);

    await runtime.start();
    const taskStore = runtime.getTaskStore();
    const layer = taskStore.getAsyncLayer();
    expect(runtime.getStatus()).toBe("active");
    expect(taskStore.isBackendMode()).toBe(true);
    expect(layer?.projectId).toBe("runtime-composition");
    expect(runtime.getMissionExecutionLoop()).toBeDefined();

    const missionStore = taskStore.getMissionStore();
    const mission = await missionStore.createMission({ title: "Runtime composition" });
    expect((await missionStore.getMission(mission.id))?.title).toBe("Runtime composition");

    const claimStore = (runtime as unknown as { leaseCentralClaimStore: AsyncCentralClaimStore })
      .leaseCentralClaimStore;
    const claimed = await claimStore.tryClaimTask({
      projectId: "runtime-composition",
      taskId: "FN-RUNTIME-COMPOSITION",
      nodeId: "node-test",
      agentId: "agent-test",
      runId: "run-test",
      renewedAt: new Date().toISOString(),
    });
    expect(claimed.ok).toBe(true);

    await central.close();
    await runtime.stop();
    await runtime.stop();
    expect(runtime.getStatus()).toBe("stopped");
    expect(lifecycle.shutdownCalls).toBe(1);
  }, 30_000);
});
