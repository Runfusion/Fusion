import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { Board } from "../Board";
import { ListView } from "../ListView";
import { writeBoardWorkflowsCache } from "../../utils/boardWorkflowsCache";
import type { BoardWorkflowsPayload } from "../../api";
import type { Task } from "@fusion/core";

const apiMocks = vi.hoisted(() => ({
  fetchBoardWorkflows: vi.fn(),
  fetchWorkflowSteps: vi.fn(),
  /*
  FNXC:BoardNoLegacyFlash 2026-07-07-09:05:
  ListView renders QuickEntryBox, whose quick-create path calls fetchWorkflowOptionalSteps (added FN-6304). The partial api mock must expose it or vitest throws "No fetchWorkflowOptionalSteps export" during render and the skeleton/legacy assertions never settle.
  */
  fetchWorkflowOptionalSteps: vi.fn(),
  fetchNodes: vi.fn(),
  fetchTaskDetail: vi.fn(),
  batchUpdateTaskModels: vi.fn(),
  promoteTask: vi.fn(),
  fetchModels: vi.fn(),
  fetchSettings: vi.fn(),
  fetchGlobalSettings: vi.fn(),
  api: vi.fn(),
}));

vi.mock("../../api", () => ({
  fetchBoardWorkflows: apiMocks.fetchBoardWorkflows,
  fetchWorkflowSteps: apiMocks.fetchWorkflowSteps,
  fetchWorkflowOptionalSteps: apiMocks.fetchWorkflowOptionalSteps,
  fetchTaskDetail: apiMocks.fetchTaskDetail,
  batchUpdateTaskModels: apiMocks.batchUpdateTaskModels,
  promoteTask: apiMocks.promoteTask,
  fetchModels: apiMocks.fetchModels,
  fetchSettings: apiMocks.fetchSettings,
  fetchGlobalSettings: apiMocks.fetchGlobalSettings,
  api: apiMocks.api,
}));

vi.mock("../../hooks/useBlockerFanout", () => ({
  useBlockerFanout: () => new Map(),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn(() => () => {}),
}));

vi.mock("../Column", () => ({
  Column: React.memo(({ column, workflowMode }: { column: string; workflowMode?: boolean }) => (
    <div className="column" data-testid={`column-${column}`} data-workflow-mode={workflowMode ? "true" : "false"} />
  )),
}));

const workflowPayload: BoardWorkflowsPayload = {
  flagEnabled: true,
  defaultWorkflowId: "workflow-a",
  workflows: [
    {
      id: "workflow-a",
      name: "Workflow A",
      columns: [
        { id: "todo", name: "Todo", flags: { intake: true } },
        { id: "done", name: "Done", flags: { complete: true } },
      ],
    },
    {
      id: "workflow-b",
      name: "Workflow B",
      columns: [
        { id: "doing", name: "Doing", flags: { countsTowardWip: true } },
        { id: "shipped", name: "Shipped", flags: { complete: true } },
      ],
    },
  ],
  taskWorkflowIds: {},
};

const emptyWorkflowPayload: BoardWorkflowsPayload = {
  flagEnabled: true,
  defaultWorkflowId: "workflow-a",
  workflows: [],
  taskWorkflowIds: {},
};


function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mockViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes("768px") ? width <= 768 : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

const tasks: Task[] = [];

const boardProps = {
  tasks,
  maxConcurrent: 2,
  onMoveTask: vi.fn(async () => ({} as Task)),
  onOpenDetail: vi.fn(),
  addToast: vi.fn(),
  onNewTask: vi.fn(),
  autoMerge: true,
  onToggleAutoMerge: vi.fn(),
};

const listProps = {
  tasks,
  onMoveTask: vi.fn(async () => ({} as Task)),
  onDeleteTask: vi.fn(async () => ({} as Task)),
  onMergeTask: vi.fn(async () => ({} as never)),
  onOpenDetail: vi.fn(),
  addToast: vi.fn(),
  onCreateWorkflow: vi.fn(),
};

type Surface = "Board" | "ListView";
type Breakpoint = "desktop" | "mobile";

function renderSurface(surface: Surface, projectId = "project-a") {
  if (surface === "Board") {
    return render(<Board {...boardProps} projectId={projectId} />);
  }
  return render(<ListView {...listProps} projectId={projectId} />);
}

function expectWorkflowLayout(surface: Surface) {
  if (surface === "Board") {
    expect(document.querySelector(".board-workflow-columns")).not.toBeNull();
    expect(document.querySelector(".board-workflows-skeleton")).toBeNull();
    expect(document.querySelectorAll('.column[data-workflow-mode="true"]').length).toBeGreaterThan(0);
    return;
  }

  expect(screen.getByTestId("workflow-switcher")).toBeInTheDocument();
  expect(screen.queryByTestId("list-workflows-skeleton")).toBeNull();
}

function expectSkeleton(surface: Surface, empty = false) {
  if (surface === "Board") {
    expect(screen.getByTestId(empty ? "board-workflows-empty" : "board-workflows-skeleton")).toBeInTheDocument();
    expect(document.querySelector(".board-workflow-columns")).toBeNull();
    expect(document.querySelectorAll(".column")).toHaveLength(0);
    return;
  }

  expect(screen.getByTestId(empty ? "list-workflows-empty" : "list-workflows-skeleton")).toBeInTheDocument();
  expect(screen.queryByTestId("workflow-switcher")).toBeNull();
}

describe("no legacy-board flash before workflow lanes load (FN-6776)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.fetchWorkflowSteps.mockResolvedValue([]);
    apiMocks.fetchWorkflowOptionalSteps.mockResolvedValue([]);
    apiMocks.fetchNodes.mockResolvedValue([]);
    apiMocks.fetchTaskDetail.mockResolvedValue(null);
    apiMocks.promoteTask.mockResolvedValue({});
    apiMocks.fetchModels.mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] });
    apiMocks.fetchSettings.mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} });
    apiMocks.fetchGlobalSettings.mockResolvedValue({});
    apiMocks.api.mockResolvedValue({ sessions: [] });
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it.each<[Surface, Breakpoint]>([
    ["Board", "desktop"],
    ["Board", "mobile"],
    ["ListView", "desktop"],
    ["ListView", "mobile"],
  ])("%s at %s renders skeleton, not legacy, while uncached workflow payload is pending", async (surface, breakpoint) => {
    mockViewport(breakpoint === "mobile" ? 390 : 1200);
    const deferred = createDeferred<BoardWorkflowsPayload>();
    apiMocks.fetchBoardWorkflows.mockReturnValue(deferred.promise);

    renderSurface(surface);

    expectSkeleton(surface);

    await act(async () => {
      deferred.resolve(workflowPayload);
      await deferred.promise;
    });

    await waitFor(() => expectWorkflowLayout(surface));
  });

  it.each<[Surface, Breakpoint]>([
    ["Board", "desktop"],
    ["Board", "mobile"],
    ["ListView", "desktop"],
    ["ListView", "mobile"],
  ])("%s at %s renders cached workflow lanes on first paint", (surface, breakpoint) => {
    mockViewport(breakpoint === "mobile" ? 390 : 1200);
    writeBoardWorkflowsCache("project-a", workflowPayload);
    apiMocks.fetchBoardWorkflows.mockReturnValue(new Promise(() => {}));

    renderSurface(surface);

    expectWorkflowLayout(surface);
  });

  it.each<Surface>(["Board", "ListView"])("%s keeps legacy hidden when the enabled payload has no workflows", async (surface) => {
    mockViewport(1024);
    apiMocks.fetchBoardWorkflows.mockResolvedValue(emptyWorkflowPayload);

    renderSurface(surface);

    await waitFor(() => expectSkeleton(surface, true));
    expectLegacyLayoutHiddenForEmpty(surface);
  });

  it.each<Surface>(["Board", "ListView"])("%s keeps the skeleton on a failed first fetch instead of flashing legacy (non-authoritative failure)", async (surface) => {
    mockViewport(1024);
    apiMocks.fetchBoardWorkflows.mockRejectedValue(new Error("network"));

    renderSurface(surface);
    expectSkeleton(surface);

    /*
    FNXC:BoardNoLegacyFlash 2026-07-07-09:30:
    FN-7234 (preserve board workflow selections) made fetch failures non-authoritative: useBoardWorkflows keeps the current/cache-hydrated payload on a rejected fetch (empty .catch) rather than falling back to legacy. With no cached payload, boardWorkflows stays null so the skeleton persists — the board never flashes legacy on a failed first fetch. Recovery happens on the next visibility/focus/switcher-open re-fetch, not by dropping to legacy.
    */
    await waitFor(() => expect(apiMocks.fetchBoardWorkflows).toHaveBeenCalled());
    expectSkeleton(surface);
  });

  it.each<Surface>(["Board", "ListView"])("%s does not leak cached workflow layouts across project switches", async (surface) => {
    mockViewport(1024);
    writeBoardWorkflowsCache("project-a", workflowPayload);
    apiMocks.fetchBoardWorkflows.mockReturnValue(new Promise(() => {}));

    const view = renderSurface(surface, "project-a");
    expectWorkflowLayout(surface);

    if (surface === "Board") {
      view.rerender(<Board {...boardProps} projectId="project-b" />);
    } else {
      view.rerender(<ListView {...listProps} projectId="project-b" />);
    }

    expectSkeleton(surface);
  });

  /*
  FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9):
  Was "ignores another project's cache when flag-off payload is cached locally".
  The flag-off payload was only the VEHICLE for making the two projects' cached
  payloads observably different; the invariant under test is per-project cache
  isolation. Rewritten to use an EMPTY-lane payload for project-a instead, so the
  invariant keeps its coverage after the flag is gone: project-b's lanes must not
  be rendered for project-a, and project-a's own cached payload wins.
  */
  it.each<Surface>(["Board", "ListView"])("%s ignores another project's cache when this project has its own cached payload", (surface) => {
    mockViewport(1024);
    writeBoardWorkflowsCache("project-b", workflowPayload);
    writeBoardWorkflowsCache("project-a", emptyWorkflowPayload);
    apiMocks.fetchBoardWorkflows.mockReturnValue(new Promise(() => {}));

    renderSurface(surface, "project-a");

    // project-a cached an empty-lane payload, so it must show the EMPTY state —
    // never project-b's lanes, and never the generic still-loading skeleton.
    expectSkeleton(surface, true);
    expectLegacyLayoutHiddenForEmpty(surface);
  });
});

function expectLegacyLayoutHiddenForEmpty(surface: Surface) {
  if (surface === "Board") {
    expect(document.querySelector(".board-workflow-columns")).toBeNull();
    expect(document.querySelectorAll(".column")).toHaveLength(0);
    return;
  }

  expect(screen.queryByTestId("workflow-switcher")).toBeNull();
}
