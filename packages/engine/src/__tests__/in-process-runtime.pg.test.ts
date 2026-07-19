/*
FNXC:PostgresRuntimeComposition 2026-07-14-18:49:
The production InProcessRuntime must compose one owned PostgreSQL backend across TaskStore, central claims, and missions, then release that backend exactly once. This real-database lifecycle test guards the wiring seam that component-only tests cannot cover.
*/

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createTaskStoreForTest,
  pgDescribe,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

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

pgDescribe("InProcessRuntime PostgreSQL composition", () => {
  it("shares its PostgreSQL layer with claims and missions and shuts it down once", async () => {
    /*
    FNXC:PostgresRuntimeComposition 2026-07-14-21:33:
    Runtime composition coverage must use the controlled PostgreSQL harness so availability gating and database administration share the repository's bounded asynchronous lifecycle. Runtime and central connections must close in a finally block before the harness drops the database, including when an assertion fails early.
    */
    lifecycle.shutdownCalls = 0;
    const harness = await createTaskStoreForTest({ prefix: "fusion_runtime" });
    const priorDatabaseUrl = process.env.DATABASE_URL;
    let projectDir = "";
    let globalDir = "";
    let central: CentralCore | undefined;
    let runtime: InProcessRuntime | undefined;

    try {
      projectDir = await mkdtemp(join(tmpdir(), "fusion-runtime-pg-project-"));
      globalDir = await mkdtemp(join(tmpdir(), "fusion-runtime-pg-global-"));
      execFileSync("git", ["init", "-q", projectDir], { stdio: "pipe" });
      process.env.DATABASE_URL = harness.testUrl;

      central = new CentralCore(globalDir);
      runtime = new InProcessRuntime({
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

      await runtime.stop();
      await runtime.stop();
      expect(runtime.getStatus()).toBe("stopped");
      expect(lifecycle.shutdownCalls).toBe(1);
    } finally {
      try {
        await runtime?.stop();
      } finally {
        try {
          await central?.close();
        } finally {
          try {
            await harness.teardown();
          } finally {
            if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
            else process.env.DATABASE_URL = priorDatabaseUrl;
            await Promise.all([
              projectDir ? rm(projectDir, { recursive: true, force: true }) : Promise.resolve(),
              globalDir ? rm(globalDir, { recursive: true, force: true }) : Promise.resolve(),
            ]);
            lifecycle.shutdownCalls = 0;
          }
        }
      }
    }
  }, 30_000);
});
