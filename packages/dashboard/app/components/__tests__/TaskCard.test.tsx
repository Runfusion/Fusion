import React from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { TaskCard, formatElapsedDurationDone, __test_areTaskCardPropsEqual } from "../TaskCard";
import { CostBadgeProvider } from "../../context/CostBadgeContext";

// Pre-existing gap (unrelated to FN-7676): TaskCard unconditionally renders
// RuntimeFallbackBadge, which calls the shared useToast() hook directly (not
// via the addToast prop). This file renders <TaskCard> outside a
// ToastProvider, so mock the hook the same way sibling suites
// (PlanningModeModal.*.test.tsx) already do to avoid a widespread
// "useToast must be used within ToastProvider" failure across this file.
vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({
    addToast: vi.fn(),
    removeToast: vi.fn(),
    toasts: [],
  }),
}));
import { NavigationHistoryProvider, useNavigationHistory } from "../../hooks/useNavigationHistory";
import { useOverlayDismiss } from "../../hooks/useOverlayDismiss";
import type { ConfirmOptions } from "../../hooks/useConfirm";
import { TASK_PRIORITIES, type Task, type TaskPriority } from "@fusion/core";
import { getPriorityColorVar, getPriorityLabel } from "../../utils/priorityIndicator";

// Mock lucide-react to avoid SVG rendering issues in test env
vi.mock("lucide-react", () => ({
  Link: () => null,
  GitBranch: () => null,
  Gitlab: () => null,
  Clock: () => null,
  Pencil: () => null,
  Layers: () => null,
  ChevronDown: () => null,
  Folder: () => null,
  GitPullRequest: () => null,
  CircleDot: () => null,
  Target: () => null,
  Bot: () => null,
  Trash2: () => null,
  RotateCw: () => null,
  Zap: () => <svg data-testid="icon-zap" />,
  AlertTriangle: () => null,
  ArrowDown: ({ style, ...props }: React.SVGProps<SVGSVGElement>) => <svg data-testid="priority-icon-low" className="lucide-arrow-down" style={style} {...props} />,
  Flag: ({ style, ...props }: React.SVGProps<SVGSVGElement>) => <svg data-testid="priority-icon-normal" className="lucide-flag" style={style} {...props} />,
  ArrowUp: ({ style, ...props }: React.SVGProps<SVGSVGElement>) => <svg data-testid="priority-icon-high" className="lucide-arrow-up" style={style} {...props} />,
  TriangleAlert: ({ style, ...props }: React.SVGProps<SVGSVGElement>) => <svg data-testid="priority-icon-urgent" className="lucide-triangle-alert" style={style} {...props} />,
  ArrowUpRight: () => null,
  // FN-7592: the overseer badge now renders an icon child instead of a text label,
  // so tests must see a real SVG (like Zap) rather than a no-op render.
  Eye: () => <svg data-testid="icon-eye" />,
  // FNXC:TaskCardMenu 2026-07-10-12:00: visible ⋯ card-actions button icon.
  MoreHorizontal: () => <svg data-testid="icon-more-horizontal" />,
}));

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: ({ provider }: { provider: string }) => <span data-testid={`provider-icon-${provider}`} />,
}));

vi.mock("../PrCreateModal", () => ({
  PrCreateModal: ({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (prInfo: any) => void }) => (
    <div data-testid="pr-create-modal" data-open={open ? "true" : "false"}>
      <button type="button" onClick={() => onClose()}>close-pr-modal</button>
      <button
        type="button"
        onClick={() => onCreated({
          number: 42,
          url: "https://github.com/owner/repo/pull/42",
          status: "open",
          title: "Created PR",
          headBranch: "fusion/fn-001",
          baseBranch: "main",
          commentCount: 0,
        })}
      >
        create-pr-modal
      </button>
    </div>
  ),
}));

const useTaskDiffStatsMock = vi.fn(() => ({ stats: null, loading: false }));
vi.mock("../../hooks/useTaskDiffStats", () => ({
  useTaskDiffStats: (...args: any[]) => useTaskDiffStatsMock(...args),
}));

const badgeUpdatesMock = new Map<string, any>();
const subscribeToBadgeMock = vi.fn();
const unsubscribeFromBadgeMock = vi.fn();
vi.mock("../../hooks/useBadgeWebSocket", () => ({
  useBadgeWebSocket: () => ({
    badgeUpdates: badgeUpdatesMock,
    isConnected: true,
    subscribeToBadge: subscribeToBadgeMock,
    unsubscribeFromBadge: unsubscribeFromBadgeMock,
  }),
}));

vi.mock("../../hooks/useBatchBadgeFetch", () => ({
  getFreshBatchData: vi.fn(() => null),
}));

// Mock the api module
vi.mock("../../api", () => ({
  addressPrFeedback: vi.fn(),
  fetchTaskDetail: vi.fn(),
  uploadAttachment: vi.fn(),
  fetchMission: vi.fn(),
  fetchAgent: vi.fn(),
  fetchAgents: vi.fn(),
  rebuildTaskSpec: vi.fn(),
  refreshPrStatus: vi.fn(),
  // FNXC:PlannerOversight 2026-07-04-13:00: tests that pass a `workflowBadge`
  // prop trigger the FN-7516 workflow-effective-oversight fetch effect; mock
  // it so those tests don't hit an unmocked API export. Resolves an empty
  // effective map (no workflow-level override) by default.
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
}));

const mockConfirm = vi.fn<(options: ConfirmOptions) => Promise<boolean>>();
const mockConfirmWithChoice = vi.fn<(options: ConfirmOptions) => Promise<"primary" | "tertiary" | "cancel">>();
vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm, confirmWithChoice: mockConfirmWithChoice }),
}));

import { addressPrFeedback, uploadAttachment, fetchMission, fetchAgent, fetchAgents, refreshPrStatus } from "../../api";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../../test/cssFixture";
import { writeCache, SWR_CACHE_KEYS } from "../../utils/swrCache";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Test task",
    column: "in-progress",
    status: undefined as any,
    steps: [],
    dependencies: [],
    description: "",
    ...overrides,
  } as Task;
}

const noop = () => {};

function seedAgentsCache(projectId: string, agents: Array<{ id: string; name: string; role?: string; state?: string }>) {
  writeCache(
    `${SWR_CACHE_KEYS.CHAT_AGENTS_MAP_PREFIX}${projectId}`,
    agents.map((agent) => ({
      role: "executor",
      state: "active",
      ...agent,
    })),
    { maxBytes: 500_000 },
  );
}

function mountCssForBadgeTests() {
  const style = document.createElement("style");
  style.textContent = loadAllAppCss();
  document.head.appendChild(style);
  document.documentElement.style.setProperty("--status-error-bg", "rgb(255, 230, 230)");
  document.documentElement.style.setProperty("--color-error-dark", "rgb(200, 0, 0)");
  document.documentElement.style.setProperty("--status-in-review-bg", "rgb(230, 255, 230)");
  document.documentElement.style.setProperty("--in-review", "rgb(0, 160, 0)");
  return () => {
    style.remove();
    document.documentElement.style.removeProperty("--status-error-bg");
    document.documentElement.style.removeProperty("--color-error-dark");
    document.documentElement.style.removeProperty("--status-in-review-bg");
    document.documentElement.style.removeProperty("--in-review");
  };
}

function expectTimerInFooterRight(container: HTMLElement) {
  const timer = container.querySelector(".card-time-indicator");
  const footerRow = container.querySelector(".card-footer-row");
  const rightCluster = container.querySelector(".card-footer-row-right");
  expect(timer).not.toBeNull();
  expect(footerRow?.contains(timer)).toBe(true);
  expect(timer?.closest(".card-footer-row-right")).toBe(rightCluster);
  expect(timer?.closest(".card-meta-badges")).toBeNull();
}

function mockBoardContextMenuGeometry() {
  const originalInnerWidth = window.innerWidth;
  const originalInnerHeight = window.innerHeight;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
  const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getMockRect(this: HTMLElement) {
    if (this.classList.contains("card")) {
      return { x: 520, y: 340, left: 520, top: 340, right: 760, bottom: 520, width: 240, height: 180, toJSON: () => ({}) } as DOMRect;
    }
    if (this.classList.contains("task-card-context-menu-popover")) {
      const left = Number.parseFloat(this.style.left || "0");
      const top = Number.parseFloat(this.style.top || "0");
      return { x: left, y: top, left, top, right: left + 180, bottom: top + 220, width: 180, height: 220, toJSON: () => ({}) } as DOMRect;
    }
    return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
  });
  return () => {
    rectSpy.mockRestore();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
  };
}

function expectBoardContextMenuPortaled() {
  const menu = screen.getByRole("menu");
  const popover = menu.closest(".task-card-context-menu-popover") as HTMLElement | null;
  expect(popover).not.toBeNull();
  expect(popover?.parentElement).toBe(document.body);
  expect(popover?.closest(".card")).toBeNull();
  expect(popover?.closest(".column")).toBeNull();
  expect(popover?.closest(".column-body")).toBeNull();
  expect(popover?.style.left).not.toBe("");
  expect(popover?.style.top).not.toBe("");
  return popover!;
}

const highFanout = {
  totalCount: 7,
  activeTodoCount: 3,
  dependentIds: ["FN-002", "FN-003"],
  dependencyDependentIds: [],
  overlapBlockedDependentIds: ["FN-002", "FN-003"],
  overlapBlockedActiveCount: 3,
  overlapBlockedTodoCount: 3,
  staleBlockedByDependentIds: [],
  isHighFanout: true,
} as const;

afterEach(() => {
  vi.useRealTimers();
  useTaskDiffStatsMock.mockReturnValue({ stats: null, loading: false });
  badgeUpdatesMock.clear();
  subscribeToBadgeMock.mockReset();
  unsubscribeFromBadgeMock.mockReset();
  mockConfirm.mockReset();
  mockConfirmWithChoice.mockReset();
  vi.mocked(addressPrFeedback).mockReset();
  vi.mocked(refreshPrStatus).mockReset();
});

describe("TaskCard", () => {
  it("renders GitLab tracking badges for linked and stale items without dropping GitHub badges", () => {
    const gitlabItem = {
      kind: "merge_request" as const,
      url: "https://gitlab.com/acme/app/-/merge_requests/5",
      instanceUrl: "https://gitlab.com",
      host: "gitlab.com",
      iid: 5,
      projectPath: "acme/app",
      title: "MR title",
      state: "opened",
      createdAt: "2026-07-02T00:00:00.000Z",
    };
    render(
      <TaskCard
        task={makeTask({
          gitlabTracking: { item: gitlabItem },
          issueInfo: { url: "https://github.com/runfusion/fusion/issues/1", number: 1, state: "open", title: "GitHub issue" },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByTestId("card-gitlab-badge")).toHaveAccessibleName("GitLab MR !5: MR title");
    expect(screen.getByRole("link", { name: /GitLab MR !5/ })).toHaveAttribute("href", gitlabItem.url);
    expect(screen.getByRole("link", { name: "#1" })).toHaveAttribute("href", "https://github.com/runfusion/fusion/issues/1");
  });

  it("updates memoized card equality when GitLab tracking changes", () => {
    const base = { task: makeTask({ gitlabTracking: undefined }) };
    const withGitLab = {
      task: makeTask({
        gitlabTracking: {
          item: {
            kind: "project_issue",
            url: "https://gitlab.com/acme/app/-/issues/42",
            instanceUrl: "https://gitlab.com",
            host: "gitlab.com",
            iid: 42,
            createdAt: "2026-07-02T00:00:00.000Z",
          },
        },
      }),
    };

    expect(__test_areTaskCardPropsEqual(base as any, withGitLab as any)).toBe(false);
  });

  it("repaints the memoized card when plannerOverseerState changes, and renders nothing when absent", () => {
    const idleTask = makeTask({ plannerOversightLevel: "autonomous", plannerOverseerState: undefined });
    const watchingTask = makeTask({
      plannerOversightLevel: "autonomous",
      plannerOverseerState: {
        state: "watching",
        oversightLevel: "autonomous",
        watchedStage: "executor",
        signal: "progressing",
        attemptCount: 0,
        attemptLimit: 3,
        pendingConfirmation: false,
        observedAt: 1700000000000,
      },
    });

    expect(
      __test_areTaskCardPropsEqual({ task: idleTask } as any, { task: watchingTask } as any),
    ).toBe(false);
    expect(
      __test_areTaskCardPropsEqual({ task: watchingTask } as any, { task: watchingTask } as any),
    ).toBe(true);

    const { rerender } = render(<TaskCard task={idleTask} onOpenDetail={noop} addToast={noop} />);
    expect(screen.queryByTestId("planner-overseer-state-badge")).not.toBeInTheDocument();

    rerender(<TaskCard task={watchingTask} onOpenDetail={noop} addToast={noop} />);
    expect(screen.getByTestId("planner-overseer-state-badge")).toBeInTheDocument();
  });

  it.each(["in-progress", "in-review"] as const)("hides the stale non-off overseer snapshot and header wrapper when a task override resolves oversight off in %s", (column) => {
    const staleSnapshotTask = makeTask({
      column,
      plannerOversightLevel: "off",
      plannerOverseerState: {
        state: "watching",
        oversightLevel: "autonomous",
        watchedStage: column === "in-review" ? "reviewer" : "executor",
        signal: "progressing",
        attemptCount: 0,
        attemptLimit: 3,
        pendingConfirmation: false,
        observedAt: 1700000000000,
      },
    });

    render(<TaskCard task={staleSnapshotTask} onOpenDetail={noop} addToast={noop} />);

    expect(screen.queryByTestId("planner-overseer-state-badge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("card-header-badges")).not.toBeInTheDocument();
  });

  it("does not render an overseer badge for a stale non-idle oversight-off snapshot", () => {
    const staleOffTask = makeTask({
      column: "in-review",
      plannerOverseerState: {
        state: "watching",
        oversightLevel: "off",
        watchedStage: "reviewer",
        signal: "progressing",
        attemptCount: 0,
        attemptLimit: 3,
        pendingConfirmation: false,
        observedAt: 1700000000000,
      },
    });

    render(<TaskCard task={staleOffTask} onOpenDetail={noop} addToast={noop} />);

    expect(screen.queryByTestId("planner-overseer-state-badge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("card-header-badges")).not.toBeInTheDocument();
  });

  // FN-7563: the badge used to print the raw kebab-case state (e.g.
  // "awaiting-confirmation") with a bare "Planner overseer: awaiting-confirmation"
  // tooltip. This reproduces the reported in-review symptom and asserts the badge
  // is now human-readable and self-explanatory.
  it("explains an in-review awaiting-confirmation badge with a readable label and a reason-bearing tooltip", () => {
    const task = makeTask({
      column: "in-review",
      plannerOversightLevel: "autonomous",
      plannerOverseerState: {
        state: "awaiting-confirmation",
        oversightLevel: "autonomous",
        watchedStage: "executor",
        signal: "stalled",
        attemptCount: 2,
        attemptLimit: 3,
        pendingConfirmation: true,
        observedAt: 1700000000000,
        reason: "Retry limit reached; waiting for an operator decision",
      },
    });

    render(<TaskCard task={task} onOpenDetail={noop} addToast={noop} />);

    // FN-7592: the badge is now an icon-only glyph. The readable label moved from
    // textContent to aria-label; the composed tooltip is unchanged on title.
    const badge = screen.getByTestId("planner-overseer-state-badge");
    expect(badge.querySelector("svg")).toBeInTheDocument();
    expect(badge.getAttribute("aria-label")).not.toBe("awaiting-confirmation");
    expect(badge.getAttribute("aria-label")).toBe("Awaiting confirmation");
    expect(badge.getAttribute("data-planner-overseer-state")).toBe("awaiting-confirmation");

    const title = badge.getAttribute("title") ?? "";
    expect(title).not.toBe("Planner overseer: awaiting-confirmation");
    expect(title).toContain("Retry limit reached; waiting for an operator decision");
    expect(title).toMatch(/human decision/i);
    expect(title).not.toMatch(/undefined/);
  });

  it("renders readable labels for in-progress watching and recovering overseer states", () => {
    const watchingTask = makeTask({
      column: "in-progress",
      plannerOversightLevel: "autonomous",
      plannerOverseerState: {
        state: "watching",
        oversightLevel: "autonomous",
        watchedStage: "executor",
        signal: "progressing",
        attemptCount: 0,
        attemptLimit: 3,
        pendingConfirmation: false,
        observedAt: 1700000000000,
      },
    });
    const { unmount } = render(<TaskCard task={watchingTask} onOpenDetail={noop} addToast={noop} />);
    // FN-7592: icon-only badge — assert the accessible name via aria-label and the
    // per-state color hook via data-planner-overseer-state, not raw text content.
    let badge = screen.getByTestId("planner-overseer-state-badge");
    expect(badge.querySelector("svg")).toBeInTheDocument();
    expect(badge.getAttribute("aria-label")).toBe("Overseer watching");
    expect(badge.getAttribute("data-planner-overseer-state")).toBe("watching");
    expect(badge.getAttribute("title")).not.toMatch(/undefined/);
    unmount();

    const recoveringTask = makeTask({
      column: "in-progress",
      plannerOversightLevel: "autonomous",
      plannerOverseerState: {
        state: "recovering",
        oversightLevel: "autonomous",
        attemptCount: 1,
        attemptLimit: 3,
        pendingConfirmation: false,
        observedAt: 1700000000000,
      },
    });
    render(<TaskCard task={recoveringTask} onOpenDetail={noop} addToast={noop} />);
    badge = screen.getByTestId("planner-overseer-state-badge");
    expect(badge.querySelector("svg")).toBeInTheDocument();
    expect(badge.getAttribute("aria-label")).toBe("Overseer recovering");
    // Distinct states expose distinct data-planner-overseer-state values, which is the
    // hook TaskCard.css keys per-state color off of (jsdom cannot compute color-mix()).
    expect(badge.getAttribute("data-planner-overseer-state")).toBe("recovering");
    expect(badge.getAttribute("data-planner-overseer-state")).not.toBe("watching");
    const title = badge.getAttribute("title") ?? "";
    expect(title).not.toMatch(/undefined/);
    expect(title.length).toBeGreaterThan(0);
  });

  it("shows an Answer-questions button when awaiting user input and opens the workflow tab", async () => {
    const onOpenDetailWithTab = vi.fn();
    render(
      <TaskCard
        task={makeTask({ status: "awaiting-user-input" as any })}
        onOpenDetail={noop}
        addToast={noop}
        onOpenDetailWithTab={onOpenDetailWithTab}
      />,
    );

    const btn = screen.getByLabelText("Answer questions");
    fireEvent.click(btn);
    expect(onOpenDetailWithTab).toHaveBeenCalledTimes(1);
    expect(onOpenDetailWithTab.mock.calls[0][1]).toBe("workflow");
  });

  it("opens the board card context menu as a viewport portal on right-click without opening detail", async () => {
    const cleanupGeometry = mockBoardContextMenuGeometry();
    const onOpenDetail = vi.fn();
    const onPauseTask = vi.fn(async () => makeTask({ paused: true }));
    try {
      render(
        <div className="column" style={{ overflow: "hidden" }}>
          <div className="column-body" style={{ overflowX: "hidden", overflowY: "auto" }}>
            <TaskCard
              task={makeTask({ column: "in-progress", status: "executing" as any })}
              onOpenDetail={onOpenDetail}
              addToast={noop}
              onPauseTask={onPauseTask}
            />
          </div>
        </div>,
      );

      fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 790, clientY: 590 });
      const popover = await waitFor(() => expectBoardContextMenuPortaled());
      expect(popover.style.left).toBe("612px");
      expect(popover.style.top).toBe("372px");
      expect(onOpenDetail).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("menuitem", { name: "Pause" }));
      await waitFor(() => expect(onPauseTask).toHaveBeenCalledWith("FN-001"));
      expect(onPauseTask).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(document.querySelector(".task-card-context-menu-popover")).toBeNull();
      expect(onOpenDetail).not.toHaveBeenCalled();
    } finally {
      cleanupGeometry();
    }
  });

  it("routes reset through the centralized confirm seam and proceeds in skip mode", async () => {
    const cleanupGeometry = mockBoardContextMenuGeometry();
    const onResetTask = vi.fn(async () => makeTask());
    mockConfirm.mockResolvedValueOnce(true);
    try {
      render(<TaskCard task={makeTask({ column: "in-progress" })} onOpenDetail={noop} onResetTask={onResetTask} addToast={noop} />);
      fireEvent.click(screen.getByTestId("card-menu-btn-FN-001"));
      await waitFor(() => expectBoardContextMenuPortaled());
      fireEvent.click(screen.getByRole("menuitem", { name: "Reset" }));
      await waitFor(() => expect(onResetTask).toHaveBeenCalledWith("FN-001"));
      expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true, title: "Reset" }));
      expect(document.querySelector(".confirm-dialog-overlay")).toBeNull();
    } finally {
      cleanupGeometry();
    }
  });

  /*
  FNXC:TaskCardMenu 2026-07-10-12:00:
  The card actions menu must ALSO be reachable from the visible ⋯ button (first-run users never
  discovered right-click). The button must open the exact same TaskContextMenu (same items — no
  duplicated menu logic), anchored as a viewport portal, and toggle closed on a second press.
  */
  it("opens the same card context menu from the visible ⋯ button and toggles it closed", async () => {
    const cleanupGeometry = mockBoardContextMenuGeometry();
    const onOpenDetail = vi.fn();
    const onPauseTask = vi.fn(async () => makeTask({ paused: true }));
    try {
      render(
        <TaskCard
          task={makeTask({ column: "in-progress", status: "executing" as any })}
          onOpenDetail={onOpenDetail}
          addToast={noop}
          onPauseTask={onPauseTask}
        />,
      );

      // Capture the canonical right-click menu item set first.
      fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
      await waitFor(() => expectBoardContextMenuPortaled());
      const rightClickItems = screen.getAllByRole("menuitem").map((item) => item.textContent);
      expect(rightClickItems.length).toBeGreaterThan(0);
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

      // The ⋯ button opens the SAME menu (identical items) as right-click, portaled to the viewport.
      const menuButton = screen.getByTestId("card-menu-btn-FN-001");
      expect(menuButton).toHaveAttribute("aria-haspopup", "menu");
      expect(menuButton).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(menuButton);
      await waitFor(() => expectBoardContextMenuPortaled());
      expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(rightClickItems);
      expect(menuButton).toHaveAttribute("aria-expanded", "true");
      expect(onOpenDetail).not.toHaveBeenCalled();

      // A second press toggles the menu closed — the document pointerdown closer must not race it
      // shut and immediately reopen it.
      fireEvent.pointerDown(menuButton);
      fireEvent.click(menuButton);
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
      expect(document.querySelector(".task-card-context-menu-popover")).toBeNull();
      expect(menuButton).toHaveAttribute("aria-expanded", "false");

      // Selecting an action from the button-opened menu invokes the shared handler and closes.
      fireEvent.click(menuButton);
      await waitFor(() => expectBoardContextMenuPortaled());
      fireEvent.click(screen.getByRole("menuitem", { name: "Pause" }));
      await waitFor(() => expect(onPauseTask).toHaveBeenCalledWith("FN-001"));
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(onOpenDetail).not.toHaveBeenCalled();
    } finally {
      cleanupGeometry();
    }
  });

  /*
  FNXC:TaskContextMenu 2026-07-16-20:50 (FN-8178):
  All card entry points converge on the same portaled auto-focus lifecycle. Simulate a browser that
  scrolls a focused portal unless `preventScroll` is requested; that scroll previously reached the
  capture-phase closer and made every card action unusable.
  */
  it("keeps every card menu entry point open when autofocus would otherwise scroll", async () => {
    vi.useFakeTimers();
    const cleanupGeometry = mockBoardContextMenuGeometry();
    const onPauseTask = vi.fn(async () => makeTask({ paused: true }));
    const nativeFocus = HTMLElement.prototype.focus;
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function focusWithBrowserScroll(options?: FocusOptions) {
      nativeFocus.call(this);
      if (!options?.preventScroll) {
        window.setTimeout(() => window.dispatchEvent(new Event("scroll")), 0);
      }
    });
    const openMethods = [
      () => fireEvent.click(screen.getByTestId("card-menu-btn-FN-001")),
      () => fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 }),
      () => {
        fireEvent.pointerDown(document.querySelector(".card")!, { pointerType: "touch", pointerId: 7, clientX: 24, clientY: 28 });
        act(() => vi.advanceTimersByTime(550));
      },
      () => fireEvent.keyDown(document.querySelector(".card")!, { key: "ContextMenu" }),
    ];

    try {
      render(
        <TaskCard
          task={makeTask({ column: "in-progress", status: "executing" as any })}
          onOpenDetail={noop}
          addToast={noop}
          onPauseTask={onPauseTask}
        />,
      );

      for (const openMenu of openMethods) {
        openMenu();
        act(() => vi.runOnlyPendingTimers());
        expectBoardContextMenuPortaled();
        expect(focusSpy).toHaveBeenLastCalledWith({ preventScroll: true });

        const pauseItem = screen.getByRole("menuitem", { name: "Pause" });
        fireEvent.pointerUp(pauseItem, { pointerType: "touch", pointerId: 8 });
        await act(async () => {
          await Promise.resolve();
        });
        expect(onPauseTask).toHaveBeenLastCalledWith("FN-001");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      }

      // Explicit dismissals remain intentional after focus no longer creates a scroll dismissal.
      fireEvent.click(screen.getByTestId("card-menu-btn-FN-001"));
      expectBoardContextMenuPortaled();
      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("card-menu-btn-FN-001"));
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("card-menu-btn-FN-001"));
      act(() => window.dispatchEvent(new Event("scroll")));
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    } finally {
      focusSpy.mockRestore();
      cleanupGeometry();
    }
  });

  it("opens Planning Mode from eligible pre-execution card menus only when wired", async () => {
    const cleanupGeometry = mockBoardContextMenuGeometry();
    const onPlanningMode = vi.fn();
    try {
      const { rerender } = render(
        <TaskCard
          task={makeTask({ column: "triage", description: "Plan from description", title: "Fallback title" })}
          onOpenDetail={noop}
          onPlanningMode={onPlanningMode}
          planningWorkflowId="WF-intake"
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByTestId("card-menu-btn-FN-001"));
      await waitFor(() => expectBoardContextMenuPortaled());
      fireEvent.click(screen.getByRole("menuitem", { name: "Plan" }));
      expect(onPlanningMode).toHaveBeenCalledWith("Plan from description", "WF-intake");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();

      rerender(
        <TaskCard
          task={makeTask({ column: "ideas" as any, description: "", title: "Custom intake title" })}
          taskColumnFlags={{ intake: true }}
          onOpenDetail={noop}
          onPlanningMode={onPlanningMode}
          planningWorkflowId="WF-custom"
          addToast={noop}
        />,
      );
      fireEvent.click(screen.getByTestId("card-menu-btn-FN-001"));
      await waitFor(() => expectBoardContextMenuPortaled());
      fireEvent.click(screen.getByRole("menuitem", { name: "Plan" }));
      expect(onPlanningMode).toHaveBeenLastCalledWith("Custom intake title", "WF-custom");

      rerender(
        <TaskCard
          task={makeTask({ column: "todo" })}
          onOpenDetail={noop}
          onPlanningMode={onPlanningMode}
          addToast={noop}
        />,
      );
      fireEvent.click(screen.getByTestId("card-menu-btn-FN-001"));
      await waitFor(() => expectBoardContextMenuPortaled());
      expect(screen.queryByRole("menuitem", { name: "Plan" })).not.toBeInTheDocument();
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

      rerender(
        <TaskCard
          task={makeTask({ column: "triage" })}
          onOpenDetail={noop}
          addToast={noop}
          onDeleteTask={vi.fn()}
        />,
      );
      fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
      expect(screen.queryByRole("menuitem", { name: "Plan" })).not.toBeInTheDocument();
    } finally {
      cleanupGeometry();
    }
  });

  it("opens Planning Mode from the mobile/touch long-press menu for custom hold cards", async () => {
    vi.useFakeTimers();
    const cleanupGeometry = mockBoardContextMenuGeometry();
    const onPlanningMode = vi.fn();
    try {
      render(
        <TaskCard
          task={makeTask({ column: "waiting" as any, description: "Touch plan seed" })}
          taskColumnFlags={{ hold: true }}
          onOpenDetail={noop}
          onPlanningMode={onPlanningMode}
          planningWorkflowId="WF-hold"
          addToast={noop}
        />,
      );

      const card = document.querySelector(".card") as HTMLElement;
      fireEvent.pointerDown(card, { pointerType: "touch", pointerId: 1, clientX: 32, clientY: 36 });
      act(() => vi.advanceTimersByTime(550));

      expectBoardContextMenuPortaled();
      fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Plan" }), { pointerType: "touch", pointerId: 2 });
      await act(async () => {
        await Promise.resolve();
      });
      expect(onPlanningMode).toHaveBeenCalledWith("Touch plan seed", "WF-hold");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    } finally {
      cleanupGeometry();
    }
  });

  it("enables GitHub tracking from the board card context menu and hides the action after refresh", async () => {
    const cleanupGeometry = mockBoardContextMenuGeometry();
    const onOpenDetail = vi.fn();
    const addToast = vi.fn();
    const onUpdateTask = vi.fn(async () => makeTask({ githubTracking: { enabled: true } as any }));
    const { rerender } = render(
      <TaskCard
        task={makeTask({ githubTracking: undefined })}
        projectId="project-1"
        onOpenDetail={onOpenDetail}
        addToast={addToast}
        onUpdateTask={onUpdateTask}
      />,
    );

    try {
      fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
      fireEvent.click(screen.getByRole("menuitem", { name: "Enable GitHub tracking" }));

      await waitFor(() => expect(onUpdateTask).toHaveBeenCalledWith("FN-001", { githubTracking: { enabled: true } }));
      expect(addToast).toHaveBeenCalledWith("Requested GitHub tracking issue creation", "info");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(onOpenDetail).not.toHaveBeenCalled();

      rerender(
        <TaskCard
          task={makeTask({ githubTracking: { enabled: true } as any })}
          projectId="project-1"
          onOpenDetail={onOpenDetail}
          addToast={addToast}
          onUpdateTask={onUpdateTask}
        />,
      );
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
      fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
      expect(screen.queryByRole("menuitem", { name: "Enable GitHub tracking" })).not.toBeInTheDocument();
    } finally {
      cleanupGeometry();
    }
  });

  it("opens the board card context menu from keyboard as a viewport portal, selects an action, and closes", async () => {
    const cleanupGeometry = mockBoardContextMenuGeometry();
    const onOpenDetail = vi.fn();
    const onArchiveTask = vi.fn(async () => makeTask({ column: "archived" }));
    try {
      render(
        <div className="column" style={{ overflow: "hidden" }}>
          <div className="column-body" style={{ overflowX: "hidden", overflowY: "auto" }}>
            <TaskCard
              task={makeTask({ column: "done", status: "done" as any })}
              onOpenDetail={onOpenDetail}
              addToast={noop}
              onArchiveTask={onArchiveTask}
            />
          </div>
        </div>,
      );

      const card = document.querySelector(".card") as HTMLElement;
      card.focus();
      fireEvent.keyDown(card, { key: "F10", shiftKey: true });

      expectBoardContextMenuPortaled();
      fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));

      await waitFor(() => expect(onArchiveTask).toHaveBeenCalledWith("FN-001"));
      expect(onArchiveTask).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(onOpenDetail).not.toHaveBeenCalled();
    } finally {
      cleanupGeometry();
    }
  });

  it("shows refine for a done card context menu and routes to the refinement opener", () => {
    const onOpenDetail = vi.fn();
    const onOpenRefine = vi.fn();
    render(
      <TaskCard
        task={makeTask({ column: "done", status: "done" as any })}
        onOpenDetail={onOpenDetail}
        onOpenRefine={onOpenRefine}
        addToast={noop}
        onDeleteTask={vi.fn()}
      />,
    );

    fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

    expect(onOpenRefine).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-001" }));
    expect(onOpenDetail).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shows refine for custom complete cards on touch long-press", () => {
    vi.useFakeTimers();
    const onOpenRefine = vi.fn();
    render(
      <TaskCard
        task={makeTask({ column: "complete" as any, status: "done" as any })}
        taskColumnFlags={{ complete: true }}
        onOpenDetail={noop}
        onOpenRefine={onOpenRefine}
        addToast={noop}
        onDeleteTask={vi.fn()}
      />,
    );

    const card = document.querySelector(".card") as HTMLElement;
    fireEvent.pointerDown(card, { pointerType: "touch", pointerId: 1, clientX: 16, clientY: 16 });
    act(() => vi.advanceTimersByTime(550));

    fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));
    expect(onOpenRefine).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-001" }));
  });

  it("confirms preserving progress before moving from the board context menu", async () => {
    const onMoveTask = vi.fn(async () => makeTask({ column: "todo" }));
    mockConfirm.mockResolvedValueOnce(true);
    render(
      <TaskCard
        task={makeTask({
          column: "in-progress",
          steps: [{ id: "s1", title: "done", status: "done" } as any],
        })}
        onOpenDetail={noop}
        addToast={noop}
        onMoveTask={onMoveTask}
      />,
    );

    fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to Todo" }));

    await waitFor(() => expect(onMoveTask).toHaveBeenCalledWith("FN-001", "todo", { preserveProgress: true }));
    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Preserve Progress?" }));
  });

  it("omits refine without a real modal callback and offers PR status actions from the board context menu", async () => {
    const onOpenDetail = vi.fn();
    vi.mocked(refreshPrStatus).mockResolvedValueOnce({} as any);
    render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          prInfo: { number: 12, url: "https://example.test/pr/12", status: "open" } as any,
        })}
        projectId="project-1"
        onOpenDetail={onOpenDetail}
        addToast={noop}
        onMergeTask={vi.fn()}
        mergeStrategy="pull-request"
      />,
    );

    fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
    expect(screen.queryByRole("menuitem", { name: "Refine" })).not.toBeInTheDocument();
    expect(onOpenDetail).not.toHaveBeenCalled();

    fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Check PR Status" }));
    await waitFor(() => expect(refreshPrStatus).toHaveBeenCalledWith("FN-001", "project-1"));
  });

  it("matches detail PR review labels before and during PR automation", () => {
    const onMergeTask = vi.fn(async () => ({ merged: false }));
    const { rerender } = render(
      <TaskCard
        task={makeTask({ column: "in-review" })}
        onOpenDetail={noop}
        addToast={noop}
        onMergeTask={onMergeTask}
        mergeStrategy="pull-request"
        autoMergeEnabled={false}
      />,
    );

    fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
    expect(screen.getByRole("menuitem", { name: "Start PR Review" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Merge & Close" })).not.toBeInTheDocument();

    rerender(
      <TaskCard
        task={makeTask({ column: "in-review", status: "creating-pr" as any })}
        onOpenDetail={noop}
        addToast={noop}
        onMergeTask={onMergeTask}
        mergeStrategy="pull-request"
        autoMergeEnabled={false}
      />,
    );

    fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
    expect(screen.getByRole("menuitem", { name: "Creating PR…" })).toBeDisabled();
    expect(screen.queryByRole("menuitem", { name: "Merge & Close" })).not.toBeInTheDocument();
  });

  it("opens the board card context menu on touch long-press as a viewport portal, selects the tapped action, and suppresses detail click", async () => {
    vi.useFakeTimers();
    const cleanupGeometry = mockBoardContextMenuGeometry();
    const onOpenDetail = vi.fn();
    const onUnpauseTask = vi.fn(async () => makeTask());
    try {
      render(
        <div className="column" style={{ overflow: "hidden" }}>
          <div className="column-body" style={{ overflowX: "hidden", overflowY: "auto" }}>
            <TaskCard
              task={makeTask({ paused: true, userPaused: true })}
              onOpenDetail={onOpenDetail}
              addToast={noop}
              onUnpauseTask={onUnpauseTask}
            />
          </div>
        </div>,
      );

      const card = document.querySelector(".card") as HTMLElement;
      fireEvent.pointerDown(card, { pointerType: "touch", pointerId: 1, clientX: 790, clientY: 590 });
      act(() => vi.advanceTimersByTime(550));

      expectBoardContextMenuPortaled();
      fireEvent.pointerUp(card, { pointerType: "touch", pointerId: 1, clientX: 790, clientY: 590 });
      fireEvent.click(card);
      expect(onOpenDetail).not.toHaveBeenCalled();

      fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Unpause" }), { pointerType: "touch", pointerId: 2 });
      await act(async () => {
        await Promise.resolve();
      });
      expect(onUnpauseTask).toHaveBeenCalledWith("FN-001");
      expect(onUnpauseTask).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    } finally {
      cleanupGeometry();
    }
  });

  it("suppresses native text selection when touch long-press opens the board card context menu", async () => {
    vi.useFakeTimers();
    const cleanupGeometry = mockBoardContextMenuGeometry();
    const onOpenDetail = vi.fn();
    const onPauseTask = vi.fn(async () => makeTask({ paused: true }));
    try {
      render(
        <div className="column" style={{ overflow: "hidden" }}>
          <div className="column-body" style={{ overflowX: "hidden", overflowY: "auto" }}>
            <TaskCard
              task={makeTask({ title: "Long selectable title", column: "in-progress", status: "executing" as any })}
              onOpenDetail={onOpenDetail}
              addToast={noop}
              onPauseTask={onPauseTask}
            />
          </div>
        </div>,
      );

      const title = screen.getByText("Long selectable title");
      const pointerDownWasNotCanceled = fireEvent.pointerDown(title, {
        pointerType: "touch",
        pointerId: 9,
        clientX: 180,
        clientY: 160,
        cancelable: true,
      });
      expect(pointerDownWasNotCanceled).toBe(false);

      act(() => vi.advanceTimersByTime(550));

      expectBoardContextMenuPortaled();
      expect(onOpenDetail).not.toHaveBeenCalled();
      fireEvent.pointerUp(title, { pointerType: "touch", pointerId: 9, clientX: 180, clientY: 160 });
    } finally {
      cleanupGeometry();
    }
  });

  it("cancels board card long-press when touch moves before the delay", () => {
    vi.useFakeTimers();
    render(
      <TaskCard
        task={makeTask()}
        onOpenDetail={vi.fn()}
        addToast={noop}
        onPauseTask={vi.fn()}
      />,
    );

    const card = document.querySelector(".card") as HTMLElement;
    fireEvent.pointerDown(card, { pointerType: "touch", pointerId: 1, clientX: 16, clientY: 16 });
    fireEvent.pointerMove(card, { pointerType: "touch", pointerId: 1, clientX: 40, clientY: 16 });
    act(() => vi.advanceTimersByTime(550));

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("dispatches portaled board menu actions for the interacted duplicate card", async () => {
    mockConfirm.mockResolvedValueOnce(true);
    const onDuplicateTask = vi.fn(async () => makeTask({ id: "FN-002-copy" }));
    render(
      <div className="column" style={{ overflow: "hidden" }}>
        <div className="column-body" style={{ overflowX: "hidden", overflowY: "auto" }}>
          <TaskCard
            task={makeTask({ id: "FN-001", title: "Duplicate title", column: "todo" })}
            onOpenDetail={noop}
            addToast={noop}
            onDuplicateTask={onDuplicateTask}
          />
          <TaskCard
            task={makeTask({ id: "FN-002", title: "Duplicate title", column: "todo" })}
            onOpenDetail={noop}
            addToast={noop}
            onDuplicateTask={onDuplicateTask}
          />
        </div>
      </div>,
    );

    const secondCard = document.querySelectorAll(".card")[1] as HTMLElement;
    fireEvent.contextMenu(secondCard, { clientX: 64, clientY: 72 });
    expectBoardContextMenuPortaled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));

    await waitFor(() => expect(onDuplicateTask).toHaveBeenCalledWith("FN-002"));
    expect(onDuplicateTask).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("cleans up the portaled board menu when the task column changes", () => {
    const { rerender } = render(
      <TaskCard
        task={makeTask({ id: "FN-001", column: "in-progress", status: "executing" as any })}
        onOpenDetail={noop}
        addToast={noop}
        onPauseTask={vi.fn()}
      />,
    );

    fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
    expectBoardContextMenuPortaled();

    rerender(
      <TaskCard
        task={makeTask({ id: "FN-001", column: "todo", status: "pending" as any })}
        onOpenDetail={noop}
        addToast={noop}
        onPauseTask={vi.fn()}
      />,
    );

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(document.querySelector(".task-card-context-menu-popover")).toBeNull();
  });

  it("does not show the Answer-questions button when not awaiting input", () => {
    render(
      <TaskCard
        task={makeTask({ status: "executing" as any })}
        onOpenDetail={noop}
        addToast={noop}
        onOpenDetailWithTab={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("Answer questions")).toBeNull();
  });

  it("uses githubIssueAction for tracked task delete", async () => {
    const onDeleteTask = vi.fn(async () => makeTask());
    mockConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    render(
      <TaskCard
        task={makeTask({
          column: "triage",
          githubTracking: {
            enabled: true,
            issue: { owner: "owner", repo: "repo", number: 42, url: "https://github.com/owner/repo/issues/42", createdAt: "2026-01-01T00:00:00Z" },
          },
        } as any)}
        onOpenDetail={noop}
        addToast={noop}
        onDeleteTask={onDeleteTask}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Delete task"));
    });

    await waitFor(() => {
      expect(onDeleteTask).toHaveBeenCalledWith("FN-001", { githubIssueAction: "close" });
    });
  });

  it("uses githubIssueAction=delete for tracked task delete", async () => {
    const onDeleteTask = vi.fn(async () => makeTask());
    mockConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    render(
      <TaskCard
        task={makeTask({
          column: "triage",
          githubTracking: {
            enabled: true,
            issue: { owner: "owner", repo: "repo", number: 42, url: "https://github.com/owner/repo/issues/42", createdAt: "2026-01-01T00:00:00Z" },
          },
        } as any)}
        onOpenDetail={noop}
        addToast={noop}
        onDeleteTask={onDeleteTask}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Delete task"));
    });

    await waitFor(() => {
      expect(onDeleteTask).toHaveBeenCalledWith("FN-001", { githubIssueAction: "delete" });
    });
  });

  it("uses githubIssueAction=leave for tracked task delete", async () => {
    const onDeleteTask = vi.fn(async () => makeTask());
    mockConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);

    render(
      <TaskCard
        task={makeTask({
          column: "triage",
          githubTracking: {
            enabled: true,
            issue: { owner: "owner", repo: "repo", number: 42, url: "https://github.com/owner/repo/issues/42", createdAt: "2026-01-01T00:00:00Z" },
          },
        } as any)}
        onOpenDetail={noop}
        addToast={noop}
        onDeleteTask={onDeleteTask}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Delete task"));
    });

    await waitFor(() => {
      expect(onDeleteTask).toHaveBeenCalledWith("FN-001", { githubIssueAction: "leave" });
    });
  });

  it("uses githubIssueAction for source-imported task delete close", async () => {
    const onDeleteTask = vi.fn(async () => makeTask());
    mockConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    render(
      <TaskCard
        task={makeTask({
          column: "triage",
          sourceIssue: { provider: "github", repository: "acme/widgets", issueNumber: 42, externalIssueId: "42" },
        } as any)}
        onOpenDetail={noop}
        addToast={noop}
        onDeleteTask={onDeleteTask}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Delete task"));
    });

    await waitFor(() => {
      expect(onDeleteTask).toHaveBeenCalledWith("FN-001", { githubIssueAction: "close" });
    });
  });

  it("uses githubIssueAction=delete for source-imported task delete", async () => {
    const onDeleteTask = vi.fn(async () => makeTask());
    mockConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    render(
      <TaskCard
        task={makeTask({
          column: "triage",
          sourceIssue: { provider: "github", repository: "acme/widgets", issueNumber: 42, externalIssueId: "42" },
        } as any)}
        onOpenDetail={noop}
        addToast={noop}
        onDeleteTask={onDeleteTask}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Delete task"));
    });

    await waitFor(() => {
      expect(onDeleteTask).toHaveBeenCalledWith("FN-001", { githubIssueAction: "delete" });
    });
  });

  it("uses githubIssueAction=leave for source-imported task delete", async () => {
    const onDeleteTask = vi.fn(async () => makeTask());
    mockConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);

    render(
      <TaskCard
        task={makeTask({
          column: "triage",
          sourceIssue: { provider: "github", repository: "acme/widgets", issueNumber: 42, externalIssueId: "42" },
        } as any)}
        onOpenDetail={noop}
        addToast={noop}
        onDeleteTask={onDeleteTask}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Delete task"));
    });

    await waitFor(() => {
      expect(onDeleteTask).toHaveBeenCalledWith("FN-001", { githubIssueAction: "leave" });
    });
  });

  it("deletes without githubIssueAction when no linked github issue exists", async () => {
    const onDeleteTask = vi.fn(async () => makeTask());
    mockConfirm.mockResolvedValueOnce(true);

    render(
      <TaskCard
        task={makeTask({ column: "triage", githubTracking: { enabled: false }, sourceIssue: undefined } as any)}
        onOpenDetail={noop}
        addToast={noop}
        onDeleteTask={onDeleteTask}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Delete task"));
    });

    await waitFor(() => {
      expect(onDeleteTask).toHaveBeenCalledWith("FN-001");
    });
  });

  it("runs the delete flow from the desktop task context menu", async () => {
    const onDeleteTask = vi.fn(async () => makeTask());
    mockConfirm.mockResolvedValueOnce(true);

    render(
      <TaskCard
        task={makeTask({ column: "todo", githubTracking: { enabled: false }, sourceIssue: undefined } as any)}
        onOpenDetail={noop}
        addToast={noop}
        onDeleteTask={onDeleteTask}
      />,
    );

    fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Delete Task" }));
      expect(onDeleteTask).toHaveBeenCalledWith("FN-001");
    });
  });

  it("runs the delete flow from the mobile pointer-up task context menu", async () => {
    const onDeleteTask = vi.fn(async () => makeTask());
    mockConfirm.mockResolvedValueOnce(true);

    render(
      <TaskCard
        task={makeTask({ column: "todo", githubTracking: { enabled: false }, sourceIssue: undefined } as any)}
        onOpenDetail={noop}
        addToast={noop}
        onDeleteTask={onDeleteTask}
      />,
    );

    fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
    fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Delete" }), { pointerType: "touch", pointerId: 7 });

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Delete Task" }));
      expect(onDeleteTask).toHaveBeenCalledWith("FN-001");
    });
  });

  it("preserves githubIssueAction on dependency-conflict retry", async () => {
    const conflict = new Error("Cannot delete task FN-001: still referenced as a dependency by FN-002.") as Error & { status: number; details: { code: string; dependentIds: string[] } };
    conflict.status = 409;
    conflict.details = { code: "TASK_HAS_DEPENDENTS", dependentIds: ["FN-002"] };
    const onDeleteTask = vi.fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(makeTask());

    mockConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    render(
      <TaskCard
        task={makeTask({
          column: "triage",
          githubTracking: {
            enabled: true,
            issue: { owner: "owner", repo: "repo", number: 42, url: "https://github.com/owner/repo/issues/42", createdAt: "2026-01-01T00:00:00Z" },
          },
        } as any)}
        onOpenDetail={noop}
        addToast={noop}
        onDeleteTask={onDeleteTask}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Delete task"));
    });

    await waitFor(() => {
      expect(onDeleteTask).toHaveBeenNthCalledWith(2, "FN-001", {
        removeDependencyReferences: true,
        removeLineageReferences: true,
        githubIssueAction: "delete",
      });
    });
  });

  it("retries delete after lineage-conflict confirmation", async () => {
    const conflict = new Error("Cannot delete task FN-001: still referenced as a lineage parent by FN-010.") as Error & {
      status: number;
      details: { code: string; lineageChildIds: string[] };
    };
    conflict.status = 409;
    conflict.details = { code: "TASK_HAS_LINEAGE_CHILDREN", lineageChildIds: ["FN-010", "FN-011"] };
    const onDeleteTask = vi.fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(makeTask());

    mockConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    render(
      <TaskCard
        task={makeTask({
          column: "triage",
          githubTracking: {
            enabled: true,
            issue: { owner: "owner", repo: "repo", number: 42, url: "https://github.com/owner/repo/issues/42", createdAt: "2026-01-01T00:00:00Z" },
          },
        } as any)}
        onOpenDetail={noop}
        addToast={noop}
        onDeleteTask={onDeleteTask}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Delete task"));
    });

    await waitFor(() => {
      expect(onDeleteTask).toHaveBeenNthCalledWith(2, "FN-001", {
        removeDependencyReferences: true,
        removeLineageReferences: true,
        githubIssueAction: "delete",
      });
    });
  });

  it("hides delete button for done tasks while keeping archive in the three-dot menu", async () => {
    const onDeleteTask = vi.fn(async () => makeTask());
    const onArchiveTask = vi.fn(async () => makeTask({ column: "archived" }));

    render(
      <TaskCard
        task={makeTask({ column: "done" })}
        onOpenDetail={noop}
        addToast={noop}
        onDeleteTask={onDeleteTask}
        onArchiveTask={onArchiveTask}
      />,
    );

    expect(screen.queryByLabelText("Delete task")).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    fireEvent.click(screen.getByTestId("card-menu-btn-FN-001"));
    expect(await screen.findByRole("menuitem", { name: "Archive" })).toBeDefined();
  });

  it.each(["triage", "todo", "in-progress", "in-review"] as const)(
    "hides archive action for %s tasks",
    (column) => {
      render(
        <TaskCard
          task={makeTask({ column })}
          onOpenDetail={noop}
          addToast={noop}
          onArchiveTask={vi.fn(async () => makeTask({ column: "archived" }))}
        />,
      );

      expect(screen.queryByLabelText("Archive task")).toBeNull();
      expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    },
  );

  it("renders archive action for done tasks inside the three-dot menu", async () => {
    const onArchiveTask = vi.fn(async () => makeTask({ column: "archived" }));

    render(
      <TaskCard
        task={makeTask({ column: "done" })}
        onOpenDetail={noop}
        addToast={noop}
        onArchiveTask={onArchiveTask}
      />,
    );

    expect(screen.queryByLabelText("Archive task")).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    fireEvent.click(screen.getByTestId("card-menu-btn-FN-001"));

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Archive" })).toBeDefined();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));

    await waitFor(() => expect(onArchiveTask).toHaveBeenCalledWith("FN-001"));
  });

  it("renders no action-menu shell when neither done action is available", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ column: "done", mergeDetails: undefined })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    expect(container.querySelector(".card-done-actions")).toBeNull();
    expect(screen.queryByTestId("card-menu-btn-FN-001")).toBeNull();
  });

  it("does not render archive action for archived tasks", () => {
    render(
      <TaskCard
        task={makeTask({ column: "archived" })}
        onOpenDetail={noop}
        addToast={noop}
        onArchiveTask={vi.fn(async () => makeTask({ column: "archived" }))}
        onUnarchiveTask={vi.fn(async () => makeTask({ column: "done" }))}
      />,
    );

    expect(screen.queryByLabelText("Archive task")).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    expect(screen.getByLabelText("Unarchive task")).toBeDefined();
  });

  /*
  FNXC:TaskRevert 2026-07-15-00:00 (FN-8035):
  Coverage for the Revert affordance across done + archived cards. Done-card
  actions are available only through the three-dot context menu; archived cards
  retain their inline row. The no-commit guard remains disabled in the menu.
  */
  describe("Revert affordance", () => {
    it("renders Archive and Revert in the done card three-dot menu when both are available", async () => {
      const { container } = render(
        <TaskCard
          task={makeTask({ column: "done", mergeDetails: { commitSha: "abc123def456" } as any })}
          onOpenDetail={noop}
          addToast={noop}
          onArchiveTask={vi.fn(async () => makeTask({ column: "archived" }))}
          onRevertTask={vi.fn(async () => ({ mode: "git", clean: true, revertCommitSha: "deadbeef" }) as any)}
        />,
      );

      expect(container.querySelector(".card-revert-btn")).toBeNull();
      expect(container.querySelector(".card-done-actions")).toBeNull();
      fireEvent.click(screen.getByTestId("card-menu-btn-FN-001"));
      const menu = await screen.findByRole("menu");
      expect(within(menu).getByRole("menuitem", { name: "Archive" })).toBeDefined();
      expect(within(menu).getByRole("menuitem", { name: "Revert" })).toBeDefined();
    });

    it("renders the inline Revert button for an archived card with a landed commit", () => {
      render(
        <TaskCard
          task={makeTask({ column: "archived", mergeDetails: { commitSha: "abc123def456" } as any })}
          onOpenDetail={noop}
          addToast={noop}
          onRevertTask={vi.fn(async () => ({ mode: "git", clean: true, revertCommitSha: "deadbeef" }) as any)}
        />,
      );

      expect(screen.getByLabelText("Revert this task's changes")).toBeDefined();
    });

    it("omits the Revert button when onRevertTask is not provided", () => {
      render(
        <TaskCard
          task={makeTask({ column: "done", mergeDetails: { commitSha: "abc123def456" } as any })}
          onOpenDetail={noop}
          addToast={noop}
        />,
      );

      expect(screen.queryByLabelText("Revert this task's changes")).toBeNull();
    });

    it("renders Archive and disabled Revert in the done three-dot menu without a landed commit", async () => {
      const { container } = render(
        <TaskCard
          task={makeTask({ column: "done", mergeDetails: undefined })}
          onOpenDetail={noop}
          addToast={noop}
          onArchiveTask={vi.fn(async () => makeTask({ column: "archived" }))}
          onRevertTask={vi.fn(async () => ({ mode: "git", clean: true, revertCommitSha: "deadbeef" }) as any)}
        />,
      );

      expect(container.querySelector(".card-revert-btn")).toBeNull();
      fireEvent.click(screen.getByTestId("card-menu-btn-FN-001"));
      const menu = await screen.findByRole("menu");
      expect(within(menu).getByRole("menuitem", { name: "Archive" })).toBeDefined();
      expect(within(menu).getByRole("menuitem", { name: "Revert" })).toBeDisabled();
    });

    it("renders only Revert in the done three-dot menu when archive is unavailable", async () => {
      render(
        <TaskCard
          task={makeTask({ column: "done", mergeDetails: { commitSha: "abc123def456" } as any })}
          onOpenDetail={noop}
          addToast={noop}
          onRevertTask={vi.fn(async () => ({ mode: "git", clean: true, revertCommitSha: "deadbeef" }) as any)}
        />,
      );

      fireEvent.click(screen.getByTestId("card-menu-btn-FN-001"));
      const menu = await screen.findByRole("menu");
      expect(within(menu).queryByRole("menuitem", { name: "Archive" })).toBeNull();
      expect(within(menu).getByRole("menuitem", { name: "Revert" })).toBeEnabled();
    });

    it("shows a disabled Revert context-menu entry when the task has no landed commit", () => {
      render(
        <TaskCard
          task={makeTask({ column: "done", mergeDetails: undefined })}
          onOpenDetail={noop}
          addToast={noop}
          onRevertTask={vi.fn(async () => ({ mode: "git", clean: true, revertCommitSha: "deadbeef" }) as any)}
        />,
      );

      fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
      const menuItem = screen.getByRole("menuitem", { name: "Revert" });
      expect(menuItem).toBeDisabled();
    });

    it("shows the Revert context-menu entry for done and archived cards", () => {
      render(
        <TaskCard
          task={makeTask({ column: "done", mergeDetails: { commitSha: "abc123def456" } as any })}
          onOpenDetail={noop}
          addToast={noop}
          onRevertTask={vi.fn(async () => ({ mode: "git", clean: true, revertCommitSha: "deadbeef" }) as any)}
        />,
      );

      fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
      expect(screen.getByRole("menuitem", { name: "Revert" })).toBeDefined();
    });

    it("calls onRevertTask in auto mode and toasts the revert commit sha on a clean result", async () => {
      const addToast = vi.fn();
      const onRevertTask = vi.fn(async () => ({ mode: "git", clean: true, revertCommitSha: "deadbeef1234" }) as any);

      render(
        <TaskCard
          task={makeTask({ column: "done", mergeDetails: { commitSha: "abc123def456" } as any })}
          onOpenDetail={noop}
          addToast={addToast}
          onRevertTask={onRevertTask}
        />,
      );

      fireEvent.click(screen.getByTestId("card-menu-btn-FN-001"));

      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Revert" }));
      });

      await waitFor(() => {
        expect(onRevertTask).toHaveBeenCalledWith("FN-001", { mode: "auto" });
      });
      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith(
          expect.stringContaining("deadbeef1234"),
          "success",
        );
      });
    });

    it("opens a confirm dialog on conflict and falls back to mode: ai, surfacing the created task id", async () => {
      const addToast = vi.fn();
      const onRevertTask = vi.fn()
        .mockResolvedValueOnce({ mode: "git", clean: false, conflicts: [{}] } as any)
        .mockResolvedValueOnce({ mode: "ai", createdTaskId: "FN-999" } as any);
      mockConfirm.mockResolvedValueOnce(true);

      render(
        <TaskCard
          task={makeTask({ column: "done", mergeDetails: { commitSha: "abc123def456" } as any })}
          onOpenDetail={noop}
          addToast={addToast}
          onRevertTask={onRevertTask}
        />,
      );

      fireEvent.click(screen.getByTestId("card-menu-btn-FN-001"));

      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Revert" }));
      });

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(onRevertTask).toHaveBeenNthCalledWith(2, "FN-001", { mode: "ai" });
      });
      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith(
          expect.stringContaining("FN-999"),
          "success",
        );
      });
    });
  });

  it("keeps two-button delete flow for non-done task", async () => {
    const onDeleteTask = vi.fn(async () => makeTask());
    mockConfirm.mockResolvedValueOnce(false);

    render(<TaskCard task={makeTask({ column: "triage" })} onOpenDetail={noop} addToast={noop} onDeleteTask={onDeleteTask} />);

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Delete task"));
    });

    expect(mockConfirmWithChoice).not.toHaveBeenCalled();
  });

  it("keeps legacy delete options for untracked task", async () => {
    const onDeleteTask = vi.fn(async () => makeTask());
    mockConfirm.mockResolvedValueOnce(true);

    render(<TaskCard task={makeTask({ column: "triage" })} onOpenDetail={noop} addToast={noop} onDeleteTask={onDeleteTask} />);

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Delete task"));
    });

    await waitFor(() => {
      expect(onDeleteTask).toHaveBeenCalledWith("FN-001");
    });
  });
  it("renders the card ID text", () => {
    render(<TaskCard task={makeTask()} onOpenDetail={noop} addToast={noop} />);
    expect(screen.getByText("FN-001")).toBeDefined();
  });

  it("renders a per-branch progress badge when the task is in a parallel window (U9/U13)", () => {
    const task = {
      ...makeTask(),
      branchProgress: [
        { branchId: "b1", nodeId: "n1", status: "completed" },
        { branchId: "b2", nodeId: "n2", status: "running" },
      ],
    } as Task;
    render(<TaskCard task={task} onOpenDetail={noop} addToast={noop} />);
    const badge = screen.getByTestId("branch-progress-badge");
    expect(badge.textContent).toContain("1/2");
  });

  it("does not render a branch-progress badge when there is no parallel window", () => {
    render(<TaskCard task={makeTask()} onOpenDetail={noop} addToast={noop} />);
    expect(screen.queryByTestId("branch-progress-badge")).toBeNull();
  });

  it("keeps native card dragging enabled by default", () => {
    const { container } = render(<TaskCard task={makeTask()} onOpenDetail={noop} addToast={noop} />);
    const card = container.querySelector(".card") as HTMLElement;
    expect(card.getAttribute("draggable")).toBe("true");
  });

  it("disables native card dragging when disableDrag is true", () => {
    const { container } = render(<TaskCard task={makeTask()} onOpenDetail={noop} addToast={noop} disableDrag={true} />);
    const card = container.querySelector(".card") as HTMLElement;
    expect(card.getAttribute("draggable")).toBe("false");
  });

  // FN-6389 follow-up: native HTML5 drag is desktop-mouse only and doesn't move
  // cards via touch, but a `draggable` element still arms the browser's touch-drag
  // heuristic, which intermittently hijacks horizontal swipes meant to scroll the
  // mobile board. On touch-primary (coarse pointer) devices we drop `draggable`.
  it("disables native card dragging on touch-primary (coarse pointer) devices", () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(hover: none) and (pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    try {
      const { container } = render(<TaskCard task={makeTask()} onOpenDetail={noop} addToast={noop} />);
      const card = container.querySelector(".card") as HTMLElement;
      expect(card.getAttribute("draggable")).toBe("false");
      // No drag-start handler should be wired on touch (would arm the heuristic).
      const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
      const prevented = !card.dispatchEvent(dragStart);
      expect(prevented).toBe(false);
    } finally {
      window.matchMedia = original;
    }
  });

  it.each([
    { name: "merged", primaryPr: { status: "merged" as const }, expectedClass: "card-github-badge--merged" },
    { name: "conflicting", primaryPr: { status: "open" as const, mergeable: "conflicting" as const }, expectedClass: "card-github-badge--conflicting" },
  ])("renders Nx PR badge label and resolver class for $name primary PR", ({ primaryPr, expectedClass }) => {
    render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          prInfo: {
            url: "https://github.com/owner/repo/pull/42",
            number: 42,
            status: "open",
            title: "PR",
            headBranch: "fusion/fn-001",
            baseBranch: "main",
            commentCount: 0,
            ...primaryPr,
          } as any,
          prInfos: [
            {
              url: "https://github.com/owner/repo/pull/42",
              number: 42,
              status: "open",
              title: "PR",
              headBranch: "fusion/fn-001",
              baseBranch: "main",
              commentCount: 0,
              ...primaryPr,
            },
            {
              url: "https://github.com/owner/repo/pull/99",
              number: 99,
              status: "open",
              title: "PR 2",
              headBranch: "fusion/fn-001-2",
              baseBranch: "main",
              commentCount: 0,
            },
          ] as any,
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = screen.getByRole("link", { name: /2x #42/i });
    expect(badge).toBeDefined();
    expect(badge).toHaveClass(expectedClass);
  });

  it("clicking PR badge link does not open the task detail modal", () => {
    const onOpenDetail = vi.fn();
    render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          prInfo: {
            url: "https://github.com/owner/repo/pull/42",
            number: 42,
            status: "open",
            title: "PR",
            headBranch: "fusion/fn-001",
            baseBranch: "main",
            commentCount: 0,
          } as any,
        })}
        onOpenDetail={onOpenDetail}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "#42" }));
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("renders Create PR quick action on eligible in-review cards", () => {
    render(
      <TaskCard
        task={makeTask({ column: "in-review", paused: false, userPaused: false, prInfo: undefined as any })}
        onOpenDetail={noop}
        addToast={noop}
        prAuthAvailable={true}
      />,
    );

    expect(screen.getByRole("button", { name: "Create pull request" })).toBeDefined();
  });

  it("renders Create PR quick action with chip class instead of btn classes", () => {
    render(
      <TaskCard
        task={makeTask({ column: "in-review", paused: false, userPaused: false, prInfo: undefined as any })}
        onOpenDetail={noop}
        addToast={noop}
        prAuthAvailable={true}
      />,
    );

    const createPrButton = screen.getByRole("button", { name: "Create pull request" });
    expect(createPrButton).toHaveClass("card-create-pr-action");
    expect(createPrButton).not.toHaveClass("btn");
    expect(createPrButton).not.toHaveClass("btn-sm");
  });

  it.each(["in-progress", "todo", "done"] as const)("does not render Create PR quick action outside in-review (%s)", (column) => {
    render(
      <TaskCard
        task={makeTask({ column, paused: false, userPaused: false, prInfo: undefined as any })}
        onOpenDetail={noop}
        addToast={noop}
        prAuthAvailable={true}
      />,
    );

    expect(screen.queryByRole("button", { name: "Create pull request" })).toBeNull();
  });

  it("does not render Create PR quick action when prAuthAvailable is false", () => {
    render(
      <TaskCard
        task={makeTask({ column: "in-review", paused: false, userPaused: false, prInfo: undefined as any })}
        onOpenDetail={noop}
        addToast={noop}
        prAuthAvailable={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Create pull request" })).toBeNull();
  });

  it.each([
    {
      name: "hides when task override turns auto-merge on while project default is off",
      taskAutoMerge: true,
      autoMergeEnabled: false,
      shouldShow: false,
    },
    {
      name: "hides when task follows an enabled project default",
      taskAutoMerge: undefined,
      autoMergeEnabled: true,
      shouldShow: false,
    },
    {
      name: "shows when task override turns auto-merge off while project default is on",
      taskAutoMerge: false,
      autoMergeEnabled: true,
      shouldShow: true,
    },
    {
      name: "shows when task follows a disabled project default",
      taskAutoMerge: undefined,
      autoMergeEnabled: false,
      shouldShow: true,
    },
  ])("Create PR quick action $name", ({ taskAutoMerge, autoMergeEnabled, shouldShow }) => {
    render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          paused: false,
          userPaused: false,
          prInfo: undefined as any,
          autoMerge: taskAutoMerge,
        })}
        onOpenDetail={noop}
        addToast={noop}
        prAuthAvailable={true}
        autoMergeEnabled={autoMergeEnabled}
      />,
    );

    if (shouldShow) {
      expect(screen.getByRole("button", { name: "Create pull request" })).toBeDefined();
      return;
    }

    expect(screen.queryByRole("button", { name: "Create pull request" })).toBeNull();
  });

  it("does not render Create PR quick action when task already has prInfo", () => {
    render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          prInfo: {
            url: "https://github.com/owner/repo/pull/7",
            number: 7,
            status: "open",
            title: "Existing PR",
            headBranch: "fusion/fn-001",
            baseBranch: "main",
            commentCount: 0,
          } as any,
        })}
        onOpenDetail={noop}
        addToast={noop}
        prAuthAvailable={true}
      />,
    );

    expect(screen.queryByRole("button", { name: "Create pull request" })).toBeNull();
  });

  it("hides Address PR feedback when the task has no actionable PR feedback", () => {
    const noPrRender = render(
      <TaskCard
        task={makeTask({ id: "FN-NO-PR", prInfo: undefined as any, prInfos: undefined })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.queryByTestId("card-address-pr-feedback-FN-NO-PR")).toBeNull();
    expect(noPrRender.container.querySelector(".card-action-row")).toBeNull();
    noPrRender.unmount();

    const noFeedbackRender = render(
      <TaskCard
        task={makeTask({
          id: "FN-NO-FEEDBACK",
          prInfo: {
            url: "https://github.com/owner/repo/pull/8",
            number: 8,
            status: "open",
            title: "No feedback PR",
            headBranch: "fusion/fn-001",
            baseBranch: "main",
            commentCount: 0,
            lastReviewDecision: "APPROVED",
          } as any,
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.queryByTestId("card-address-pr-feedback-FN-NO-FEEDBACK")).toBeNull();
    expect(noFeedbackRender.container.querySelector(".card-action-row")).toBeNull();
    noFeedbackRender.unmount();

    const unsupportedColumnRender = render(
      <TaskCard
        task={makeTask({
          id: "FN-DONE-FEEDBACK",
          column: "done",
          prInfo: {
            url: "https://github.com/owner/repo/pull/13",
            number: 13,
            status: "open",
            title: "Feedback on done task",
            headBranch: "fusion/fn-done",
            baseBranch: "main",
            commentCount: 2,
            lastReviewDecision: "CHANGES_REQUESTED",
          } as any,
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.queryByTestId("card-address-pr-feedback-FN-DONE-FEEDBACK")).toBeNull();
    expect(unsupportedColumnRender.container.querySelector(".card-action-row")).toBeNull();
  });

  it("renders Address PR feedback once for actionable primary PR feedback", () => {
    render(
      <TaskCard
        task={makeTask({
          id: "FN-PR-FEEDBACK",
          prInfos: [
            {
              url: "https://github.com/owner/repo/pull/9",
              number: 9,
              status: "open",
              title: "Feedback PR",
              headBranch: "fusion/fn-001",
              baseBranch: "main",
              commentCount: 2,
            } as any,
            {
              url: "https://github.com/owner/repo/pull/10",
              number: 10,
              status: "open",
              title: "Secondary PR",
              headBranch: "fusion/fn-001-alt",
              baseBranch: "main",
              commentCount: 4,
            } as any,
          ],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const buttons = screen.getAllByTestId("card-address-pr-feedback-FN-PR-FEEDBACK");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveClass("card-create-pr-action", "card-address-pr-feedback-action");
    expect(buttons[0].closest(".card-action-row")).not.toBeNull();
  });

  it("starts Address PR feedback from the card without opening detail", async () => {
    const addToast = vi.fn();
    const onOpenDetail = vi.fn();
    vi.mocked(addressPrFeedback).mockResolvedValue({ task: makeTask({ id: "FN-CLICK" }) });

    render(
      <TaskCard
        task={makeTask({
          id: "FN-CLICK",
          prInfo: {
            url: "https://github.com/owner/repo/pull/11",
            number: 11,
            status: "open",
            title: "Changes requested PR",
            headBranch: "fusion/fn-click",
            baseBranch: "main",
            commentCount: 0,
            lastReviewDecision: "CHANGES_REQUESTED",
          } as any,
        })}
        onOpenDetail={onOpenDetail}
        addToast={addToast}
        projectId="proj-1"
      />,
    );

    fireEvent.click(screen.getByTestId("card-address-pr-feedback-FN-CLICK"));

    await waitFor(() => expect(addressPrFeedback).toHaveBeenCalledWith("FN-CLICK", "proj-1"));
    expect(addToast).toHaveBeenCalledWith("Addressing PR feedback — AI session started", "success");
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("shows an error toast when Address PR feedback cannot start", async () => {
    const addToast = vi.fn();
    vi.mocked(addressPrFeedback).mockRejectedValue(new Error("wake failed"));

    render(
      <TaskCard
        task={makeTask({
          id: "FN-ERROR",
          prInfo: {
            url: "https://github.com/owner/repo/pull/12",
            number: 12,
            status: "open",
            title: "Feedback PR",
            headBranch: "fusion/fn-error",
            baseBranch: "main",
            commentCount: 1,
          } as any,
        })}
        onOpenDetail={noop}
        addToast={addToast}
      />,
    );

    fireEvent.click(screen.getByTestId("card-address-pr-feedback-FN-ERROR"));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith("Failed to start PR feedback session: wake failed", "error"));
  });

  it.each([
    { paused: true, userPaused: false },
    { paused: false, userPaused: true },
  ])("does not render Create PR quick action when paused flags are set", ({ paused, userPaused }) => {
    render(
      <TaskCard
        task={makeTask({ column: "in-review", paused, userPaused, prInfo: undefined as any })}
        onOpenDetail={noop}
        addToast={noop}
        prAuthAvailable={true}
      />,
    );

    expect(screen.queryByRole("button", { name: "Create pull request" })).toBeNull();
  });

  it("opens Create PR modal on click and does not open task detail", () => {
    const onOpenDetail = vi.fn();

    render(
      <TaskCard
        task={makeTask({ column: "in-review", paused: false, userPaused: false, prInfo: undefined as any })}
        onOpenDetail={onOpenDetail}
        addToast={noop}
        prAuthAvailable={true}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));

    expect(screen.getByTestId("pr-create-modal").getAttribute("data-open")).toBe("true");
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("closes Create PR modal when onClose fires", () => {
    render(
      <TaskCard
        task={makeTask({ column: "in-review", paused: false, userPaused: false, prInfo: undefined as any })}
        onOpenDetail={noop}
        addToast={noop}
        prAuthAvailable={true}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));
    fireEvent.click(screen.getByRole("button", { name: "close-pr-modal" }));

    expect(screen.getByTestId("pr-create-modal").getAttribute("data-open")).toBe("false");
  });

  it("shows success toast and closes modal when PR is created", () => {
    const addToast = vi.fn();

    render(
      <TaskCard
        task={makeTask({ column: "in-review", paused: false, userPaused: false, prInfo: undefined as any })}
        onOpenDetail={noop}
        addToast={addToast}
        prAuthAvailable={true}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));
    fireEvent.click(screen.getByRole("button", { name: "create-pr-modal" }));

    expect(addToast).toHaveBeenCalledWith("Created PR #42", "success");
    expect(screen.getByTestId("pr-create-modal").getAttribute("data-open")).toBe("false");
  });

  it("renders GitHub badge from live websocket data even when task payload has no badge fields", () => {
    badgeUpdatesMock.set("default:FN-001", {
      prInfo: {
        url: "https://github.com/owner/repo/pull/77",
        number: 77,
        status: "open",
        title: "Live PR",
        headBranch: "feature/live",
        baseBranch: "main",
        commentCount: 0,
      },
      timestamp: "2026-05-13T12:00:00.000Z",
    });

    render(
      <TaskCard
        task={makeTask({ column: "in-review", prInfo: undefined, issueInfo: undefined })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(subscribeToBadgeMock).toHaveBeenCalledWith("FN-001");
    expect(screen.getByRole("link", { name: "#77" })).toBeDefined();
  });

  it("clicking issue badge text does not open the task detail modal", () => {
    const onOpenDetail = vi.fn();
    render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          issueInfo: {
            url: "https://github.com/owner/repo/issues/123",
            number: 123,
            state: "open",
            title: "Issue",
          } as any,
        })}
        onOpenDetail={onOpenDetail}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByText("#123"));
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("renders the status badge when task.status is set", () => {
    render(
      <TaskCard
        task={makeTask({ status: "executing" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    expect(screen.getByText("executing")).toBeDefined();
  });

  it.each([
    { column: "todo" as const, status: "planning" },
    { column: "in-progress" as const, status: "planning" },
  ])("FN-8170 suppresses stale planning status and its empty header wrapper on $column cards", ({ column, status }) => {
    const { container } = render(
      <TaskCard
        task={makeTask({ column, status })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.queryByText("planning")).toBeNull();
    expect(container.querySelector(".card-header-badges")).toBeNull();
  });

  it("FN-8170 preserves triage planning and non-planning status badges", () => {
    const { rerender } = render(
      <TaskCard
        task={makeTask({ column: "triage", status: "planning" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    expect(screen.getByText("planning")).toBeDefined();

    rerender(
      <TaskCard
        task={makeTask({
          column: "in-progress",
          status: "executing",
          steps: [{ name: "Executing step", status: "in-progress" }],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    expect(screen.getByText("executing")).toBeDefined();
  });

  it("renders merge-remediation status as merge-active for in-review tasks", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ column: "in-review", status: "merging-fix" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Merging fixes…")).toBeDefined();
    const badge = container.querySelector(".card-status-badge");
    expect(badge?.className).toContain("pulsing");
  });

  it("FN-4208 keeps failed in-review TaskCard badge on error colors", () => {
    const cleanupCss = mountCssForBadgeTests();
    try {
      const { container } = render(
        <TaskCard task={makeTask({ column: "in-review", status: "failed" as any, error: "boom" })} onOpenDetail={noop} addToast={noop} />,
      );

      const badge = container.querySelector(".card-status-badge") as HTMLElement;
      expect(badge.className).toContain("card-status-badge--in-review");
      expect(badge.className).toContain("failed");
      expect(getComputedStyle(badge).color).toBe("var(--color-error-dark)");
      expect(getComputedStyle(badge).color).not.toBe("var(--in-review)");
    } finally {
      cleanupCss();
    }
  });

  it.each([
    { name: "undefined results", workflowStepResults: undefined, shouldRender: false },
    { name: "pending but not started", workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "pending" }], shouldRender: false },
    { name: "running", workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "pending", startedAt: "2026-07-11T12:00:00.000Z" }], shouldRender: true },
    { name: "passed", workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "passed", startedAt: "2026-07-11T12:00:00.000Z", completedAt: "2026-07-11T12:01:00.000Z" }], shouldRender: false },
    { name: "failed", workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "failed", startedAt: "2026-07-11T12:00:00.000Z", completedAt: "2026-07-11T12:01:00.000Z" }], shouldRender: false },
    { name: "skipped", workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "skipped", startedAt: "2026-07-11T12:00:00.000Z", completedAt: "2026-07-11T12:01:00.000Z" }], shouldRender: false },
    { name: "advisory failure", workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "advisory_failure", startedAt: "2026-07-11T12:00:00.000Z", completedAt: "2026-07-11T12:01:00.000Z" }], shouldRender: false },
  ])("renders the Reviewing badge only while Plan Review is actively running: $name", ({ workflowStepResults, shouldRender }) => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          id: "FN-7831",
          column: "triage",
          status: "planning",
          enabledWorkflowSteps: ["plan-review"],
          workflowStepResults: workflowStepResults as Task["workflowStepResults"],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = container.querySelector('[data-testid="card-reviewing-FN-7831"]');
    expect(Boolean(badge)).toBe(shouldRender);
    if (shouldRender) {
      expect(badge).toHaveTextContent("Reviewing");
      expect(screen.getByText("planning")).toBeDefined();
    }
  });

  it("keeps the card border and Reviewing badge in agreement for a status-null running Plan Review", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          id: "FN-8055",
          column: "triage",
          status: null as any,
          enabledWorkflowSteps: ["plan-review"],
          workflowStepResults: [{
            workflowStepId: "plan-review",
            workflowStepName: "Plan Review",
            status: "pending",
            startedAt: "2026-07-16T00:00:00.000Z",
          }],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card")?.className).toContain("agent-active");
    expect(container.querySelector('[data-testid="card-reviewing-FN-8055"]')?.className).toContain("pulsing");
  });

  it("turns off both border and Reviewing pulse when the render queue gate is active", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          id: "FN-8055-queued",
          column: "triage",
          status: null as any,
          enabledWorkflowSteps: ["plan-review"],
          workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "pending", startedAt: "2026-07-16T00:00:00.000Z" }],
        })}
        queued
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card")?.className).not.toContain("agent-active");
    expect(container.querySelector('[data-testid="card-reviewing-FN-8055-queued"]')).toBeNull();
  });

  it("renders the status badge after the card ID in DOM order", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ status: "executing" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    const cardId = container.querySelector(".card-id")!;
    const badge = container.querySelector(".card-status-badge")!;
    expect(cardId).toBeDefined();
    expect(badge).toBeDefined();
    const headerBadges = container.querySelector(".card-header-badges")!;
    expect(headerBadges).toBeDefined();
    expect(cardId.nextElementSibling).toBe(headerBadges);
    expect(headerBadges.contains(badge)).toBe(true);
  });

  it("does not render a status badge when task.status is falsy", () => {
    const { container } = render(
      <TaskCard task={makeTask({ status: undefined as any })} onOpenDetail={noop} addToast={noop} />,
    );
    expect(container.querySelector(".card-status-badge")).toBeNull();
  });

  /*
   * FNXC:ReleaseAuthorizationGate 2026-07-09-00:00: the triage release-authorization
   * gate was removed. A legacy release-authorization hold now renders the generic
   * "Awaiting Approval" badge like any manual plan-approval hold — no distinct
   * release-authorization label or badge class.
   */
  it("renders the generic Awaiting Approval badge for a legacy release-authorization hold", () => {
    const { container: releaseContainer } = render(
      <TaskCard
        task={makeTask({ column: "triage", status: "awaiting-approval", awaitingApprovalReason: "release-authorization" } as any)}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    expect(within(releaseContainer).getByText("Awaiting Approval")).toBeDefined();
    expect(within(releaseContainer).queryByText("Awaiting Release Authorization")).toBeNull();
    const releaseBadge = releaseContainer.querySelector(".card-status-badge") as HTMLElement;
    expect(releaseBadge.className).not.toContain("awaiting-release-authorization");
  });

  /*
   * FNXC:PlanReviewReplan 2026-07-15-11:09:
   * When Plan Review exhausts automatic REVISE replans, the card must not look like a
   * generic require-all hold — badge text + title explain the non-convergence reason.
   */
  it("keeps the generic Awaiting Approval badge for an ordinary manual hold", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ column: "triage", status: "awaiting-approval" } as any)}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(within(container).getByText("Awaiting Approval")).toBeDefined();
    expect(container.querySelector(".awaiting-approval--plan-review-replan-cap")).toBeNull();
  });

  it("renders a distinct review-budget-exhausted badge when awaitingApprovalReason is plan-review-replan-cap", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "triage",
          status: "awaiting-approval",
          awaitingApprovalReason: "plan-review-replan-cap",
        } as any)}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    expect(within(container).getByText("Review budget exhausted")).toBeDefined();
    expect(within(container).queryByText("Awaiting Approval")).toBeNull();
    const badge = container.querySelector(".card-status-badge") as HTMLElement;
    expect(badge.className).toContain("awaiting-approval--plan-review-replan-cap");
    expect(badge.getAttribute("data-awaiting-approval-reason")).toBe("plan-review-replan-cap");
    expect(badge.getAttribute("title")).toMatch(/Plan Review requested revisions/i);
  });

  it("renders stalled badge with visible reason when stalledReview is set", () => {
    render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          status: "merging",
          stalledReview: {
            reason: "Re-enqueued for merge 3 times in the last 60 minutes without leaving in-review",
            heuristic: "reenqueue-churn",
            matchCount: 3,
            firstMatchAt: "2026-05-12T11:00:00.000Z",
            lastMatchAt: "2026-05-12T11:50:00.000Z",
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const stalledBadge = screen.getByText("Stalled");
    expect(stalledBadge.getAttribute("title")).toContain("Re-enqueued for merge 3 times");
    expect(screen.getByText("Re-enqueued for merge 3 times in the last 60 minutes without leaving in-review")).toBeDefined();
  });

  it("does not render stalled badge when stalledReview is undefined", () => {
    render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          status: "merging",
          stalledReview: undefined,
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.queryByText("Stalled")).toBeNull();
    expect(screen.queryByText(/Re-enqueued for merge/)).toBeNull();
  });

  it("renders retry-exhausted in-review stall badge with counter, code, and tooltip", () => {
    render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          status: "merging",
          mergeRetries: 3,
          inReviewStall: {
            code: "merge-retries-exhausted",
            reason: "Auto-merge retries exhausted",
            observedAt: "2026-05-13T00:00:00.000Z",
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = screen.getByText("Retries exhausted 3/3");
    expect(badge.getAttribute("data-stall-code")).toBe("merge-retries-exhausted");
    expect(badge.getAttribute("title")).toContain("Auto-merge retries exhausted");
  });

  it("renders merge-blocker in-review stall badge without retry counter", () => {
    render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          status: "failed",
          mergeRetries: 3,
          inReviewStall: {
            code: "merge-blocker",
            reason: "Merge blocked by pre-merge check",
            observedAt: "2026-05-13T00:00:00.000Z",
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Merge blocked")).toBeDefined();
    expect(screen.queryByText(/\/3/)).toBeNull();
  });

  it("FN-4570: hides merge-blocker stall badge while merge is active", () => {
    render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          status: "merging",
          inReviewStall: {
            code: "merge-blocker",
            reason: "Merge blocked by pre-merge check",
            observedAt: "2026-05-13T00:00:00.000Z",
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Merging…")).toBeDefined();
    expect(screen.queryByText("Merge blocked")).toBeNull();
  });

  it.each(["merging", "reviewing", "landing", "merging-pr"] as const)(
    "FN-merge-badge: shows Merging… badge while task.status is %s",
    (status) => {
      render(
        <TaskCard
          task={makeTask({
            column: "in-review",
            status,
          })}
          onOpenDetail={noop}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Merging…")).toBeDefined();
    },
  );

  it.each([
    {
      label: "paused in-review task",
      task: makeTask({
        column: "in-review",
        paused: true,
        status: "merging",
        inReviewStall: {
          code: "merge-retries-exhausted",
          reason: "Auto-merge retries exhausted",
          observedAt: "2026-05-13T00:00:00.000Z",
        },
      }),
    },
    {
      label: "in-review task without inReviewStall",
      task: makeTask({ column: "in-review", status: "merging", inReviewStall: undefined }),
    },
    {
      label: "non in-review task with fabricated signal",
      task: makeTask({
        column: "in-progress",
        status: "executing",
        inReviewStall: {
          code: "merge-retries-exhausted",
          reason: "Auto-merge retries exhausted",
          observedAt: "2026-05-13T00:00:00.000Z",
        },
      }),
    },
  ])("hides in-review stall badge for $label", ({ task }) => {
    render(<TaskCard task={task} onOpenDetail={noop} addToast={noop} />);
    expect(screen.queryByText("Retries exhausted")).toBeNull();
  });

  it("renders stale paused review badge for paused in-review signal", () => {
    render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          paused: true,
          stalePausedReview: {
            code: "stale-paused-review",
            reason: "Task has remained paused in review beyond threshold",
            observedAt: "2026-05-14T00:00:00.000Z",
            ageMs: 86_400_000,
            thresholdMs: 86_400_000,
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Paused stall")).toBeDefined();
  });

  it("hides stale paused review badge when signal missing", () => {
    render(
      <TaskCard task={makeTask({ column: "in-review", paused: true, stalePausedReview: undefined })} onOpenDetail={noop} addToast={noop} />,
    );
    expect(screen.queryByText("Paused stall")).toBeNull();
  });

  it("hides stale paused review badge when task is not paused", () => {
    render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          paused: false,
          stalePausedReview: {
            code: "stale-paused-review",
            reason: "Task has remained paused in review beyond threshold",
            observedAt: "2026-05-14T00:00:00.000Z",
            ageMs: 86_400_000,
            thresholdMs: 86_400_000,
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    expect(screen.queryByText("Paused stall")).toBeNull();
  });

  it("renders warning task-age staleness badge", () => {
    render(
      <TaskCard
        task={makeTask({
          ageStaleness: {
            level: "warning",
            reason: "in-progress age exceeded warning threshold",
            observedAt: "2026-05-14T00:00:00.000Z",
            ageMs: 5 * 60 * 60_000,
            warningThresholdMs: 4 * 60 * 60_000,
            criticalThresholdMs: 24 * 60 * 60_000,
            column: "in-progress",
            paused: false,
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Stale")).toBeDefined();
  });

  it("renders critical task-age staleness badge", () => {
    render(
      <TaskCard
        task={makeTask({
          ageStaleness: {
            level: "critical",
            reason: "in-review age exceeded critical threshold",
            observedAt: "2026-05-14T00:00:00.000Z",
            ageMs: 80 * 60 * 60_000,
            warningThresholdMs: 24 * 60 * 60_000,
            criticalThresholdMs: 72 * 60 * 60_000,
            column: "in-review",
            paused: true,
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Stale (critical)")).toBeDefined();
  });

  it("hides task-age staleness badge when signal is absent", () => {
    render(<TaskCard task={makeTask({ ageStaleness: undefined })} onOpenDetail={noop} addToast={noop} />);
    expect(screen.queryByText("Stale")).toBeNull();
    expect(screen.queryByText("Stale (critical)")).toBeNull();
  });

  it("shows paused by agent label when pausedByAgentId is set", () => {
    render(
      <TaskCard task={makeTask({ paused: true, pausedByAgentId: "agent-1" })} onOpenDetail={noop} addToast={noop} />,
    );

    expect(screen.getByText("paused by agent")).toBeDefined();
  });

  it("shows plain paused label when pausedByAgentId is not set", () => {
    render(
      <TaskCard task={makeTask({ paused: true })} onOpenDetail={noop} addToast={noop} />,
    );

    expect(screen.getByText("paused")).toBeDefined();
    expect(screen.queryByText("paused by agent")).toBeNull();
  });

  it("renders todo userPaused tasks as paused", () => {
    const { container } = render(
      <TaskCard task={makeTask({ column: "todo", paused: undefined, userPaused: true })} onOpenDetail={noop} addToast={noop} />,
    );

    expect(screen.getByText("paused")).toBeDefined();
    expect(container.querySelector(".card")?.className).toContain("paused");
  });

  it("does not show paused by agent copy for userPaused-only tasks", () => {
    render(
      <TaskCard task={makeTask({ column: "todo", paused: undefined, userPaused: true, pausedByAgentId: undefined })} onOpenDetail={noop} addToast={noop} />,
    );

    expect(screen.getByText("paused")).toBeDefined();
    expect(screen.queryByText("paused by agent")).toBeNull();
  });

  it("keeps done status badge when stale paused metadata exists", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ column: "done", status: "paused", paused: true, userPaused: true, pausedByAgentId: "agent-1" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.queryByText("paused by agent")).toBeNull();
    expect(screen.queryByText("paused")).toBeNull();
    expect(screen.getByText("done")).toBeDefined();
    expect(container.querySelector(".card")?.className).not.toContain("paused");
  });

  it("keeps done status badge when done task status is paused", () => {
    render(
      <TaskCard task={makeTask({ column: "done", status: "paused", paused: false, userPaused: false })} onOpenDetail={noop} addToast={noop} />,
    );

    expect(screen.queryByText("paused")).toBeNull();
    expect(screen.getByText("done")).toBeDefined();
  });

  it("renders decision-only badge when noCommitsExpected is true", () => {
    render(<TaskCard task={makeTask({ noCommitsExpected: true })} onOpenDetail={noop} addToast={noop} />);
    expect(screen.getByText("decision-only")).toBeTruthy();
  });

  it("hides decision-only badge when noCommitsExpected is false", () => {
    render(<TaskCard task={makeTask({ noCommitsExpected: false })} onOpenDetail={noop} addToast={noop} />);
    expect(screen.queryByText("decision-only")).toBeNull();
  });

  it("does not render fan-out badge when fanout is missing or zero", () => {
    const { container, rerender } = render(
      <TaskCard task={makeTask({ column: "todo" })} onOpenDetail={noop} addToast={noop} />,
    );

    expect(container.querySelector(".card-fanout-badge")).toBeNull();

    rerender(
      <TaskCard
        task={makeTask({ column: "todo" })}
        fanout={{ totalCount: 0, activeTodoCount: 0, dependentIds: [], dependencyDependentIds: [], overlapBlockedDependentIds: [], overlapBlockedActiveCount: 0, overlapBlockedTodoCount: 0, staleBlockedByDependentIds: [], isHighFanout: false }}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-fanout-badge")).toBeNull();
  });

  it("renders overlap scope badge when overlapBlockedBy is set without blockedBy", () => {
    render(
      <TaskCard
        task={makeTask({ column: "todo", blockedBy: undefined, overlapBlockedBy: "FN-OVER" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("FN-OVER")).toBeInTheDocument();
  });

  it("does not render overlap scope badge when blockedBy and overlapBlockedBy are absent", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ column: "todo", blockedBy: undefined, overlapBlockedBy: undefined })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-scope-badge")).toBeNull();
  });

  it("renders fan-out badge with downstream count and tooltip", () => {
    render(
      <TaskCard
        task={makeTask({ column: "in-progress" })}
        fanout={{ totalCount: 7, activeTodoCount: 4, dependentIds: ["FN-002"], dependencyDependentIds: ["FN-002"], overlapBlockedDependentIds: [], overlapBlockedActiveCount: 0, overlapBlockedTodoCount: 0, staleBlockedByDependentIds: [], isHighFanout: false }}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = screen.getByText("Blocks").closest(".card-fanout-badge") as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toContain("Blocks 7");
    expect(badge.getAttribute("data-tooltip")).toContain("overlap blockedBy queue: 0 todo");
  });

  it("applies stale fan-out modifier when stale blockedBy dependents exist", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ column: "in-progress" })}
        fanout={{ totalCount: 3, activeTodoCount: 1, dependentIds: ["FN-003"], dependencyDependentIds: [], overlapBlockedDependentIds: ["FN-003"], overlapBlockedActiveCount: 1, overlapBlockedTodoCount: 1, staleBlockedByDependentIds: ["FN-003"], isHighFanout: false }}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = container.querySelector(".card-fanout-badge") as HTMLElement;
    expect(badge.className).toContain("card-fanout-badge--stale");
    expect(badge.textContent).toContain("(1 stale)");
  });

  it("renders overlap bottleneck badge without visible todo suffix while keeping tooltip context", () => {
    render(
      <TaskCard
        task={makeTask({ column: "in-progress" })}
        fanout={highFanout}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = screen.getByText("Overlap bottleneck").closest(".card-fanout-badge") as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toContain("Overlap bottleneck 7");
    expect(badge.textContent).not.toContain("todo)");
    expect(badge.getAttribute("data-tooltip")).toContain("overlap blockedBy queue: 3 todo");
  });

  it("escalates only threshold-crossing fan-out badges", () => {
    const { rerender } = render(
      <TaskCard
        task={makeTask({ column: "in-progress" })}
        fanout={{
          ...highFanout,
          totalCount: 8,
          activeTodoCount: 5,
          overlapBlockedTodoCount: 5,
          overlapBlockedActiveCount: 8,
          dependentIds: ["FN-003"],
          escalation: { blockerId: "FN-001", activeTodoCount: 5, totalActiveCount: 8, blockingAgeMs: 3_600_000 },
        }}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    let badge = screen.getByText("Escalated overlap").closest(".card-fanout-badge") as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toContain("Escalated");
    expect(badge.textContent).toContain("8");
    expect(badge.textContent).not.toContain("todo)");

    rerender(
      <TaskCard
        task={makeTask({ column: "in-progress" })}
        fanout={{ totalCount: 8, activeTodoCount: 4, dependentIds: ["FN-003"], dependencyDependentIds: ["FN-003"], overlapBlockedDependentIds: [], overlapBlockedActiveCount: 0, overlapBlockedTodoCount: 0, staleBlockedByDependentIds: [], isHighFanout: false }}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    badge = screen.getByText("Blocks").closest(".card-fanout-badge") as HTMLElement;
    expect(badge).not.toBeNull();
  });

  it("shows plain paused label when pausedByAgentId is not set", () => {
    render(
      <TaskCard task={makeTask({ paused: true })} onOpenDetail={noop} addToast={noop} />,
    );

    expect(screen.getByText("paused")).toBeDefined();
    expect(screen.queryByText("paused by agent")).toBeNull();
  });

  it("hides default working branch and default base branch metadata", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ branch: "fusion/fn-001", baseBranch: "main" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-branch-row")).toBeNull();
  });

  it("hides auto-generated suffixed default working branches", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ branch: "fusion/fn-001-2", baseBranch: "main" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-branch-row")).toBeNull();
  });

  it("shows only custom working branch metadata when base branch is default", () => {
    render(
      <TaskCard
        task={makeTask({ branch: "feature/working-only", baseBranch: "main" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Branch")).toBeDefined();
    expect(screen.getByText("feature/working-only")).toBeDefined();
    expect(screen.queryByText("Base")).toBeNull();
  });

  it("shows only non-default base branch metadata when working branch is default", () => {
    render(
      <TaskCard
        task={makeTask({ branch: "fusion/fn-001", baseBranch: "release/2026-05" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Base")).toBeDefined();
    expect(screen.getByText("release/2026-05")).toBeDefined();
    expect(screen.queryByText("Branch")).toBeNull();
  });

  it("renders merge target from task.baseBranch, not prInfo.baseBranch metadata", () => {
    render(
      <TaskCard
        task={makeTask({
          branch: "fusion/fn-001",
          baseBranch: "release/task-target",
          prInfo: {
            url: "https://github.com/runfusion/fusion/pull/10",
            number: 10,
            status: "open",
            title: "PR title",
            headBranch: "feature/pr-head",
            baseBranch: "main",
            commentCount: 0,
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Base")).toBeDefined();
    expect(screen.getByText("release/task-target")).toBeDefined();
    expect(screen.queryByText("main")).toBeNull();
  });

  it("shows both chips when branch and base branch are both non-default", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ branch: "feature/fn-3423-card-branches", baseBranch: "develop" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const branchRow = container.querySelector(".card-branch-row");
    expect(branchRow).not.toBeNull();
    expect(screen.getByText("Branch")).toBeDefined();
    expect(screen.getByText("feature/fn-3423-card-branches")).toBeDefined();
    expect(screen.getByText("Base")).toBeDefined();
    expect(screen.getByText("develop")).toBeDefined();
  });

  it("shows shared group chip with shared branch label for grouped tasks", () => {
    render(
      <TaskCard
        task={makeTask({
          branch: "feature/shared-branch",
          branchContext: { groupId: "BG-22", source: "planning", assignmentMode: "shared" },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Shared")).toBeDefined();
    expect(screen.getAllByText("feature/shared-branch").length).toBeGreaterThan(0);
  });

  it("opens group modal from shared branch chip", () => {
    const onOpenGroupModal = vi.fn();
    render(
      <TaskCard
        task={makeTask({
          branch: "feature/shared-branch",
          branchContext: { groupId: "BG-22", source: "planning", assignmentMode: "shared" },
        })}
        onOpenDetail={noop}
        onOpenGroupModal={onOpenGroupModal}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByText("Shared"));
    expect(onOpenGroupModal).toHaveBeenCalledWith("BG-22");
  });

  it("keeps long non-default branch names readable via text and title semantics", () => {
    const longBranch = "feature/fn-3423-display-very-long-working-branch-name-for-card-metadata";
    const { container } = render(
      <TaskCard
        task={makeTask({ branch: longBranch, baseBranch: "main" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const branchChip = container.querySelector(".card-branch-chip");
    expect(branchChip?.getAttribute("title")).toBe(longBranch);
    expect(screen.getByText(longBranch)).toBeDefined();
  });

  it("renders fast-mode indicator only when executionMode is fast", () => {
    const { container, rerender } = render(
      <TaskCard task={makeTask({ executionMode: "fast" })} onOpenDetail={noop} addToast={noop} />,
    );

    const fastBadge = container.querySelector(".card-execution-mode-badge");
    expect(fastBadge).not.toBeNull();
    expect(screen.getByTestId("icon-zap")).toBeDefined();
    expect(fastBadge?.getAttribute("aria-label")).toBe("Fast mode");

    rerender(
      <TaskCard task={makeTask({ executionMode: "standard" })} onOpenDetail={noop} addToast={noop} />,
    );

    expect(container.querySelector(".card-execution-mode-badge")).toBeNull();
  });

  it("updates fast-mode indicator when executionMode changes", () => {
    const { container, rerender } = render(
      <TaskCard task={makeTask({ executionMode: "standard" })} onOpenDetail={noop} addToast={noop} />,
    );

    expect(container.querySelector(".card-execution-mode-badge")).toBeNull();

    rerender(
      <TaskCard task={makeTask({ executionMode: "fast" })} onOpenDetail={noop} addToast={noop} />,
    );

    expect(container.querySelector(".card-execution-mode-badge")).not.toBeNull();
    expect(screen.getByTestId("icon-zap")).toBeDefined();
  });


  it("keeps priority and fast mode in meta while agent-created and time move to bottom rows", () => {

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "done",
          priority: "high",
          executionMode: "fast",
          sourceType: "automation",
          sourceMetadata: { agentName: "Task Robot" },
          executionStartedAt: "2026-04-25T13:00:00.000Z",
          executionCompletedAt: "2026-04-25T15:00:00.000Z",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const group = container.querySelector(".card-meta-badges");
    expect(group).not.toBeNull();

    const expectedMetaSelectors = [
      ".card-priority-badge",
      ".card-execution-mode-badge",
    ];
    expectedMetaSelectors.forEach((selector) => {

      const badge = container.querySelector(selector);
      expect(badge).not.toBeNull();
      expect(badge?.closest(".card-meta-badges")).toBe(group);
    });

    const timer = container.querySelector(".card-time-indicator");
    expect(timer).not.toBeNull();
    expect(timer?.closest(".card-meta-badges")).toBeNull();
    expect(timer?.closest(".card-footer-row-right")).not.toBeNull();

    // FNXC:PlannerOversight 2026-07-04-00:00: an unset per-task oversight
    // override resolving to the inherited schema default ("autonomous") no
    // longer renders a per-card badge (FN-7539) — an inherited default is not
    // meaningfully-configured oversight, so it does not appear among the
    // opt-in meta badges here.
    const agentBadge = container.querySelector(".card-agent-created-badge");
    expect(agentBadge).not.toBeNull();
    expect(agentBadge?.closest(".card-agent-badge-row")).not.toBeNull();
    expect(agentBadge?.closest(".card-meta-badges")).toBeNull();
    expect(agentBadge?.closest(".card-header")).toBeNull();

    expect(Array.from(group?.children ?? []).map((child) => child.className)).toEqual([
      "card-priority-badge card-priority-badge--high",
      "card-execution-mode-badge card-execution-mode-badge--fast",
    ]);
  });

  it("renders icon-only urgency-colored priority badges with accessible labels while normal stays hidden", () => {
    for (const priority of TASK_PRIORITIES) {
      const { container, unmount } = render(
        <TaskCard
          task={makeTask({ priority: priority as TaskPriority })}
          onOpenDetail={noop}
          addToast={noop}
        />,
      );

      const badge = container.querySelector(".card-priority-badge");
      if (priority === "normal") {
        expect(badge).toBeNull();
        unmount();
        continue;
      }

      const label = getPriorityLabel(priority);
      expect(badge).not.toBeNull();
      expect(badge).toHaveAttribute("aria-label", label);
      expect(badge).toHaveAttribute("title", label);
      expect(Array.from(badge?.childNodes ?? []).filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())).toEqual([]);
      const visibleLabelSpans = Array.from(badge?.querySelectorAll("span") ?? []).filter((span) => !span.classList.contains("visually-hidden"));
      expect(visibleLabelSpans).toEqual([]);
      expect(badge?.querySelector(".visually-hidden")).toHaveTextContent(label);
      const icon = badge?.querySelector("svg");
      expect(icon).not.toBeNull();
      expect(icon).toHaveAttribute("aria-hidden", "true");
      expect(icon?.getAttribute("style")).toContain(`color: ${getPriorityColorVar(priority)}`);
      unmount();
    }

    const { container } = render(
      <TaskCard
        task={makeTask({ priority: undefined })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    expect(container.querySelector(".card-priority-badge")).toBeNull();
  });

  it("renders partial card meta groups without empty wrappers when time is absent", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "triage",
          priority: "urgent",
          executionMode: "fast",
          sourceType: "automation",
          sourceMetadata: { agentName: "Task Robot" },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const group = container.querySelector(".card-meta-badges");
    expect(group).not.toBeNull();
    expect(group?.querySelector(".card-priority-badge")).not.toBeNull();
    expect(group?.querySelector(".card-execution-mode-badge")).not.toBeNull();
    expect(group?.querySelector(".card-agent-created-badge")).toBeNull();
    expect(container.querySelector(".card-agent-created-badge")?.closest(".card-agent-badge-row")).not.toBeNull();
    expect(group?.querySelector(".card-time-indicator")).toBeNull();
    expect(container.querySelector(".card-footer-row")).toBeNull();
    expect(container.querySelector(".card-footer-row-right")).toBeNull();
  });


  it("moves a lone time chip into the footer without rendering empty meta badges", () => {

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:05:00.000Z"));

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-progress",
          columnMovedAt: "2026-04-25T12:00:00.000Z",
          updatedAt: "2026-04-25T12:00:00.000Z",
          // FNXC:PlannerOversight 2026-07-04-00:00: pin the oversight level "off" so
          // the FN-7516 oversight/overseer-state badges don't populate
          // .card-meta-badges here — this test is specifically about the
          // lone-time-chip footer placement, not the oversight badges.
          plannerOversightLevel: "off",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const group = container.querySelector(".card-meta-badges");
    const timer = container.querySelector(".card-time-indicator");

    const footerRow = container.querySelector(".card-footer-row");
    const rightCluster = container.querySelector(".card-footer-row-right");
    expect(group).toBeNull();
    expect(timer).not.toBeNull();
    expect(footerRow).not.toBeNull();
    expect(rightCluster).not.toBeNull();
    expect(timer?.closest(".card-footer-row-right")).toBe(rightCluster);
    expect(Array.from(rightCluster?.children ?? [])).toEqual([timer]);
    expect(container.querySelector(".card-priority-badge")).toBeNull();
    expect(container.querySelector(".card-execution-mode-badge")).toBeNull();
    expect(container.querySelector(".card-agent-created-badge")).toBeNull();
    expect(container.querySelector(".card-agent-badge-row")).toBeNull();

  });

  it("does not render card meta badge shells when all grouped affordances are absent", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "todo",
          priority: "normal",
          executionMode: "standard",
          sourceType: "dashboard_ui",
          // FNXC:PlannerOversight 2026-07-04-00:00: an unset oversight override now
          // resolves to the schema default ("autonomous") and renders a badge
          // (FN-7516) — pin the level explicitly "off" here so this test keeps
          // asserting the ORIGINAL affordance set (priority/fast-mode/agent-created)
          // is what determines the wrapper's presence.
          plannerOversightLevel: "off",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-meta-badges")).toBeNull();
    expect(container.querySelector(".card-footer-row")).toBeNull();
    expect(container.querySelector(".card-footer-row-right")).toBeNull();
  });

  it("defines responsive flex-wrap styling for grouped card meta badges", () => {
    const fullCss = loadAllAppCss();

    expect(fullCss).toMatch(/\.card-meta-badges\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*gap:\s*var\(--space-xs\);[^}]*\}/);
    expect(fullCss).toMatch(/@media[^{]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.card-meta-badges\s*\{[^}]*gap:\s*calc\(var\(--space-xs\) \/ 2\);[^}]*\}/);
  });

  describe("retry button on failed tasks", () => {
    it("renders when task is failed and onRetryTask is provided", () => {
      const onRetryTask = vi.fn(async () => ({}) as Task);
      render(
        <TaskCard
          task={makeTask({ column: "todo", status: "failed", error: "Executor crashed" })}
          onOpenDetail={noop}
          addToast={noop}
          onRetryTask={onRetryTask}
        />,
      );

      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    });

    it("does not render for non-failed tasks", () => {
      const onRetryTask = vi.fn(async () => ({}) as Task);
      render(
        <TaskCard task={makeTask({ column: "todo", status: "done", error: "Executor crashed" })} onOpenDetail={noop} addToast={noop} onRetryTask={onRetryTask} />,
      );

      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });

    it("does not render card-error banner for auto-recovered transient row", () => {
      const { container } = render(
        <TaskCard
          task={makeTask({
            column: "todo",
            status: undefined,
            error: undefined,
            log: [{ timestamp: new Date().toISOString(), action: "Auto-recovered: retry/verification session targeted unusable worktree" }],
          })}
          onOpenDetail={noop}
          addToast={noop}
        />,
      );

      expect(container.querySelector(".card-error")).toBeNull();
    });

    it("suppresses failed chrome and Retry while a stale failed task has automatic recovery pending", () => {
      const { container } = render(
        <TaskCard
          task={makeTask({
            column: "todo",
            status: "failed",
            error: "Transient provider error",
            recoveryRetryCount: 1,
            nextRecoveryAt: new Date(Date.now() + 60_000).toISOString(),
          })}
          onOpenDetail={noop}
          addToast={noop}
          onRetryTask={vi.fn(async () => ({}) as Task)}
        />,
      );

      expect(container.querySelector(".card-error")).toBeNull();
      expect(container.querySelector(".card.failed")).toBeNull();
      expect(container.querySelector(".card-status-badge.failed")).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });

    it("calls onRetryTask with task id", async () => {
      const onRetryTask = vi.fn(async () => ({}) as Task);
      render(
        <TaskCard task={makeTask({ column: "todo", status: "failed", error: "Executor crashed" })} onOpenDetail={noop} addToast={noop} onRetryTask={onRetryTask} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(onRetryTask).toHaveBeenCalledWith("FN-001"));
    });

    it("shows loading and disabled state while retry is in progress", async () => {
      let resolveRetry: ((value: Task) => void) | null = null;
      const onRetryTask = vi.fn(() => new Promise<Task>((resolve) => { resolveRetry = resolve; }));

      render(
        <TaskCard task={makeTask({ column: "todo", status: "failed", error: "Executor crashed" })} onOpenDetail={noop} addToast={noop} onRetryTask={onRetryTask} />,
      );

      const button = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
      fireEvent.click(button);

      expect(screen.getByRole("button", { name: "Retrying…" })).toBeDefined();
      expect(button.disabled).toBe(true);

      await act(async () => {
        resolveRetry?.({} as Task);
      });

      await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeDefined());
    });

    it("shows toast when retry fails", async () => {
      const addToast = vi.fn();
      const onRetryTask = vi.fn(async () => {
        throw new Error("network down");
      });

      render(
        <TaskCard task={makeTask({ column: "todo", status: "failed", error: "Executor crashed" })} onOpenDetail={noop} addToast={addToast} onRetryTask={onRetryTask} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Failed to retry FN-001: network down", "error");
      });
    });
  });

  it("renders unified progress counts for task steps + workflow checks", () => {
    render(
      <TaskCard
        task={makeTask({
          steps: [
            { name: "Step 0", status: "done" },
            { name: "Step 1", status: "pending" },
          ],
          enabledWorkflowSteps: ["WS-001", "WS-002", "WS-003"],
          workflowStepResults: [
            {
              workflowStepId: "WS-001",
              workflowStepName: "Browser Verification",
              status: "passed",
            },
            {
              workflowStepId: "WS-002",
              workflowStepName: "Frontend UX Design",
              status: "failed",
            },
          ],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("2/5")).toBeDefined();
    expect(screen.getByText("5 steps")).toBeDefined();
  });

  it("surfaces in-progress implementation steps on the collapsed card", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-progress",
          status: "executing" as any,
          steps: [
            { name: "Step 0", status: "done" },
            { name: "Step 1", status: "in-progress" },
            { name: "Step 2", status: "pending" },
          ],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("1/3")).toBeDefined();
    expect(screen.getByText("1 active")).toBeDefined();
    expect(screen.getByText("active")).toBeDefined();
    expect(container.querySelector(".card-step-name.active")?.textContent).toBe("Step 1");
    // FN-7676: the steps breakdown must still render once a task is out of Planning (`in-progress`/`executing`).
    expect(container.querySelector(".card-steps-toggle")).not.toBeNull();
    expect(container.querySelector(".card-progress")).not.toBeNull();
  });

  it("hides the steps breakdown while the task is still in triage, even with a running Plan Review", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "triage",
          status: "planning" as any,
          steps: [],
          enabledWorkflowSteps: ["plan-review", "code-review"],
          workflowStepResults: [
            {
              workflowStepId: "plan-review",
              workflowStepName: "Plan Review",
              status: "pending",
              startedAt: "2026-07-04T00:00:00.000Z",
            },
          ],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-progress")).toBeNull();
    expect(container.querySelector(".card-steps-toggle")).toBeNull();
    expect(container.querySelector(".card-steps-list")).toBeNull();
    expect(screen.queryByText("0/2")).toBeNull();
    expect(screen.queryByText("1 active")).toBeNull();
  });

  it("does not render the steps toggle for a triage card with populated steps", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "triage",
          status: "planning" as any,
          steps: Array.from({ length: 10 }, (_, i) => ({ name: `Step ${i}`, status: "pending" as const })),
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-progress")).toBeNull();
    expect(container.querySelector(".card-steps-toggle")).toBeNull();
    expect(container.querySelector(".card-steps-list")).toBeNull();
    expect(screen.queryByText("0/10")).toBeNull();
    expect(screen.queryByText("10 steps")).toBeNull();
  });

  it("does not show a false triage active indicator for enabled-but-not-started Plan Review", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "triage",
          status: "planning" as any,
          steps: [],
          enabledWorkflowSteps: ["plan-review", "code-review"],
          workflowStepResults: [],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.queryByText("1 active")).toBeNull();
    expect(container.querySelector(".card-progress")).toBeNull();
    expect(container.querySelector(".card-steps-toggle")).toBeNull();
  });

  it("does not render an empty triage progress shell without workflow progress", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "triage",
          status: undefined as any,
          steps: [],
          enabledWorkflowSteps: undefined,
          workflowStepResults: undefined,
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-progress")).toBeNull();
    expect(container.querySelector(".card-steps-toggle")).toBeNull();
  });

  it("uses singular step label when unified progress total is one", () => {
    render(
      <TaskCard
        task={makeTask({
          steps: [{ name: "Step 0", status: "done" }],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("1 step")).toBeDefined();
    expect(screen.queryByText("1 steps")).toBeNull();
  });

  // FNXC:WorkflowSteps 2026-06-25-00:00 — graph-written results drive the card progress; names come from
  // result.workflowStepName (with raw-id fallback), and advisory_failure (amber) is visually distinct
  // from failed (red). No board-level name lookup is involved.
  // FNXC:WorkflowSteps 2026-06-30-12:00 — expanded task-card rows deliberately omit the redundant workflow text badge; tests preserve mixed implementation/workflow visibility through names, status dots, and the active badge instead.
  it("renders workflow checks after normal steps with graph-written statuses and no workflow text badges", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          steps: [
            { name: "Step 0", status: "done" },
            { name: "Step 1", status: "failed" as any },
          ],
          enabledWorkflowSteps: ["WS-001", "WS-002", "WS-003", "WS-004", "WS-005"],
          workflowStepResults: [
            {
              workflowStepId: "WS-001",
              workflowStepName: "Browser Verification",
              status: "passed",
            },
            {
              workflowStepId: "WS-002",
              workflowStepName: "Frontend UX Design",
              status: "advisory_failure",
              phase: "post-merge",
            },
            {
              workflowStepId: "WS-004",
              workflowStepName: "Code Review Gate",
              status: "failed",
            },
            {
              workflowStepId: "WS-005",
              workflowStepName: "Merge Validation",
              status: "pending",
              startedAt: "2026-06-25T00:00:00.000Z",
            },
          ],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const stepNames = Array.from(container.querySelectorAll(".card-step-name")).map((el) => el.textContent);
    // WS-003 has no result → name falls back to the display-normalized id; all others resolve from result.workflowStepName.
    expect(stepNames).toEqual([
      "Step 0",
      "Step 1",
      "Browser Verification",
      "Frontend UX Design",
      "WS 003",
      "Code Review Gate",
      "Merge Validation",
    ]);

    const dots = container.querySelectorAll(".card-step-dot");
    // Impl step failure → blocking red.
    expect(dots[1]?.className).toContain("card-step-dot--failed");
    expect(dots[1]?.className).not.toContain("card-step-dot--advisory_failure");

    // Passed workflow step → done.
    expect(dots[2]?.className).toContain("card-step-dot--done");

    // advisory_failure → amber, NOT the blocking red failed class.
    expect(dots[3]?.className).toContain("card-step-dot--advisory_failure");
    expect(dots[3]?.className).not.toContain("card-step-dot--failed");

    // Enabled-but-not-run → pending.
    expect(dots[4]?.className).toContain("card-step-dot--pending");

    // Gate failure → blocking red, NOT amber advisory.
    expect(dots[5]?.className).toContain("card-step-dot--failed");
    expect(dots[5]?.className).not.toContain("card-step-dot--advisory_failure");

    // Started-but-not-finished workflow step → running with the same active badge as implementation steps.
    expect(dots[6]?.className).toContain("card-step-dot--running");
    expect(dots[6]?.className).not.toContain("card-step-dot--pending");
    expect(container.querySelector(".card-step-active-badge")?.textContent).toBe("active");

    const workflowBadgeElements = container.querySelectorAll(".card-step-workflow-badge");
    expect(workflowBadgeElements).toHaveLength(0);
    expect(container.querySelector('[title="Workflow check"]')).toBeNull();
    expect(Array.from(container.querySelectorAll(".card-step-item")).some((item) => item.textContent === "workflow")).toBe(false);
  });

  it("renders the running state for a started-but-not-completed workflow step", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          enabledWorkflowSteps: ["WS-001"],
          workflowStepResults: [
            {
              workflowStepId: "WS-001",
              workflowStepName: "Browser Verification",
              status: "pending",
              startedAt: "2026-06-25T00:00:00.000Z",
            },
          ],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const dots = container.querySelectorAll(".card-step-dot");
    expect(dots[0]?.className).toContain("card-step-dot--running");
    expect(dots[0]?.className).not.toContain("card-step-dot--pending");
  });

  it("falls back to the raw workflow step ID when the result name is blank", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          enabledWorkflowSteps: ["WS-002", "WS-003"],
          workflowStepResults: [
            {
              workflowStepId: "WS-002",
              workflowStepName: "   ",
              status: "passed",
            },
          ],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const stepNames = Array.from(container.querySelectorAll(".card-step-name")).map((el) => el.textContent);
    // Blank result name → display-normalized id; WS-003 (no result) → display-normalized id.
    expect(stepNames).toEqual(["WS 002", "WS 003"]);
  });

  it("shows drop indicator on file dragover and removes on dragleave", () => {
    const { container } = render(
      <TaskCard task={makeTask()} onOpenDetail={noop} addToast={noop} />,
    );
    const card = container.querySelector(".card")!;

    // Simulate file dragover
    fireEvent.dragOver(card, {
      dataTransfer: { types: ["Files"], dropEffect: "none" },
    });
    expect(card.classList.contains("file-drop-target")).toBe(true);

    // Simulate dragleave
    fireEvent.dragLeave(card, {
      dataTransfer: { types: ["Files"] },
    });
    expect(card.classList.contains("file-drop-target")).toBe(false);
  });

  it("does not show drop indicator for non-file drag", () => {
    const { container } = render(
      <TaskCard task={makeTask()} onOpenDetail={noop} addToast={noop} />,
    );
    const card = container.querySelector(".card")!;

    // Simulate card dragover (not files)
    fireEvent.dragOver(card, {
      dataTransfer: { types: ["text/plain"], dropEffect: "none" },
    });
    expect(card.classList.contains("file-drop-target")).toBe(false);
  });

  it("calls uploadAttachment on file drop", async () => {
    const mockUpload = vi.mocked(uploadAttachment);
    mockUpload.mockResolvedValue({
      filename: "abc-test.png",
      originalName: "test.png",
      mimeType: "image/png",
      size: 1024,
      createdAt: new Date().toISOString(),
    });
    const addToast = vi.fn();

    const { container } = render(
      <TaskCard task={makeTask()} onOpenDetail={noop} addToast={addToast} />,
    );
    const card = container.querySelector(".card")!;

    const file = new File(["content"], "test.png", { type: "image/png" });
    fireEvent.drop(card, {
      dataTransfer: { types: ["Files"], files: [file] },
    });

    await waitFor(() => {
      expect(mockUpload).toHaveBeenCalledWith("FN-001", file, undefined);
      expect(addToast).toHaveBeenCalledWith(
        expect.stringContaining("Attached test.png"),
        "success",
      );
    });
  });

  it("shows in-review files-changed chip from modifiedFiles fallback when no worktree diff is available", () => {
    const onOpenDetailWithTab = vi.fn();
    const task = makeTask({
      column: "in-review",
      worktree: undefined,
      modifiedFiles: ["packages/dashboard/app/App.tsx", "packages/dashboard/app/styles.css"],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={noop}
        addToast={noop}
        onOpenDetailWithTab={onOpenDetailWithTab}
      />,
    );

    const filesChangedButton = screen.getByRole("button", { name: "2 files changed" });
    expect(filesChangedButton).toBeDefined();
    expect((filesChangedButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(filesChangedButton);
    expect(onOpenDetailWithTab).toHaveBeenCalledWith(task, "changes");
  });

  it("shows in-progress files-changed chip from modifiedFiles fallback when no live diff is available", () => {
    const onOpenDetailWithTab = vi.fn();
    const task = makeTask({
      column: "in-progress",
      worktree: undefined,
      modifiedFiles: ["packages/core/src/store.ts", "packages/core/src/types.ts"],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={noop}
        addToast={noop}
        onOpenDetailWithTab={onOpenDetailWithTab}
      />,
    );

    const filesChangedButton = screen.getByRole("button", { name: "2 files changed" });
    expect(filesChangedButton).toBeDefined();
    expect((filesChangedButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(filesChangedButton);
    expect(onOpenDetailWithTab).toHaveBeenCalledWith(task, "changes");
  });

  it("shows error toast when upload fails", async () => {
    const mockUpload = vi.mocked(uploadAttachment);
    mockUpload.mockRejectedValue(new Error("Upload failed"));
    const addToast = vi.fn();

    const { container } = render(
      <TaskCard task={makeTask()} onOpenDetail={noop} addToast={addToast} />,
    );
    const card = container.querySelector(".card")!;

    const file = new File(["content"], "bad.png", { type: "image/png" });
    fireEvent.drop(card, {
      dataTransfer: { types: ["Files"], files: [file] },
    });

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(
        expect.stringContaining("Failed to attach bad.png"),
        "error",
      );
    });
  });

  // Size badge positioning regression tests (KB-197)
  it("renders size badge for sized tasks", () => {
    const { container } = render(
      <TaskCard task={makeTask({ size: "S" })} onOpenDetail={noop} addToast={noop} />,
    );
    expect(container.querySelector(".card-size-badge")).not.toBeNull();
    expect(screen.getByText("S")).toBeDefined();
  });

  it("does not render size badge when task has no size", () => {
    const { container } = render(
      <TaskCard task={makeTask({ size: undefined })} onOpenDetail={noop} addToast={noop} />,
    );
    expect(container.querySelector(".card-size-badge")).toBeNull();
  });

  it("renders all three size values with correct CSS classes", () => {
    const sizes: Array<"S" | "M" | "L"> = ["S", "M", "L"];
    const expectedClasses = ["size-s", "size-m", "size-l"];

    sizes.forEach((size, index) => {
      const { container } = render(
        <TaskCard task={makeTask({ size })} onOpenDetail={noop} addToast={noop} />,
      );
      const header = container.querySelector(".card-header");
      const cardId = container.querySelector(".card-id");
      const badge = container.querySelector(".card-size-badge");
      expect(badge).not.toBeNull();
      expect(badge?.classList.contains(expectedClasses[index])).toBe(true);
      expect(container.querySelectorAll(".card-size-badge")).toHaveLength(1);
      expect(badge?.parentElement).toBe(header);
      expect(cardId?.nextElementSibling).toBe(badge);
      // Clean up for next iteration
      container.remove();
    });
  });

  it("places size badge directly after the task id outside header badge and action groups", () => {
    const { container } = render(
      <TaskCard task={makeTask({ size: "M" })} onOpenDetail={noop} addToast={noop} />,
    );
    const header = container.querySelector(".card-header");
    const cardId = container.querySelector(".card-id");
    const headerBadges = container.querySelector(".card-header-badges");
    const actionsContainer = container.querySelector(".card-header-actions");
    const sizeBadge = container.querySelector(".card-size-badge");

    expect(header).not.toBeNull();
    expect(sizeBadge).not.toBeNull();
    expect(sizeBadge?.parentElement).toBe(header);
    expect(cardId?.nextElementSibling).toBe(sizeBadge);
    expect(actionsContainer?.contains(sizeBadge)).toBe(false);
    expect(headerBadges?.contains(sizeBadge) ?? false).toBe(false);
    expect(sizeBadge?.closest(".card-header-badges")).toBeNull();
  });

  it("keeps trailing controls in header actions after the id-adjacent size badge", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ column: "in-progress", status: "executing" as any, size: "M" })}
        onOpenDetail={noop}
        addToast={noop}
        onPauseTask={async () => makeTask({ paused: true })}
      />,
    );
    const header = container.querySelector(".card-header");
    const cardId = container.querySelector(".card-id");
    const headerBadges = container.querySelector(".card-header-badges");
    const actionsContainer = container.querySelector(".card-header-actions") as HTMLElement | null;
    const menuButton = container.querySelector(".card-menu-btn");
    const sizeBadge = container.querySelector(".card-size-badge");

    expect(actionsContainer).not.toBeNull();
    expect(menuButton).not.toBeNull();
    expect(sizeBadge).not.toBeNull();
    expect(sizeBadge?.parentElement).toBe(header);
    expect(cardId?.nextElementSibling).toBe(sizeBadge);
    expect(sizeBadge?.compareDocumentPosition(headerBadges!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(actionsContainer?.contains(menuButton)).toBe(true);
    expect(actionsContainer?.contains(sizeBadge)).toBe(false);
  });

  it("places card-header-actions as a direct header child after the wrapped badge group", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ size: "S", priority: "urgent" as Task["priority"], executionMode: "fast" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    const header = container.querySelector(".card-header")!;
    const cardId = container.querySelector(".card-id")!;
    const headerBadges = container.querySelector(".card-header-badges")!;
    const actionsContainer = container.querySelector(".card-header-actions")!;

    expect(cardId).not.toBeNull();
    expect(headerBadges).not.toBeNull();
    expect(actionsContainer).not.toBeNull();
    expect(actionsContainer.parentElement).toBe(header);
    expect(headerBadges.parentElement).toBe(header);
    expect(
      cardId.compareDocumentPosition(headerBadges) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      headerBadges.compareDocumentPosition(actionsContainer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("renders edit button inside card-header-actions for editable columns", () => {
    const { container } = render(
      <TaskCard 
        task={makeTask({ column: "todo", size: "S" })} 
        onOpenDetail={noop} 
        addToast={noop}
        onUpdateTask={async () => makeTask()}
      />,
    );
    const actionsContainer = container.querySelector(".card-header-actions");
    const editBtn = container.querySelector(".card-edit-btn");
    
    expect(actionsContainer).not.toBeNull();
    expect(editBtn).not.toBeNull();
    expect(actionsContainer?.contains(editBtn)).toBe(true);
  });

  it("renders the done-card three-dot menu inside card-header-actions", () => {
    const { container } = render(
      <TaskCard 
        task={makeTask({ column: "done", size: "L" })} 
        onOpenDetail={noop} 
        addToast={noop}
        onArchiveTask={async () => makeTask()}
      />,
    );
    const actionsContainer = container.querySelector(".card-header-actions");
    const menuButton = screen.getByTestId("card-menu-btn-FN-001");
    
    expect(actionsContainer).not.toBeNull();
    expect(container.querySelector(".card-archive-btn")).toBeNull();
    expect(container.querySelector(".card-done-actions")).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    expect(actionsContainer?.contains(menuButton)).toBe(true);
  });

  it.each([
    { name: "meta-row overlap badge", task: makeTask({ column: "in-review", overlapBlockedBy: "FN-OVER", blockedBy: undefined }), queued: false },
    { name: "meta-row queued badge", task: makeTask({ column: "in-review", status: "queued" as any, dependencies: [], blockedBy: undefined, overlapBlockedBy: undefined }), queued: true },
    { name: "no-meta action-row placement", task: makeTask({ column: "in-review", dependencies: [], blockedBy: undefined, overlapBlockedBy: undefined, status: undefined as any }), queued: false },
  ])("uses the three-dot menu as the only in-review move entry point for $name", ({ task, queued }) => {
    const onMoveTask = vi.fn();
    const { container } = render(
      <TaskCard
        task={task}
        queued={queued}
        onOpenDetail={noop}
        addToast={noop}
        onMoveTask={onMoveTask}
      />,
    );

    expect(container.querySelector(".card-send-back")).toBeNull();
    expect(screen.queryByRole("button", { name: "Move task" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send back" })).toBeNull();

    fireEvent.click(screen.getByTestId("card-menu-btn-FN-001"));

    expect(screen.getByRole("menuitem", { name: "Done (no merge)" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Move to Planning" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Move to Todo" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Back to In Progress" })).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "Done (no merge)" }));

    expect(onMoveTask).toHaveBeenCalledWith("FN-001", "done", undefined);
  });

  it("uses the three-dot menu for every in-progress move target without a Send back shell", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ column: "in-progress" })}
        onOpenDetail={noop}
        addToast={noop}
        onMoveTask={vi.fn()}
      />,
    );

    expect(container.querySelector(".card-send-back")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send back" })).toBeNull();

    fireEvent.click(screen.getByTestId("card-menu-btn-FN-001"));

    expect(screen.getByRole("menuitem", { name: "Move to Todo" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Move to Planning" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Move to Done" })).toBeTruthy();
  });

  it("does not render a move shell when onMoveTask is absent", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ column: "in-review" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-send-back")).toBeNull();
    expect(screen.queryByRole("button", { name: "Move task" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send back" })).toBeNull();
  });

  it("shows timer chip for in-progress cards summing workflow runtime + timed events", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-progress",
          workflowStepResults: [
            {
              workflowStepId: "step-1",
              workflowStepName: "Plan",
              phase: "pre-merge" as const,
              status: "passed" as const,
              startedAt: "2026-04-25T12:00:00.000Z",
              completedAt: "2026-04-25T12:08:00.000Z",
            },
          ],
          log: [
            {
              timestamp: "2026-04-25T12:09:00.000Z",
              action: "[timing] llm_call in 240000ms",
              outcome: "",
            } as unknown as Task["log"][number],
          ],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const timer = container.querySelector(".card-time-indicator");
    expectTimerInFooterRight(container);
    // 8m workflow + 4m timed = 12m
    expect(timer?.textContent).toContain("12m");
    expect(timer?.getAttribute("title")).toContain("In progress 12m");
  });

  it("updates the in-progress timer when timedExecutionMs changes", () => {
    const { container, rerender } = render(
      <TaskCard
        task={makeTask({
          column: "in-progress",
          timedExecutionMs: 60_000,
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-time-indicator")?.textContent).toContain("1m");
    expectTimerInFooterRight(container);

    rerender(
      <TaskCard
        task={makeTask({
          column: "in-progress",
          timedExecutionMs: 120_000,
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-time-indicator")?.textContent).toContain("2m");
    expectTimerInFooterRight(container);
  });

  it("shows timer chip for done cards summing workflow runtime + timed events", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "done",
          columnMovedAt: "2026-04-25T15:00:00.000Z",
          updatedAt: "2026-04-25T15:00:00.000Z",
          createdAt: "2026-04-25T13:00:00.000Z",
          workflowStepResults: [
            {
              workflowStepId: "step-1",
              workflowStepName: "Plan",
              phase: "pre-merge" as const,
              status: "passed" as const,
              startedAt: "2026-04-25T13:00:00.000Z",
              completedAt: "2026-04-25T14:00:00.000Z",
            },
          ],
          log: [
            {
              timestamp: "2026-04-25T14:30:00.000Z",
              action: "[timing] llm_call in 3600000ms",
              outcome: "",
            } as unknown as Task["log"][number],
          ],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const timer = container.querySelector(".card-time-indicator");
    expectTimerInFooterRight(container);
    // 1h workflow + 1h timed = 2h
    expect(timer?.textContent).toContain("2h");
    expect(timer?.getAttribute("title")).toContain("Execution time 2h");
    expect(timer?.getAttribute("title")).toContain("Completed");
  });

  it("renders GitHub provenance marker for github_import tasks", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "github_import",
          sourceMetadata: { issueUrl: "https://github.com/owner/repo/issues/42" },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const footerRow = container.querySelector(".card-footer-row");
    const provenance = container.querySelector(".card-source-provenance");

    expect(footerRow).not.toBeNull();
    expect(provenance).not.toBeNull();
    expect(provenance?.getAttribute("title")).toContain("https://github.com/owner/repo/issues/42");
    expect(screen.getByTestId("provider-icon-github")).toBeDefined();
  });

  it("does not render GitHub provenance marker for non-imported tasks", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "dashboard_ui",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-source-provenance")).toBeNull();
    expect(screen.queryByTestId("provider-icon-github")).toBeNull();
  });

  it("renders a GitHub tracking link for tracked issues on non-imported tasks", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "dashboard_ui",
          githubTracking: {
            issue: {
              owner: "owner",
              repo: "repo",
              number: 42,
              url: "https://github.com/owner/repo/issues/42",
              createdAt: "2026-05-12T00:00:00.000Z",
            },
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const link = screen.getByRole("link", { name: "Linked GitHub issue #42" });
    const bottomRightRow = container.querySelector(".card-bottom-right-row");
    const footerRow = container.querySelector(".card-footer-row");
    expect(link.getAttribute("href")).toBe("https://github.com/owner/repo/issues/42");
    expect(link.getAttribute("title")).toBe("Linked GitHub issue: owner/repo#42");
    expect(link).toHaveClass("card-github-tracking-chip", "card-github-tracking-link");
    expect(link).toHaveTextContent("#42");
    expect(footerRow).not.toBeNull();
    expect(footerRow?.contains(link)).toBe(true);
    expect(bottomRightRow).toBeNull();
    expect(screen.getByTestId("provider-icon-github")).toBeDefined();
  });

  it("renders the GitHub tracking link inline with queued metadata when the footer has no leading content", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "todo",
          status: "queued",
          sourceType: "dashboard_ui",
          githubTracking: {
            issue: {
              owner: "owner",
              repo: "repo",
              number: 42,
              url: "https://github.com/owner/repo/issues/42",
              createdAt: "2026-05-12T00:00:00.000Z",
            },
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const link = screen.getByRole("link", { name: "Linked GitHub issue #42" });
    const metaRow = container.querySelector(".card-meta");
    const queuedBadge = container.querySelector(".queued-badge");
    expect(container.querySelector(".card-footer-row")).toBeNull();
    expect(link.closest(".card-meta")).toBe(metaRow);
    expect(link.closest(".card-footer-row-right")?.closest(".card-meta")).toBe(metaRow);
    expect(container.querySelector(".card-bottom-right-row")).toBeNull();
    expect(queuedBadge).not.toBeNull();
    expect(queuedBadge?.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });


  it("renders tracking, retry, and timer in the footer right cluster", () => {

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          sourceType: "dashboard_ui",
          retrySummary: { total: 3 } as any,
          githubTracking: {
            issue: {
              owner: "owner",
              repo: "repo",
              number: 42,
              url: "https://github.com/owner/repo/issues/42",
              createdAt: "2026-05-12T00:00:00.000Z",
            },
          },
          executionStartedAt: "2026-04-25T12:00:00.000Z",
          updatedAt: "2026-04-25T12:12:00.000Z",
          // FNXC:PlannerOversight 2026-07-04-00:00: pin the oversight level "off" so
          // the FN-7516 oversight/overseer-state badges don't populate
          // .card-meta-badges here — this test is specifically about the footer
          // right-cluster grouping, not the oversight badges.
          plannerOversightLevel: "off",
        })}
        onOpenDetail={noop}
        addToast={noop}
        onOpenDetailWithTab={vi.fn()}
      />,
    );

    const footerRow = container.querySelector(".card-footer-row");
    const metaBadges = container.querySelector(".card-meta-badges");

    const rightCluster = container.querySelector(".card-footer-row-right");

    const trackingLink = container.querySelector(".card-github-tracking-chip");
    const retryChip = container.querySelector(".card-retry-badge");
    const timerChip = container.querySelector(".card-time-indicator");

    expect(footerRow).not.toBeNull();

    expect(metaBadges).toBeNull();
    expect(rightCluster).not.toBeNull();
    expect(footerRow?.contains(trackingLink)).toBe(true);
    expect(footerRow?.contains(retryChip)).toBe(true);
    expect(footerRow?.contains(timerChip)).toBe(true);
    expect(rightCluster?.contains(timerChip)).toBe(true);
    expect(Array.from(rightCluster?.children ?? [])).toContain(timerChip);

    expect(container.querySelector(".card-bottom-right-row")).toBeNull();
  });

  it("keeps the GitHub tracking link keyboard focusable", () => {
    render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "dashboard_ui",
          githubTracking: {
            issue: {
              owner: "owner",
              repo: "repo",
              number: 42,
              url: "https://github.com/owner/repo/issues/42",
              createdAt: "2026-05-12T00:00:00.000Z",
            },
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const link = screen.getByRole("link", { name: "Linked GitHub issue #42" });
    expect(link.tabIndex).not.toBe(-1);
    link.focus();
    expect(document.activeElement).toBe(link);
  });

  it("renders safe external-link attributes for the GitHub tracking link", () => {
    render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "dashboard_ui",
          githubTracking: {
            issue: {
              owner: "owner",
              repo: "repo",
              number: 42,
              url: "https://github.com/owner/repo/issues/42",
              createdAt: "2026-05-12T00:00:00.000Z",
            },
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const link = screen.getByRole("link", { name: "Linked GitHub issue #42" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("keeps GitHub tracking chip interaction-affordance CSS contract", () => {
    const css = loadAllAppCssBaseOnly();

    expect(css).toMatch(/\.card-time-indicator\s*,\s*\.card-cost-indicator\s*,\s*\.card-github-tracking-chip\s*,\s*\.card-retry-badge\s*,\s*\.card-create-pr-action\s*\{[^}]*display:\s*inline-flex;[^}]*font-family:\s*var\(--font-mono\);[^}]*\}/);
    expect(css).toContain(".card-github-tracking-chip:hover");
    expect(css).toMatch(/\.card-github-tracking-chip:focus-visible\s*\{[^}]*--focus-ring-strong/);
    expect(css).toMatch(/\.card-time-indicator\s*,\s*\.card-cost-indicator\s*,\s*\.card-github-tracking-chip\s*,\s*\.card-retry-badge\s*,\s*\.card-create-pr-action\s*\{[^}]*padding:\s*var\(--space-xs\)\s+var\(--space-sm\);[^}]*height:\s*var\(--card-chip-height\);[^}]*border-radius:\s*var\(--radius-pill\);[^}]*font-size:\s*0\.6875rem;[^}]*line-height:\s*1;[^}]*\}/);
    expect(css).toMatch(/\.card-github-tracking-chip\s+\.provider-icon\s+svg\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px;[^}]*\}/);

    render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "dashboard_ui",
          githubTracking: {
            issue: {
              owner: "owner",
              repo: "repo",
              number: 42,
              url: "https://github.com/owner/repo/issues/42",
              createdAt: "2026-05-12T00:00:00.000Z",
            },
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const link = screen.getByRole("link", { name: "Linked GitHub issue #42" });
    const chipStyle = getComputedStyle(link);
    expect(chipStyle.display).toBe("inline-flex");
    expect(chipStyle.whiteSpace).toBe("nowrap");
  });

  it("FN-4287: keeps GitHub provenance indicators grouped on the right edge", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "github_import",
          sourceMetadata: { issueUrl: "https://github.com/owner/repo/issues/42" },
          githubTracking: {
            issue: {
              owner: "other",
              repo: "tracking",
              number: 99,
              url: "https://github.com/other/tracking/issues/99",
              createdAt: "2026-05-12T00:00:00.000Z",
            },
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const footerRow = container.querySelector(".card-footer-row");
    const footerProvenance = container.querySelectorAll(".card-footer-row .card-source-provenance");
    const trackingLink = container.querySelector(".card-github-tracking-link");

    expect(footerRow).not.toBeNull();
    expect(footerProvenance).toHaveLength(1);
    expect(trackingLink).not.toBeNull();

    const css = loadAllAppCssBaseOnly();
    expect(css).toMatch(/\.card-footer-row-right\s*\{[^}]*margin-left:\s*auto;[^}]*\}/);
    const provenanceRule = css.match(/\.card-source-provenance\s*\{[^}]*\}/)?.[0] ?? "";
    expect(provenanceRule).not.toMatch(/margin-left\s*:\s*auto/);
  });

  describe("FN-4607 TaskCard GitHub badge right-alignment", () => {
    it("keeps source provenance and tracking chip grouped in footer order", () => {
      const { container } = render(
        <TaskCard
          task={makeTask({
            column: "todo",
            sourceType: "github_import",
            sourceMetadata: { issueUrl: "https://github.com/owner/repo/issues/42" },
            githubTracking: {
              issue: {
                owner: "other",
                repo: "tracking",
                number: 99,
                url: "https://github.com/other/tracking/issues/99",
                createdAt: "2026-05-12T00:00:00.000Z",
              },
            },
          })}
          onOpenDetail={noop}
          addToast={noop}
        />,
      );

      const footerRow = container.querySelector(".card-footer-row");
      const sourceBadge = container.querySelector(".card-footer-row > .card-source-provenance");
      const trackingChip = container.querySelector(".card-footer-row-right > .card-github-tracking-chip");
      expect(footerRow).not.toBeNull();
      expect(sourceBadge).not.toBeNull();
      expect(trackingChip).not.toBeNull();
      const rightCluster = container.querySelector(".card-footer-row > .card-footer-row-right");
      expect(rightCluster).not.toBeNull();
      expect((sourceBadge as Element).nextElementSibling).toBe(rightCluster);

      const css = loadAllAppCssBaseOnly();
      expect(css).toMatch(/\.card-footer-row-right\s*\{[^}]*margin-left:\s*auto;[^}]*\}/);
    });

    it("applies right-alignment rule when only tracking chip is rendered", () => {
      const css = loadAllAppCssBaseOnly();
      expect(css).toMatch(/\.card-footer-row-right\s*\{[^}]*margin-left:\s*auto;[^}]*\}/);

      const { container } = render(
        <TaskCard
          task={makeTask({
            column: "todo",
            sourceType: "dashboard_ui",
            githubTracking: {
              issue: {
                owner: "owner",
                repo: "repo",
                number: 42,
                url: "https://github.com/owner/repo/issues/42",
                createdAt: "2026-05-12T00:00:00.000Z",
              },
            },
          })}
          onOpenDetail={noop}
          addToast={noop}
        />,
      );

      const footerRow = container.querySelector(".card-footer-row");
      const trackingChip = container.querySelector(".card-footer-row-right > .card-github-tracking-chip");
      expect(footerRow).not.toBeNull();
      expect(trackingChip).not.toBeNull();
      expect(container.querySelector(".card-footer-row > .card-source-provenance")).toBeNull();
    });


    it("keeps github badges before retry while time chip ends the footer cluster", () => {

      const { container } = render(
        <TaskCard
          task={makeTask({
            column: "in-review",
            sourceType: "github_import",
            sourceMetadata: { issueUrl: "https://github.com/owner/repo/issues/42" },
            retrySummary: { total: 3 } as any,
            githubTracking: {
              issue: {
                owner: "other",
                repo: "tracking",
                number: 99,
                url: "https://github.com/other/tracking/issues/99",
                createdAt: "2026-05-12T00:00:00.000Z",
              },
            },
            executionStartedAt: "2026-04-25T12:00:00.000Z",
            updatedAt: "2026-04-25T12:12:00.000Z",
          })}
          onOpenDetail={noop}
          addToast={noop}
          onOpenDetailWithTab={vi.fn()}
        />,
      );

      const footerRow = container.querySelector(".card-footer-row");
      expect(footerRow).not.toBeNull();

      const sourceNode = footerRow?.querySelector(".card-source-provenance");
      const rightCluster = footerRow?.querySelector(".card-footer-row-right");
      const timerChip = container.querySelector(".card-time-indicator");
      expect(sourceNode).not.toBeNull();
      expect(rightCluster).not.toBeNull();

      expect(timerChip?.closest(".card-footer-row-right")).toBe(rightCluster);
      const orderedNodes = [
        rightCluster?.querySelector(".card-github-tracking-chip"),
        rightCluster?.querySelector(".card-retry-badge"),
        timerChip,

      ];
      orderedNodes.forEach((node) => expect(node).not.toBeNull());
      expect(Array.from((rightCluster as Element).children)).toEqual(orderedNodes);
    });
  });

  describe("FN-4634 in-progress GitHub linked badge far-right placement", () => {
    const trackedIssue = {
      owner: "owner",
      repo: "repo",
      number: 42,
      url: "https://github.com/owner/repo/issues/42",
      createdAt: "2026-05-12T00:00:00.000Z",
    };

    it.each([
      {
        name: "retry summary present",
        taskPatch: { retrySummary: { total: 2 } as any },
        expectedLeftChipSelector: ".card-retry-badge",
      },
      {
        name: "time indicator present",
        taskPatch: {
          executionStartedAt: "2026-04-25T12:00:00.000Z",
          updatedAt: "2026-04-25T12:12:00.000Z",
        },
        expectedLeftChipSelector: ".card-time-indicator",
      },
    ])("keeps right-side chips after tracking on in-progress when files changed is absent: $name", ({ taskPatch, expectedLeftChipSelector }) => {
      const { container } = render(
        <TaskCard
          task={makeTask({
            column: "in-progress",
            sourceType: "dashboard_ui",
            modifiedFiles: [],
            githubTracking: { issue: trackedIssue },
            ...taskPatch,
          })}
          onOpenDetail={noop}
          addToast={noop}
          onOpenDetailWithTab={vi.fn()}
        />,
      );

      const footerRow = container.querySelector(".card-footer-row") as HTMLElement | null;
      const trackingChip = container.querySelector(".card-github-tracking-chip") as HTMLElement | null;
      const rightSideChip = container.querySelector(expectedLeftChipSelector) as HTMLElement | null;
      expect(footerRow).not.toBeNull();
      expect(footerRow).toHaveClass("card-footer-row--chip-far-right");
      expect(trackingChip).not.toBeNull();
      expect(rightSideChip).not.toBeNull();
      const rightCluster = container.querySelector(".card-footer-row-right") as HTMLElement | null;
      expect(rightCluster).not.toBeNull();
      const children = Array.from((rightCluster as HTMLElement).children);

      expect(children).toContain(trackingChip as HTMLElement);
      expect(children).toContain(rightSideChip as HTMLElement);
      expect(children.indexOf(rightSideChip as HTMLElement)).toBeGreaterThan(children.indexOf(trackingChip as HTMLElement));
      expect(getComputedStyle(rightCluster as HTMLElement).marginLeft).toBe("auto");
    });

    it.each(["in-progress", "in-review"] as const)("renders time indicator in footer right cluster beside tracking chip for %s", (column) => {

      const { container } = render(
        <TaskCard
          task={makeTask({
            column,
            sourceType: "dashboard_ui",
            modifiedFiles: [],
            githubTracking: { issue: trackedIssue },
            executionStartedAt: "2026-04-25T12:00:00.000Z",
            updatedAt: "2026-04-25T12:12:00.000Z",
          })}
          onOpenDetail={noop}
          addToast={noop}
          onOpenDetailWithTab={vi.fn()}
        />,
      );

      const footerRow = container.querySelector(".card-footer-row") as HTMLElement | null;
      const trackingChip = container.querySelector(".card-github-tracking-chip") as HTMLElement | null;
      const timeChip = container.querySelector(".card-time-indicator") as HTMLElement | null;
      expect(footerRow).not.toBeNull();
      expect(trackingChip).not.toBeNull();
      expect(timeChip).not.toBeNull();
      const rightCluster = container.querySelector(".card-footer-row-right") as HTMLElement | null;
      expect(rightCluster).not.toBeNull();
      const children = Array.from((rightCluster as HTMLElement).children);
      expect(children).toContain(trackingChip);

      expect(children).toContain(timeChip);
      expect(timeChip?.closest(".card-footer-row-right")).toBe(rightCluster);

    });

    it("does not force far-right modifier when in-progress card has files changed", () => {
      const { container } = render(
        <TaskCard
          task={makeTask({
            column: "in-progress",
            sourceType: "dashboard_ui",
            modifiedFiles: ["src/file.ts"],
            githubTracking: { issue: trackedIssue },
            retrySummary: { total: 2 } as any,
          })}
          onOpenDetail={noop}
          addToast={noop}
          onOpenDetailWithTab={vi.fn()}
        />,
      );

      const footerRow = container.querySelector(".card-footer-row");
      expect(footerRow).not.toBeNull();
      expect(footerRow).not.toHaveClass("card-footer-row--chip-far-right");
    });

    it.each([
      {
        name: "retry summary present",
        taskPatch: { retrySummary: { total: 2 } as any },
        expectedLeftChipSelector: ".card-retry-badge",
      },
      {
        name: "time indicator present",
        taskPatch: {
          executionStartedAt: "2026-04-25T12:00:00.000Z",
          updatedAt: "2026-04-25T12:12:00.000Z",
        },
        expectedLeftChipSelector: ".card-time-indicator",
      },
    ])("keeps right-side chips after tracking on in-review when files changed is absent: $name", ({ taskPatch, expectedLeftChipSelector }) => {
      const { container } = render(
        <TaskCard
          task={makeTask({
            column: "in-review",
            sourceType: "dashboard_ui",
            modifiedFiles: [],
            githubTracking: { issue: trackedIssue },
            ...taskPatch,
          })}
          onOpenDetail={noop}
          addToast={noop}
          onOpenDetailWithTab={vi.fn()}
        />,
      );

      const footerRow = container.querySelector(".card-footer-row") as HTMLElement | null;
      const trackingChip = container.querySelector(".card-github-tracking-chip") as HTMLElement | null;
      const rightSideChip = container.querySelector(expectedLeftChipSelector) as HTMLElement | null;
      expect(footerRow).not.toBeNull();
      expect(footerRow).toHaveClass("card-footer-row--chip-far-right");
      expect(trackingChip).not.toBeNull();
      expect(rightSideChip).not.toBeNull();
      const rightCluster = container.querySelector(".card-footer-row-right") as HTMLElement | null;
      expect(rightCluster).not.toBeNull();
      const children = Array.from((rightCluster as HTMLElement).children);

      expect(children).toContain(trackingChip as HTMLElement);
      expect(children).toContain(rightSideChip as HTMLElement);
      expect(children.indexOf(rightSideChip as HTMLElement)).toBeGreaterThan(children.indexOf(trackingChip as HTMLElement));

      expect(getComputedStyle(rightCluster as HTMLElement).marginLeft).toBe("auto");
    });

    it("does not force far-right modifier when in-review card has files changed", () => {
      const { container } = render(
        <TaskCard
          task={makeTask({
            column: "in-review",
            sourceType: "dashboard_ui",
            modifiedFiles: ["src/file.ts"],
            githubTracking: { issue: trackedIssue },
            retrySummary: { total: 2 } as any,
          })}
          onOpenDetail={noop}
          addToast={noop}
          onOpenDetailWithTab={vi.fn()}
        />,
      );

      const footerRow = container.querySelector(".card-footer-row");
      expect(footerRow).not.toBeNull();
      expect(footerRow).not.toHaveClass("card-footer-row--chip-far-right");
    });
  });

  describe("FN-4923 tracking chip alignment", () => {
    it("FN-4923 right-aligns tracking chip next to timer in done when files-changed is absent", () => {
      const cleanupCss = mountCssForBadgeTests();
      try {
        const { container } = render(
          <TaskCard
            task={makeTask({
              column: "done",
              sourceType: "dashboard_ui",
              modifiedFiles: [],
              githubTracking: {
                issue: {
                  owner: "owner",
                  repo: "repo",
                  number: 42,
                  url: "https://github.com/owner/repo/issues/42",
                  createdAt: "2026-05-12T00:00:00.000Z",
                },
              },
              executionStartedAt: "2026-04-25T12:00:00.000Z",
              executionCompletedAt: "2026-04-25T12:12:00.000Z",
            })}
            onOpenDetail={noop}
            addToast={noop}
            onOpenDetailWithTab={vi.fn()}
          />,
        );

        const footerRow = container.querySelector(".card-footer-row") as HTMLElement | null;
        const trackingChip = container.querySelector(".card-github-tracking-chip") as HTMLElement | null;
        const timerChip = container.querySelector(".card-time-indicator") as HTMLElement | null;
        expect(footerRow).not.toBeNull();
        expect(footerRow).toHaveClass("card-footer-row--chip-far-right");
        expect(trackingChip).not.toBeNull();
        expect(timerChip).not.toBeNull();
        const rightCluster = container.querySelector(".card-footer-row-right") as HTMLElement | null;
        expect(rightCluster).not.toBeNull();
        expect(getComputedStyle(rightCluster as HTMLElement).marginLeft).toBe("auto");

        expect((trackingChip as HTMLElement).nextElementSibling).toBe(timerChip);
        expect(timerChip?.closest(".card-footer-row-right")).toBe(rightCluster);

      } finally {
        cleanupCss();
      }
    });

    it("FN-4923 preserves in-progress tracking-chip right alignment without files-changed", () => {
      const cleanupCss = mountCssForBadgeTests();
      try {
        const { container } = render(
          <TaskCard
            task={makeTask({
              column: "in-progress",
              sourceType: "dashboard_ui",
              modifiedFiles: [],
              githubTracking: {
                issue: {
                  owner: "owner",
                  repo: "repo",
                  number: 42,
                  url: "https://github.com/owner/repo/issues/42",
                  createdAt: "2026-05-12T00:00:00.000Z",
                },
              },
              executionStartedAt: "2026-04-25T12:00:00.000Z",
              updatedAt: "2026-04-25T12:12:00.000Z",
            })}
            onOpenDetail={noop}
            addToast={noop}
            onOpenDetailWithTab={vi.fn()}
          />,
        );

        const trackingChip = container.querySelector(".card-github-tracking-chip") as HTMLElement | null;
        const rightCluster = container.querySelector(".card-footer-row-right") as HTMLElement | null;
        expect(trackingChip).not.toBeNull();
        expect(rightCluster).not.toBeNull();
        expect(getComputedStyle(rightCluster as HTMLElement).marginLeft).toBe("auto");
      } finally {
        cleanupCss();
      }
    });

    it("FN-4923 keeps tracking chip, retry/timer chips grouped as one right-aligned cluster with files-changed", () => {
      const cleanupCss = mountCssForBadgeTests();
      try {
        const { container } = render(
          <TaskCard
            task={makeTask({
              column: "in-progress",
              sourceType: "dashboard_ui",
              modifiedFiles: ["src/file.ts"],
              githubTracking: {
                issue: {
                  owner: "owner",
                  repo: "repo",
                  number: 42,
                  url: "https://github.com/owner/repo/issues/42",
                  createdAt: "2026-05-12T00:00:00.000Z",
                },
              },
              executionStartedAt: "2026-04-25T12:00:00.000Z",
              updatedAt: "2026-04-25T12:12:00.000Z",
            })}
            onOpenDetail={noop}
            addToast={noop}
            onOpenDetailWithTab={vi.fn()}
          />,
        );

        const footerRow = container.querySelector(".card-footer-row") as HTMLElement | null;
        const filesChangedButton = screen.getByRole("button", { name: "1 file changed" });
        const trackingChip = container.querySelector(".card-github-tracking-chip") as HTMLElement | null;
        const timerChip = container.querySelector(".card-time-indicator") as HTMLElement | null;
        expect(footerRow).not.toBeNull();
        expect(footerRow).not.toHaveClass("card-footer-row--chip-far-right");
        expect(trackingChip).not.toBeNull();
        expect(timerChip).not.toBeNull();
        const rightCluster = container.querySelector(".card-footer-row-right") as HTMLElement | null;
        expect(filesChangedButton.compareDocumentPosition(trackingChip as HTMLElement)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
        expect(rightCluster).not.toBeNull();
        expect(getComputedStyle(rightCluster as HTMLElement).marginLeft).toBe("auto");
        expect(getComputedStyle(timerChip as HTMLElement).marginLeft).not.toBe("auto");
      } finally {
        cleanupCss();
      }
    });
  });

  it("does not render a GitHub tracking link when githubTracking is absent", () => {
    render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "dashboard_ui",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.queryByRole("link", { name: /Linked GitHub issue/i })).toBeNull();
  });

  it("keeps the plain provenance badge when source issue differs from tracked issue", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "github_import",
          sourceMetadata: { issueUrl: "https://github.com/owner/repo/issues/42" },
          githubTracking: {
            issue: {
              owner: "other",
              repo: "tracking",
              number: 99,
              url: "https://github.com/other/tracking/issues/99",
              createdAt: "2026-05-12T00:00:00.000Z",
            },
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-source-provenance")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Linked GitHub issue #99" })).toBeDefined();
  });

  it("replaces the GitHub import provenance badge with the linked-issue chip when source and tracked issue match", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "github_import",
          sourceMetadata: { issueUrl: "https://github.com/owner/repo/issues/42" },
          githubTracking: {
            issue: {
              owner: "owner",
              repo: "repo",
              number: 42,
              url: "https://github.com/owner/repo/issues/42",
              createdAt: "2026-05-12T00:00:00.000Z",
            },
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const chips = container.querySelectorAll(".card-github-tracking-chip");
    const link = screen.getByRole("link", { name: "Linked GitHub issue #42" });
    expect(chips).toHaveLength(1);
    expect(link.getAttribute("href")).toBe("https://github.com/owner/repo/issues/42");
    expect(link).toHaveTextContent("#42");
    expect(container.querySelector(".card-source-provenance")).toBeNull();
  });

  it("keeps the plain provenance badge alone when there is no linked issue", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "github_import",
          sourceMetadata: { issueUrl: "https://github.com/owner/repo/issues/42" },
          githubTracking: undefined,
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-source-provenance")).not.toBeNull();
    expect(container.querySelector(".card-github-tracking-chip")).toBeNull();
  });

  it("uses the same matching logic for task.issueInfo", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "github_import",
          issueInfo: {
            url: "https://github.com/owner/repo/issues/42",
            number: 42,
            state: "open",
            title: "Issue",
          },
          githubTracking: {
            issue: {
              owner: "owner",
              repo: "repo",
              number: 42,
              url: "https://github.com/owner/repo/issues/42",
              createdAt: "2026-05-12T00:00:00.000Z",
            },
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByRole("link", { name: "Linked GitHub issue #42" })).toBeDefined();
    expect(container.querySelector(".card-source-provenance")).toBeNull();
  });

  it("does not render a GitHub tracking link when a matching issue badge is already shown", () => {
    render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "dashboard_ui",
          githubTracking: {
            issue: {
              owner: "owner",
              repo: "repo",
              number: 42,
              url: "https://github.com/owner/repo/issues/42",
              createdAt: "2026-05-12T00:00:00.000Z",
            },
          },
          issueInfo: {
            url: "https://github.com/owner/repo/issues/42",
            number: 42,
            state: "open",
            title: "Issue",
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.queryByRole("link", { name: /Linked GitHub issue/i })).toBeNull();
  });

  it("clicking the GitHub tracking link does not open the task detail modal", () => {
    const onOpenDetail = vi.fn();
    render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "dashboard_ui",
          githubTracking: {
            issue: {
              owner: "owner",
              repo: "repo",
              number: 42,
              url: "https://github.com/owner/repo/issues/42",
              createdAt: "2026-05-12T00:00:00.000Z",
            },
          },
        })}
        onOpenDetail={onOpenDetail}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "Linked GitHub issue #42" }));
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("renders agent-created provenance badge for automation tasks and prefers sourceMetadata.agentName", () => {
    seedAgentsCache("p1", [{ id: "agent-123", name: "Cache Robot" }]);

    const { container } = render(
      <TaskCard
        projectId="p1"
        task={makeTask({
          column: "todo",
          sourceType: "automation",
          sourceAgentId: "agent-123",
          sourceMetadata: { agentName: "Task Robot" },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = container.querySelector(".card-agent-created-badge");
    expect(badge).not.toBeNull();
    expect(badge?.closest(".card-agent-badge-row")).not.toBeNull();
    expect(badge?.closest(".card-header")).toBeNull();
    expect(badge?.getAttribute("title")).toBe("Created by agent: Task Robot");
    expect(badge?.getAttribute("aria-label")).toBe("Created by agent: Task Robot");
    expect(badge?.querySelector("span[aria-hidden='true']")?.textContent).toBe("Task Robot");
    expect(badge?.querySelector(".visually-hidden")?.textContent).toBe("Created by agent: Task Robot");
  });

  it("renders agent-created provenance badge for agent_heartbeat tasks", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "agent_heartbeat",
          sourceAgentId: "heartbeat-agent-1",
          sourceMetadata: { agentName: "Scheduler Bot" },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = container.querySelector(".card-agent-created-badge");
    expect(badge).not.toBeNull();
    expect(badge?.closest(".card-agent-badge-row")).not.toBeNull();
    expect(badge?.closest(".card-meta-badges")).toBeNull();
    expect(badge?.getAttribute("title")).toBe("Created by agent: Scheduler Bot");
    expect(badge?.getAttribute("aria-label")).toBe("Created by agent: Scheduler Bot");
  });

  it("renders agent-created provenance badge with cached source agent names before falling back to ids", () => {
    seedAgentsCache("p1", [{ id: "legacy-agent-1", name: "Legacy Robot" }]);

    const { container } = render(
      <TaskCard
        projectId="p1"
        task={makeTask({
          column: "todo",
          sourceAgentId: "legacy-agent-1",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = container.querySelector(".card-agent-created-badge");
    expect(badge).not.toBeNull();
    expect(badge?.closest(".card-agent-badge-row")).not.toBeNull();
    expect(badge?.getAttribute("title")).toBe("Created by agent: Legacy Robot");
    expect(badge?.querySelector("span[aria-hidden='true']")?.textContent).toBe("Legacy Robot");
  });

  it("falls back to the generic Agent label when source type is agent-created without a resolvable name", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "automation",
          sourceAgentId: undefined,
          sourceMetadata: undefined,
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = container.querySelector(".card-agent-created-badge");
    expect(badge).not.toBeNull();
    expect(badge?.closest(".card-agent-badge-row")).not.toBeNull();
    expect(badge?.getAttribute("title")).toBe("Created by agent");
    expect(badge?.getAttribute("aria-label")).toBe("Created by agent");
    expect(badge?.querySelector("span[aria-hidden='true']")?.textContent).toBe("Agent");
    expect(badge?.querySelector(".visually-hidden")?.textContent).toBe("Created by agent");
  });

  it("does not render agent-created provenance badge for non-agent task sources", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "dashboard_ui",
          sourceAgentId: undefined,
          sourceMetadata: undefined,
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-agent-created-badge")).toBeNull();
    expect(container.querySelector(".card-agent-badge-row")).toBeNull();
  });

  it("coexists with GitHub badge and timer metadata", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "done",
          sourceType: "github_import",
          sourceAgentId: "agent-42",
          sourceMetadata: { issueUrl: "https://github.com/owner/repo/issues/7" },
          issueInfo: {
            owner: "owner",
            repo: "repo",
            issueNumber: 7,
            state: "open",
            title: "Fix bug",
          } as any,
          executionStartedAt: "2026-04-25T13:00:00.000Z",
          executionCompletedAt: "2026-04-25T15:00:00.000Z",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-github-badge")).not.toBeNull();
    expect(container.querySelector(".card-source-provenance")).not.toBeNull();
    expect(container.querySelector(".card-agent-created-badge")?.closest(".card-agent-badge-row")).not.toBeNull();
    expect(container.querySelector(".card-time-indicator")).not.toBeNull();
  });

  it("FN-4511 keeps GitHub badge sizing tokens aligned with card-time-indicator", () => {
    const baseCss = loadAllAppCssBaseOnly();

    expect(baseCss).toMatch(/\.card-github-badge\s*\{[^}]*padding:\s*var\(--space-xs\)\s+var\(--space-sm\);[^}]*\}/);
    expect(baseCss).toMatch(/\.card-github-badge\s*\{[^}]*font-size:\s*0\.6875rem;[^}]*\}/);
    expect(baseCss).toMatch(/\.card-github-badge\s*\{[^}]*gap:\s*var\(--space-xs\);[^}]*\}/);
    expect(baseCss).toMatch(/\.card-github-badge\s*\{[^}]*font-family:\s*var\(--font-mono\);[^}]*\}/);

    const fullCss = loadAllAppCss();
    expect(fullCss).toMatch(/@media[^{]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.card-github-badge\s*\{[^}]*font-size:\s*0\.625rem;[^}]*\}/);
  });

  it("FN-4525 defines shared card-chip height tokens and applies them to badges and chips", () => {
    const baseCss = loadAllAppCssBaseOnly();

    expect(baseCss).toMatch(/:root\s*\{[^}]*--card-chip-height:\s*22px;[^}]*--card-chip-height-mobile:\s*20px;[^}]*\}/);
    expect(baseCss).toMatch(/\.card-github-badge\s*\{[^}]*height:\s*var\(--card-chip-height\);[^}]*\}/);
    expect(baseCss).toMatch(/\.card-time-indicator\s*,\s*\.card-cost-indicator\s*,\s*\.card-github-tracking-chip\s*,\s*\.card-retry-badge\s*,\s*\.card-create-pr-action\s*\{[^}]*height:\s*var\(--card-chip-height\);[^}]*\}/);
  });

  it("FN-4525 applies shared mobile card-chip height token to badges and chips", () => {
    const fullCss = loadAllAppCss();

    expect(fullCss).toMatch(/@media[^{]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.card-github-badge\s*\{[^}]*height:\s*var\(--card-chip-height-mobile\);[^}]*\}/);
    expect(fullCss).toMatch(/@media[^{]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.card-time-indicator\s*,\s*\.card-cost-indicator\s*,\s*\.card-github-tracking-chip\s*,\s*\.card-retry-badge\s*,\s*\.card-create-pr-action\s*\{[^}]*height:\s*var\(--card-chip-height-mobile\);[^}]*\}/);
  });

  it("keeps Create PR action on shared chip height tokens", () => {
    const baseCss = loadAllAppCssBaseOnly();
    const fullCss = loadAllAppCss();

    expect(baseCss).toMatch(/\.card-create-pr-action\s*\{[^}]*height:\s*var\(--card-chip-height\);[^}]*\}/);
    expect(fullCss).toMatch(/@media[^{]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.card-create-pr-action\s*\{[^}]*height:\s*var\(--card-chip-height-mobile\);[^}]*\}/);
  });

  it("FN-4511 keeps GitHub badge and timer chip geometry in parity", () => {
    const cleanupCss = mountCssForBadgeTests();
    try {
      const { container } = render(
        <TaskCard
          task={makeTask({
            column: "done",
            issueInfo: {
              owner: "owner",
              repo: "repo",
              issueNumber: 7,
              state: "open",
              title: "Fix bug",
            } as any,
            executionStartedAt: "2026-04-25T13:00:00.000Z",
            executionCompletedAt: "2026-04-25T15:00:00.000Z",
          })}
          onOpenDetail={noop}
          addToast={noop}
        />,
      );

      const githubBadge = container.querySelector(".card-github-badge") as HTMLElement;
      const timeIndicator = container.querySelector(".card-time-indicator") as HTMLElement;
      expect(githubBadge).toBeDefined();
      expect(timeIndicator).toBeDefined();

      const githubStyles = getComputedStyle(githubBadge);
      const timeStyles = getComputedStyle(timeIndicator);

      expect(githubStyles.padding).toBe(timeStyles.padding);
      expect(githubStyles.fontSize).toBe(timeStyles.fontSize);
      expect(githubStyles.lineHeight).toBe(timeStyles.lineHeight);
      const githubBorderTopWidth = githubStyles.borderTopWidth || "1px";
      const timeBorderTopWidth = timeStyles.borderTopWidth || "1px";
      const githubBorderBottomWidth = githubStyles.borderBottomWidth || "1px";
      const timeBorderBottomWidth = timeStyles.borderBottomWidth || "1px";
      expect(githubBorderTopWidth).toBe(timeBorderTopWidth);
      expect(githubBorderBottomWidth).toBe(timeBorderBottomWidth);
      expect(githubStyles.gap).toBe(timeStyles.gap);

      if (githubBadge.offsetHeight > 0 || timeIndicator.offsetHeight > 0) {
        expect(githubBadge.offsetHeight).toBe(timeIndicator.offsetHeight);
      } else {
        expect(githubStyles.height).not.toBe("");
        expect(githubStyles.height).toBe(timeStyles.height);
      }
    } finally {
      cleanupCss();
    }
  });

  it("FN-4511 preserves transparent border slot on .card-github-badge", () => {
    const css = loadAllAppCssBaseOnly();
    expect(css).toMatch(/\.card-github-badge\s*\{[^}]*border:\s*1px\s+solid\s+transparent;[^}]*\}/);
  });

  it.each([
    {
      name: "uses live diff stats over stale mergeDetails",
      diff: { stats: { filesChanged: 2, additions: 4, deletions: 1 }, loading: false },
      mergeDetails: { filesChanged: 108 },
      expectedLabel: "2 files changed",
    },
    {
      name: "uses mergeDetails as transient placeholder while loading",
      diff: { stats: null, loading: true },
      mergeDetails: { filesChanged: 108 },
      expectedLabel: "108 files changed",
    },
    {
      name: "hides badge when fetch resolved null and no execution fallback exists",
      diff: { stats: null, loading: false },
      mergeDetails: { filesChanged: 108 },
      expectedLabel: null,
    },
    {
      name: "hides badge when live diff resolves zero",
      diff: { stats: { filesChanged: 0, additions: 0, deletions: 0 }, loading: false },
      mergeDetails: { filesChanged: 108 },
      expectedLabel: null,
    },
    {
      name: "clamps live diff count when landed files are attribution-restricted",
      diff: { stats: { filesChanged: 5, additions: 10, deletions: 2 }, loading: false },
      mergeDetails: { landedFilesAttributionRestricted: true, landedFiles: ["a.ts"] },
      expectedLabel: "1 file changed",
    },
    {
      name: "does not clamp when attribution restriction is absent",
      diff: { stats: { filesChanged: 5, additions: 10, deletions: 2 }, loading: false },
      mergeDetails: { landedFiles: ["a.ts"] },
      expectedLabel: "5 files changed",
    },
    {
      name: "uses singular grammar for one live file",
      diff: { stats: { filesChanged: 1, additions: 1, deletions: 0 }, loading: false },
      mergeDetails: undefined,
      expectedLabel: "1 file changed",
    },
  ])("FN-4527 done-task files changed contract: $name", ({ diff, mergeDetails, expectedLabel }) => {
    useTaskDiffStatsMock.mockReturnValue(diff);

    render(
      <TaskCard
        task={makeTask({
          column: "done",
          mergeDetails: mergeDetails
            ? {
                commitSha: "abc123",
                insertions: 10,
                deletions: 2,
                mergedAt: "2026-04-25T15:00:00.000Z",
                mergeConfirmed: true,
                ...mergeDetails,
              }
            : undefined,
        })}
        onOpenDetail={noop}
        addToast={noop}
        onOpenDetailWithTab={vi.fn()}
      />,
    );

    if (expectedLabel) {
      expect(screen.getByRole("button", { name: expectedLabel })).toBeDefined();
      return;
    }

    const filesChangedButton = document.querySelector(".card-session-files");
    expect(filesChangedButton).toBeNull();
  });

  it("backfills done-card files-changed chip when mergeDetails enrichment arrives without remount", () => {
    useTaskDiffStatsMock.mockImplementation((...args: any[]) => {
      const options = args[4] as { mergeSignature?: string } | undefined;
      if (options?.mergeSignature === "3:3") {
        return { stats: { filesChanged: 3, additions: 9, deletions: 2 }, loading: false };
      }
      return { stats: null, loading: false };
    });

    const baseTask = makeTask({
      column: "done",
      mergeDetails: {
        commitSha: "abc123",
        insertions: 10,
        deletions: 2,
        mergedAt: "2026-04-25T15:00:00.000Z",
        mergeConfirmed: true,
      },
    });

    const { rerender } = render(
      <TaskCard
        task={baseTask}
        onOpenDetail={noop}
        addToast={noop}
        onOpenDetailWithTab={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /files changed/i })).toBeNull();
    expect(useTaskDiffStatsMock).toHaveBeenLastCalledWith(
      "FN-001",
      "done",
      "abc123",
      undefined,
      expect.objectContaining({ mergeSignature: ":" }),
    );

    rerender(
      <TaskCard
        task={{
          ...baseTask,
          mergeDetails: {
            ...baseTask.mergeDetails,
            filesChanged: 3,
            landedFiles: ["a.ts", "b.ts", "c.ts"],
          },
        }}
        onOpenDetail={noop}
        addToast={noop}
        onOpenDetailWithTab={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "3 files changed" })).toBeDefined();
    expect(useTaskDiffStatsMock).toHaveBeenLastCalledWith(
      "FN-001",
      "done",
      "abc123",
      undefined,
      expect.objectContaining({ mergeSignature: "3:3" }),
    );
  });

  it("prefers landedFiles fallback files-changed label for done tasks when lineage stats are unavailable", () => {
    const onOpenDetailWithTab = vi.fn();
    useTaskDiffStatsMock.mockReturnValue({ stats: null, loading: false });

    render(
      <TaskCard
        task={makeTask({
          column: "done",
          mergeDetails: { landedFiles: ["a.ts", "b.ts"] },
        })}
        onOpenDetail={noop}
        addToast={noop}
        onOpenDetailWithTab={onOpenDetailWithTab}
      />,
    );

    const landedButton = screen.getByRole("button", { name: "2 files changed" });
    expect(landedButton).toBeDefined();

    fireEvent.click(landedButton);
    expect(onOpenDetailWithTab).toHaveBeenCalledTimes(1);
    expect(onOpenDetailWithTab.mock.calls[0]?.[1]).toBe("changes");
  });

  it("hides the done-task file chip when only execution-touched modifiedFiles exist", () => {
    useTaskDiffStatsMock.mockReturnValue({ stats: null, loading: false });

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "done",
          modifiedFiles: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"],
        })}
        onOpenDetail={noop}
        addToast={noop}
        onOpenDetailWithTab={vi.fn()}
      />,
    );

    expect(screen.queryByText(/touched during execution/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /files changed/i })).toBeNull();
    expect(container.querySelector(".card-session-files")).toBeNull();
  });

  it("prefers lineage files-changed stats over stale execution-touched modifiedFiles for done tasks", () => {
    useTaskDiffStatsMock.mockReturnValue({
      stats: { filesChanged: 4, additions: 12, deletions: 3 },
      loading: false,
    });

    render(
      <TaskCard
        task={makeTask({
          column: "done",
          modifiedFiles: [
            "one.ts",
            "two.ts",
            "three.ts",
            "four.ts",
            "five.ts",
            "six.ts",
            "seven.ts",
            "eight.ts",
            "nine.ts",
            "ten.ts",
          ],
        })}
        onOpenDetail={noop}
        addToast={noop}
        onOpenDetailWithTab={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "4 files changed" })).toBeDefined();
    expect(screen.queryByText(/touched during execution/i)).toBeNull();
    expect(screen.queryByText(/in merged commit/i)).toBeNull();
  });

  it("uses singular 'file changed' grammar for landedFiles-only done tasks", () => {
    useTaskDiffStatsMock.mockReturnValue({ stats: null, loading: false });

    render(
      <TaskCard
        task={makeTask({
          column: "done",
          mergeDetails: { landedFiles: ["a.ts"] },
        })}
        onOpenDetail={noop}
        addToast={noop}
        onOpenDetailWithTab={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "1 file changed" })).toBeDefined();
  });

  it("hides done-task file chip when lineage stats are unavailable and no execution fallback exists", () => {
    useTaskDiffStatsMock.mockReturnValue({ stats: null, loading: false });

    const { container } = render(
      <TaskCard
        task={makeTask({ column: "done", modifiedFiles: [] })}
        onOpenDetail={noop}
        addToast={noop}
        onOpenDetailWithTab={vi.fn()}
      />,
    );

    expect(container.querySelector(".card-session-files")).toBeNull();
  });

  it("renders files-changed metadata and timer chip in footer row", () => {
    useTaskDiffStatsMock.mockReturnValue({
      stats: { filesChanged: 4, additions: 10, deletions: 2 },
      loading: false,
    });

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "done",
          columnMovedAt: "2026-04-25T15:00:00.000Z",
          updatedAt: "2026-04-25T15:00:00.000Z",
          createdAt: "2026-04-25T13:00:00.000Z",
          workflowStepResults: [
            {
              workflowStepId: "step-1",
              workflowStepName: "Plan",
              phase: "pre-merge" as const,
              status: "passed" as const,
              startedAt: "2026-04-25T13:00:00.000Z",
              completedAt: "2026-04-25T15:00:00.000Z",
            },
          ],
          mergeDetails: {
            commitSha: "abc123",
            filesChanged: 4,
            insertions: 10,
            deletions: 2,
            mergedAt: "2026-04-25T15:00:00.000Z",
            mergeConfirmed: true,
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
        onOpenDetailWithTab={vi.fn()}
      />,
    );

    const header = container.querySelector(".card-header");
    const footerRow = container.querySelector(".card-footer-row");
    const filesChanged = container.querySelector(".card-session-files");
    const timer = container.querySelector(".card-time-indicator");

    expect(header).not.toBeNull();
    expect(footerRow).not.toBeNull();
    expect(filesChanged).not.toBeNull();
    expect(timer).not.toBeNull();
    const rightCluster = container.querySelector(".card-footer-row-right");
    expect(footerRow?.contains(filesChanged)).toBe(true);

    expect(footerRow?.contains(timer)).toBe(true);
    expect(header?.contains(timer)).toBe(false);
    expect(timer?.closest(".card-footer-row-right")).toBe(rightCluster);
    expect(rightCluster).not.toBeNull();
    expect(Array.from(footerRow?.children ?? [])).toEqual([filesChanged, rightCluster]);

  });

  it("shows timer chip for in-review cards", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          workflowStepResults: [
            {
              workflowStepId: "step-1",
              workflowStepName: "Plan",
              phase: "pre-merge" as const,
              status: "passed" as const,
              startedAt: "2026-04-25T12:00:00.000Z",
              completedAt: "2026-04-25T12:08:00.000Z",
            },
          ],
          log: [
            {
              timestamp: "2026-04-25T12:09:00.000Z",
              action: "[timing] llm_call in 240000ms",
              outcome: "",
            } as unknown as Task["log"][number],
          ],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const timer = container.querySelector(".card-time-indicator");
    expectTimerInFooterRight(container);
    expect(timer?.textContent).toContain("12m");
    expect(timer?.getAttribute("title")).toContain("Execution time 12m");
    expect(timer?.getAttribute("title")).not.toContain("Completed");
  });

  it("keeps the in-review timer live from executionStartedAt when present", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:30:00.000Z"));

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          executionStartedAt: "2026-04-25T12:00:00.000Z",
          columnMovedAt: "2026-04-25T12:12:00.000Z",
          updatedAt: "2026-04-25T12:30:00.000Z",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const timer = container.querySelector(".card-time-indicator");
    expectTimerInFooterRight(container);
    expect(timer?.textContent).toContain("30m");
    expect(timer?.getAttribute("title")).toBe("Execution time 30m");

    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });

    expect(container.querySelector(".card-time-indicator")?.textContent).toContain("35m");
    expect(container.querySelector(".card-time-indicator")?.getAttribute("title")).toBe("Execution time 35m");
  });

  it("shows cumulative runtime across a user reopen", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T13:17:00.000Z"));

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          firstExecutionAt: "2026-05-15T08:42:00.000Z",
          cumulativeActiveMs: 6 * 60_000,
          executionStartedAt: "2026-05-15T13:15:00.000Z",
          columnMovedAt: "2026-05-15T13:17:00.000Z",
          updatedAt: "2026-05-15T13:17:00.000Z",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const timer = container.querySelector(".card-time-indicator");
    expectTimerInFooterRight(container);
    expect(timer?.textContent).toContain("6m");
    expect(timer?.getAttribute("title")).toBe("Execution time 6m");
  });

  it("keeps legacy wall-clock timers after firstExecutionAt migration backfill", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "done",
          executionStartedAt: "2026-04-25T12:00:00.000Z",
          executionCompletedAt: "2026-04-25T12:30:00.000Z",
          firstExecutionAt: "2026-04-25T12:00:00.000Z",
          cumulativeActiveMs: undefined,
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const timer = container.querySelector(".card-time-indicator");
    expect(timer).not.toBeNull();
    expect(timer?.textContent).toContain("30m");
  });

  it("renders the optional cost badge only when enabled and token usage exists", () => {
    const pricedTask = makeTask({
      column: "done",
      tokenUsage: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 1_000_000,
        firstUsedAt: "2026-01-01T00:00:00Z",
        lastUsedAt: "2026-01-01T00:00:00Z",
        modelProvider: "openai",
        modelId: "gpt-5-mini",
      },
    } as Partial<Task>);

    const disabled = render(<TaskCard task={pricedTask} onOpenDetail={noop} addToast={noop} />);
    expect(disabled.container.querySelector(".card-cost-indicator")).toBeNull();
    disabled.unmount();

    const enabled = render(
      <CostBadgeProvider value={{ enabled: true }}>
        <TaskCard task={pricedTask} onOpenDetail={noop} addToast={noop} />
      </CostBadgeProvider>,
    );

    const costBadge = enabled.container.querySelector(".card-cost-indicator") as HTMLElement | null;
    expect(costBadge).not.toBeNull();
    expect(costBadge?.textContent).toContain("$0.25");
    expect(costBadge?.querySelector("svg")).toBeNull();
    expect(costBadge?.getAttribute("aria-label")).toBe("Estimated cost $0.25");
    expect(costBadge?.getAttribute("title")).toBe("Estimated cost $0.25");
    expect(costBadge?.closest(".card-footer-row-right")).toBe(enabled.container.querySelector(".card-footer-row-right"));
    expect(costBadge?.closest(".card-footer-row")).toBe(enabled.container.querySelector(".card-footer-row"));
    expect(costBadge?.closest(".card-meta")).toBeNull();
    enabled.unmount();

    const noUsage = render(
      <CostBadgeProvider value={{ enabled: true }}>
        <TaskCard task={makeTask({ id: "FN-002", column: "done" })} onOpenDetail={noop} addToast={noop} />
      </CostBadgeProvider>,
    );
    expect(noUsage.container.querySelector(".card-cost-indicator")).toBeNull();
  });

  it("places a todo cost badge inside the meta row when the footer has no leading content", () => {
    const { container } = render(
      <CostBadgeProvider value={{ enabled: true }}>
        <TaskCard
          task={makeTask({
            column: "todo",
            dependencies: ["FN-000"],
            tokenUsage: {
              inputTokens: 1_000_000,
              outputTokens: 0,
              cachedTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 1_000_000,
              firstUsedAt: "2026-01-01T00:00:00Z",
              lastUsedAt: "2026-01-01T00:00:00Z",
              modelProvider: "openai",
              modelId: "gpt-5-mini",
            },
          } as Partial<Task>)}
          onOpenDetail={noop}
          addToast={noop}
        />
      </CostBadgeProvider>,
    );

    const costBadge = container.querySelector(".card-cost-indicator") as HTMLElement | null;
    const metaRow = container.querySelector(".card-meta");
    const rightCluster = container.querySelector(".card-footer-row-right");
    expect(costBadge).not.toBeNull();
    expect(costBadge?.textContent).toContain("$0.25");
    expect(costBadge?.closest(".card-meta")).toBe(metaRow);
    expect(costBadge?.closest(".card-footer-row")).toBeNull();
    expect(rightCluster?.closest(".card-meta")).toBe(metaRow);
    expect(rightCluster?.contains(costBadge)).toBe(true);
    expect(container.querySelector(".card-footer-row")).toBeNull();
  });

  it("places the unavailable cost sentinel inside todo meta without adding an icon", () => {
    const { container } = render(
      <CostBadgeProvider value={{ enabled: true }}>
        <TaskCard
          task={makeTask({
            column: "todo",
            dependencies: ["FN-000"],
            tokenUsage: {
              inputTokens: 1,
              outputTokens: 0,
              cachedTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 1,
              firstUsedAt: "2026-01-01T00:00:00Z",
              lastUsedAt: "2026-01-01T00:00:00Z",
              modelProvider: "unknown",
              modelId: "no-price",
            },
          } as Partial<Task>)}
          onOpenDetail={noop}
          addToast={noop}
        />
      </CostBadgeProvider>,
    );

    const costBadge = container.querySelector(".card-cost-indicator") as HTMLElement | null;
    expect(costBadge).not.toBeNull();
    expect(costBadge?.textContent).toContain("—");
    expect(costBadge?.querySelector("svg")).toBeNull();
    expect(costBadge?.getAttribute("aria-label")).toBe("Estimated cost —");
    expect(costBadge?.getAttribute("title")).toBe("Estimated cost —");
    expect(costBadge?.closest(".card-meta")).toBe(container.querySelector(".card-meta"));
    expect(costBadge?.closest(".card-footer-row")).toBeNull();
    expect(container.querySelector(".card-footer-row")).toBeNull();
  });

  it("keeps in-progress cost badges in the footer row with files changed", () => {
    const { container } = render(
      <CostBadgeProvider value={{ enabled: true }}>
        <TaskCard
          task={makeTask({
            column: "in-progress",
            modifiedFiles: ["packages/dashboard/app/components/TaskCard.tsx"],
            tokenUsage: {
              inputTokens: 1_000_000,
              outputTokens: 0,
              cachedTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 1_000_000,
              firstUsedAt: "2026-01-01T00:00:00Z",
              lastUsedAt: "2026-01-01T00:00:00Z",
              modelProvider: "openai",
              modelId: "gpt-5-mini",
            },
          } as Partial<Task>)}
          onOpenDetail={noop}
          addToast={noop}
        />
      </CostBadgeProvider>,
    );

    const costBadge = container.querySelector(".card-cost-indicator") as HTMLElement | null;
    const footerRow = container.querySelector(".card-footer-row");
    const rightCluster = container.querySelector(".card-footer-row-right");
    expect(container.querySelector(".card-session-files")).not.toBeNull();
    expect(costBadge).not.toBeNull();
    expect(costBadge?.closest(".card-footer-row")).toBe(footerRow);
    expect(costBadge?.closest(".card-footer-row-right")).toBe(rightCluster);
    expect(costBadge?.closest(".card-meta")).toBeNull();
  });

  it.each(["merging", "merging-fix"] as const)("shows live merge elapsed in timer chip while task.status is %s", (status) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T13:45:00.000Z"));

    try {
      const { container } = render(
        <TaskCard
          task={makeTask({
            column: "in-review",
            status,
            executionStartedAt: "2026-04-25T13:00:00.000Z",
            updatedAt: "2026-04-25T13:44:30.000Z",
            workflowStepResults: [
              {
                workflowStepId: "step-1",
                workflowStepName: "Plan",
                phase: "pre-merge" as const,
                status: "passed" as const,
                startedAt: "2026-04-25T12:00:00.000Z",
                completedAt: "2026-04-25T12:03:00.000Z",
              },
            ],
          })}
          onOpenDetail={noop}
          addToast={noop}
        />,
      );

      const timer = container.querySelector(".card-time-indicator");
      expectTimerInFooterRight(container);
      expect(timer?.textContent).toContain("45m");
      expect(timer?.getAttribute("title")).toBe("Execution time 45m. Merge phase <1m");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not render timer chip for in-review cards without instrumentation data", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          workflowStepResults: undefined,
          log: [],
          timedExecutionMs: undefined,
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-time-indicator")).toBeNull();
  });

  it.each(["triage", "todo", "archived"] as const)(
    "does not render timer chip for %s cards",
    (column) => {
      const { container } = render(
        <TaskCard
          task={makeTask({
            column,
            workflowStepResults: [
              {
                workflowStepId: "step-1",
                workflowStepName: "Plan",
                phase: "pre-merge" as const,
                status: "passed" as const,
                startedAt: "2026-04-25T13:00:00.000Z",
                completedAt: "2026-04-25T15:00:00.000Z",
              },
            ],
          })}
          onOpenDetail={noop}
          addToast={noop}
        />,
      );

      expect(container.querySelector(".card-time-indicator")).toBeNull();
    },
  );

  it("shows wall-clock timer for in-progress cards when columnMovedAt is available", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:05:00.000Z"));

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-progress",
          columnMovedAt: "2026-04-25T12:00:00.000Z",
          updatedAt: "2026-04-25T12:00:00.000Z",
          createdAt: "2026-04-25T11:58:00.000Z",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const timer = container.querySelector(".card-time-indicator");
    expect(timer?.textContent).toContain("5m");
    expect(timer?.getAttribute("title")).toContain("In progress 5m");
  });

  it("prefers executionStartedAt over a newer columnMovedAt for in-progress timers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:10:00.000Z"));

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-progress",
          columnMovedAt: "2026-04-25T12:08:00.000Z",
          executionStartedAt: "2026-04-25T12:00:00.000Z",
          updatedAt: "2026-04-25T12:08:00.000Z",
          createdAt: "2026-04-25T11:58:00.000Z",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const timer = container.querySelector(".card-time-indicator");
    expect(timer?.textContent).toContain("10m");
    expect(timer?.getAttribute("title")).toContain("In progress 10m");
  });

  it("does not render timer chip on done card without instrumentation, even with old timestamps", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "done",
          createdAt: "2026-04-25T10:00:00.000Z",
          columnMovedAt: "2026-04-25T12:30:00.000Z",
          updatedAt: "2026-04-25T12:30:00.000Z",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-time-indicator")).toBeNull();
  });

  describe("formatElapsedDuration rounding for done tasks", () => {
    it.each([
      [59_999, "1m"],
      [60_000, "1m"],
      [90_000, "2m"],
      [3_540_000, "1h"],
      [3_600_000, "1h"],
      [86_400_000, "1d"],
    ])("formats %dms as %s for done tasks", (elapsedMs, expected) => {
      expect(formatElapsedDurationDone(elapsedMs)).toBe(expected);
    });

    it("keeps in-progress rounding with floor semantics", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-25T12:01:30.000Z"));

      const { container } = render(
        <TaskCard
          task={makeTask({
            column: "in-progress",
            workflowStepResults: [
              {
                workflowStepId: "step-1",
                workflowStepName: "Plan",
                phase: "pre-merge" as const,
                status: "pending" as const,
                startedAt: "2026-04-25T12:00:00.000Z",
              },
            ],
          })}
          onOpenDetail={noop}
          addToast={noop}
        />,
      );

      expect(container.querySelector(".card-time-indicator")?.textContent).toContain("1m");
    });

    it("renders done-card timer with ceiling rounding for fractional minutes", () => {
      const { container } = render(
        <TaskCard
          task={makeTask({
            column: "done",
            createdAt: "2026-04-25T12:00:00.000Z",
            columnMovedAt: "2026-04-25T12:04:30.000Z",
            updatedAt: "2026-04-25T12:04:30.000Z",
            workflowStepResults: [
              {
                workflowStepId: "step-1",
                workflowStepName: "Plan",
                phase: "pre-merge" as const,
                status: "passed" as const,
                startedAt: "2026-04-25T12:00:00.000Z",
                completedAt: "2026-04-25T12:04:30.000Z",
              },
            ],
          })}
          onOpenDetail={noop}
          addToast={noop}
        />,
      );

      expect(container.querySelector(".card-time-indicator")?.textContent).toContain("5m");
    });
  });

  it("live-ticks workflow runtime for in-progress steps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:30.000Z"));

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-progress",
          workflowStepResults: [
            {
              workflowStepId: "step-1",
              workflowStepName: "Plan",
              phase: "pre-merge" as const,
              status: "pending" as const,
              startedAt: "2026-04-25T12:00:00.000Z",
            },
          ],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const timer = container.querySelector(".card-time-indicator");
    expect(timer?.textContent).toContain("<1m");

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(container.querySelector(".card-time-indicator")?.textContent).toContain("1m");
  });
});

describe("TaskCard provider icons on agent row", () => {
  it("renders provider icons when task has model overrides", () => {
    render(
      <TaskCard
        task={makeTask({ modelProvider: "anthropic", assignedAgentId: "agent-1" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByTestId("card-provider-icons")).toBeDefined();
    expect(screen.getByTestId("provider-icon-anthropic")).toBeDefined();
  });

  it("keeps assigned agent badge accessible when label is visually collapsible", async () => {
    vi.mocked(fetchAgent).mockResolvedValue({
      id: "agent-robot",
      name: "Task Robot",
      role: "executor",
      state: "active",
      metadata: {},
      heartbeatHistory: [],
      completedRuns: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as any);

    const { container } = render(
      <TaskCard
        task={makeTask({ modelProvider: "anthropic", assignedAgentId: "agent-robot" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    await waitFor(() => {
      const badge = container.querySelector(".card-agent-badge");
      expect(badge).not.toBeNull();
      expect(badge?.getAttribute("title")).toBe("Assigned to Task Robot");
      expect(badge?.querySelector(".visually-hidden")?.textContent).toContain("Assigned to Task Robot");
    });
  });

  it("deduplicates when executor and validator use same provider", () => {
    render(
      <TaskCard
        task={makeTask({
          modelProvider: "openai",
          validatorModelProvider: "openai",
          planningModelProvider: "anthropic",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const icons = screen.getByTestId("card-provider-icons");
    expect(icons.querySelectorAll("[data-testid^='provider-icon-']").length).toBe(2);
    expect(screen.getByTestId("provider-icon-openai")).toBeDefined();
    expect(screen.getByTestId("provider-icon-anthropic")).toBeDefined();
  });

  it("renders agent row with provider icons even without assignedAgentId", () => {
    render(
      <TaskCard
        task={makeTask({ modelProvider: "anthropic", assignedAgentId: undefined })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByTestId("card-provider-icons")).toBeDefined();
    expect(screen.getByTestId("provider-icon-anthropic")).toBeDefined();
  });

  it("does not render provider icons when no model overrides set", () => {
    render(
      <TaskCard
        task={makeTask({ assignedAgentId: "agent-1" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.queryByTestId("card-provider-icons")).toBeNull();
  });
});

describe("TaskCard near-duplicate chip", () => {
  it("shows a needs-user-feedback status when a triage duplicate is paused for a decision", () => {
    render(
      <TaskCard
        task={makeTask({
          paused: true,
          pausedReason: "duplicate-decision-required",
          sourceMetadata: { nearDuplicateOf: "FN-1234", duplicateSource: "triage-marker" },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByTestId("card-needs-user-feedback-FN-001")).toHaveTextContent("Needs your decision");
    expect(screen.getByText("Duplicate of FN-1234")).toBeInTheDocument();
  });

  it("renders duplicate chip when nearDuplicateOf is present", () => {
    render(
      <TaskCard
        task={makeTask({ sourceMetadata: { nearDuplicateOf: "FN-1234" } })}
        onOpenDetail={noop}
        addToast={noop}
        onUpdateTask={vi.fn()}
      />,
    );

    expect(screen.getByText("Duplicate of FN-1234")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep this task and dismiss duplicate warning" })).toBeInTheDocument();
  });

  it("hides duplicate chip when nearDuplicateDismissed is true", () => {
    render(
      <TaskCard
        task={makeTask({ sourceMetadata: { nearDuplicateOf: "FN-1234", nearDuplicateDismissed: true } })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.queryByText("Duplicate of FN-1234")).toBeNull();
  });

  it("hides duplicate chip when parent resolves the canonical as inactive or missing", () => {
    render(
      <TaskCard
        task={makeTask({ sourceMetadata: { nearDuplicateOf: "FN-1234" } })}
        nearDuplicateCanonicalInactive={true}
        onOpenDetail={noop}
        addToast={noop}
        onUpdateTask={vi.fn()}
      />,
    );

    expect(screen.queryByText("Duplicate of FN-1234")).toBeNull();
  });

  it("renders duplicate chip when canonical activity is unknown", () => {
    render(
      <TaskCard
        task={makeTask({ sourceMetadata: { nearDuplicateOf: "FN-1234" } })}
        nearDuplicateCanonicalInactive={undefined}
        onOpenDetail={noop}
        addToast={noop}
        onUpdateTask={vi.fn()}
      />,
    );

    expect(screen.getByText("Duplicate of FN-1234")).toBeInTheDocument();
  });

  it("hides duplicate chip in archived and done columns", () => {
    const { rerender } = render(
      <TaskCard
        task={makeTask({ column: "archived", sourceMetadata: { nearDuplicateOf: "FN-1234" } })}
        onOpenDetail={noop}
        addToast={noop}
        onUpdateTask={vi.fn()}
      />,
    );

    expect(screen.queryByText("Duplicate of FN-1234")).toBeNull();

    rerender(
      <TaskCard
        task={makeTask({ column: "done", sourceMetadata: { nearDuplicateOf: "FN-1234" } })}
        onOpenDetail={noop}
        addToast={noop}
        onUpdateTask={vi.fn()}
      />,
    );

    expect(screen.queryByText("Duplicate of FN-1234")).toBeNull();
  });

  it("clicking Keep calls updateTask dismissNearDuplicate", async () => {
    const onUpdateTask = vi.fn().mockResolvedValue(makeTask());

    render(
      <TaskCard
        task={makeTask({ sourceMetadata: { nearDuplicateOf: "FN-1234" } })}
        onOpenDetail={noop}
        addToast={noop}
        onUpdateTask={onUpdateTask}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Keep this task and dismiss duplicate warning" }));

    await waitFor(() => {
      expect(onUpdateTask).toHaveBeenCalledWith("FN-001", { dismissNearDuplicate: true });
    });
  });
});

/**
 * FNXC:TaskRevert 2026-07-04-00:00:
 * FN-7555 forward affordance coverage. Mirrors the near-duplicate chip test shape
 * above: an AI-undo task (`sourceMetadata.revertOf` set by `createAiUndoTask`) shows
 * an "Undo of <id>" footer chip; an ordinary task without that marker renders no chip
 * and no empty footer shell.
 */
describe("TaskCard undo-of chip", () => {
  it("renders undo-of chip when sourceMetadata.revertOf is present", () => {
    render(
      <TaskCard
        task={makeTask({ sourceMetadata: { revertOf: "FN-1234" } })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Undo of FN-1234")).toBeInTheDocument();
  });

  it("renders no undo-of chip and no empty footer shell for an ordinary task", () => {
    render(
      <TaskCard
        task={makeTask({ sourceMetadata: undefined })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.queryByText(/Undo of/)).toBeNull();
    expect(document.querySelector(".card-undo-chip")).toBeNull();
  });

  it("does not throw and renders nothing for malformed sourceMetadata.revertOf", () => {
    render(
      <TaskCard
        task={makeTask({ sourceMetadata: { revertOf: 12345 as any } })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.queryByText(/Undo of/)).toBeNull();
  });
});

/*
 * FNXC:TaskRevert 2026-07-16-00:00:
 * FN-8066 regression coverage locks the completed-source invariant at TaskCard,
 * the shared board/list card component: only persisted, non-blank revert markers
 * render the compact chip in done or archived columns, while other provenance
 * chips can coexist in the same footer cluster.
 */
describe("TaskCard reverted chip", () => {
  it.each(["done", "archived"] as const)("renders for reverted %s cards", (column) => {
    render(
      <TaskCard
        task={makeTask({ column, sourceMetadata: { revertedAt: "2026-07-16T00:00:00.000Z" } })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByLabelText("This task's changes were reverted")).toBeInTheDocument();
  });

  it("does not render for missing, blank, or non-completed revert markers", () => {
    const { rerender } = render(
      <TaskCard task={makeTask({ column: "done" })} onOpenDetail={noop} addToast={noop} />,
    );
    expect(document.querySelector(".card-reverted-chip")).toBeNull();

    rerender(
      <TaskCard
        task={makeTask({ column: "archived", sourceMetadata: { revertedAt: "  " } })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    expect(document.querySelector(".card-reverted-chip")).toBeNull();

    rerender(
      <TaskCard
        task={makeTask({ column: "todo", sourceMetadata: { revertedAt: "2026-07-16T00:00:00.000Z" } })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    expect(document.querySelector(".card-reverted-chip")).toBeNull();
  });

  it("coexists with undo and duplicate provenance chips", () => {
    render(
      <TaskCard
        task={makeTask({
          column: "done",
          sourceMetadata: {
            revertedAt: "2026-07-16T00:00:00.000Z",
            revertOf: "FN-1234",
            nearDuplicateOf: "FN-5678",
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Reverted")).toBeInTheDocument();
    expect(screen.getByText("Undo of FN-1234")).toBeInTheDocument();
    expect(screen.queryByText("Duplicate of FN-5678")).toBeNull();
  });
});

describe("TaskCard memo comparator provenance behavior", () => {
  it("returns false when prAuthAvailable changes", () => {
    const task = makeTask({ column: "in-review" });

    expect(
      __test_areTaskCardPropsEqual(
        { task, onOpenDetail: noop, addToast: noop, prAuthAvailable: false } as any,
        { task, onOpenDetail: noop, addToast: noop, prAuthAvailable: true } as any,
      ),
    ).toBe(false);
  });

  it("returns false when disableDrag changes", () => {
    const task = makeTask();

    expect(
      __test_areTaskCardPropsEqual(
        { task, onOpenDetail: noop, addToast: noop, disableDrag: false } as any,
        { task, onOpenDetail: noop, addToast: noop, disableDrag: true } as any,
      ),
    ).toBe(false);
  });

  it("returns false when board context-menu action handlers change", () => {
    const task = makeTask();
    const actionHandler = vi.fn();

    expect(
      __test_areTaskCardPropsEqual(
        { task, onOpenDetail: noop, addToast: noop, onPauseTask: actionHandler } as any,
        { task, onOpenDetail: noop, addToast: noop, onUnpauseTask: actionHandler } as any,
      ),
    ).toBe(false);
  });

  it("returns false when sourceMetadata.agentName changes", () => {
    const previousTask = makeTask({ sourceType: "automation", sourceMetadata: { agentName: "Agent One" } });
    const nextTask = makeTask({ sourceType: "automation", sourceMetadata: { agentName: "Agent Two" } });

    const previousProps = {
      task: previousTask,
      onOpenDetail: noop,
      addToast: noop,
    };
    const nextProps = {
      task: nextTask,
      onOpenDetail: noop,
      addToast: noop,
    };

    expect(__test_areTaskCardPropsEqual(previousProps as any, nextProps as any)).toBe(false);
  });

  it("returns false when sourceType changes", () => {
    const previousTask = makeTask({ sourceType: "automation", sourceMetadata: { agentName: "Agent" } });
    const nextTask = makeTask({ sourceType: "dashboard_ui", sourceMetadata: { agentName: "Agent" } });

    expect(
      __test_areTaskCardPropsEqual(
        { task: previousTask, onOpenDetail: noop, addToast: noop } as any,
        { task: nextTask, onOpenDetail: noop, addToast: noop } as any,
      ),
    ).toBe(false);
  });

  it("returns false when sourceAgentId changes", () => {
    const previousTask = makeTask({ sourceType: "automation", sourceAgentId: "agent-a" });
    const nextTask = makeTask({ sourceType: "automation", sourceAgentId: "agent-b" });

    expect(
      __test_areTaskCardPropsEqual(
        { task: previousTask, onOpenDetail: noop, addToast: noop } as any,
        { task: nextTask, onOpenDetail: noop, addToast: noop } as any,
      ),
    ).toBe(false);
  });

  it("returns false when branch changes", () => {
    const previousTask = makeTask({ branch: "feature/old", baseBranch: "main" });
    const nextTask = makeTask({ branch: "feature/new", baseBranch: "main" });

    expect(
      __test_areTaskCardPropsEqual(
        { task: previousTask, onOpenDetail: noop, addToast: noop } as any,
        { task: nextTask, onOpenDetail: noop, addToast: noop } as any,
      ),
    ).toBe(false);
  });

  it("returns false when baseBranch changes", () => {
    const previousTask = makeTask({ branch: "fusion/fn-001", baseBranch: "main" });
    const nextTask = makeTask({ branch: "fusion/fn-001", baseBranch: "release/2026-05" });

    expect(
      __test_areTaskCardPropsEqual(
        { task: previousTask, onOpenDetail: noop, addToast: noop } as any,
        { task: nextTask, onOpenDetail: noop, addToast: noop } as any,
      ),
    ).toBe(false);
  });

  it.each([
    { name: "mergeable", patch: { mergeable: "conflicting" } },
    { name: "draft", patch: { draft: true } },
    { name: "isDraft", patch: { isDraft: true } },
  ])("returns false when multi-PR badge $name color input changes", ({ patch }) => {
    const basePr = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      status: "open" as const,
      title: "PR",
      headBranch: "fusion/fn-001",
      baseBranch: "main",
      commentCount: 0,
    };
    const secondPr = { ...basePr, url: "https://github.com/owner/repo/pull/99", number: 99, title: "PR 2" };
    const previousTask = makeTask({ prInfos: [basePr, secondPr] as any });
    const nextTask = makeTask({ prInfos: [{ ...basePr, ...patch }, secondPr] as any });

    expect(
      __test_areTaskCardPropsEqual(
        { task: previousTask, onOpenDetail: noop, addToast: noop } as any,
        { task: nextTask, onOpenDetail: noop, addToast: noop } as any,
      ),
    ).toBe(false);
  });

  it("skips customFields JSON.stringify when both cardFieldDefs are absent", () => {
    // Without cardFieldDefs present, two tasks with different customFields should
    // compare equal (JSON.stringify is skipped — guard path).
    const taskA = makeTask({ customFields: { x: "a" } });
    const taskB = makeTask({ customFields: { x: "b" } });
    expect(
      __test_areTaskCardPropsEqual(
        { task: taskA, onOpenDetail: noop, addToast: noop } as any,
        { task: taskB, onOpenDetail: noop, addToast: noop } as any,
      ),
    ).toBe(true);
  });

  it("detects customFields change when cardFieldDefs are present on both sides", () => {
    const defs = [{ id: "sev", name: "Severity", type: "enum" as const, render: { placement: "card" as const } }];
    const taskA = makeTask({ customFields: { sev: "low" } });
    const taskB = makeTask({ customFields: { sev: "high" } });
    expect(
      __test_areTaskCardPropsEqual(
        { task: taskA, cardFieldDefs: defs, onOpenDetail: noop, addToast: noop } as any,
        { task: taskB, cardFieldDefs: defs, onOpenDetail: noop, addToast: noop } as any,
      ),
    ).toBe(false);
  });

  it("detects customFields change when only one side has cardFieldDefs", () => {
    const defs = [{ id: "sev", name: "Severity", type: "enum" as const, render: { placement: "card" as const } }];
    const task = makeTask({ customFields: { sev: "low" } });
    expect(
      __test_areTaskCardPropsEqual(
        { task, cardFieldDefs: undefined, onOpenDetail: noop, addToast: noop } as any,
        { task, cardFieldDefs: defs, onOpenDetail: noop, addToast: noop } as any,
      ),
    ).toBe(false);
  });

  it("detects workflow badge metadata changes", () => {
    const task = makeTask();
    expect(
      __test_areTaskCardPropsEqual(
        { task, workflowBadge: { workflowId: "builtin:coding", workflowName: "Coding" }, onOpenDetail: noop, addToast: noop } as any,
        { task, workflowBadge: { workflowId: "wf-custom", workflowName: "Custom Flow" }, onOpenDetail: noop, addToast: noop } as any,
      ),
    ).toBe(false);
  });
});

describe("TaskCard workflow badges", () => {
  it("renders a compact accessible workflow badge only when metadata is present", () => {
    const { container, rerender } = render(
      <TaskCard
        // FNXC:PlannerOversight 2026-07-04-00:00: pin the oversight level "off" so
        // the FN-7516 oversight/overseer-state badges don't populate
        // .card-meta-badges here — this test is specifically about workflow-badge
        // placement, not the oversight badges.
        task={makeTask({ plannerOversightLevel: "off" })}
        onOpenDetail={noop}
        addToast={noop}
        workflowBadge={{ workflowId: "wf-custom", workflowName: "Custom Flow", workflowIcon: "⚙️" }}
      />,
    );

    const badge = screen.getByTestId("card-workflow-badge");
    const row = screen.getByTestId("card-workflow-badge-row");
    const workflowBadgeBlock = [...loadAllAppCssBaseOnly().matchAll(/^\.card-workflow-badge\s*\{([^}]*)\}/gm)]
      .map((match) => match[1])
      .join("\n");
    expect(badge).toHaveTextContent("Custom Flow");
    expect(badge.querySelector(".workflow-icon")).not.toBeNull();
    expect(badge.querySelector(".workflow-icon")?.nextElementSibling).toHaveTextContent("Custom Flow");
    expect(workflowBadgeBlock).toContain("column-gap: calc(var(--space-xs) / 2);");
    expect(badge).toHaveAttribute("data-workflow-id", "wf-custom");
    expect(badge).toHaveAccessibleName("Workflow Custom Flow");
    expect(row).toContainElement(badge);
    expect(badge.closest(".card-meta-badges")).toBeNull();
    expect(container.querySelector(".card-meta-badges")).toBeNull();

    rerender(
      <TaskCard
        task={makeTask()}
        onOpenDetail={noop}
        addToast={noop}
        workflowBadge={{ workflowId: "", workflowName: "" }}
      />,
    );
    expect(screen.queryByTestId("card-workflow-badge")).toBeNull();
    expect(screen.queryByTestId("card-workflow-badge-row")).toBeNull();
  });

  it("keeps top badges in the meta cluster while rendering agent and workflow identity below card rows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T12:10:00.000Z"));

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-progress",
          priority: "high",
          executionMode: "fast",
          sourceType: "automation",
          sourceMetadata: { agentName: "Task Robot" },
          assignedAgentId: "agent-1",
          columnMovedAt: "2026-06-30T12:00:00.000Z",
          updatedAt: "2026-06-30T12:00:00.000Z",
          dependencies: ["FN-1"],
        })}
        onOpenDetail={noop}
        addToast={noop}
        workflowBadge={{ workflowId: "wf-long", workflowName: "Very long custom workflow name for aggregate cards", workflowIcon: "🧭" }}
      />,
    );

    const metaBadges = screen.getByTestId("card-meta-badges");
    const badge = screen.getByTestId("card-workflow-badge");
    const workflowRow = screen.getByTestId("card-workflow-badge-row");
    const agentRow = screen.getByTestId("card-agent-badge-row");
    const agentBadge = container.querySelector(".card-agent-created-badge");
    expect(metaBadges.querySelector(".card-priority-badge")).not.toBeNull();
    expect(metaBadges.querySelector(".card-execution-mode-badge")).not.toBeNull();
    expect(metaBadges.querySelector(".card-agent-created-badge")).toBeNull();
    expect(metaBadges.querySelector(".card-workflow-badge")).toBeNull();
    expect(agentRow).toContainElement(agentBadge as HTMLElement);
    expect(agentBadge?.closest(".card-header")).toBeNull();
    expect(workflowRow).toContainElement(badge);
    expect(agentRow.compareDocumentPosition(workflowRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(container.querySelector(".card-footer-row")).toBeNull();
    [".card-meta", ".card-agent-row"].forEach((selector) => {
      const row = container.querySelector(selector);
      expect(row, `${selector} should render for the placement fixture`).not.toBeNull();
      expect(row!.compareDocumentPosition(workflowRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    expect(badge.closest(".card-action-row")).toBeNull();
    vi.useRealTimers();
  });
});

describe("TaskCard mission badge", () => {
  // Access the internal cache reset helper
  let clearCache: () => void;

  beforeAll(async () => {
    const mod = await import("../TaskCard");
    clearCache = (mod as any).__test_clearMissionTitleCache;
  });

  beforeEach(() => {
    clearCache?.();
    vi.mocked(fetchMission).mockReset();
  });

  it("displays mission title instead of missionId", async () => {
    vi.mocked(fetchMission).mockResolvedValue({
      id: "M-ABC123",
      title: "Database Optimization",
      status: "active",
      interviewState: "completed",
      milestones: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const { container } = render(
      <TaskCard
        task={makeTask({ missionId: "M-ABC123" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = container.querySelector(".card-mission-badge");
    expect(badge).not.toBeNull();

    await waitFor(() => {
      // MAX_MISSION_TITLE_LENGTH is 12, so first 9 chars + "..."
      expect(badge?.textContent).toContain("Database ...");
    });
  });

  it("abbreviates long mission titles with ellipsis", async () => {
    vi.mocked(fetchMission).mockResolvedValue({
      id: "M-LONG1",
      title: "This Is A Very Long Mission Title That Exceeds Twenty Characters",
      status: "active",
      interviewState: "completed",
      milestones: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const { container } = render(
      <TaskCard
        task={makeTask({ missionId: "M-LONG1" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = container.querySelector(".card-mission-badge");
    expect(badge).not.toBeNull();

    await waitFor(() => {
      // MAX_MISSION_TITLE_LENGTH is 12, so first 9 chars + "..."
      expect(badge?.textContent).toContain("This Is A...");
    });
  });

  it("falls back to missionId on fetch error", async () => {
    vi.mocked(fetchMission).mockRejectedValue(new Error("Network error"));

    const { container } = render(
      <TaskCard
        task={makeTask({ missionId: "M-ERR99" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = container.querySelector(".card-mission-badge");
    expect(badge).not.toBeNull();

    await waitFor(() => {
      expect(badge?.textContent).toContain("M-ERR99");
    });
  });

  it("renders a promote action when onPromote is provided", () => {
    const onPromote = vi.fn().mockResolvedValue(undefined);
    const style = document.createElement("style");
    style.textContent = loadAllAppCss();
    document.head.appendChild(style);

    try {
      render(
        <TaskCard
          task={makeTask({ id: "FN-777", column: "todo" })}
          onOpenDetail={noop}
          addToast={noop}
          onPromote={onPromote}
        />,
      );

      const promoteButton = screen.getByTestId("card-promote-FN-777");
      expect(promoteButton).toBeDefined();
      expect(promoteButton).toHaveClass("card-promote-action");
      expect(promoteButton.textContent).toContain("Promote");

      const styles = getComputedStyle(promoteButton);
      expect(styles.gap).toBe("var(--space-xs)");
      expect(styles.padding).toBe("var(--space-xs) var(--space-sm)");
    } finally {
      style.remove();
    }
  });

  it("right-aligns the promote action inside the card action row", () => {
    const onPromote = vi.fn().mockResolvedValue(undefined);
    const css = loadAllAppCssBaseOnly();

    render(
      <TaskCard
        task={makeTask({ id: "FN-781", column: "todo" })}
        onOpenDetail={noop}
        addToast={noop}
        onPromote={onPromote}
      />,
    );

    const promoteButton = screen.getByTestId("card-promote-FN-781");
    const actionRow = promoteButton.closest(".card-action-row");

    expect(actionRow).not.toBeNull();
    expect(actionRow?.contains(promoteButton)).toBe(true);
    expect(css).toMatch(/\.card-promote-action\s*\{[^}]*margin-left:\s*auto;[^}]*\}/);
    expect(css).toMatch(/\.card-promote-action\.card-send-back-btn\s*\{[^}]*margin-left:\s*auto;[^}]*\}/);
  });

  it("keeps the promote action right-aligned in the mobile card action row", () => {
    const css = loadAllAppCss();
    const onPromote = vi.fn().mockResolvedValue(undefined);

    const soloRender = render(
      <TaskCard
        task={makeTask({ id: "FN-782", column: "todo" })}
        onOpenDetail={noop}
        addToast={noop}
        onPromote={onPromote}
      />,
    );

    const soloPromoteButton = screen.getByTestId("card-promote-FN-782");
    expect(soloPromoteButton.closest(".card-action-row")?.children).toHaveLength(1);
    expect(soloPromoteButton).toHaveClass("card-promote-action", "card-send-back-btn");
    soloRender.unmount();

    render(
      <TaskCard
        task={makeTask({ id: "FN-783", column: "in-review", paused: false, userPaused: false, prInfo: undefined as any })}
        onOpenDetail={noop}
        addToast={noop}
        onPromote={onPromote}
        prAuthAvailable={true}
        autoMergeEnabled={false}
      />,
    );

    const createPrButton = screen.getByRole("button", { name: "Create pull request" });
    const promoteButton = screen.getByTestId("card-promote-FN-783");
    const actionRow = promoteButton.closest(".card-action-row");

    expect(actionRow).not.toBeNull();
    expect(actionRow?.contains(createPrButton)).toBe(true);
    expect(createPrButton.compareDocumentPosition(promoteButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(css).toMatch(/@media[^{}]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.card-promote-action\.card-send-back-btn\s*\{[^}]*margin-left:\s*auto;[^}]*\}/);
  });

  it("calls onPromote without opening the card when promote is clicked", () => {
    const onPromote = vi.fn().mockResolvedValue(undefined);
    const onOpenDetail = vi.fn();

    render(
      <TaskCard
        task={makeTask({ id: "FN-778", column: "todo" })}
        onOpenDetail={onOpenDetail}
        addToast={noop}
        onPromote={onPromote}
      />,
    );

    fireEvent.click(screen.getByTestId("card-promote-FN-778"));

    expect(onPromote).toHaveBeenCalledWith("FN-778");
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("disables the promote action and shows loading copy while promoting", () => {
    const onPromote = vi.fn().mockResolvedValue(undefined);

    render(
      <TaskCard
        task={makeTask({ id: "FN-779", column: "todo" })}
        onOpenDetail={noop}
        addToast={noop}
        onPromote={onPromote}
        isPromoting
      />,
    );

    const promoteButton = screen.getByTestId("card-promote-FN-779") as HTMLButtonElement;
    expect(promoteButton.disabled).toBe(true);
    expect(promoteButton.textContent).toContain("Promoting…");

    fireEvent.click(promoteButton);
    expect(onPromote).not.toHaveBeenCalled();
  });

  it("does not render a promote action when onPromote is omitted", () => {
    render(
      <TaskCard
        task={makeTask({ id: "FN-780", column: "todo" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.queryByTestId("card-promote-FN-780")).toBeNull();
  });

  it("shows mission title in title attribute", async () => {
    vi.mocked(fetchMission).mockResolvedValue({
      id: "M-TITLE",
      title: "Refactor Auth",
      status: "active",
      interviewState: "completed",
      milestones: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const { container } = render(
      <TaskCard
        task={makeTask({ missionId: "M-TITLE" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = container.querySelector(".card-mission-badge");
    expect(badge).not.toBeNull();

    await waitFor(() => {
      expect(badge?.getAttribute("title")).toBe("Mission: Refactor Auth");
    });
  });

  it("shows short mission title without abbreviation", async () => {
    vi.mocked(fetchMission).mockResolvedValue({
      id: "M-SHORT",
      title: "Auth Fix",
      status: "active",
      interviewState: "completed",
      milestones: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const { container } = render(
      <TaskCard
        task={makeTask({ missionId: "M-SHORT" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = container.querySelector(".card-mission-badge");
    expect(badge).not.toBeNull();

    await waitFor(() => {
      // "Auth Fix" is 8 chars, well under 20 — no abbreviation needed
      expect(badge?.textContent).toContain("Auth Fix");
      expect(badge?.textContent).not.toContain("...");
    });
  });
});

describe("TaskCard Android tap regression", () => {
  function AndroidTapHarness({
    task,
    onOpenDetail,
    onOpenDetailWithTab,
    onClose,
  }: {
    task: Task;
    onOpenDetail: (task: Task) => void;
    onOpenDetailWithTab: (task: Task, tab: "changes") => void;
    onClose: () => void;
  }) {
    const [isOpen, setIsOpen] = React.useState(false);
    const nav = useNavigationHistory({ enabled: true });
    const overlayDismiss = useOverlayDismiss(() => {
      onClose();
      setIsOpen(false);
    });

    return (
      <NavigationHistoryProvider value={nav}>
        <TaskCard
          task={task}
          onOpenDetail={(nextTask) => {
            onOpenDetail(nextTask as Task);
            setIsOpen(true);
            nav.pushNav({
              type: "modal",
              close: () => {
                onClose();
                setIsOpen(false);
              },
            });
          }}
          onOpenDetailWithTab={onOpenDetailWithTab}
          addToast={noop}
        />
        {isOpen && (
          <div className="modal-overlay" data-testid="android-modal-overlay" {...overlayDismiss}>
            <div className="modal-content">detail</div>
          </div>
        )}
      </NavigationHistoryProvider>
    );
  }

  it("keeps modal open after Android compatibility mouse sequence and supports popstate close", () => {
    const onOpenDetail = vi.fn();
    const onOpenDetailWithTab = vi.fn();
    const onClose = vi.fn();
    const pushStateSpy = vi.spyOn(window.history, "pushState");

    render(
      <AndroidTapHarness
        task={makeTask({ column: "todo", status: undefined, mergeDetails: { landedFiles: ["a.ts"] } } as any)}
        onOpenDetail={onOpenDetail}
        onOpenDetailWithTab={onOpenDetailWithTab}
        onClose={onClose}
      />,
    );

    const card = document.querySelector(".card") as HTMLElement;
    fireEvent.touchStart(card, {
      touches: [{ clientX: 20, clientY: 20 }],
      changedTouches: [{ clientX: 20, clientY: 20 }],
    });
    fireEvent.touchEnd(card, {
      touches: [],
      changedTouches: [{ clientX: 20, clientY: 20 }],
    });

    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(pushStateSpy).toHaveBeenCalledTimes(1);

    const overlay = screen.getByTestId("android-modal-overlay");
    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);
    expect(onClose).toHaveBeenCalledTimes(0);

    window.dispatchEvent(new PopStateEvent("popstate", { state: { navIndex: 0 } }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps files-changed chip touch path opening changes tab once", () => {
    const onOpenDetail = vi.fn();
    const onOpenDetailWithTab = vi.fn();
    const onClose = vi.fn();
    const task = makeTask({
      column: "done",
      status: undefined,
      mergeDetails: { landedFiles: ["a.ts", "b.ts"] },
    } as any);

    render(
      <AndroidTapHarness
        task={task}
        onOpenDetail={onOpenDetail}
        onOpenDetailWithTab={onOpenDetailWithTab as any}
        onClose={onClose}
      />,
    );

    const filesChip = screen.getByRole("button", { name: "2 files changed" });
    fireEvent.touchStart(filesChip, {
      touches: [{ clientX: 12, clientY: 12 }],
      changedTouches: [{ clientX: 12, clientY: 12 }],
    });
    fireEvent.touchEnd(filesChip, {
      touches: [],
      changedTouches: [{ clientX: 12, clientY: 12 }],
    });
    fireEvent.click(filesChip);

    expect(onOpenDetailWithTab).toHaveBeenCalledTimes(1);
    expect(onOpenDetailWithTab).toHaveBeenCalledWith(task, "changes");
    expect(onOpenDetail).toHaveBeenCalledTimes(0);
    expect(onClose).toHaveBeenCalledTimes(0);
  });

  it("allows horizontal board pan from every non-editing card descendant on mobile", () => {
    const css = loadAllAppCssBaseOnly();

    expect(css).toMatch(
      /\.card:not\(\.card-editing\)\s*,\s*\.card:not\(\.card-editing\)\s+\*\s*\{[^}]*touch-action:\s*pan-x\s+pan-y;[^}]*\}/,
    );
  });
});

describe("TaskCard agent badge", () => {
  let clearAgentCache: () => void;

  beforeAll(async () => {
    const mod = await import("../TaskCard");
    clearAgentCache = (mod as { __test_clearAgentNameCache?: () => void }).__test_clearAgentNameCache ?? (() => undefined);
  });

  beforeEach(() => {
    clearAgentCache?.();
    localStorage.clear();
    vi.mocked(fetchAgent).mockReset();
    vi.mocked(fetchAgents).mockReset();
    vi.mocked(fetchAgents).mockResolvedValue([] as any);
  });

  it("renders agent badge synchronously from the seeded agents cache", () => {
    seedAgentsCache("p1", [{ id: "agent-001", name: "Task Robot" }]);

    const { container } = render(
      <TaskCard
        projectId="p1"
        task={makeTask({ assignedAgentId: "agent-001" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = container.querySelector(".card-agent-badge");
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("title")).toBe("Assigned to Task Robot");
    expect(badge?.className).not.toContain("card-agent-badge--loading");
    expect(badge?.querySelector(".card-agent-badge-text")?.textContent).toBe("Task Robot");
    expect(badge?.querySelector(".visually-hidden")?.textContent).toContain("Assigned to Task Robot");
    expect(fetchAgent).not.toHaveBeenCalled();
  });

  it("renders agent badge when task has assignedAgentId and falls back to fetchAgent on cache miss", async () => {
    vi.mocked(fetchAgent).mockResolvedValue({
      id: "agent-001",
      name: "Task Robot",
      role: "executor",
      state: "active",
      metadata: {},
      heartbeatHistory: [],
      completedRuns: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as any);

    render(
      <TaskCard
        task={makeTask({ assignedAgentId: "agent-001" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    await waitFor(() => {
      const badge = screen.getByTitle("Assigned to Task Robot");
      expect(badge).toBeDefined();
      expect(badge.querySelector(".visually-hidden")?.textContent).toContain("Assigned to Task Robot");
    });
  });

  it("does not render agent badge when assignedAgentId is undefined", () => {
    render(
      <TaskCard
        task={makeTask()}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.queryByTitle(/Assigned to/)).toBeNull();
  });
});

describe("TaskCard custom field badges (U13/KTD-14)", () => {
  type FieldDef = import("../../api").WorkflowFieldDefinition;
  const cardDef = (over: Partial<FieldDef> & Pick<FieldDef, "id" | "name" | "type">): FieldDef => ({
    render: { placement: "card" },
    ...over,
  });

  it("renders no badges and stays byte-identical when no field defs are passed", () => {
    const { container: withTask } = render(
      <TaskCard task={makeTask({ customFields: { x: "y" } })} onOpenDetail={noop} addToast={noop} />,
    );
    expect(withTask.querySelector('[data-testid="card-field-badges"]')).toBeNull();
  });

  it("renders an enum badge with the option color and label", () => {
    const defs: FieldDef[] = [
      cardDef({ id: "sev", name: "Severity", type: "enum", options: [{ value: "high", label: "High", color: "#ef4444" }] }),
    ];
    render(
      <TaskCard
        task={makeTask({ customFields: { sev: "high" } })}
        onOpenDetail={noop}
        addToast={noop}
        cardFieldDefs={defs}
      />,
    );
    const badge = screen.getByText("High");
    expect(badge.getAttribute("style")).toContain("rgb(239, 68, 68)");
  });

  it("renders a labeled chip for boolean true and nothing for false", () => {
    const defs: FieldDef[] = [cardDef({ id: "blk", name: "Blocked", type: "boolean" })];
    const { rerender } = render(
      <TaskCard task={makeTask({ customFields: { blk: true } })} onOpenDetail={noop} addToast={noop} cardFieldDefs={defs} />,
    );
    expect(screen.getByText("Blocked")).toBeTruthy();
    rerender(
      <TaskCard task={makeTask({ customFields: { blk: false } })} onOpenDetail={noop} addToast={noop} cardFieldDefs={defs} />,
    );
    expect(screen.queryByTestId("card-field-badges")).toBeNull();
  });

  it("caps at 3 badges and shows a +N overflow indicator", () => {
    const defs: FieldDef[] = [
      cardDef({ id: "a", name: "A", type: "string" }),
      cardDef({ id: "b", name: "B", type: "string" }),
      cardDef({ id: "c", name: "C", type: "string" }),
      cardDef({ id: "d", name: "D", type: "string" }),
      cardDef({ id: "e", name: "E", type: "string" }),
    ];
    render(
      <TaskCard
        task={makeTask({ customFields: { a: "1", b: "2", c: "3", d: "4", e: "5" } })}
        onOpenDetail={noop}
        addToast={noop}
        cardFieldDefs={defs}
      />,
    );
    const overflow = screen.getByTestId("card-field-overflow");
    expect(overflow.textContent).toBe("+2");
    // Exactly 3 value badges + 1 overflow chip.
    const container = screen.getByTestId("card-field-badges");
    expect(container.querySelectorAll(".card-field-badge").length).toBe(4);
  });

  it("ignores non-card-placed defs", () => {
    const defs: FieldDef[] = [
      { id: "detailOnly", name: "Detail", type: "string", render: { placement: "detail" } },
    ];
    render(
      <TaskCard
        task={makeTask({ customFields: { detailOnly: "x" } })}
        onOpenDetail={noop}
        addToast={noop}
        cardFieldDefs={defs}
      />,
    );
    expect(screen.queryByTestId("card-field-badges")).toBeNull();
  });
});

/*
FNXC:CodingIdeasWorkflow 2026-07-05-00:00:
FN-7596 regression-tests the TaskCard "Start" affordance that promotes a Coding (Ideas) manual-intake card. `showStartAction` requires taskColumnFlags.intake and a non-"triage" column; `startTargetColumn` derives the destination from `taskMoveColumns` (first non-intake/non-archived/non-hiddenFromBoard column) rather than a hard-coded "todo" string, per the FNXC comment at its call site.
*/
describe("TaskCard Start affordance (FN-7596)", () => {
  it("renders the Start button for a manual-intake column with onMoveTask provided", () => {
    render(
      <TaskCard
        task={makeTask({ column: "ideas" as any })}
        taskColumnFlags={{ intake: true }}
        onOpenDetail={noop}
        addToast={noop}
        onMoveTask={vi.fn()}
      />,
    );

    expect(screen.getByTestId("card-start-FN-001")).toBeInTheDocument();
  });

  it("omits the Start button when the column is not flagged as an intake", () => {
    render(
      <TaskCard
        task={makeTask({ column: "ideas" as any })}
        taskColumnFlags={{ intake: false }}
        onOpenDetail={noop}
        addToast={noop}
        onMoveTask={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("card-start-FN-001")).toBeNull();
  });

  it("omits the Start button for the triage column even when intake is flagged", () => {
    render(
      <TaskCard
        task={makeTask({ column: "triage" })}
        taskColumnFlags={{ intake: true }}
        onOpenDetail={noop}
        addToast={noop}
        onMoveTask={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("card-start-FN-001")).toBeNull();
  });

  it("omits the Start button when no onMoveTask handler is provided", () => {
    render(
      <TaskCard
        task={makeTask({ column: "ideas" as any })}
        taskColumnFlags={{ intake: true }}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.queryByTestId("card-start-FN-001")).toBeNull();
  });

  it("derives the Start target from taskMoveColumns instead of a hard-coded 'todo' string", async () => {
    const onMoveTask = vi.fn().mockResolvedValue(makeTask({ column: "custom-working-stage" as any }));
    const addToast = vi.fn();
    // The intake column itself, plus a non-intake working column that is NOT literally
    // named "todo", must win over any coincidental fallback — proving derivation, not a hard-coded string.
    const taskMoveColumns = [
      { id: "ideas" as any, label: "Ideas", flags: { intake: true } },
      { id: "custom-working-stage" as any, label: "Custom Working Stage", flags: {} },
      { id: "todo" as any, label: "Todo", flags: {} },
    ];

    render(
      <TaskCard
        task={makeTask({ column: "ideas" as any })}
        taskColumnFlags={{ intake: true }}
        taskMoveColumns={taskMoveColumns}
        onOpenDetail={noop}
        addToast={addToast}
        onMoveTask={onMoveTask}
      />,
    );

    fireEvent.click(screen.getByTestId("card-start-FN-001"));

    await waitFor(() => expect(onMoveTask).toHaveBeenCalledWith("FN-001", "custom-working-stage"));
  });

  it("falls back to 'todo' when taskMoveColumns metadata is unavailable", async () => {
    const onMoveTask = vi.fn().mockResolvedValue(makeTask({ column: "todo" }));
    render(
      <TaskCard
        task={makeTask({ column: "ideas" as any })}
        taskColumnFlags={{ intake: true }}
        onOpenDetail={noop}
        addToast={noop}
        onMoveTask={onMoveTask}
      />,
    );

    fireEvent.click(screen.getByTestId("card-start-FN-001"));

    await waitFor(() => expect(onMoveTask).toHaveBeenCalledWith("FN-001", "todo"));
  });

  it("disables the button and shows the Starting label while the move is in flight, then shows a success toast", async () => {
    let resolveMove: (task: ReturnType<typeof makeTask>) => void = () => {};
    const onMoveTask = vi.fn().mockImplementation(
      () => new Promise((resolve) => { resolveMove = resolve; }),
    );
    const addToast = vi.fn();

    render(
      <TaskCard
        task={makeTask({ column: "ideas" as any })}
        taskColumnFlags={{ intake: true }}
        onOpenDetail={noop}
        addToast={addToast}
        onMoveTask={onMoveTask}
      />,
    );

    const startButton = screen.getByTestId("card-start-FN-001");
    fireEvent.click(startButton);

    await waitFor(() => expect(startButton).toBeDisabled());
    expect(startButton.textContent).toContain("Starting");

    resolveMove(makeTask({ column: "todo" }));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.stringContaining("FN-001"), "success"));
    await waitFor(() => expect(startButton).not.toBeDisabled());
  });

  it("shows an error toast when the Start move fails", async () => {
    const onMoveTask = vi.fn().mockRejectedValue(new Error("move blocked"));
    const addToast = vi.fn();

    render(
      <TaskCard
        task={makeTask({ column: "ideas" as any })}
        taskColumnFlags={{ intake: true }}
        onOpenDetail={noop}
        addToast={addToast}
        onMoveTask={onMoveTask}
      />,
    );

    fireEvent.click(screen.getByTestId("card-start-FN-001"));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith("move blocked", "error"));
  });
});
