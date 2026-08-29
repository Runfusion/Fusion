import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskDetail, Column, MergeResult, PrInfo } from "@fusion/core";
import { clearAuthToken } from "../../auth";

const apiMocks = vi.hoisted(() => ({
  createPr: vi.fn(),
  fetchPrOptions: vi.fn(),
  fetchPrPreflight: vi.fn(),
  generatePrMetadata: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    uploadAttachment: vi.fn(),
    deleteAttachment: vi.fn(),
    updateTask: vi.fn().mockResolvedValue({}),
    fetchTaskDetail: vi.fn().mockResolvedValue(makeTask()),
    fetchAgentLogs: vi.fn().mockResolvedValue([]),
    requestSpecRevision: vi.fn().mockResolvedValue({}),
    approvePlan: vi.fn().mockResolvedValue({}),
    rejectPlan: vi.fn().mockResolvedValue({}),
    duplicateTask: vi.fn().mockResolvedValue({}),
    refineTask: vi.fn().mockResolvedValue({}),
    addSteeringComment: vi.fn(),
    assignTask: vi.fn().mockResolvedValue({}),
    fetchAgents: vi.fn().mockResolvedValue([]),
    fetchAgent: vi.fn().mockResolvedValue(null),
    fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [] }),
    fetchSettings: vi.fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {}, autoMerge: false }),
    fetchGlobalSettings: vi.fn().mockResolvedValue({}),
    fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
    refineText: vi.fn(),
    getRefineErrorMessage: vi.fn((err: any) => err?.message || "Failed to refine"),
    updateGlobalSettings: vi.fn().mockResolvedValue({}),
    pauseTask: vi.fn().mockResolvedValue({}),
    unpauseTask: vi.fn().mockResolvedValue({}),
    fetchWorkflowResults: vi.fn().mockResolvedValue([]),
    fetchTaskReview: vi.fn().mockResolvedValue({ reviewState: { source: "reviewer-agent", items: [], addressing: [] }, automationStatus: null, emptyMessage: "No reviewer feedback yet" }),
    refreshTaskReview: vi.fn().mockResolvedValue({ reviewState: undefined, automationStatus: null }),
    reviseTaskReviewItems: vi.fn().mockResolvedValue({ task: makeTask(), reviewState: undefined }),
    generatePrMetadata: apiMocks.generatePrMetadata,
    fetchPrPreflight: apiMocks.fetchPrPreflight,
    fetchPrOptions: apiMocks.fetchPrOptions,
    createPr: apiMocks.createPr,
  });
});

vi.mock("../../hooks/useAgentLogs", () => ({
  useAgentLogs: vi.fn(() => ({ entries: [], loading: false, clear: vi.fn(), loadMore: vi.fn(async () => {}), hasMore: false, total: null, loadingMore: false })),
}));

vi.mock("../../hooks/usePluginUiSlots", () => ({
  usePluginUiSlots: () => ({ slots: [], getSlotsForId: vi.fn(() => []), loading: false, error: null }),
}));

const mockConfirm = vi.fn();
const mockConfirmWithChoice = vi.fn();

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm, confirmWithChoice: mockConfirmWithChoice }),
}));

import { TaskDetailModal } from "../TaskDetailModal";

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-5145",
    title: "Create PR wiring",
    description: "Test task",
    column: "in-progress" as Column,
    dependencies: [],
    prompt: "",
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as TaskDetail;
}

const noop = vi.fn();
const noopMove = vi.fn(async () => ({}) as Task);
const noopDelete = vi.fn(async () => ({}) as Task);
const noopMerge = vi.fn(async () => ({ merged: false }) as MergeResult);
const noopOpenDetail = vi.fn();

describe("TaskDetailModal create-PR integration wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockResolvedValue(true);
    mockConfirmWithChoice.mockResolvedValue("primary");
    clearAuthToken();
    localStorage.removeItem("fn.authToken");
    apiMocks.generatePrMetadata.mockResolvedValue({
      title: "AI-generated PR title",
      body: "AI-generated PR body",
    });
    apiMocks.fetchPrPreflight.mockResolvedValue({
      ok: true,
      clean: true,
      branchName: "fusion/FN-5145",
      headBranch: "fusion/FN-5145",
      baseBranch: "main",
      checks: [],
    });
    apiMocks.fetchPrOptions.mockResolvedValue({
      labels: [],
      reviewers: [],
      assignees: [],
      defaultBaseBranch: "main",
      availableBaseBranches: ["main"],
    });
    apiMocks.createPr.mockResolvedValue({
      number: 5145,
      title: "Created PR",
      url: "https://example.test/pr/5145",
      status: "open",
      headBranch: "fusion/FN-5145",
      baseBranch: "main",
      commentCount: 0,
    } satisfies PrInfo);
  });

  afterEach(() => {
    clearAuthToken();
    localStorage.removeItem("fn.authToken");
  });

  it("opens the real PR create modal from the Review tab", async () => {
    const task = makeTask({ id: "FN-5145", column: "in-review", prInfo: undefined, prInfos: [] });

    render(
      <TaskDetailModal
        task={task}
        projectId="project-123"
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={vi.fn()}
        prAuthAvailable
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    const reviewCreateButton = await screen.findByTestId("task-review-create-pr");
    expect(screen.queryByRole("dialog", { name: "Create Pull Request" })).toBeNull();

    fireEvent.click(reviewCreateButton);

    expect(await screen.findByRole("dialog", { name: "Create Pull Request" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Create Pull Request" })).toBeInTheDocument();
    await waitFor(() => {
      expect(apiMocks.generatePrMetadata).toHaveBeenCalledWith("FN-5145", "project-123");
      expect(apiMocks.fetchPrPreflight).toHaveBeenCalledWith("FN-5145", "project-123", undefined);
      expect(apiMocks.fetchPrOptions).toHaveBeenCalledWith("FN-5145", "project-123");
    });
    expect(screen.getByTestId("task-review-create-pr")).toBeInTheDocument();
  });

  it("still opens the real PR create modal from the default PrPanel path", async () => {
    const task = makeTask({ id: "FN-5146", column: "in-review", prInfo: undefined, prInfos: [] });

    render(
      <TaskDetailModal
        task={task}
        projectId="project-123"
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={vi.fn()}
        prAuthAvailable
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Pull Request" }));
    const panelCreateButton = await screen.findByTestId("pr-panel-create-pr");
    expect(screen.queryByRole("dialog", { name: "Create Pull Request" })).toBeNull();

    fireEvent.click(panelCreateButton);

    expect(await screen.findByRole("dialog", { name: "Create Pull Request" })).toBeInTheDocument();
    await waitFor(() => {
      expect(apiMocks.generatePrMetadata).toHaveBeenCalledWith("FN-5146", "project-123");
      expect(apiMocks.fetchPrPreflight).toHaveBeenCalledWith("FN-5146", "project-123", undefined);
      expect(apiMocks.fetchPrOptions).toHaveBeenCalledWith("FN-5146", "project-123");
    });
  });
});
