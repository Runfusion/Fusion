/*
FNXC:PostgresRuntimeComposition 2026-07-14-18:49:
The production InProcessRuntime must compose one owned PostgreSQL backend across TaskStore, central claims, and missions, then release that backend exactly once. This real-database lifecycle test guards the wiring seam that component-only tests cannot cover.
*/

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createTaskStoreForTest,
  pgDescribe,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

const lifecycle = vi.hoisted(() => ({
  shutdownCalls: 0,
  secretsStore: { listEnvExportable: vi.fn() },
  secretsStoreFailure: undefined as Error | undefined,
  secretsStoreGetter: undefined as ReturnType<typeof vi.spyOn> | undefined,
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    createTaskStoreForBackend: async (
      options: Parameters<typeof actual.createTaskStoreForBackend>[0],
    ) => {
      const boot = await actual.createTaskStoreForBackend(options);
      const shutdown = boot.shutdown;
      lifecycle.secretsStoreGetter = vi.spyOn(boot.taskStore, "getSecretsStore");
      if (lifecycle.secretsStoreFailure) {
        lifecycle.secretsStoreGetter.mockRejectedValue(lifecycle.secretsStoreFailure);
      } else {
        lifecycle.secretsStoreGetter.mockResolvedValue(lifecycle.secretsStore as any);
      }
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
    lifecycle.secretsStore.listEnvExportable.mockReset();
    lifecycle.secretsStoreFailure = undefined;
    lifecycle.secretsStoreGetter = undefined;
    const harness = await createTaskStoreForTest({ prefix: "fusion_runtime" });
    const priorDatabaseUrl = process.env.DATABASE_URL;
    let projectDir = "";
    let globalDir = "";
    let central: CentralCore | undefined;
    let runtime: InProcessRuntime | undefined;
    let failedRuntime: InProcessRuntime | undefined;

    try {
      projectDir = await mkdtemp(join(tmpdir(), "fusion-runtime-pg-project-"));
      globalDir = await mkdtemp(join(tmpdir(), "fusion-runtime-pg-global-"));
      execFileSync("git", ["init", "-q", projectDir], { stdio: "pipe" });
      await writeFile(join(projectDir, ".gitignore"), ".secrets.env\n");
      await writeFile(join(projectDir, "README.md"), "runtime composition fixture\n");
      execFileSync("git", ["config", "user.email", "runtime-test@example.invalid"], { cwd: projectDir, stdio: "pipe" });
      execFileSync("git", ["config", "user.name", "Fusion Runtime Test"], { cwd: projectDir, stdio: "pipe" });
      execFileSync("git", ["add", "."], { cwd: projectDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-qm", "initialize runtime composition fixture"], { cwd: projectDir, stdio: "pipe" });
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
      const runtimeInternals = runtime as unknown as {
        usageLimitPauser?: unknown;
        triageProcessor?: { options?: { usageLimitPauser?: unknown } };
      };
      expect(runtimeInternals.usageLimitPauser).toBeDefined();
      expect(runtimeInternals.triageProcessor?.options?.usageLimitPauser)
        .toBe(runtimeInternals.usageLimitPauser);

      /*
      FNXC:SecretsEnvRuntimeWiring 2026-08-05-21:30:
      Production composition resolves the project store once and gives the exact instance to
      both fresh-worktree consumers. Their existing acquisition coverage verifies the writer;
      this seam test prevents an omitted runtime dependency from silently becoming no-store.
      */
      const secretsStore = await lifecycle.secretsStoreGetter?.mock.results[0]?.value;
      const runtimeConsumers = runtime as unknown as {
        executor?: { options?: { secretsStore?: unknown; agentStore?: unknown } };
        heartbeatMonitor?: { secretsStore?: unknown; configStore?: unknown };
        scheduler?: { options?: { agentStore?: unknown } };
        triageProcessor?: { options?: { agentStore?: unknown } };
        selfHealingManager?: { options?: { agentStore?: unknown } };
      };
      expect(lifecycle.secretsStoreGetter).toHaveBeenCalled();
      expect(runtimeConsumers.executor?.options?.secretsStore).toBe(secretsStore);
      expect(runtimeConsumers.heartbeatMonitor?.secretsStore).toBe(secretsStore);

      /*
      FNXC:WorkflowAgentRouting 2026-08-07-22:39:
      Every runtime consumer that resolves a permanent workflow principal must receive the ONE
      long-lived engine AgentStore — asserted across all of them, not only the consumer that
      regressed. FN-8764 gave the executor a fail-closed role-routing gate keyed on
      `options.agentStore` but never wired that option, so a store the runtime had already built
      was simply absent at the seam: every role-classified node (execute / step-execute / review /
      merge) failed closed, the executor's `workflow-principal-*` branch swallowed it as a
      recoverable hold, and the board deadlocked with no log, audit, or task error. The invariant
      is the shared instance at every seam; an undefined here is the deadlock.
      */
      const runtimeAgentStore = runtime.getAgentStore();
      expect(runtimeAgentStore).toBeDefined();
      expect(runtimeConsumers.executor?.options?.agentStore).toBe(runtimeAgentStore);
      expect(runtimeConsumers.scheduler?.options?.agentStore).toBe(runtimeAgentStore);
      expect(runtimeConsumers.triageProcessor?.options?.agentStore).toBe(runtimeAgentStore);
      expect(runtimeConsumers.selfHealingManager?.options?.agentStore).toBe(runtimeAgentStore);
      expect(runtimeConsumers.heartbeatMonitor?.configStore).toBe(runtimeAgentStore);

      /*
      FNXC:SecretsEnvRuntimeWiring 2026-08-05-21:58:
      Production coverage must invoke the runtime-created executor and heartbeat monitor, not
      extract their dependency into a helper call. Each consumer owns a distinct fresh-worktree
      path; both must materialize the ignored file and record a redacted write audit.
      */
      await taskStore.updateSettings({
        testMode: true,
        secretsEnv: { enabled: true, filename: ".secrets.env" },
      });
      lifecycle.secretsStore.listEnvExportable.mockResolvedValue([
        {
          id: "runtime-secret",
          key: "runtime-key",
          exportKey: "RUNTIME_SECRET",
          scope: "project",
          plaintextValue: "runtime-test-value",
        },
      ]);
      const assertConsumerMaterializedSecretsEnv = async (taskId: string) => {
        const task = await taskStore.getTask(taskId);
        expect(task?.worktree).toEqual(expect.any(String));
        const exportedKeys = (await readFile(join(task!.worktree!, ".secrets.env"), "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("=", 1)[0]);
        expect(exportedKeys).toContain("RUNTIME_SECRET");
        const auditEvents = await taskStore.getRunAuditEventsAsync();
        const writeEvent = auditEvents.find((event) =>
          event.target === taskId && event.mutationType === "secret:env-write",
        );
        expect(writeEvent?.metadata).toMatchObject({ keyCount: 1, fingerprint: expect.any(String) });
        expect(auditEvents.some((event) =>
          event.target === taskId
            && event.mutationType === "secret:env-write-skipped"
            && event.metadata?.reason === "no-store",
        )).toBe(false);
      };

      const executorTask = await taskStore.createTask({ description: "executor secrets env" });
      await (runtime.getExecutor() as any).ensureGraphCustomNodeWorktree(
        executorTask,
        await taskStore.getSettings(),
        "test-worktree",
      );
      await assertConsumerMaterializedSecretsEnv(executorTask.id);

      const heartbeatTask = await taskStore.createTask({ description: "heartbeat secrets env" });
      const agentStore = runtime.getAgentStore()!;
      const heartbeatAgent = await agentStore.createAgent({
        name: "Runtime secrets-env heartbeat agent",
        role: "executor",
      });
      await agentStore.assignTask(heartbeatAgent.id, heartbeatTask.id);
      await runtime.getHeartbeatMonitor()!.executeHeartbeat({
        agentId: heartbeatAgent.id,
        source: "on_demand",
      });
      await assertConsumerMaterializedSecretsEnv(heartbeatTask.id);

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

      /*
      FNXC:SecretsEnvRuntimeWiring 2026-08-05-22:12:
      Secrets-store resolution is an essential composition dependency, not a best-effort
      secretsEnv convenience. A rejection must take the normal fail-closed startup cleanup
      path so no partial executor or heartbeat runtime remains active.
      */
      lifecycle.secretsStoreFailure = new Error("test secrets-store initialization failure");
      failedRuntime = new InProcessRuntime({
        projectId: "runtime-composition-secrets-store-failure",
        workingDirectory: projectDir,
        isolationMode: "in-process",
        maxConcurrent: 1,
        maxWorktrees: 1,
      }, central);
      failedRuntime.on("error", () => undefined);
      await expect(failedRuntime.start()).rejects.toThrow("test secrets-store initialization failure");
      expect(failedRuntime.getStatus()).toBe("errored");
      expect(lifecycle.shutdownCalls).toBe(2);
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
            lifecycle.secretsStoreFailure = undefined;
            lifecycle.secretsStoreGetter = undefined;
          }
        }
      }
    }
  }, 30_000);
});
