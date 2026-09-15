import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listComponentFiles, readAppFile } from "../../test/cssFixture";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  resetTaskDetailFetchMock,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { MobileDrawer } from "../MobileDrawer";
import { FloatingWindow } from "../FloatingWindow";
import { TaskDetailModal } from "../TaskDetailModal";
import {
  AppTaskPopoutWindow,
  ListSplitTaskDetailHost,
  MainPanelTaskDetailHost,
  RightDockTaskDetailHost,
} from "../TaskDetailHostBoundaries";

setupTaskDetailModalHooks();

const originalWidth = window.innerWidth;
const originalMatchMedia = window.matchMedia;

function setViewport(mode: "mobile" | "desktop") {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: mode === "mobile" ? 390 : 1280 });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: mode === "mobile" && (query.includes("max-width") || query.includes("max-height")),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  document.documentElement.dataset.viewportMode = mode;
  if (mode === "mobile") document.documentElement.dataset.mobileDrawers = "true";
  else delete document.documentElement.dataset.mobileDrawers;
}

const sharedProps = {
  task: makeTask({ id: "FN-379-DETAIL", column: "todo" }),
  initialTab: "definition" as const,
  onDeleteTask: noopDelete,
  onMergeTask: noopMerge,
  onOpenDetail: noopOpenDetail,
  addToast: noop,
};

describe("shared drawer and Task Detail view layout", () => {
  it("keeps the drawer handle inventory on the shared primitive", () => {
    const consumers = listComponentFiles()
      .filter((file) => !file.startsWith("__tests__/") && file !== "ViewDrawer.tsx")
      .filter((file) => readAppFile(`components/${file}`).includes("<ViewDrawerHandle"))
      .sort();
    expect(consumers).toEqual(["FloatingWindow.tsx", "MobileDrawer.tsx", "TerminalModal.tsx"]);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await resetTaskDetailFetchMock();
    setViewport("mobile");
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
    delete document.documentElement.dataset.viewportMode;
    delete document.documentElement.dataset.mobileDrawers;
  });

  it("uses one shared handle and ordered zones in Alpha and FloatingWindow drawers", () => {
    const alpha = render(
      <MobileDrawer open title="Alpha" onClose={noop}>
        <div>Alpha content</div>
      </MobileDrawer>,
    );
    const alphaDialog = screen.getByRole("dialog", { name: "Alpha" });
    expect(alphaDialog.querySelectorAll(":scope > .view-drawer__handle-target")).toHaveLength(1);
    expect(Array.from(alphaDialog.children).map((child) => child.getAttribute("data-view-layout-zone")).filter(Boolean)).toEqual(["header", "content"]);
    alpha.unmount();

    const floating = render(
      <FloatingWindow windowKey="shared-drawer" title="Floating" onClose={noop}>
        <div>Floating content</div>
      </FloatingWindow>,
    );
    const floatingPanel = screen.getByTestId("floating-window-shared-drawer");
    expect(floatingPanel.querySelectorAll(":scope > .view-drawer__handle-target")).toHaveLength(1);
    expect(floatingPanel.querySelector('[data-view-layout-zone="header"]')).toBeInTheDocument();
    expect(floatingPanel.querySelector('[data-view-layout-zone="content"]')).toBeInTheDocument();
    floating.unmount();
  });

  it("renders one ChevronLeft before identity and no close, pop-out, or fullscreen chrome in all six phone hosts", () => {
    const onClose = vi.fn();
    const onPopOut = vi.fn();
    const hosts = [
      <TaskDetailModal key="overlay" {...sharedProps} onClose={onClose} onPopOut={onPopOut} />,
      <MainPanelTaskDetailHost key="panel" {...sharedProps} onNavigateToBoard={onClose} onPopOut={onPopOut} />,
      <ListSplitTaskDetailHost key="list" {...sharedProps} onClearSelection={onClose} onPopOut={onPopOut} />,
      <RightDockTaskDetailHost key="dock" {...sharedProps} onCloseDock={onClose} onPopOut={onPopOut} />,
      <TaskDetailModal key="drawer" {...sharedProps} onClose={onClose} onPopOut={onPopOut} mobileDrawer />,
      <AppTaskPopoutWindow key="popout" {...sharedProps} hidden={false} onRemoveWindow={onClose} onPopOut={onPopOut} />,
    ];

    for (const host of hosts) {
      const view = render(host);
      const surface = view.baseElement.querySelector<HTMLElement>(".task-detail-content")!;
      const header = surface.querySelector<HTMLElement>(":scope > .modal-header")!;
      const back = within(header).getByRole("button", { name: "Back" });
      expect(back).toHaveClass("view-back-button");
      expect(back.querySelector(".lucide-chevron-left")).toBeInTheDocument();
      expect(header.firstElementChild).toBe(back);
      expect(header.children[1]).toHaveClass("detail-header-copy");
      expect(within(header).queryByRole("button", { name: "Close" })).toBeNull();
      expect(within(header).queryByTestId("task-detail-pop-out")).toBeNull();
      expect(surface.querySelector('[data-view-layout-zone="content"]')).toBeInTheDocument();
      fireEvent.click(within(surface).getByRole("button", { name: "Activity" }));
      expect(within(surface).queryByTestId("task-chat-expand-toggle")).toBeNull();
      view.unmount();
    }
  });

  it("retains close, pop-out, and FloatingWindow resize chrome on desktop", () => {
    setViewport("desktop");
    render(<TaskDetailModal {...sharedProps} onClose={noop} onPopOut={noop} />);
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.getByTestId("task-detail-pop-out")).toBeInTheDocument();
    expect(document.querySelectorAll(".floating-window__resize-handle").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
});
