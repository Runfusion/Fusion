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
import { FloatingWindow } from "../FloatingWindow";
import { ConfirmDialog } from "../ConfirmDialog";
import { AlphaMobileDrawer } from "../AlphaMobileDrawer";
import { AlphaDialog } from "../alpha-ui/AlphaPrimitives";
import { AlphaBoundary } from "../../context/AlphaContext";

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
    const closeAlphaDialog = vi.fn();
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
        <AlphaBoundary>
          <AlphaDialog labelledBy="alpha-title" onClose={closeAlphaDialog}><h2 id="alpha-title">Alpha dialog</h2></AlphaDialog>
        </AlphaBoundary>
        <AlphaMobileDrawer open title="Drawer" onClose={closeDrawer}>Drawer body</AlphaMobileDrawer>
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
    expect(closeAlphaDialog).not.toHaveBeenCalled();
    expect(closeDrawer).not.toHaveBeenCalled();
    expect(screen.getByText("Still mounted")).toBeInTheDocument();
    expect(screen.getByText("Alpha dialog")).toBeInTheDocument();
    expect(screen.getByText("Drawer body")).toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));
    expect(productionPanel.style.zIndex).toBe(originalZ);
    expect(localStorage.getItem("floating-window:production")).toBe(originalGeometry);
  });

  it("leaves the shared FloatingWindow usable without a provider", () => {
    const close = vi.fn();
    render(<FloatingWindow windowKey="standalone" title="Standalone" onClose={close}>body</FloatingWindow>);
    const overlay = screen.getByTestId("floating-window-overlay-standalone");
    expect(overlay).not.toHaveAttribute("data-dashboard-window-globally-hidden");
    fireEvent.click(screen.getByTestId("floating-window-close-standalone"));
    expect(close).toHaveBeenCalledOnce();
  });
});
