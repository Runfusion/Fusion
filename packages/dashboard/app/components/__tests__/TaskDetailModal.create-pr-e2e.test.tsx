import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskDetail, Column, MergeResult } from "@fusion/core";
import { clearAuthToken } from "../../auth";
import { loadAllAppCss } from "../../test/cssFixture";

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
    id: "FN-5169",
    title: "Create PR e2e",
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

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("TaskDetailModal Review-tab Create PR e2e flow", () => {
  let styleEl: HTMLStyleElement;
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

  beforeAll(() => {
    styleEl = document.createElement("style");
    styleEl.textContent = loadAllAppCss();
    document.head.appendChild(styleEl);
  });

  afterAll(() => {
    styleEl.remove();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockResolvedValue(true);
    mockConfirmWithChoice.mockResolvedValue("primary");
    clearAuthToken();
    localStorage.removeItem("fn.authToken");
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/tasks/FN-5169/pr/generate-metadata?projectId=project-123") {
        expect(init?.method).toBe("POST");
        return jsonResponse({ title: "test title", body: "test body", templateUsed: false });
      }
      if (url === "/api/tasks/FN-5169/pr/preflight?projectId=project-123") {
        expect(init?.method ?? "GET").toBe("GET");
        return jsonResponse({
          branchOnRemote: true,
          commitsPresent: true,
          conflictsWithBase: false,
          ghAuthOk: true,
          defaultBaseBranch: "main",
          head: "fusion/FN-5169",
          commits: [],
          changedFiles: [],
        });
      }
      if (url === "/api/tasks/FN-5169/pr/options?projectId=project-123") {
        expect(init?.method ?? "GET").toBe("GET");
        return jsonResponse({ baseBranches: ["main"], reviewers: [], assignees: [], labels: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  });

  afterEach(() => {
    clearAuthToken();
    localStorage.removeItem("fn.authToken");
    fetchSpy.mockRestore();
  });

  it("mounts PrCreateModal from the Review tab and loads metadata, preflight, and options through legacy fetch wrappers", async () => {
    const task = makeTask({ id: "FN-5169", column: "in-review", prInfo: undefined, prInfos: [] });

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
    fireEvent.click(await screen.findByTestId("task-review-create-pr"));

    expect(await screen.findByRole("dialog", { name: /create pull request/i })).toBeInTheDocument();
    expect(await screen.findByDisplayValue("test title")).toBeInTheDocument();
    expect(screen.getByLabelText(/base branch/i)).toHaveValue("main");

    const prCalls = await waitFor(() => {
      const calls = fetchSpy.mock.calls.filter(([input]) => String(input).includes("/api/tasks/FN-5169/pr/"));
      expect(calls).toHaveLength(3);
      return calls;
    });

    expect(prCalls).toEqual([
      [
        "/api/tasks/FN-5169/pr/generate-metadata?projectId=project-123",
        expect.objectContaining({ method: "POST" }),
      ],
      [
        "/api/tasks/FN-5169/pr/preflight?projectId=project-123",
        expect.objectContaining({ headers: expect.anything() }),
      ],
      [
        "/api/tasks/FN-5169/pr/options?projectId=project-123",
        expect.objectContaining({ headers: expect.anything() }),
      ],
    ]);
    expect(screen.queryByText("Loading PR metadata…")).toBeNull();
  });

  it("surfaces a recoverable error when the generate-metadata endpoint is missing instead of failing silently", async () => {
    fetchSpy.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/tasks/FN-5169/pr/generate-metadata?projectId=project-123") {
        expect(init?.method).toBe("POST");
        return jsonResponse({ error: "Route not found" }, { status: 404, statusText: "Not Found" });
      }
      if (url === "/api/tasks/FN-5169/pr/preflight?projectId=project-123") {
        return jsonResponse({
          branchOnRemote: true,
          commitsPresent: true,
          conflictsWithBase: false,
          ghAuthOk: true,
          defaultBaseBranch: "main",
          head: "fusion/FN-5169",
          commits: [],
          changedFiles: [],
        });
      }
      if (url === "/api/tasks/FN-5169/pr/options?projectId=project-123") {
        return jsonResponse({ baseBranches: ["main"], reviewers: [], assignees: [], labels: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const task = makeTask({ id: "FN-5169", column: "in-review", prInfo: undefined, prInfos: [] });

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
    fireEvent.click(await screen.findByTestId("task-review-create-pr"));

    expect(await screen.findByRole("dialog", { name: /create pull request/i })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Route not found");
    expect(screen.queryByText("Loading PR metadata…")).toBeNull();
  });
});
