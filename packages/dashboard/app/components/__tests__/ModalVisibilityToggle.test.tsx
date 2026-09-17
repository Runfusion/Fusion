import { useState, type ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DashboardWindowManagerProvider,
  DashboardWindowManagerScope,
  useDashboardWindowSurface,
  useDashboardWindowVisibility,
} from "../../context/DashboardWindowManagerContext";
import { useDashboardKeyboardShortcuts } from "../../hooks/useDashboardKeyboardShortcuts";
import { DashboardWindowVisibilityToggle } from "../DashboardWindowVisibilityToggle";
import { DesktopActionBar } from "../DesktopActionBar";
import { buildDashboardNavigationEntries } from "../dashboardNavigationEntries";
import { useExecutorStats } from "../../hooks/useExecutorStats";
import { FloatingWindow } from "../FloatingWindow";
import { ConfirmDialog } from "../ConfirmDialog";
import { MobileDrawer } from "../MobileDrawer";
import { UiDialog } from "../ui/UiPrimitives";

function ManagedFixture({ id, locallyVisible = true, stackOrder = 0, children }: { id: string; locallyVisible?: boolean; stackOrder?: number; children?: ReactNode }) {
  const surface = useDashboardWindowSurface({ logicalId: id, locallyVisible, stackOrder });
  return (
    <div
      ref={surface.rootRef}
      hidden={!locallyVisible}
      aria-hidden={!locallyVisible || surface.globallyHidden || undefined}
      inert={!locallyVisible || surface.globallyHidden || undefined}
      data-testid={`managed-${id}`}
      data-dashboard-window-surface={surface.surfaceAttributes["data-dashboard-window-surface"]}
      data-dashboard-window-globally-hidden={surface.surfaceAttributes["data-dashboard-window-globally-hidden"]}
      style={{ zIndex: stackOrder }}
      tabIndex={-1}
    >
      {children}
    </div>
  );
}

vi.mock("../../hooks/useExecutorStats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useExecutorStats")>();
  return { ...actual, useExecutorStats: vi.fn(() => ({ stats: { runningTaskCount: 0, maxConcurrent: 4 }, loading: false, error: null, refresh: vi.fn() })) };
});

/** Production footer host: DesktopActionBar mounts the toggle itself, so this harness adds no second control. */
function FooterHarness({ children }: { children?: ReactNode }) {
  return (
    <DashboardWindowManagerProvider>
      <DashboardWindowManagerScope scopeKey="project-a" />
      <main>{children}</main>
      <DesktopActionBar
        entries={buildDashboardNavigationEntries({ view: "board", onChangeView: vi.fn(), onNewTask: vi.fn(), onOpenSettings: vi.fn(), showAgents: true })}
        activeId="board"
        tasks={[]}
      />
    </DashboardWindowManagerProvider>
  );
}

function ToggleHarness({ children, scope = "project-a" }: { children?: ReactNode; scope?: string }) {
  return (
    <DashboardWindowManagerProvider>
      <DashboardWindowManagerScope scopeKey={scope} />
      <main>{children}</main>
      <footer><DashboardWindowVisibilityToggle /></footer>
    </DashboardWindowManagerProvider>
  );
}

function VisibilityShortcutHarness() {
  const visibility = useDashboardWindowVisibility();
  useDashboardKeyboardShortcuts({
    shortcuts: { toggleModalVisibility: "Alt+M" },
    toggleModalVisibility: () => visibility?.toggleVisibility(),
    toggleTerminal: () => undefined,
    toggleFiles: () => undefined,
    toggleSettings: () => undefined,
    toggleCommandCenter: () => undefined,
    toggleNewTask: () => undefined,
    toggleChatList: () => undefined,
  });
  return null;
}

function SnapshotHarness() {
  const [showFirst, setShowFirst] = useState(true);
  const [showNew, setShowNew] = useState(false);
  return (
    <ToggleHarness>
      {showFirst ? <ManagedFixture id="duplicate" stackOrder={10101}><input aria-label="draft" defaultValue="preserved" /></ManagedFixture> : null}
      <ManagedFixture id="duplicate" stackOrder={10102}><div data-testid="scroll-state">second</div></ManagedFixture>
      <ManagedFixture id="owner-hidden" locallyVisible={false}>hidden by owner</ManagedFixture>
      {showNew ? <ManagedFixture id="new-window">new</ManagedFixture> : null}
      <button type="button" onClick={() => setShowFirst(false)}>close first</button>
      <button type="button" onClick={() => setShowNew(true)}>open new</button>
    </ToggleHarness>
  );
}

/*
FNXC:DashboardWindowVisibility 2026-09-14-10:52:
The global toggle snapshots opaque mount identities rather than logical names. These behavior tests preserve mounted state/focus/stack geometry while covering duplicate, owner-hidden, removed, newly opened, nested, and project-reset surfaces through the production provider and footer control.
*/
describe("Dashboard window visibility toggle", () => {
  beforeEach(() => {
    document.getElementById("dashboard-window-toggle-root")?.remove();
    const root = document.createElement("div");
    root.id = "dashboard-window-toggle-root";
    document.body.appendChild(root);
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    vi.stubGlobal("ResizeObserver", class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { this.callback([], this as unknown as ResizeObserver); }
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === "dashboard-window-visibility-placeholder") {
        return { left: 1200, top: 764, right: 1280, bottom: 800, width: 80, height: 36, x: 1200, y: 764, toJSON() {} };
      }
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.getElementById("dashboard-window-toggle-root")?.remove();
  });

  it("keeps duplicate mounted surfaces intact and restores focus without changing stack geometry", async () => {
    render(<SnapshotHarness />);
    const toggle = await screen.findByTestId("dashboard-window-visibility-toggle");
    const duplicates = screen.getAllByTestId("managed-duplicate");
    expect(toggle.parentElement).toHaveAttribute("id", "dashboard-window-toggle-root");
    expect(toggle.closest("footer")).toBeNull();
    expect(toggle.style.getPropertyValue("--dashboard-window-toggle-left")).toBe("1200px");
    expect(toggle.style.getPropertyValue("--dashboard-window-toggle-top")).toBe("764px");
    const input = screen.getByRole("textbox", { name: "draft" });
    const scrollState = screen.getByTestId("scroll-state");
    scrollState.scrollTop = 37;
    input.focus();

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    expect(duplicates).toHaveLength(2);
    expect(duplicates.every((surface) => surface.getAttribute("data-dashboard-window-globally-hidden") === "true")).toBe(true);
    expect(duplicates.every((surface) => surface.hasAttribute("inert"))).toBe(true);
    expect(screen.getByTestId("managed-owner-hidden")).not.toHaveAttribute("data-dashboard-window-globally-hidden");
    expect(input).toHaveValue("preserved");
    expect(scrollState.scrollTop).toBe(37);
    expect(duplicates.map((surface) => surface.style.zIndex)).toEqual(["10101", "10102"]);
    await waitFor(() => expect(toggle).toHaveFocus());

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));
    expect(duplicates.every((surface) => !surface.hasAttribute("data-dashboard-window-globally-hidden"))).toBe(true);
    await waitFor(() => expect(input).toHaveFocus());
    expect(scrollState.scrollTop).toBe(37);
    expect(duplicates.map((surface) => surface.style.zIndex)).toEqual(["10101", "10102"]);
  });

  it("intersects a snapshot with live mounts and restores it before showing a newly opened surface", async () => {
    render(<SnapshotHarness />);
    const toggle = await screen.findByTestId("dashboard-window-visibility-toggle");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));

    fireEvent.click(screen.getByRole("button", { name: "close first" }));
    expect(screen.getAllByTestId("managed-duplicate")).toHaveLength(1);
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "open new" }));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));
    expect(screen.getByTestId("managed-new-window")).not.toHaveAttribute("data-dashboard-window-globally-hidden");
    expect(screen.getByTestId("managed-duplicate")).not.toHaveAttribute("data-dashboard-window-globally-hidden");
  });

  it("clears ephemeral hidden state when project scope changes", async () => {
    const { rerender } = render(<ToggleHarness scope="project-a"><ManagedFixture id="scoped">scoped</ManagedFixture></ToggleHarness>);
    const toggle = await screen.findByTestId("dashboard-window-visibility-toggle");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));

    rerender(<ToggleHarness scope="project-b"><ManagedFixture id="scoped">scoped</ManagedFixture></ToggleHarness>);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));
    expect(screen.getByTestId("managed-scoped")).not.toHaveAttribute("data-dashboard-window-globally-hidden");
  });

  it("keeps nested surfaces distinct and disables the control when no visible surface exists", async () => {
    const { rerender } = render(<ToggleHarness />);
    const toggle = await screen.findByTestId("dashboard-window-visibility-toggle");
    expect(toggle).toBeDisabled();

    rerender(<ToggleHarness><ManagedFixture id="outer"><ManagedFixture id="inner">inner</ManagedFixture></ManagedFixture></ToggleHarness>);
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);
    expect(screen.getByTestId("managed-outer")).toHaveAttribute("data-dashboard-window-globally-hidden", "true");
    expect(screen.getByTestId("managed-inner")).toHaveAttribute("data-dashboard-window-globally-hidden", "true");
  });

  it("restores the manager snapshot by shortcut while its footer button owns focus", async () => {
    render(
      <ToggleHarness>
        <VisibilityShortcutHarness />
        <ManagedFixture id="shortcut-window">body</ManagedFixture>
      </ToggleHarness>,
    );

    const toggle = await screen.findByTestId("dashboard-window-visibility-toggle");
    fireEvent.keyDown(document, { key: "m", altKey: true });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    await waitFor(() => expect(document.activeElement).toBe(toggle));

    fireEvent.keyDown(toggle, { key: "m", altKey: true });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));
    expect(screen.getByTestId("managed-shortcut-window")).not.toHaveAttribute("data-dashboard-window-globally-hidden");
  });

  it("disarms production Escape and outside-dismiss handlers while their retained surfaces are hidden", async () => {
    const closeWindow = vi.fn();
    const closeConfirm = vi.fn();
    const closeUiDialog = vi.fn();
    const closeDrawer = vi.fn();
    render(
      <ToggleHarness>
        <FloatingWindow windowKey="production" title="Production" onClose={closeWindow} closeOnOutsidePointerDown persistGeometryKey="floating-window:production">body</FloatingWindow>
        <ConfirmDialog
          isOpen
          options={{ title: "Confirm action", message: "Still mounted" }}
          onConfirm={vi.fn()}
          onCancel={closeConfirm}
        />
        <>
          <UiDialog labelledBy="alpha-title" onClose={closeUiDialog}><h2 id="alpha-title">Alpha dialog</h2></UiDialog>
        </>
        <MobileDrawer open title="Drawer" onClose={closeDrawer}>Drawer body</MobileDrawer>
      </ToggleHarness>,
    );
    const toggle = await screen.findByTestId("dashboard-window-visibility-toggle");
    const productionPanel = screen.getByTestId("floating-window-production");
    const originalZ = productionPanel.style.zIndex;
    const originalGeometry = localStorage.getItem("floating-window:production");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.pointerDown(document.body);
    expect(closeWindow).not.toHaveBeenCalled();
    expect(closeConfirm).not.toHaveBeenCalled();
    expect(closeUiDialog).not.toHaveBeenCalled();
    expect(closeDrawer).not.toHaveBeenCalled();
    expect(screen.getByText("Still mounted")).toBeInTheDocument();
    expect(screen.getByText("Alpha dialog")).toBeInTheDocument();
    expect(screen.getByText("Drawer body")).toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));
    expect(productionPanel.style.zIndex).toBe(originalZ);
    expect(localStorage.getItem("floating-window:production")).toBe(originalGeometry);
  });

  /*
  FNXC:DashboardWindowVisibility 2026-09-14-17:46:
  FN-392 symptom: hide then show had to be purely visual. With two real modal windows mounted in one order and then
  deliberately reordered by raising the first, a full hide/restore must return the SAME DOM nodes with the SAME z-index
  values, invoke no close callback, and keep a child dialog above its parent. A real click afterwards must still raise,
  which is what distinguishes "restore claims nothing" from "focus-to-front is broken".
  */
  it("restores two reordered modal windows as the same nodes, layers, and children", async () => {
    const closeFirst = vi.fn();
    const closeSecond = vi.fn();
    const closeDialog = vi.fn();
    render(
      <ToggleHarness>
        <FloatingWindow windowKey="first" title="First" modal onClose={closeFirst}>
          <button type="button">first body</button>
          <>
            <UiDialog labelledBy="child-dialog-title" onClose={closeDialog}><h2 id="child-dialog-title">Child dialog</h2></UiDialog>
          </>
        </FloatingWindow>
        <FloatingWindow windowKey="second" title="Second" modal onClose={closeSecond}>
          <button type="button">second body</button>
        </FloatingWindow>
      </ToggleHarness>,
    );

    const toggle = await screen.findByTestId("dashboard-window-visibility-toggle");
    const firstOverlay = screen.getByTestId("floating-window-overlay-first");
    const secondOverlay = screen.getByTestId("floating-window-overlay-second");
    const dialogOverlay = document.querySelector('[data-dashboard-window-surface="child-dialog-title"]') as HTMLElement;

    // Second mounted last, so it starts on top; a real press on the first window deliberately inverts that order.
    expect(Number(secondOverlay.style.zIndex)).toBeGreaterThan(Number(firstOverlay.style.zIndex));
    fireEvent.pointerDown(screen.getByTestId("floating-window-first"));
    await waitFor(() => expect(Number(firstOverlay.style.zIndex)).toBeGreaterThan(Number(secondOverlay.style.zIndex)));

    // Interacting with the child dialog puts it back above its freshly raised parent.
    fireEvent.pointerDown(screen.getByRole("heading", { name: "Child dialog" }));
    await waitFor(() => expect(Number(dialogOverlay.style.zIndex)).toBeGreaterThan(Number(firstOverlay.style.zIndex)));
    const layersBefore = [firstOverlay.style.zIndex, secondOverlay.style.zIndex, dialogOverlay.style.zIndex];

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    expect(firstOverlay).toHaveAttribute("data-dashboard-window-globally-hidden", "true");
    expect(secondOverlay).toHaveAttribute("data-dashboard-window-globally-hidden", "true");
    expect(dialogOverlay).toHaveAttribute("data-dashboard-window-globally-hidden", "true");
    expect(firstOverlay).toHaveAttribute("inert");
    expect(firstOverlay).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));

    expect(screen.getByTestId("floating-window-overlay-first")).toBe(firstOverlay);
    expect(screen.getByTestId("floating-window-overlay-second")).toBe(secondOverlay);
    expect(document.querySelector('[data-dashboard-window-surface="child-dialog-title"]')).toBe(dialogOverlay);
    await waitFor(() => expect(firstOverlay).not.toHaveAttribute("data-dashboard-window-globally-hidden"));
    expect([firstOverlay.style.zIndex, secondOverlay.style.zIndex, dialogOverlay.style.zIndex]).toEqual(layersBefore);
    expect(closeFirst).not.toHaveBeenCalled();
    expect(closeSecond).not.toHaveBeenCalled();
    expect(closeDialog).not.toHaveBeenCalled();

    // A real interaction after the restore still raises a window: only restoration focus is neutral.
    fireEvent.pointerDown(screen.getByTestId("floating-window-second"));
    await waitFor(() => expect(Number(secondOverlay.style.zIndex)).toBeGreaterThan(Number(layersBefore[0])));
  });

  it("leaves the shared FloatingWindow usable without a provider", () => {
    const close = vi.fn();
    render(<FloatingWindow windowKey="standalone" title="Standalone" onClose={close}>body</FloatingWindow>);
    const overlay = screen.getByTestId("floating-window-overlay-standalone");
    expect(overlay).not.toHaveAttribute("data-dashboard-window-globally-hidden");
    fireEvent.click(screen.getByTestId("floating-window-close-standalone"));
    expect(close).toHaveBeenCalledOnce();
  });

  /*
  FNXC:DashboardWindowVisibility 2026-09-15-19:42:
  FN-432 symptom: opening the footer More menu raised the whole opaque bar above the portaled control, which vanished.
  The control is a global escape hatch, so it must stay mounted, enabled, and clickable while that menu is open.
  */
  // (h)
  it("stays mounted, enabled and clickable while the footer More menu is open", async () => {
    vi.mocked(useExecutorStats).mockReturnValue({ stats: { runningTaskCount: 0, maxConcurrent: 4 } as never, loading: false, error: null, refresh: vi.fn() });
    render(<FooterHarness><ManagedFixture id="visible-window">body</ManagedFixture></FooterHarness>);

    const toggle = await screen.findByTestId("dashboard-window-visibility-toggle");
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.pointerEnter(screen.getByTestId("desktop-nav-more"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByTestId("desktop-action-bar")).toHaveClass("desktop-action-bar--menu-open");

    expect(screen.getByTestId("dashboard-window-visibility-toggle")).toBe(toggle);
    expect(toggle.parentElement).toHaveAttribute("id", "dashboard-window-toggle-root");
    expect(toggle).not.toBeDisabled();

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByTestId("managed-visible-window")).toHaveAttribute("data-dashboard-window-globally-hidden", "true");
  });
});
