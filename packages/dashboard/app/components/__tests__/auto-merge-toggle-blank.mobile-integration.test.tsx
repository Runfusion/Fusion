import React, { useEffect, useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { Settings, Task } from "@fusion/core";
import { Board } from "../Board";
import { PageErrorBoundary } from "../ErrorBoundary";
import { TaskReviewTab } from "../TaskReviewTab";
import { MobileNavBar } from "../MobileNavBar";
import { RetryWarningProvider } from "../../context/RetryWarningContext";
import { useAppSettings } from "../../hooks/useAppSettings";
import { useMobileKeyboard, _resetInitialViewportHeight } from "../../hooks/useMobileKeyboard";
import { MOBILE_MEDIA_QUERY, useViewportMode } from "../../hooks/useViewportMode";
import { fetchConfig, fetchSettings, fetchTaskReview, updateSettings } from "../../api";

const defaultSettings: Settings = {
  maxConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 15000,
  groupOverlappingFiles: false,
  autoMerge: true,
  recycleWorktrees: false,
  worktreeInitCommand: "",
  testCommand: "",
  buildCommand: "",
  capacityRiskBannerEnabled: false,
  capacityRiskTodoThreshold: 20,
  experimentalFeatures: {},
};

let mockSettings: Settings = { ...defaultSettings };

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchConfig: vi.fn(() => Promise.resolve({ maxConcurrent: 2, rootDir: "/workspace/project" })),
    fetchSettings: vi.fn(() => Promise.resolve({ ...mockSettings })),
    updateSettings: vi.fn((updates: Partial<Settings>) => {
      mockSettings = { ...mockSettings, ...updates };
      return Promise.resolve({ ...mockSettings });
    }),
    fetchWorkflowSteps: vi.fn(() => Promise.resolve([])),
    fetchAgents: vi.fn(() => Promise.resolve([])),
    fetchTaskReview: vi.fn(() =>
      Promise.resolve({
        reviewState: { source: "pull-request", items: [], addressing: [] },
        automationStatus: null,
        emptyMessage: null,
      }),
    ),
  });
});

vi.mock("../../hooks/useBlockerFanout", () => ({
  useBlockerFanout: () => new Map(),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: vi.fn() }),
}));

vi.mock("../../hooks/useFlashOnIncrease", () => ({
  useFlashOnIncrease: () => false,
}));

vi.mock("../../hooks/useBadgeWebSocket", () => ({
  useBadgeWebSocket: () => ({
    badgeUpdates: new Map(),
    subscribeToBadge: vi.fn(),
    unsubscribeFromBadge: vi.fn(),
    isConnected: false,
  }),
}));

vi.mock("../../hooks/useTaskDiffStats", () => ({
  useTaskDiffStats: () => ({ stats: null, loading: false }),
}));

vi.mock("../../hooks/useAgentsMapCache", () => ({
  useAgentsMapCache: () => ({ agentsMap: new Map(), agents: [], loading: false, refresh: vi.fn() }),
}));

vi.mock("../PluginSlot", () => ({
  PluginSlot: () => null,
}));

function ensureMatchMedia() {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn(),
    });
  }
}

const MOBILE_WIDTH_MEDIA_QUERY = "(max-width: 768px)";
const MOBILE_HEIGHT_MEDIA_QUERY = "(max-height: 480px)";
const TABLET_MEDIA_QUERY = "(min-width: 769px) and (max-width: 1024px)";
const originalScreen = window.screen;

type ViewportSpy = ReturnType<typeof vi.spyOn> & {
  setViewport: (width: number, height?: number) => void;
  dispatchChange: (query: string) => void;
};

function mockViewport(width: number, height = 812): ViewportSpy {
  ensureMatchMedia();
  let viewportWidth = width;
  let viewportHeight = height;
  const listeners = new Map<string, Set<() => void>>();

  const matchesQuery = (query: string) => {
    if (query === MOBILE_WIDTH_MEDIA_QUERY) return viewportWidth <= 768;
    if (query === MOBILE_HEIGHT_MEDIA_QUERY) return viewportHeight <= 480;
    if (query === MOBILE_MEDIA_QUERY) return viewportWidth <= 768 || viewportHeight <= 480;
    if (query === TABLET_MEDIA_QUERY) return viewportWidth >= 769 && viewportWidth <= 1024;
    return false;
  };

  const setWindowSize = () => {
    Object.defineProperty(window, "innerWidth", { value: viewportWidth, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: viewportHeight, configurable: true });
  };

  const setScreenSize = () => {
    Object.defineProperty(window, "screen", {
      configurable: true,
      value: {
        ...originalScreen,
        width,
        height,
        availWidth: width,
        availHeight: height,
      } as Screen,
    });
  };

  setWindowSize();
  setScreenSize();

  const spy = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    const queryListeners = listeners.get(query) ?? new Set<() => void>();
    listeners.set(query, queryListeners);
    return {
      get matches() {
        return matchesQuery(query);
      },
      media: query,
      onchange: null,
      addListener: vi.fn((listener: () => void) => queryListeners.add(listener)),
      removeListener: vi.fn((listener: () => void) => queryListeners.delete(listener)),
      addEventListener: vi.fn((event: string, listener: () => void) => {
        if (event === "change") queryListeners.add(listener);
      }),
      removeEventListener: vi.fn((event: string, listener: () => void) => {
        if (event === "change") queryListeners.delete(listener);
      }),
      dispatchEvent: vi.fn(() => true),
    };
  }) as ViewportSpy;

  spy.setViewport = (nextWidth: number, nextHeight = viewportHeight) => {
    viewportWidth = nextWidth;
    viewportHeight = nextHeight;
    setWindowSize();
  };
  spy.dispatchChange = (query: string) => {
    for (const listener of [...(listeners.get(query) ?? [])]) listener();
  };

  return spy;
}

function createVisualViewport(scale = 1, width = window.innerWidth, height = window.innerHeight) {
  const resizeListeners = new Set<() => void>();
  return {
    scale,
    offsetTop: 0,
    offsetLeft: 0,
    width,
    height,
    addEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === "resize") {
        resizeListeners.add(listener);
      }
    }),
    removeEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === "resize") {
        resizeListeners.delete(listener);
      }
    }),
    setSize: (nextWidth: number, nextHeight: number) => {
      Object.assign(window.visualViewport ?? {}, { width: nextWidth, height: nextHeight });
    },
    dispatchResize: () => {
      for (const listener of [...resizeListeners]) {
        listener();
      }
    },
  };
}

function installAnimationFrame() {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    setTimeout(() => cb(0), 0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
}

function createTask(id: string, column: Task["column"], overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: `${id} description`,
    column,
    status: column === "in-review" ? "in-review" : overrides.status,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function ThrowOnAutoMergeOff({ autoMerge }: { autoMerge: boolean }) {
  if (autoMerge === false) {
    throw new Error("Auto-merge render failed");
  }

  return null;
}

function SettingsBoardHarness({
  tasks,
  openTaskOnMountId,
  includeThrowProbe = false,
}: {
  tasks: Task[];
  openTaskOnMountId?: string;
  includeThrowProbe?: boolean;
}) {
  const { autoMerge, toggleAutoMerge, maxConcurrent } = useAppSettings("proj_123");
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const handleOpenDetail = (task: Task) => setSelectedTask(task);

  useEffect(() => {
    if (!openTaskOnMountId) {
      return;
    }
    const initialTask = tasks.find((task) => task.id === openTaskOnMountId) ?? null;
    if (initialTask) {
      handleOpenDetail(initialTask);
    }
  }, [openTaskOnMountId, tasks]);

  return (
    <RetryWarningProvider value={undefined}>
      <PageErrorBoundary>
        <Board
          tasks={tasks}
          projectId="proj_123"
          maxConcurrent={maxConcurrent}
          onMoveTask={vi.fn(async () => ({} as Task))}
          onOpenDetail={handleOpenDetail}
          addToast={vi.fn()}
          onQuickCreate={vi.fn(async () => undefined)}
          onNewTask={vi.fn()}
          autoMerge={autoMerge}
          onToggleAutoMerge={toggleAutoMerge}
          globalPaused={false}
          prAuthAvailable={true}
        />
        {selectedTask ? (
          <div data-testid="task-detail-review-surface">
            <TaskReviewTab task={selectedTask} addToast={vi.fn()} autoMergeEnabled={autoMerge} prAuthAvailable />
          </div>
        ) : null}
        {includeThrowProbe ? <ThrowOnAutoMergeOff autoMerge={autoMerge} /> : null}
      </PageErrorBoundary>
    </RetryWarningProvider>
  );
}

function AppShellMobileHarness({ tasks }: { tasks: Task[] }) {
  const viewportMode = useViewportMode();
  const isMobile = viewportMode === "mobile";
  const { keyboardOpen } = useMobileKeyboard({ enabled: isMobile });
  const { autoMerge, toggleAutoMerge, maxConcurrent } = useAppSettings("proj_123");

  return (
    <RetryWarningProvider value={undefined}>
      <div className={`project-content${isMobile && !keyboardOpen ? " project-content--with-mobile-nav" : ""}`}>
        <PageErrorBoundary>
          <Board
            tasks={tasks}
            projectId="proj_123"
            maxConcurrent={maxConcurrent}
            onMoveTask={vi.fn(async () => ({} as Task))}
            onOpenDetail={vi.fn()}
            addToast={vi.fn()}
            onQuickCreate={vi.fn(async () => undefined)}
            onNewTask={vi.fn()}
            autoMerge={autoMerge}
            onToggleAutoMerge={toggleAutoMerge}
            globalPaused={false}
            prAuthAvailable={true}
          />
        </PageErrorBoundary>
      </div>
      {isMobile && !keyboardOpen ? (
        <MobileNavBar
          view="board"
          onChangeView={vi.fn()}
          footerVisible={true}
          modalOpen={false}
          keyboardOpen={keyboardOpen}
          onOpenSettings={vi.fn()}
          onOpenActivityLog={vi.fn()}
          onOpenMailbox={vi.fn()}
          onOpenGitManager={vi.fn()}
          onOpenWorkflowEditor={vi.fn()}
          onOpenSchedules={vi.fn()}
          onOpenScripts={vi.fn()}
          onToggleTerminal={vi.fn()}
          onOpenFiles={vi.fn()}
          onOpenTodos={vi.fn()}
          onOpenGitHubImport={vi.fn()}
          onOpenPlanning={vi.fn()}
          onResumePlanning={vi.fn()}
          onOpenUsage={vi.fn()}
          onRunScript={vi.fn()}
          onViewAllProjects={vi.fn()}
          onOpenNodes={vi.fn()}
          projectId="proj_123"
          activePlanningSessionCount={0}
          experimentalFeatures={{}}
          pluginDashboardViews={[]}
        />
      ) : null}
    </RetryWarningProvider>
  );
}

function expectBoardVisible(taskTitles: string[] = []) {
  expect(document.querySelector("main.board")).not.toBeNull();
  expect(screen.getByText("In Review")).toBeInTheDocument();
  for (const title of taskTitles) {
    expect(screen.getAllByText(title).length).toBeGreaterThan(0);
  }
  expect(screen.queryByText("Something went wrong")).toBeNull();
}

function createInReviewAndWorktreeTasks() {
  return [
    createTask("FN-5972", "in-review"),
    createTask("FN-5972-WT", "in-progress", {
      title: "Worktree child task",
      status: "in-progress",
      worktree: "/workspace/project/.worktrees/FN-5972-WT",
    }),
  ];
}

function installMobileDeviceEnvironment() {
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    configurable: true,
    value: 5,
  });
}

function renderAppShellHarness({
  width,
  height = 812,
  tasks,
  autoMerge = false,
}: {
  width: number;
  height?: number;
  tasks: Task[];
  autoMerge?: Settings["autoMerge"];
}) {
  const viewportSpy = mockViewport(width, height);
  const visualViewport = createVisualViewport();
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: visualViewport,
  });
  installMobileDeviceEnvironment();
  installAnimationFrame();
  mockSettings = { ...defaultSettings, autoMerge };

  render(<AppShellMobileHarness tasks={tasks} />);

  return { viewportSpy, visualViewport };
}

function renderBoardHarness({
  width,
  height = 812,
  tasks,
  autoMerge = false,
  openTaskOnMountId,
  includeThrowProbe = false,
}: {
  width: number;
  height?: number;
  tasks: Task[];
  autoMerge?: Settings["autoMerge"];
  openTaskOnMountId?: string;
  includeThrowProbe?: boolean;
}) {
  const viewportSpy = mockViewport(width, height);
  const visualViewport = createVisualViewport();
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: visualViewport,
  });
  installAnimationFrame();
  mockSettings = { ...defaultSettings, autoMerge };

  render(
    <SettingsBoardHarness
      tasks={tasks}
      openTaskOnMountId={openTaskOnMountId}
      includeThrowProbe={includeThrowProbe}
    />,
  );

  return { viewportSpy, visualViewport };
}

describe("auto-merge toggle mobile integration regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetInitialViewportHeight();
    mockSettings = { ...defaultSettings };
  });

  afterEach(() => {
    _resetInitialViewportHeight();
    Object.defineProperty(window, "screen", {
      configurable: true,
      value: originalScreen,
    });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    { name: "mobile portrait", width: 375, height: 812 },
    { name: "mobile landscape", width: 844, height: 390 },
  ])("realigns mobile document horizontal scroll after toggling an offscreen auto-merge control on $name", async ({ width, height }) => {
    const { viewportSpy, visualViewport } = renderBoardHarness({
      width,
      height,
      tasks: createInReviewAndWorktreeTasks(),
      autoMerge: true,
    });

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(1);
    });

    const scrollToSpy = vi.spyOn(window, "scrollTo").mockImplementation((xOrOptions?: number | ScrollToOptions, y?: number) => {
      const left = typeof xOrOptions === "object" ? (xOrOptions.left ?? window.scrollX) : (xOrOptions ?? window.scrollX);
      const top = typeof xOrOptions === "object" ? (xOrOptions.top ?? window.scrollY) : (y ?? window.scrollY);
      Object.defineProperty(window, "scrollX", { configurable: true, value: left });
      Object.defineProperty(window, "scrollY", { configurable: true, value: top });
    });
    Object.defineProperty(window, "scrollX", { configurable: true, value: 911 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    document.documentElement.scrollLeft = 911;
    document.body.scrollLeft = 911;

    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Auto-merge" }));
      await Promise.resolve();
    });
    act(() => {
      visualViewport.dispatchResize();
      vi.advanceTimersByTime(1);
    });

    expect(updateSettings).toHaveBeenCalledWith({ autoMerge: false }, "proj_123");
    expect(scrollToSpy).toHaveBeenCalledWith(0, 0);
    expect(window.scrollX).toBe(0);
    expect(document.documentElement.scrollLeft).toBe(0);
    expect(document.body.scrollLeft).toBe(0);
    expectBoardVisible(["FN-5972", "Worktree child task"]);

    scrollToSpy.mockRestore();
    viewportSpy.mockRestore();
  });

  it("keeps the real board/task-card and worktree-group composition visible on mobile portrait after toggling auto-merge on and back off", async () => {
    const { viewportSpy, visualViewport } = renderBoardHarness({
      width: 375,
      tasks: createInReviewAndWorktreeTasks(),
      autoMerge: undefined,
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchConfig).toHaveBeenCalledWith("proj_123");
    expect(fetchSettings).toHaveBeenCalledWith("proj_123");

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expectBoardVisible(["FN-5972", "Worktree child task"]);
    expect(screen.getAllByText("FN-5972-WT").length).toBeGreaterThan(0);

    const toggle = screen.getByRole("checkbox", { name: "Auto-merge" });
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole("button", { name: /create pull request/i })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });

    act(() => {
      visualViewport.dispatchResize();
      vi.advanceTimersByTime(1);
    });

    expect(updateSettings).toHaveBeenCalledWith({ autoMerge: true }, "proj_123");
    expect(toggle).toBeChecked();
    expect(screen.queryByRole("button", { name: /create pull request/i })).toBeNull();
    expectBoardVisible(["FN-5972", "Worktree child task"]);

    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });

    act(() => {
      visualViewport.dispatchResize();
      vi.advanceTimersByTime(1);
    });

    expect(updateSettings).toHaveBeenLastCalledWith({ autoMerge: false }, "proj_123");
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole("button", { name: /create pull request/i })).toBeInTheDocument();
    expectBoardVisible(["FN-5972", "Worktree child task"]);

    viewportSpy.mockRestore();
  });

  it("keeps the board visible for an empty in-review column while round-tripping auto-merge on mobile", async () => {
    const { viewportSpy, visualViewport } = renderBoardHarness({
      width: 375,
      tasks: [],
      autoMerge: true,
    });

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(1);
    });

    const toggle = screen.getByRole("checkbox", { name: "Auto-merge" });
    expect(toggle).toBeChecked();
    expectBoardVisible();
    expect(screen.getAllByText("No tasks").length).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });
    act(() => {
      visualViewport.dispatchResize();
      vi.advanceTimersByTime(1);
    });

    expect(toggle).not.toBeChecked();
    expectBoardVisible();

    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });
    act(() => {
      visualViewport.dispatchResize();
      vi.advanceTimersByTime(1);
    });

    expect(toggle).toBeChecked();
    expectBoardVisible();

    viewportSpy.mockRestore();
  });

  it("shows the page error boundary fallback instead of a blank page when a sibling render throws after auto-merge toggles off", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { viewportSpy, visualViewport } = renderBoardHarness({
      width: 375,
      tasks: createInReviewAndWorktreeTasks(),
      autoMerge: true,
      includeThrowProbe: true,
    });

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(1);
    });

    const toggle = screen.getByRole("checkbox", { name: "Auto-merge" });
    expect(toggle).toBeChecked();
    expectBoardVisible(["FN-5972", "Worktree child task"]);

    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });
    act(() => {
      visualViewport.dispatchResize();
      vi.advanceTimersByTime(1);
    });

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(document.querySelector("main.board")).toBeNull();

    consoleErrorSpy.mockRestore();
    viewportSpy.mockRestore();
  });

  it("reflows the App shell from mobile to tablet without leaving mobile chrome or a blank strip", async () => {
    const { viewportSpy, visualViewport } = renderAppShellHarness({
      width: 375,
      height: 812,
      tasks: createInReviewAndWorktreeTasks(),
      autoMerge: false,
    });

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expectBoardVisible(["FN-5972", "Worktree child task"]);
    expect(document.querySelector(".project-content.project-content--with-mobile-nav")).not.toBeNull();
    expect(screen.getByTestId("mobile-nav-tab-tasks")).toBeInTheDocument();

    act(() => {
      viewportSpy.setViewport(834, 1112);
      visualViewport.setSize(834, 1112);
      viewportSpy.dispatchChange(MOBILE_MEDIA_QUERY);
      visualViewport.dispatchResize();
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(1);
    });

    expectBoardVisible(["FN-5972", "Worktree child task"]);
    const projectContent = document.querySelector(".project-content");
    expect(projectContent).not.toBeNull();
    expect(projectContent).not.toHaveClass("project-content--with-mobile-nav");
    expect(projectContent).not.toHaveStyle({ width: "375px" });
    expect(screen.queryByTestId("mobile-nav-tab-tasks")).toBeNull();
    expect(screen.queryByText("Something went wrong")).toBeNull();

    viewportSpy.mockRestore();
  });

  it("keeps short landscape phones in mobile mode with mobile chrome", async () => {
    const { viewportSpy, visualViewport } = renderAppShellHarness({
      width: 844,
      height: 390,
      tasks: [createTask("FN-LANDSCAPE", "in-review")],
      autoMerge: false,
    });

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      visualViewport.dispatchResize();
      vi.advanceTimersByTime(1);
    });

    expectBoardVisible(["FN-LANDSCAPE"]);
    expect(document.querySelector(".project-content.project-content--with-mobile-nav")).not.toBeNull();
    expect(screen.getByTestId("mobile-nav-tab-tasks")).toBeInTheDocument();

    viewportSpy.mockRestore();
  });

  it("keeps the App-level mobile shell visible while round-tripping auto-merge", async () => {
    const { viewportSpy, visualViewport } = renderAppShellHarness({
      width: 375,
      tasks: createInReviewAndWorktreeTasks(),
      autoMerge: false,
    });

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(1);
    });

    const toggle = screen.getByRole("checkbox", { name: "Auto-merge" });
    expect(toggle).not.toBeChecked();
    expectBoardVisible(["FN-5972", "Worktree child task"]);
    expect(document.querySelector(".project-content.project-content--with-mobile-nav")).not.toBeNull();
    expect(screen.getByTestId("mobile-nav-tab-tasks")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).toBeNull();

    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });
    act(() => {
      visualViewport.dispatchResize();
      vi.advanceTimersByTime(1);
    });

    expect(toggle).toBeChecked();
    expectBoardVisible(["FN-5972", "Worktree child task"]);
    expect(document.querySelector(".project-content.project-content--with-mobile-nav")).not.toBeNull();
    expect(screen.getByTestId("mobile-nav-tab-tasks")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).toBeNull();

    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });
    act(() => {
      visualViewport.dispatchResize();
      vi.advanceTimersByTime(1);
    });

    expect(toggle).not.toBeChecked();
    expectBoardVisible(["FN-5972", "Worktree child task"]);
    expect(document.querySelector(".project-content.project-content--with-mobile-nav")).not.toBeNull();
    expect(screen.getByTestId("mobile-nav-tab-tasks")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).toBeNull();

    viewportSpy.mockRestore();
  });

  it.each([
    { name: "mobile landscape", width: 844, height: 390 },
    { name: "tablet", width: 834, height: 1112 },
    { name: "desktop", width: 1280, height: 900 },
  ])("keeps the board visible after toggling auto-merge on $name", async ({ width, height }) => {
    const { viewportSpy, visualViewport } = renderBoardHarness({
      width,
      height,
      tasks: [createTask(`FN-${width}`, "in-review")],
      autoMerge: false,
    });

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(1);
    });

    const toggle = screen.getByRole("checkbox", { name: "Auto-merge" });
    expect(toggle).not.toBeChecked();
    expectBoardVisible([`FN-${width}`]);

    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });
    act(() => {
      visualViewport.dispatchResize();
      vi.advanceTimersByTime(1);
    });

    expect(toggle).toBeChecked();
    expectBoardVisible([`FN-${width}`]);
    viewportSpy.mockRestore();
  });

  it("keeps task review detail visible while toggling auto-merge with a detail panel open", async () => {
    const detailTask = createTask("FN-DETAIL", "in-review", {
      reviewState: { source: "pull-request", items: [], addressing: [] },
    });
    vi.mocked(fetchTaskReview).mockResolvedValue({
      reviewState: detailTask.reviewState ?? { source: "pull-request", items: [], addressing: [] },
      automationStatus: null,
      emptyMessage: null,
    } as never);

    const { viewportSpy, visualViewport } = renderBoardHarness({
      width: 375,
      tasks: [detailTask],
      autoMerge: false,
      openTaskOnMountId: detailTask.id,
    });

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("task-detail-review-surface")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(screen.getByTestId("task-review-auto-merge-effective-hint")).toHaveTextContent(
      "Effective: Auto-merge off",
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Auto-merge" }));
      await Promise.resolve();
    });
    act(() => {
      visualViewport.dispatchResize();
      vi.advanceTimersByTime(1);
    });

    expect(screen.getByTestId("task-detail-review-surface")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(screen.getByTestId("task-review-auto-merge-effective-hint")).toHaveTextContent(
      "Effective: Auto-merge on",
    );
    expectBoardVisible(["FN-DETAIL"]);

    viewportSpy.mockRestore();
  });

  it("rolls back the real useAppSettings toggle on mobile without blanking the board when updateSettings fails", async () => {
    vi.mocked(updateSettings).mockRejectedValueOnce(new Error("network"));

    const { viewportSpy, visualViewport } = renderBoardHarness({
      width: 375,
      tasks: [createTask("FN-ROLLBACK", "in-review")],
      autoMerge: false,
    });

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(1);
    });

    const toggle = screen.getByRole("checkbox", { name: "Auto-merge" });
    expect(toggle).not.toBeChecked();
    expectBoardVisible(["FN-ROLLBACK"]);

    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });
    act(() => {
      visualViewport.dispatchResize();
      vi.advanceTimersByTime(1);
    });

    expect(updateSettings).toHaveBeenCalledWith({ autoMerge: true }, "proj_123");
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole("button", { name: /create pull request/i })).toBeInTheDocument();
    expectBoardVisible(["FN-ROLLBACK"]);

    viewportSpy.mockRestore();
  });
});
