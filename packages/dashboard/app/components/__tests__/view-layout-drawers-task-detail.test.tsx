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

function setViewport(mode: "mobile" | "desktop", { drawers = true }: { drawers?: boolean } = {}) {
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
  if (mode === "mobile" && drawers) document.documentElement.dataset.mobileDrawers = "true";
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
    /*
    FNXC:StandardizedDrawers 2026-09-15-04:56:
    FN-406: the mobile More sheet joins the census because its hand-drawn grab bar was replaced by the shared handle.
    */
    expect(consumers).toEqual(["FloatingWindow.tsx", "MobileDrawer.tsx", "MobileNavBar.tsx", "TerminalModal.tsx"]);
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

  /*
  FNXC:StandardizedDrawers 2026-09-15-16:33:
  FN-427 supersedes the previous "one ChevronLeft in all six phone hosts" case. Task Detail owns no list→detail
  navigation, so its ChevronLeft only ever dismissed the surface; in drawer presentation the handle, scrim and Escape
  already do that, which made it duplicated chrome. It survives exactly where it is still the only visible way out:
  a phone without the `data-mobile-drawers` opt-in, and the inline phone hosts that are not drawers at all.
  */
  /** Hosts whose drawer presentation depends on the `data-mobile-drawers` opt-in (FloatingWindow shells). */
  const optInDrawerHosts = (onClose: () => void, onPopOut: () => void) => [
    ["overlay FloatingWindow", <TaskDetailModal key="overlay" {...sharedProps} onClose={onClose} onPopOut={onPopOut} />] as const,
    ["pop-out window", <AppTaskPopoutWindow key="popout" {...sharedProps} hidden={false} onRemoveWindow={onClose} onPopOut={onPopOut} />] as const,
  ];

  /** MobileDrawer is a drawer BY CONSTRUCTION: it publishes drawer presentation with or without the opt-in. */
  const mobileDrawerHost = (onClose: () => void, onPopOut: () => void) => [
    ["MobileDrawer", <TaskDetailModal key="drawer" {...sharedProps} onClose={onClose} onPopOut={onPopOut} mobileDrawer />] as const,
  ];

  const drawerHosts = (onClose: () => void, onPopOut: () => void) => [
    ...optInDrawerHosts(onClose, onPopOut),
    ...mobileDrawerHost(onClose, onPopOut),
  ];

  const inlineHosts = (onClose: () => void, onPopOut: () => void) => [
    ["main panel", <MainPanelTaskDetailHost key="panel" {...sharedProps} onNavigateToBoard={onClose} onPopOut={onPopOut} />] as const,
    ["list split", <ListSplitTaskDetailHost key="list" {...sharedProps} onClearSelection={onClose} onPopOut={onPopOut} />] as const,
    ["right dock", <RightDockTaskDetailHost key="dock" {...sharedProps} onCloseDock={onClose} onPopOut={onPopOut} />] as const,
  ];

  it("renders no back, close, pop-out, or fullscreen chrome in phone drawer presentation", () => {
    const onClose = vi.fn();
    const onPopOut = vi.fn();

    for (const [, host] of drawerHosts(onClose, onPopOut)) {
      const view = render(host);
      const surface = view.baseElement.querySelector<HTMLElement>(".task-detail-content")!;
      const header = surface.querySelector<HTMLElement>(":scope > .modal-header")!;
      expect(within(header).queryByRole("button", { name: "Back" })).toBeNull();
      expect(header.querySelector(".view-back-button")).toBeNull();
      expect(header.querySelector('[data-testid="task-detail-mobile-back"]')).toBeNull();
      // No residual shell: identity leads the header and no unnamed touch target survives the removal.
      expect(header.firstElementChild).toHaveClass("detail-header-copy");
      for (const button of Array.from(header.querySelectorAll("button"))) {
        expect((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()).not.toBe("");
      }
      expect(within(header).queryByRole("button", { name: "Close" })).toBeNull();
      expect(within(header).queryByTestId("task-detail-pop-out")).toBeNull();
      expect(surface.querySelector('[data-view-layout-zone="content"]')).toBeInTheDocument();
      fireEvent.click(within(surface).getByRole("button", { name: "Activity" }));
      expect(within(surface).queryByTestId("task-chat-expand-toggle")).toBeNull();
      view.unmount();
    }
  });

  it("keeps exactly one ChevronLeft before identity on a phone without the drawer opt-in", () => {
    setViewport("mobile", { drawers: false });
    const onClose = vi.fn();
    const onPopOut = vi.fn();

    for (const [, host] of [...optInDrawerHosts(onClose, onPopOut), ...inlineHosts(onClose, onPopOut)]) {
      const view = render(host);
      const surface = view.baseElement.querySelector<HTMLElement>(".task-detail-content")!;
      const header = surface.querySelector<HTMLElement>(":scope > .modal-header")!;
      const back = within(header).getByRole("button", { name: "Back" });
      expect(back).toHaveClass("view-back-button");
      expect(back.querySelector(".lucide-chevron-left")).toBeInTheDocument();
      expect(header.firstElementChild).toBe(back);
      expect(header.children[1]).toHaveClass("detail-header-copy");
      expect(header.querySelectorAll(".view-back-button")).toHaveLength(1);
      // The back control is the only visible way out here, because the canonical close stays hidden on every phone.
      expect(within(header).queryByRole("button", { name: "Close" })).toBeNull();
      expect(within(header).queryByTestId("task-detail-pop-out")).toBeNull();
      view.unmount();
    }

    // MobileDrawer stays dismissible through its own handle and scrim, so it drops the back control either way.
    for (const [, host] of mobileDrawerHost(onClose, onPopOut)) {
      const view = render(host);
      const header = view.baseElement.querySelector<HTMLElement>(".task-detail-content > .modal-header")!;
      expect(within(header).queryByRole("button", { name: "Back" })).toBeNull();
      expect(header.firstElementChild).toHaveClass("detail-header-copy");
      view.unmount();
    }
  });

  it("keeps the ChevronLeft in inline phone hosts that are not drawers even with the opt-in", () => {
    const onClose = vi.fn();
    const onPopOut = vi.fn();

    for (const [, host] of inlineHosts(onClose, onPopOut)) {
      const view = render(host);
      const surface = view.baseElement.querySelector<HTMLElement>(".task-detail-content")!;
      const header = surface.querySelector<HTMLElement>(":scope > .modal-header")!;
      const back = within(header).getByRole("button", { name: "Back" });
      expect(header.firstElementChild).toBe(back);
      expect(within(header).queryByRole("button", { name: "Close" })).toBeNull();
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
