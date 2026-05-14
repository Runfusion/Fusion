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

function createFrontendStep() {
  return {
    id: "frontend-ux-design",
    name: "Frontend UX Design",
    description: "UI review",
    prompt: "Review UI",
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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

describe("executor workflow step scope gating", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it.each([
    {
      name: "both signals empty",
      diffFiles: [] as string[],
      declaredFiles: [] as string[],
      expectedSkip: false,
    },
    {
      name: "diff only non-frontend",
      diffFiles: ["packages/engine/src/executor.ts"],
      declaredFiles: [],
      expectedSkip: true,
    },
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
    store.getWorkflowStep.mockResolvedValue(createFrontendStep() as any);
    store.parseFileScopeFromPrompt.mockResolvedValue(declaredFiles);
    mockDiffFiles(diffFiles);

    const executor = new TaskExecutor(store as any, "/tmp/test", {} as any);
    const executeStepSpy = vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, output: "ok" });

    const result = await (executor as any).runWorkflowSteps(task as any, "/tmp/test", {} as any);

    expect(result).toEqual({ allPassed: true });
    if (expectedSkip) {
      expect(executeStepSpy).not.toHaveBeenCalled();
      const statuses = store.updateTask.mock.calls.flatMap((call: any[]) => call[1]?.workflowStepResults ?? []).map((r: any) => r.status);
      expect(statuses).toContain("skipped");
      if (expectedLog) {
        const logged = store.logEntry.mock.calls.map((call: any[]) => String(call[1] ?? ""));
        expect(logged.some((line: string) => line.includes(expectedLog))).toBe(true);
      }
    } else {
      expect(executeStepSpy).toHaveBeenCalledTimes(1);
    }
  });
});
