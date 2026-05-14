import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, mockedExecSync, resetExecutorMocks } from "./executor-test-helpers.js";

function createTask() {
  return {
    id: "FN-001",
    title: "Test",
    description: "Test task",
    column: "in-progress" as const,
    dependencies: [],
    steps: [{ name: "Preflight", status: "done" as const }],
    currentStep: 0,
    log: [],
    enabledWorkflowSteps: ["frontend-ux-design"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createWorkflowStep(overrides: Record<string, unknown> = {}) {
  return {
    id: "frontend-ux-design",
    name: "Frontend UX Design",
    description: "UI review",
    prompt: "Review UI",
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockDiffFiles(files: string[]) {
  mockedExecSync.mockImplementation((cmd: string | string[]) => {
    if (typeof cmd === "string" && cmd.includes("git merge-base HEAD origin/main")) {
      return Buffer.from("abc123\n");
    }
    if (typeof cmd === "string" && cmd.includes("git diff --name-only abc123..HEAD")) {
      return Buffer.from(files.join("\n"));
    }
    return Buffer.from("");
  });
}

function mockDiffSequence(preStepFiles: string[], postStepFiles: string[]) {
  let diffCallCount = 0;
  mockedExecSync.mockImplementation((cmd: string | string[]) => {
    if (typeof cmd === "string" && cmd.includes("git merge-base HEAD origin/main")) {
      return Buffer.from("abc123\n");
    }
    if (typeof cmd === "string" && cmd.includes("git diff --name-only abc123..HEAD")) {
      diffCallCount += 1;
      const files = diffCallCount === 1 ? preStepFiles : postStepFiles;
      return Buffer.from(files.join("\n"));
    }
    return Buffer.from("");
  });
}

describe("executor workflow step scope gating", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it.each([
    { name: "both signals empty", diffFiles: [] as string[], declaredFiles: [] as string[], expectedSkip: false },
    { name: "diff only non-frontend", diffFiles: ["packages/engine/src/executor.ts"], declaredFiles: [], expectedSkip: true },
    {
      name: "declared only non-frontend",
      diffFiles: [],
      declaredFiles: [".github/workflows/ci.yml"],
      expectedSkip: true,
      expectedLog: "declared File Scope contains no frontend/UI files",
    },
    {
      name: "both present and both non-frontend",
      diffFiles: ["packages/engine/src/executor.ts"],
      declaredFiles: [".github/workflows/ci.yml"],
      expectedSkip: true,
      expectedLog: "declared File Scope contains no frontend/UI files",
    },
  ])("FN-4343 auto-skip matrix: $name", async ({ diffFiles, declaredFiles, expectedSkip, expectedLog }) => {
    const store = createMockStore();
    const task = createTask();
    store.getTask.mockResolvedValue(task as any);
    store.getWorkflowStep.mockResolvedValue(createWorkflowStep() as any);
    store.parseFileScopeFromPrompt.mockResolvedValue(declaredFiles);
    mockDiffFiles(diffFiles);

    const executor = new TaskExecutor(store as any, "/tmp/test", {} as any);
    const executeStepSpy = vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, output: "ok" });

    const result = await (executor as any).runWorkflowSteps(task as any, "/tmp/test", {} as any);

    expect(result).toEqual({ allPassed: true });
    if (expectedSkip) {
      expect(executeStepSpy).not.toHaveBeenCalled();
      if (expectedLog) {
        const logged = store.logEntry.mock.calls.map((call: any[]) => String(call[1] ?? ""));
        expect(logged.some((line: string) => line.includes(expectedLog))).toBe(true);
      }
    } else {
      expect(executeStepSpy).toHaveBeenCalledTimes(1);
    }
  });

  it("passes when prompt-mode pre-merge step writes in-scope files", async () => {
    const store = createMockStore();
    const task = { ...createTask(), enabledWorkflowSteps: ["WS-001"] };
    store.getTask.mockResolvedValue(task as any);
    store.getWorkflowStep.mockResolvedValue(createWorkflowStep({ id: "WS-001", name: "Workflow Review" }) as any);
    store.parseFileScopeFromPrompt.mockResolvedValue(["packages/engine/src/executor.ts"]);
    mockDiffFiles(["packages/engine/src/executor.ts"]);

    const executor = new TaskExecutor(store as any, "/tmp/test", {} as any);
    vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, output: "ok" });

    const result = await (executor as any).runWorkflowSteps(task as any, "/tmp/test", { workflowStepScopeEnforcement: "block" } as any);

    expect(result).toEqual({ allPassed: true });
  });

  it("requests revision in block mode when step writes off-scope files", async () => {
    const store = createMockStore();
    const task = { ...createTask(), enabledWorkflowSteps: ["WS-001"] };
    store.getTask.mockResolvedValue(task as any);
    store.getWorkflowStep.mockResolvedValue(createWorkflowStep({ id: "WS-001", name: "Workflow Review" }) as any);
    store.parseFileScopeFromPrompt.mockResolvedValue(["packages/engine/src/executor.ts"]);
    mockDiffSequence([], ["packages/dashboard/app/components/TaskDetailModal.tsx"]);

    const executor = new TaskExecutor(store as any, "/tmp/test", {} as any);
    vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, output: "ok" });

    const result = await (executor as any).runWorkflowSteps(task as any, "/tmp/test", { workflowStepScopeEnforcement: "block" } as any);

    expect(result).toEqual(expect.objectContaining({ allPassed: false, revisionRequested: true, stepName: "Workflow Review" }));
    expect(String((result as any).feedback)).toContain("wrote files outside declared File Scope");
  });

  it("detects off-scope delta even when pre-step diff has in-scope files", async () => {
    const store = createMockStore();
    const task = { ...createTask(), enabledWorkflowSteps: ["WS-001"] };
    store.getTask.mockResolvedValue(task as any);
    store.getWorkflowStep.mockResolvedValue(createWorkflowStep({ id: "WS-001", name: "Workflow Review" }) as any);
    store.parseFileScopeFromPrompt.mockResolvedValue(["packages/engine/src/executor.ts"]);

    mockDiffSequence(
      ["packages/engine/src/executor.ts"],
      ["packages/engine/src/executor.ts", "packages/dashboard/app/components/TaskDetailModal.tsx"],
    );

    const executor = new TaskExecutor(store as any, "/tmp/test", {} as any);
    vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, output: "ok" });

    const result = await (executor as any).runWorkflowSteps(task as any, "/tmp/test", { workflowStepScopeEnforcement: "block" } as any);

    expect(result).toEqual(expect.objectContaining({ allPassed: false, revisionRequested: true }));
    expect(String((result as any).feedback)).toContain("TaskDetailModal.tsx");
  });

  it("warn mode logs but passes on off-scope writes", async () => {
    const store = createMockStore();
    const task = { ...createTask(), enabledWorkflowSteps: ["WS-001"] };
    store.getTask.mockResolvedValue(task as any);
    store.getWorkflowStep.mockResolvedValue(createWorkflowStep({ id: "WS-001", name: "Workflow Review" }) as any);
    store.parseFileScopeFromPrompt.mockResolvedValue(["packages/engine/src/executor.ts"]);
    mockDiffSequence([], ["packages/dashboard/app/components/TaskDetailModal.tsx"]);

    const executor = new TaskExecutor(store as any, "/tmp/test", {} as any);
    vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, output: "ok" });

    const result = await (executor as any).runWorkflowSteps(task as any, "/tmp/test", { workflowStepScopeEnforcement: "warn" } as any);

    expect(result).toEqual({ allPassed: true });
    const logged = store.logEntry.mock.calls.map((call: any[]) => String(call[1] ?? ""));
    expect(logged.some((line: string) => line.includes("workflowStepScopeEnforcement=warn"))).toBe(true);
  });

  it("off mode bypasses enforcement", async () => {
    const store = createMockStore();
    const task = { ...createTask(), enabledWorkflowSteps: ["WS-001"] };
    store.getTask.mockResolvedValue(task as any);
    store.getWorkflowStep.mockResolvedValue(createWorkflowStep({ id: "WS-001", name: "Workflow Review" }) as any);
    store.parseFileScopeFromPrompt.mockResolvedValue(["packages/engine/src/executor.ts"]);
    mockDiffFiles(["packages/dashboard/app/components/TaskDetailModal.tsx"]);

    const executor = new TaskExecutor(store as any, "/tmp/test", {} as any);
    vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, output: "ok" });

    const result = await (executor as any).runWorkflowSteps(task as any, "/tmp/test", { workflowStepScopeEnforcement: "off" } as any);

    expect(result).toEqual({ allPassed: true });
  });

  it("scopeOverride=true bypasses enforcement regardless of mode", async () => {
    const store = createMockStore();
    const task = { ...createTask(), enabledWorkflowSteps: ["WS-001"], scopeOverride: true };
    store.getTask.mockResolvedValue(task as any);
    store.getWorkflowStep.mockResolvedValue(createWorkflowStep({ id: "WS-001", name: "Workflow Review" }) as any);
    store.parseFileScopeFromPrompt.mockResolvedValue(["packages/engine/src/executor.ts"]);
    mockDiffSequence([], ["packages/dashboard/app/components/TaskDetailModal.tsx"]);

    const executor = new TaskExecutor(store as any, "/tmp/test", {} as any);
    vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, output: "ok" });

    const result = await (executor as any).runWorkflowSteps(task as any, "/tmp/test", { workflowStepScopeEnforcement: "block" } as any);

    expect(result).toEqual({ allPassed: true });
  });

  it("FN-4280 regression: declared workflow-only scope skips Frontend UX without executing agent", async () => {
    const store = createMockStore();
    const task = createTask();
    store.getTask.mockResolvedValue(task as any);
    store.getWorkflowStep.mockResolvedValue(createWorkflowStep() as any);
    store.parseFileScopeFromPrompt.mockResolvedValue([
      ".github/workflows/ci.yml",
      ".github/workflows/mobile.yml",
      ".github/workflows/test-release.yml",
      ".github/workflows/release.yml",
      ".github/workflows/version.yml",
    ]);
    mockDiffFiles([]);

    const executor = new TaskExecutor(store as any, "/tmp/test", {} as any);
    const executeStepSpy = vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, output: "ok" });

    const result = await (executor as any).runWorkflowSteps(task as any, "/tmp/test", {} as any);

    expect(result).toEqual({ allPassed: true });
    expect(executeStepSpy).not.toHaveBeenCalled();
    const logged = store.logEntry.mock.calls.map((call: any[]) => String(call[1] ?? ""));
    expect(logged.some((line: string) => line.includes("declared File Scope contains no frontend/UI files"))).toBe(true);
  });
});
