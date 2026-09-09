// @ts-nocheck
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { executeScriptWorkflowStep } from "../executor/workflow-script-step.js";
import { acquireTaskWorktree } from "../worktree/worktree-acquisition.js";
import { runConfiguredCommand } from "../executor/configured-command.js";
import {
  createMockStore,
  mockedExistsSync,
  mockExecuteAll,
  resetExecutorMocks,
} from "./executor-test-helpers.js";
import { TaskStore as CoreTaskStore } from "../../../core/src/store.js";
import { writeProjectConfig } from "../../../core/src/task-store/async/async-settings.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

vi.mock("../worktree/worktree-acquisition.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../worktree/worktree-acquisition.js")>()),
  acquireTaskWorktree: vi.fn(),
}));

vi.mock("../executor/configured-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../executor/configured-command.js")>()),
  runConfiguredCommand: vi.fn(),
}));

const renamedName = "Build production";
const command = "pnpm build --production";
const worktreePath = "/tmp/test/.fusion/worktrees/fn-305";
const now = "2026-09-06T20:02:00.000Z";

function task() {
  return {
    id: "FN-305-consumer",
    title: "Execute renamed terminal script",
    description: "prove indirect consumers keep the command",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Implementation", status: "done" }],
    currentStep: 0,
    log: [],
    prompt: "# Task\n## Steps\n### Step 1\n- [x] done",
    createdAt: now,
    updatedAt: now,
  };
}

/*
FNXC:TerminalScripts 2026-09-06-20:02:
Renaming a terminal script changes only its catalog key and automation references. Both fresh-worktree setup and script workflow execution must still resolve and run the unchanged command rather than the optional description.
*/
describe("renamed terminal script execution consumers", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
    vi.mocked(acquireTaskWorktree).mockReset().mockResolvedValue({
      worktreePath,
      branch: "fusion/fn-305-consumer",
      source: "fresh",
      hydrated: true,
      isResume: false,
    });
    vi.mocked(runConfiguredCommand).mockReset().mockResolvedValue({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
    });
    mockExecuteAll.mockResolvedValue([{ stepIndex: 0, success: true, retries: 0 }]);
  });

  it("runs the unchanged command through runImplementation after setupScript is renamed", async () => {
    const liveTask = task();
    const store = createMockStore();
    store.getTask.mockImplementation(async () => ({ ...liveTask }));
    store.getSettings.mockResolvedValue({
      autoMerge: false,
      runStepsInNewSessions: true,
      setupScript: renamedName,
      scripts: { [renamedName]: command },
      scriptMetadata: { [renamedName]: { description: "Compile le produit" } },
      experimentalFeatures: { workflowGraphExecutor: true },
    });
    const executor = new TaskExecutor(store, "/tmp/test");
    vi.spyOn(executor as never as { runExecutorDeterministicVerification: () => unknown }, "runExecutorDeterministicVerification")
      .mockResolvedValue({ allPassed: true });

    await (executor as any).runImplementation(liveTask, vi.fn(), vi.fn());

    expect(vi.mocked(runConfiguredCommand).mock.calls[0]?.slice(0, 3)).toEqual([
      command,
      worktreePath,
      120_000,
    ]);
    expect(vi.mocked(runConfiguredCommand).mock.calls.some(([executed]) => executed === "Compile le produit")).toBe(false);
  });

  it("runs the unchanged command through executeScriptWorkflowStep after its graph reference is renamed", async () => {
    const scriptName = renamedName;
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
    const store = { logEntry: vi.fn(async () => undefined) };

    await expect(executeScriptWorkflowStep({
      store,
      getRunContextFor: () => undefined,
      registerConfiguredCommandController: vi.fn(),
      unregisterConfiguredCommandController: vi.fn(),
      runConfiguredCommand: run,
    } as never, task() as never, {
      id: "WS-renamed",
      name: "Build",
      mode: "script",
      scriptName,
    } as never, worktreePath, {
      scripts: { [renamedName]: command },
      scriptMetadata: { [renamedName]: { description: "Compile le produit" } },
    } as never)).resolves.toMatchObject({ success: true });

    expect(run).toHaveBeenCalledWith(
      command,
      worktreePath,
      120_000,
      undefined,
      expect.any(Object),
      expect.any(AbortSignal),
    );
    expect(run.mock.calls.some(([executed]) => executed === "Compile le produit")).toBe(false);
  });
});

pgDescribe("renamed terminal script execution from persisted mutation output", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_script_rename_execution",
  });

  beforeAll(h.beforeAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });
  afterAll(h.afterAll);

  it("feeds the persisted renamed setup and workflow-step references to both execution consumers", async () => {
    const projectId = "script-rename-execution";
    const layer = { ...h.layer(), projectId };
    const persistentStore = new CoreTaskStore(h.rootDir(), undefined, { asyncLayer: layer });
    await writeProjectConfig(layer, {
      scripts: { build: command },
      scriptMetadata: { build: { description: "Compile le produit" } },
      setupScript: "build",
    });
    const originalStep = await persistentStore.createWorkflowStep({
      name: "Build",
      description: "",
      mode: "script",
      scriptName: "build",
      phase: "pre-merge",
      gateMode: "gate",
    });

    await persistentStore.mutateScript({
      originalName: "build",
      name: renamedName,
      command,
      description: "Compile le produit",
    });

    const renamedSettings = await persistentStore.getSettings();
    const renamedStep = await persistentStore.getWorkflowStep(originalStep.id);
    expect(renamedSettings).toMatchObject({
      setupScript: renamedName,
      scripts: { [renamedName]: command },
    });
    expect(renamedStep?.scriptName).toBe(renamedName);

    const liveTask = task();
    const executorStore = createMockStore();
    executorStore.getTask.mockImplementation(async () => ({ ...liveTask }));
    executorStore.getSettings.mockResolvedValue({
      ...renamedSettings,
      autoMerge: false,
      runStepsInNewSessions: true,
      experimentalFeatures: { workflowGraphExecutor: true },
    });
    const executor = new TaskExecutor(executorStore, "/tmp/test");
    vi.spyOn(executor as never as { runExecutorDeterministicVerification: () => unknown }, "runExecutorDeterministicVerification")
      .mockResolvedValue({ allPassed: true });

    await (executor as any).runImplementation(liveTask, vi.fn(), vi.fn());
    expect(vi.mocked(runConfiguredCommand).mock.calls[0]?.[0]).toBe(command);

    const workflowRun = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
    await expect(executeScriptWorkflowStep({
      store: { logEntry: vi.fn(async () => undefined) },
      getRunContextFor: () => undefined,
      registerConfiguredCommandController: vi.fn(),
      unregisterConfiguredCommandController: vi.fn(),
      runConfiguredCommand: workflowRun,
    } as never, liveTask as never, renamedStep as never, worktreePath, renamedSettings)).resolves.toMatchObject({ success: true });

    expect(workflowRun.mock.calls[0]?.[0]).toBe(command);
    expect([
      vi.mocked(runConfiguredCommand).mock.calls[0]?.[0],
      workflowRun.mock.calls[0]?.[0],
    ]).not.toContain("Compile le produit");
  });
});
