import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TaskStore, TaskDetail, Settings } from "@fusion/core";
import { TriageProcessor } from "../triage.js";
import { reviewStep } from "../reviewer.js";

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  return createEngineCoreMock(() => importOriginal<typeof import("@fusion/core")>(), {
    resolveAgentPrompt: vi.fn().mockReturnValue(null),
  });
});

vi.mock("../reviewer.js", () => ({
  reviewStep: vi.fn().mockResolvedValue({ verdict: "APPROVE", review: "ok", summary: "ok" }),
}));

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 10000,
      groupOverlappingFiles: false,
      autoMerge: true,
    } as Settings),
    updateSettings: vi.fn(),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
    emit: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
}

const mockTaskDetail: TaskDetail = {
  id: "FN-5321",
  description: "Test task",
  column: "triage",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  prompt: "# Task\n",
  attachments: [],
  comments: [],
};

describe("triage deterministic plan validation for external integration evidence", () => {
  it("does not reject incomplete evidence during deterministic triage validation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "fusion-triage-ext-evidence-"));
    try {
      const taskId = "FN-5321";
      const fabricatedRepo = ["worktrunk", "worktrunk"].join("/");

      const store = createMockStore({ getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail, id: taskId }) });
      const processor = new TriageProcessor(store, rootDir);
      const failure = await (processor as any).validateGeneratedPrompt(
        taskId,
        `## Mission\nAdd third-party external binary integration.\n## Steps\n- install and probe \`worktrunk\` from release URL https://github.com/${fabricatedRepo}/releases/latest/download/worktrunk.tar.gz\n`,
      );

      expect(failure).toBeNull();
      expect(store.logEntry).not.toHaveBeenCalledWith(
        taskId,
        expect.stringContaining("external-integration evidence gaps"),
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("passes when dedicated labeled evidence section is complete", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "fusion-triage-ext-evidence-labeled-ok-"));
    try {
      const taskId = "FN-5321";
      const store = createMockStore({ getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail, id: taskId }) });
      const processor = new TriageProcessor(store, rootDir);
      const failure = await (processor as any).validateGeneratedPrompt(
        taskId,
        "## Mission\nValidate released third-party external integration.\n\n## External Integration Evidence\n- Canonical upstream repo URL: https://github.com/Runfusion/Fusion\n- Docs / homepage URL: https://github.com/Runfusion/Fusion#readme (npm package page: https://www.npmjs.com/package/@runfusion/fusion)\n- Release / download URL: https://registry.npmjs.org/@runfusion/fusion/-/fusion-0.41.0.tgz\n- Binary / CLI name: `fn`\n- Checksum (dist.integrity for 0.41.0): `sha512-y8BSeK3XUgcE7ceTrz6F/zWQidaiADVgHSHHWKRzwjyR40xeUc8i5ZSolGd1zL/K9AxrBSkRErimkW1xqb/EBw==` (marker: `upstream-pending-verification`)\n\n## Steps\n- Install, download, probe, and run the released external binary.\n",
      );

      expect(failure).toBeNull();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("passes when evidence is complete", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "fusion-triage-ext-evidence-ok-"));
    try {
      const taskId = "FN-5321";
      const store = createMockStore({ getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail, id: taskId }) });
      const processor = new TriageProcessor(store, rootDir);
      const failure = await (processor as any).validateGeneratedPrompt(
        taskId,
        "## Mission\nAdd third-party external integration.\n## Context to Read First\n- https://github.com/max-sixty/worktrunk\n- https://worktrunk.dev/\n- WORKTRUNK_PINNED_RELEASE\n## Steps\n- probe and run `wt`\n- release URL: https://github.com/max-sixty/worktrunk/releases/latest/download/wt-linux-x64.tar.gz\n- source: upstream-pending-verification\n",
      );

      expect(failure).toBeNull();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("blocks the per-step review workflow during Plan Review when external evidence is missing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "fusion-triage-ext-evidence-plan-review-"));
    try {
      const taskId = "FN-5321";
      const prompt = "## Mission\nAdd an external CLI.\n\n## Steps\n- Download and run `wt` from https://github.com/worktrunk/worktrunk/releases/latest/download/wt-linux-x64.tar.gz\n";
      const task = {
        ...mockTaskDetail,
        id: taskId,
        enabledWorkflowSteps: ["plan-review"],
        workflowStepResults: [],
      };
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(task),
        getTaskWorkflowSelection: vi.fn().mockReturnValue({ workflowId: "builtin:stepwise-coding", stepIds: ["plan-review"] }),
        getWorkflowDefinition: vi.fn().mockResolvedValue({
          id: "builtin:stepwise-coding",
          ir: {
            nodes: [
              {
                id: "plan-review",
                kind: "optional-group",
                config: {
                  template: {
                    nodes: [
                      {
                        id: "plan-review-step",
                        kind: "prompt",
                        config: { requireExternalIntegrationEvidence: true },
                      },
                    ],
                  },
                },
              },
            ],
          },
        }),
      } as Partial<TaskStore>);
      const processor = new TriageProcessor(store, rootDir);

      const result = await (processor as any).runPlanReviewBeforeExecution(task, prompt, {} as Settings);

      expect(result).toBe("blocked");
      expect(reviewStep).not.toHaveBeenCalled();
      expect(store.updateTask).toHaveBeenCalledWith(taskId, expect.objectContaining({ status: "needs-replan" }));
      expect((store.logEntry as ReturnType<typeof vi.fn>).mock.calls.some(
        ([id, action]) => id === taskId && action === "[pre-merge] Workflow step failed: Plan Review",
      )).toBe(false);
      expect(store.logEntry).toHaveBeenCalledWith(
        taskId,
        "AI spec revision requested",
        expect.stringContaining("External-integration evidence gaps"),
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
