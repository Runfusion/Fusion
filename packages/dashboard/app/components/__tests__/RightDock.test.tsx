import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RightDock, RIGHT_DOCK_VIEW_STORAGE_KEY, RIGHT_DOCK_WIDTH_STORAGE_KEY } from "../RightDock";
import { RightDockExpandModal } from "../RightDockExpandModal";
import { useRightDockController, type RightDockControllerInput } from "../useRightDockController";

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchWorkspaceFileList: vi.fn().mockResolvedValue({ entries: [], currentPath: "." }),
  };
});

const renderProps = {
  addToast: vi.fn(),
  projectId: "project-1",
};

/*
FNXC:Navigation 2026-06-22-16:00:
The right dock is now an all-inline tools rail sourced from STATIC_OVERFLOW_VIEW_ENTRIES in overflowViewRegistry. The roster, in registry order, is files, activity-log, git-manager, devserver (gated on devServerView), secrets, todos (gated on todosEnabled), pull-requests. The earlier usage/github-import/automation launcher actions were removed, so every visible tab is an inline view that switches the dock body and can expand into the modal.
*/
const toolTabIds = [
  "right-dock-tab-files",
  "right-dock-tab-activity-log",
  "right-dock-tab-git-manager",
  "right-dock-tab-devserver",
  "right-dock-tab-secrets",
  "right-dock-tab-todos",
  "right-dock-tab-pull-requests",
];

const removedViewTabIds = [
  "right-dock-tab-usage",
  "right-dock-tab-github-import",
  "right-dock-tab-automation",
  "right-dock-tab-documents",
  "right-dock-tab-research",
  "right-dock-tab-insights",
  "right-dock-tab-skills",
  "right-dock-tab-memory",
  "right-dock-tab-evals",
  "right-dock-tab-goals",
  "right-dock-tab-stash-recovery",
];

describe("RightDock", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("renders Files by default and restores the persisted inline view on remount", () => {
    const { unmount } = render(<RightDock open={true} renderProps={renderProps} />);

    expect(screen.getByTestId("right-dock-tab-files")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("right-dock-files-view")).toBeInTheDocument();

    /*
    FNXC:Navigation 2026-06-22-16:00:
    Every right-dock tab is now an inline view, so selecting one (git-manager) persists it and the dock restores that selection on remount instead of snapping back to Files.
    */
    fireEvent.click(screen.getByTestId("right-dock-tab-git-manager"));
    expect(screen.getByTestId("right-dock-tab-git-manager")).toHaveAttribute("aria-selected", "true");
    expect(window.localStorage.getItem(RIGHT_DOCK_VIEW_STORAGE_KEY)).toBe("git-manager");
    unmount();

    render(<RightDock open={true} renderProps={renderProps} />);
    expect(screen.getByTestId("right-dock-tab-git-manager")).toHaveAttribute("aria-selected", "true");
  });

  it("falls back to Files when storage points at a removed right-dock view", () => {
    window.localStorage.setItem(RIGHT_DOCK_VIEW_STORAGE_KEY, "documents");
    render(<RightDock open={true} renderProps={renderProps} />);

    expect(screen.getByTestId("right-dock-tab-files")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("right-dock-files-view")).toBeInTheDocument();
    expect(screen.queryByTestId("right-dock-tab-documents")).toBeNull();
  });

  it("renders exactly the current right-dock tool entries and no removed content-view tabs", () => {
    render(
      <RightDock
        open={true}

        renderProps={renderProps}
        visibilityOptions={{
          experimentalFeatures: {
            insights: true,
            memoryView: true,
            devServerView: true,
            researchView: true,
            evalsView: true,
            goalsView: true,
          },
          showSkillsTab: true,
          todosEnabled: true,
        }}
      />,
    );

    /*
    FNXC:Navigation 2026-06-22-16:00:
    With devServerView and todosEnabled both on, the full seven-entry roster renders in registry order. Files, Activity Log, Git Manager, Dev Server, Secrets, Todos, and Pull Requests are all inline views.
    */
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("data-testid"))).toEqual(toolTabIds);
    expect(screen.getByTestId("right-dock-tab-files")).toHaveAttribute("aria-label", "Files");
    expect(screen.getByTestId("right-dock-tab-activity-log")).toHaveAttribute("aria-label", "Activity Log");
    expect(screen.getByTestId("right-dock-tab-git-manager")).toHaveAttribute("aria-label", "Git Manager");
    expect(screen.getByTestId("right-dock-tab-devserver")).toHaveAttribute("aria-label", "Dev Server");
    expect(screen.getByTestId("right-dock-tab-secrets")).toHaveAttribute("aria-label", "Secrets");
    expect(screen.getByTestId("right-dock-tab-todos")).toHaveAttribute("aria-label", "Todos");
    expect(screen.getByTestId("right-dock-tab-pull-requests")).toHaveAttribute("aria-label", "Pull Requests");
    for (const removedId of removedViewTabIds) {
      expect(screen.queryByTestId(removedId)).toBeNull();
    }
  });

  it("gates devserver and todos tabs behind their visibility flags", () => {
    /*
    FNXC:Navigation 2026-06-22-16:00:
    devserver is gated on experimentalFeatures.devServerView and todos on todosEnabled. With both unset (default renderProps), the dock renders only the five always-on inline tools.
    */
    render(<RightDock open={true} renderProps={renderProps} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("data-testid"))).toEqual([
      "right-dock-tab-files",
      "right-dock-tab-activity-log",
      "right-dock-tab-git-manager",
      "right-dock-tab-secrets",
      "right-dock-tab-pull-requests",
    ]);
    expect(screen.queryByTestId("right-dock-tab-devserver")).toBeNull();
    expect(screen.queryByTestId("right-dock-tab-todos")).toBeNull();
  });

  it("clicking an inline tool tab switches the dock body and selection, and Files returns home", () => {
    /*
    FNXC:Navigation 2026-06-22-16:00:
    The right dock no longer hosts launcher-action tabs that fire Header handlers; every tab is an inline view. Clicking a non-Files tab selects it (aria-selected flips, Files deselects) and replaces the body, and the Files tab restores the inline Files view.
    */
    render(<RightDock open={true} renderProps={renderProps} />);

    expect(screen.getByTestId("right-dock-tab-files")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("right-dock-files-view")).toBeInTheDocument();

    for (const tabId of ["right-dock-tab-activity-log", "right-dock-tab-git-manager", "right-dock-tab-secrets"]) {
      fireEvent.click(screen.getByTestId(tabId));
      expect(screen.getByTestId(tabId)).toHaveAttribute("aria-selected", "true");
      expect(screen.getByTestId("right-dock-tab-files")).toHaveAttribute("aria-selected", "false");
      expect(screen.queryByTestId("right-dock-files-view")).toBeNull();
    }

    fireEvent.click(screen.getByTestId("right-dock-tab-files"));
    expect(screen.getByTestId("right-dock-tab-files")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("right-dock-files-view")).toBeInTheDocument();
  });

  it("clamps then persists resize width while open", () => {
    render(<RightDock open={true} renderProps={renderProps} />);

    const handle = screen.getByTestId("right-dock-resize-handle");
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 900 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 0 });
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 0 });
    expect(window.localStorage.getItem(RIGHT_DOCK_WIDTH_STORAGE_KEY)).toBe("720");

    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(window.localStorage.getItem(RIGHT_DOCK_WIDTH_STORAGE_KEY)).toBe("672");
  });

  it("restores persisted width on mount", () => {
    window.localStorage.setItem(RIGHT_DOCK_WIDTH_STORAGE_KEY, "400");
    render(<RightDock open={true} renderProps={renderProps} />);

    expect(screen.getByTestId("right-dock")).toHaveStyle({ width: "400px" });
    expect(screen.getByTestId("right-dock-resize-handle")).toHaveAttribute("aria-valuenow", "400");
  });

  // FNXC:Navigation 2026-06-22-09:00: Show/hide is owned by the canonical Header right-sidebar toggle. The dock no longer renders an in-dock collapse toggle or a collapsed rail; when open=false it renders nothing so the main content reclaims the space.
  it("renders nothing when closed and renders the dock content when open", () => {
    const { rerender } = render(<RightDock open={true} renderProps={renderProps} />);

    // Show/hide invariant only — the exact tab set is owned by overflowViewRegistry, not asserted here.
    expect(screen.getByTestId("right-dock")).toBeInTheDocument();
    expect(screen.getByTestId("right-dock-body")).toBeInTheDocument();
    expect(screen.getByTestId("right-dock-resize-handle")).toBeInTheDocument();
    expect(screen.getAllByRole("tab").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("right-dock-collapse-toggle")).toBeNull();

    rerender(<RightDock open={false} renderProps={renderProps} />);
    expect(screen.queryByTestId("right-dock")).toBeNull();
    expect(screen.queryByTestId("right-dock-body")).toBeNull();
    expect(screen.queryByTestId("right-dock-resize-handle")).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);

    rerender(<RightDock open={true} renderProps={renderProps} />);
    expect(screen.getByTestId("right-dock")).toBeInTheDocument();
    expect(screen.getByTestId("right-dock-body")).toBeInTheDocument();
  });

  it("renders the expanded modal through the same registry and restores focus on close", async () => {
    const onClose = vi.fn();
    const focusButton = document.createElement("button");
    document.body.appendChild(focusButton);
    const focusSpy = vi.spyOn(focusButton, "focus");

    render(
      <RightDockExpandModal
        viewKey="files"
        renderProps={renderProps}
        onClose={onClose}
        returnFocusRef={{ current: focusButton }}
      />,
    );

    expect(screen.getByTestId("right-dock-expand-modal")).toBeInTheDocument();
    expect(screen.getByTestId("right-dock-expand-body")).toBeInTheDocument();
    /*
    FNXC:RightDock 2026-06-22-17:40:
    The pop-out is a floating, non-blocking window: the overlay carries the non-blocking class (transparent + pointer-events:none in CSS so behind-clicks pass through), a drag handle (header) exists, and the panel is the floating variant. There is no overlay click-to-dismiss; the explicit close button is the only dismissal.
    */
    expect(screen.getByTestId("right-dock-expand-modal")).toHaveClass("right-dock-expand-modal-overlay");
    expect(screen.getByTestId("right-dock-expand-modal")).toHaveAttribute("aria-modal", "false");
    expect(screen.getByTestId("right-dock-expand-drag-handle")).toBeInTheDocument();
    expect(screen.getByTestId("right-dock-expand-modal").querySelector(".right-dock-expand-modal--floating")).not.toBeNull();
    expect(screen.getByTestId("right-dock-expand-resize-se")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("right-dock-expand-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(focusSpy).toHaveBeenCalled();
    focusButton.remove();
  });

  it("does not render the expanded modal for action entries", () => {
    render(
      <RightDockExpandModal
        viewKey="automation"
        renderProps={renderProps}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("right-dock-expand-modal")).toBeNull();
  });

  it("restores the expanded modal's persisted size", () => {
    window.localStorage.setItem("fusion:right-dock-expand-modal-size", JSON.stringify({ width: 640, height: 480 }));
    render(
      <RightDockExpandModal
        viewKey="files"
        renderProps={renderProps}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId("right-dock-expand-modal").querySelector(".right-dock-expand-modal")).toHaveStyle({
      width: "640px",
      height: "480px",
    });
  });

  it("drags the floating pop-out by its header and clamps + persists the new position", () => {
    /*
    FNXC:RightDock 2026-06-22-17:40:
    Pointerdown on the header drag handle then pointermove moves the panel via state-driven fixed left/top, and pointerup persists the clamped position. Assert the panel moved and that a position was persisted (clamped on-screen).

    FNXC:RightDock 2026-06-22-18:50:
    Move/up are now dispatched on the captured handle element (not document) because the handler attaches its pointermove/up/cancel listeners to the captured target — setPointerCapture redirects the touch stream there, which is what makes touch dragging smooth.
    */
    render(
      <RightDockExpandModal
        viewKey="files"
        renderProps={renderProps}
        onClose={vi.fn()}
      />,
    );

    const handle = screen.getByTestId("right-dock-expand-drag-handle");
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 60, clientY: 140 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 60, clientY: 140 });

    const persisted = window.localStorage.getItem("fusion:right-dock-expand-modal-position");
    expect(persisted).not.toBeNull();
    const parsed = JSON.parse(persisted as string) as { x: number; y: number };
    expect(parsed.x).toBeGreaterThanOrEqual(0);
    expect(parsed.y).toBeGreaterThanOrEqual(0);
  });

  it("fires expand for the currently selected inline entry", () => {
    /*
    FNXC:Navigation 2026-06-22-16:00:
    Every tab is inline, so the expand button fires onExpand with whichever inline entry is selected (here git-manager after switching away from the default Files).
    */
    const onExpand = vi.fn();
    render(<RightDock open={true} renderProps={renderProps} onExpand={onExpand} />);
    fireEvent.click(screen.getByTestId("right-dock-tab-git-manager"));
    fireEvent.click(screen.getByTestId("right-dock-expand"));
    expect(onExpand).toHaveBeenCalledWith("git-manager");
  });

  /*
  FNXC:RightDock 2026-06-22-18:50:
  The popped-out expand modal is independent of the dock's open state. This drives the real controller, pops out a view, then toggles the dock closed and asserts the floating modal is STILL mounted and interactive — only its own close button dismisses it. Guards against the regression where toggling the dock cleared expandedView (and where the modal was a child of the dock that early-returns null when closed).
  */
  it("keeps the popped-out expand modal mounted when the dock is toggled closed", () => {
    const controllerInput = {
      active: true,
      projectId: "project-1",
      addToast: vi.fn(),
      settingsLoaded: true,
      researchReadinessVersion: 0,
      tasks: [],
      workflowSteps: [],
      subscribePluginEvents: () => () => {},
      openDetailTask: vi.fn(),
      openFileInBrowser: vi.fn(),
      openSettings: vi.fn(),
      onSendSelectionToTask: vi.fn(),
      onCreateTaskFromInsight: vi.fn(),
      onNavigateToMission: vi.fn(),
      onTaskCreated: vi.fn(),
      workflowStepNameLookup: new Map<string, string>(),
      prAuthAvailable: false,
      autoMerge: false,
      visibilityOptions: {},
      footerVisible: false,
    } as unknown as RightDockControllerInput;

    function Harness() {
      const controller = useRightDockController(controllerInput);
      return (
        <>
          <button type="button" data-testid="harness-toggle-dock" onClick={controller.toggle}>
            toggle dock
          </button>
          {controller.dock}
          {controller.modal}
        </>
      );
    }

    render(<Harness />);

    // Pop out the currently selected (Files) view: the floating modal appears AND
    // popping out closes the dock (pop-out dismisses the dock so the full-width app
    // sits behind the movable modal). The dock unmounts; the floating modal survives.
    fireEvent.click(screen.getByTestId("right-dock-expand"));
    expect(screen.getByTestId("right-dock-expand-modal")).toBeInTheDocument();
    expect(screen.queryByTestId("right-dock")).toBeNull();
    expect(screen.getByTestId("right-dock-expand-body")).toBeInTheDocument();

    // Re-opening the dock does not disturb the independent floating modal.
    fireEvent.click(screen.getByTestId("harness-toggle-dock"));
    expect(screen.getByTestId("right-dock-expand-modal")).toBeInTheDocument();

    // Its own close button still dismisses it.
    fireEvent.click(screen.getByTestId("right-dock-expand-close"));
    expect(screen.queryByTestId("right-dock-expand-modal")).toBeNull();
  });
});
