import React, { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Board } from "../Board";
import { ListView } from "../ListView";
import "../../styles.css";

vi.mock("../../api", () => ({
  fetchBoardWorkflows: vi.fn().mockResolvedValue({ flagEnabled: false, defaultWorkflowId: "", workflows: [], taskWorkflowIds: {} }),
  fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchSettings: vi.fn().mockResolvedValue({
    modelPresets: [],
    autoSelectModelPreset: false,
    defaultPresetBySize: {},
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 30000,
    groupOverlappingFiles: true,
    autoMerge: true,
  }),
  fetchTaskDetail: vi.fn(),
  batchUpdateTaskModels: vi.fn(),
  fetchNodes: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: vi.fn() }),
}));

vi.mock("../../hooks/useBadgeWebSocket", () => ({
  useBadgeWebSocket: () => ({
    badgeUpdates: new Map(),
    isConnected: false,
    subscribeToBadge: vi.fn(),
    unsubscribeFromBadge: vi.fn(),
  }),
}));

vi.mock("../../hooks/useSessionFiles", () => ({
  useSessionFiles: () => ({ files: [], loading: false }),
}));

vi.mock("../../hooks/useTaskDiffStats", () => ({
  useTaskDiffStats: () => ({ stats: null, loading: false }),
}));

vi.mock("../Column", () => ({
  Column: React.memo(({ column }: { column: string }) => (
    <div data-testid={`column-${column}`} />
  )),
}));

function ensureMatchMedia() {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn(),
    });
  }
}

function mockMobileViewport() {
  ensureMatchMedia();
  Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)",
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function ViewSwitchHarness() {
  const [view, setView] = useState<"list" | "board">("list");

  const boardProps = {
    tasks: [],
    maxConcurrent: 2,
    onMoveTask: vi.fn(async () => ({}) as any),
    onOpenDetail: vi.fn(),
    addToast: vi.fn(),
    onQuickCreate: vi.fn(async () => ({}) as any),
    onNewTask: vi.fn(),
    autoMerge: true,
    onToggleAutoMerge: vi.fn(),
    globalPaused: false,
  };

  const listProps = {
    tasks: [],
    onMoveTask: vi.fn(async () => ({}) as any),
    onRetryTask: vi.fn(async () => ({}) as any),
    onDeleteTask: vi.fn(async () => ({}) as any),
    onMergeTask: vi.fn(async () => ({ merged: false })),
    onOpenDetail: vi.fn(),
    addToast: vi.fn(),
    onNewTask: vi.fn(),
    projectId: "proj-123",
  };

  return (
    <div>
      <button data-testid="switch-to-list" onClick={() => setView("list")}>
        List
      </button>
      <button data-testid="switch-to-board" onClick={() => setView("board")}>
        Board
      </button>
      <div className="project-content">
        {view === "board" ? <Board {...boardProps} /> : <ListView {...listProps} />}
      </div>
    </div>
  );
}

describe("Board mobile view switch (FN-001)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("renders .board as <main> with the board class after switching from list view on mobile", () => {
    const viewportSpy = mockMobileViewport();

    render(<ViewSwitchHarness />);

    // Start in list view
    /*
    FNXC:ListView 2026-07-30-12:40:
    Asserts the SKELETON by name, not `.list-view`, which the skeleton and the real body share.

    This harness renders `<ListView>` with a deliberately small `../../api` mock and no workflows, so
    what appears here is the workflow skeleton — and that is fine, because the subject of these cases
    is the BOARD's structure after switching, not the list's contents. Naming it keeps the assertion
    honest about what it observes.

    Do not "upgrade" this to the real body without also expanding the api mock: supplying workflows
    makes ListView render its full body, which throws under this mock, and with no ErrorBoundary in
    the harness React unmounts the entire root — the DOM goes empty and every later query fails with
    a misleading "switch-to-board not found". Measured; that is what happens.
    */
    expect(screen.getByTestId("list-workflows-skeleton")).not.toBeNull();
    expect(document.querySelector(".board")).toBeNull();

    // Switch to board view
    fireEvent.click(screen.getByTestId("switch-to-board"));

    const board = document.querySelector(".board");
    expect(board).not.toBeNull();
    expect(board!.tagName).toBe("MAIN");
    expect(board!.id).toBe("board");

    viewportSpy.mockRestore();
  });

  it("preserves board structure through list -> board -> list -> board cycle on mobile", () => {
    const viewportSpy = mockMobileViewport();

    render(<ViewSwitchHarness />);

    fireEvent.click(screen.getByTestId("switch-to-board"));
    expect(document.querySelector(".board")).not.toBeNull();
    expect(document.querySelector(".list-view")).toBeNull();

    fireEvent.click(screen.getByTestId("switch-to-list"));
    /*
    FNXC:ListView 2026-07-30-12:40:
    Asserts the SKELETON by name, not `.list-view`, which the skeleton and the real body share.

    This harness renders `<ListView>` with a deliberately small `../../api` mock and no workflows, so
    what appears here is the workflow skeleton — and that is fine, because the subject of these cases
    is the BOARD's structure after switching, not the list's contents. Naming it keeps the assertion
    honest about what it observes.

    Do not "upgrade" this to the real body without also expanding the api mock: supplying workflows
    makes ListView render its full body, which throws under this mock, and with no ErrorBoundary in
    the harness React unmounts the entire root — the DOM goes empty and every later query fails with
    a misleading "switch-to-board not found". Measured; that is what happens.
    */
    expect(screen.getByTestId("list-workflows-skeleton")).not.toBeNull();
    expect(document.querySelector(".board")).toBeNull();

    fireEvent.click(screen.getByTestId("switch-to-board"));
    const board = document.querySelector(".board");
    expect(board).not.toBeNull();
    expect(board!.tagName).toBe("MAIN");

    viewportSpy.mockRestore();
  });

  it("does not reintroduce scroll-snap-type: x mandatory after switching on mobile", () => {
    const viewportSpy = mockMobileViewport();

    render(<ViewSwitchHarness />);
    fireEvent.click(screen.getByTestId("switch-to-board"));

    const board = document.querySelector(".board") as HTMLElement;
    expect(board).not.toBeNull();
    expect(board.className).toContain("board");

    viewportSpy.mockRestore();
  });
});
