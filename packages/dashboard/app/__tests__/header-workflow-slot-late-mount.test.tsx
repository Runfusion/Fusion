import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { Header } from "../components/Header";
import { Board } from "../components/Board";

/*
FNXC:WorkflowControls 2026-09-15-01:44:
FN-405 symptom verification. The operator saw the workflow selector rendered in a
`div.board-workflow-toolbar` UNDER the header instead of inside the header, on the same line, left of
the search magnifier. Cause: Board/List resolved `#header-workflow-slot` exactly once and never
retried, so a header slot that mounts after the view — or a breakpoint swap that REPLACES the slot node
with a different node carrying the same id — pinned the selector to its inline fallback forever.

These cases render the REAL Header (which owns the slot and places it immediately before the search
button) together with the REAL Board, and prove document order rather than a fabricated slot node.
Browser automation is unavailable in this environment, so `compareDocumentPosition` between the
populated slot and the search button is the sanctioned executable substitute for a screenshot.
*/

const mockFetchScripts = vi.fn();

vi.mock("../api", () => ({
  fetchScripts: (...args: unknown[]) => mockFetchScripts(...args),
}));

const workflow = {
  id: "builtin:coding",
  name: "Coding (Ideas)",
  columns: [
    { id: "triage", name: "Triage", flags: { intake: true } },
    { id: "done", name: "Done", flags: { complete: true } },
  ],
};

vi.mock("../hooks/useBoardWorkflows", () => ({
  useBoardWorkflows: () => ({
    boardWorkflows: { defaultWorkflowId: workflow.id, workflows: [workflow], taskWorkflowIds: {} },
    workflowMode: true,
    workflowOptions: [workflow],
    selectedWorkflow: workflow,
    selectedWorkflowId: workflow.id,
    setSelectedWorkflowId: vi.fn(),
    refreshBoardWorkflows: vi.fn(),
    setBoardWorkflowsState: vi.fn(),
  }),
}));

vi.mock("../components/Column", () => ({ Column: () => null }));

type ViewportTier = "mobile" | "tablet" | "desktop";

function mockMatchMedia(tier: ViewportTier) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: tier === "mobile" ? 375 : 1280 });
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: tier === "mobile" && query.includes("max-width: 768px"),
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

function boardProps(overrides: Partial<React.ComponentProps<typeof Board>> = {}) {
  return {
    tasks: [],
    maxConcurrent: 2,
    showWorktreeGrouping: false,
    onMoveTask: vi.fn(async () => ({})),
    onOpenDetail: vi.fn(),
    addToast: vi.fn(),
    onNewTask: vi.fn(),
    autoMerge: true,
    onToggleAutoMerge: vi.fn(),
    planAutoApproveEnabled: false,
    onTogglePlanAutoApprove: vi.fn(),
    active: true,
    workflowControlsInHeader: true,
    ...overrides,
  } as React.ComponentProps<typeof Board>;
}

function Shell({
  leftSidebarNavActive,
  mobileNavEnabled = false,
  headerKey = "header",
}: {
  leftSidebarNavActive: boolean;
  mobileNavEnabled?: boolean;
  /** Remounting only the Header replaces the slot node while the Board instance is retained. */
  headerKey?: string;
}) {
  return (
    <>
      <Header
        key={headerKey}
        onOpenSettings={() => {}}
        onOpenGitHubImport={() => {}}
        onChangeView={() => {}}
        onSearchChange={() => {}}
        view="board"
        leftSidebarNavActive={leftSidebarNavActive}
        mobileNavEnabled={mobileNavEnabled}
      />
      <Board {...boardProps()} />
    </>
  );
}

function searchButton(): HTMLElement {
  /*
   * On desktop the Header renders the inline search trigger (`desktop-inline-header-search-btn`); the older ids are
   * still produced on the other hosts. The helper resolves whichever trigger the current host renders so the
   * "slot precedes search" ordering assertion keeps testing ordering rather than an obsolete id.
   */
  return screen.queryByTestId("alpha-desktop-header-search-btn")
    ?? screen.queryByTestId("desktop-inline-header-search-btn")
    ?? screen.getByTestId("desktop-header-search-btn");
}

beforeEach(() => {
  mockFetchScripts.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("header workflow slot placement", () => {
  it("renders the workflow selector inside the header, left of the search button", async () => {
    mockMatchMedia("desktop");
    render(<Shell leftSidebarNavActive />);

    const slot = await screen.findByTestId("header-workflow-slot");
    await waitFor(() => expect(slot.querySelector(".board-workflow-toolbar")).not.toBeNull());

    // The affordance the operator reported is inside the header, not under it.
    expect(slot.contains(screen.getByTestId("workflow-switcher"))).toBe(true);
    expect(document.querySelector(".board-workflow-view > .board-workflow-toolbar")).toBeNull();
    expect(document.querySelectorAll(".board-workflow-toolbar")).toHaveLength(1);

    // Same line, left of the magnifier: the populated slot precedes the search button.
    const search = searchButton();
    expect(slot.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("relocates the selector when the header slot mounts after the board", async () => {
    mockMatchMedia("desktop");
    const { rerender } = render(<Shell leftSidebarNavActive={false} />);

    // Header renders no slot yet: the documented inline fallback keeps the control reachable.
    await waitFor(() => expect(document.querySelector(".board-workflow-view > .board-workflow-toolbar")).not.toBeNull());
    expect(screen.queryByTestId("header-workflow-slot")).toBeNull();

    rerender(<Shell leftSidebarNavActive />);

    const slot = await screen.findByTestId("header-workflow-slot");
    await waitFor(() => expect(slot.querySelector(".board-workflow-toolbar")).not.toBeNull());
    expect(document.querySelector(".board-workflow-view > .board-workflow-toolbar")).toBeNull();
    expect(document.querySelectorAll(".board-workflow-toolbar")).toHaveLength(1);
    expect(slot.compareDocumentPosition(searchButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("migrates the selector when a breakpoint swap replaces the header slot node", async () => {
    mockMatchMedia("mobile");
    const { rerender } = render(<Shell leftSidebarNavActive mobileNavEnabled />);

    const mobileSlot = await screen.findByTestId("header-workflow-slot");
    expect(mobileSlot.className).toContain("header-workflow-slot--mobile");
    await waitFor(() => expect(mobileSlot.querySelector(".board-workflow-toolbar")).not.toBeNull());

    mockMatchMedia("desktop");
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    rerender(<Shell leftSidebarNavActive />);

    await waitFor(() => {
      const desktopSlot = screen.getByTestId("header-workflow-slot");
      expect(desktopSlot.className).not.toContain("header-workflow-slot--mobile");
      expect(desktopSlot.querySelector(".board-workflow-toolbar")).not.toBeNull();
    });
    // The replaced node no longer holds the affordance, and no inline copy reappeared.
    expect(mobileSlot.isConnected && mobileSlot.querySelector(".board-workflow-toolbar")).toBeFalsy();
    expect(document.querySelector(".board-workflow-view > .board-workflow-toolbar")).toBeNull();
    expect(document.querySelectorAll(".board-workflow-toolbar")).toHaveLength(1);
  });

  /*
  FNXC:WorkflowControls 2026-09-15-01:44:
  FN-405: a header shell can remount and REPLACE the slot with a different node carrying the same id
  without any viewport-mode change (project shell swap, keep-alive route return). The pre-fix
  viewport-keyed re-resolution could not see that, so the selector was stranded in a detached node.
  */
  it("migrates the selector when the header remounts its slot without a viewport change", async () => {
    mockMatchMedia("desktop");
    const { rerender } = render(<Shell leftSidebarNavActive headerKey="header-a" />);

    const firstSlot = await screen.findByTestId("header-workflow-slot");
    await waitFor(() => expect(firstSlot.querySelector(".board-workflow-toolbar")).not.toBeNull());

    rerender(<Shell leftSidebarNavActive headerKey="header-b" />);

    const secondSlot = screen.getByTestId("header-workflow-slot");
    expect(secondSlot).not.toBe(firstSlot);
    await waitFor(() => expect(secondSlot.querySelector(".board-workflow-toolbar")).not.toBeNull());
    expect(firstSlot.isConnected).toBe(false);
    expect(document.querySelector(".board-workflow-view > .board-workflow-toolbar")).toBeNull();
    expect(document.querySelectorAll(".board-workflow-toolbar")).toHaveLength(1);
    expect(secondSlot.compareDocumentPosition(searchButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the inline fallback exactly once when the header renders no slot at all", async () => {
    mockMatchMedia("desktop");
    render(<Shell leftSidebarNavActive={false} />);

    await waitFor(() => expect(document.querySelector(".board-workflow-view > .board-workflow-toolbar")).not.toBeNull());
    expect(screen.queryByTestId("header-workflow-slot")).toBeNull();
    expect(document.querySelectorAll(".board-workflow-toolbar")).toHaveLength(1);
  });
});
