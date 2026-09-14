import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ViewLayoutProvider, VIEW_SIDEBAR_STORAGE_KEY } from "../../context/ViewLayoutContext";
import { scopedKey } from "../../utils/projectStorage";
import { ViewSidebar } from "../ViewSidebar";

function SidebarHarness({ projectId = "project-a", mobile = false, hostIdentity = "host-a" }: { projectId?: string; mobile?: boolean; hostIdentity?: string }) {
  return (
    <ViewLayoutProvider projectId={projectId}>
      <ViewSidebar
        ariaLabel="Sessions"
        resizeLabel="Redimensionner la liste"
        panelTestId="sidebar-panel"
        mobile={mobile}
        hostIdentity={hostIdentity}
      >
        <button type="button">Session A</button>
      </ViewSidebar>
    </ViewLayoutProvider>
  );
}

describe("ViewSidebar", () => {
  beforeEach(() => localStorage.clear());

  it("rend la largeur et le séparateur canoniques", () => {
    render(<SidebarHarness />);
    expect(screen.getByTestId("sidebar-panel")).toHaveAttribute("aria-label", "Sessions");
    const frame = screen.getByTestId("sidebar-panel").parentElement!;
    expect(frame).toHaveAttribute("data-view-sidebar-width", "300");
    const separator = screen.getByRole("separator", { name: "Redimensionner la liste" });
    expect(separator).toHaveAttribute("aria-valuemin", "220");
    expect(separator).toHaveAttribute("aria-valuemax", "560");
    expect(separator).toHaveAttribute("aria-valuenow", "300");
  });

  it("partage le clavier et la persistance bornée", () => {
    render(<SidebarHarness />);
    const separator = screen.getByRole("separator");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "316");
    expect(localStorage.getItem(scopedKey(VIEW_SIDEBAR_STORAGE_KEY, "project-a"))).toBe("316");
    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator).toHaveAttribute("aria-valuenow", "220");
    fireEvent.keyDown(separator, { key: "End" });
    expect(separator).toHaveAttribute("aria-valuenow", "560");
    fireEvent.doubleClick(separator);
    expect(separator).toHaveAttribute("aria-valuenow", "300");
  });

  it("prévisualise un drag puis ne persiste qu’au relâchement", () => {
    render(<SidebarHarness />);
    const separator = screen.getByRole("separator") as HTMLElement;
    separator.setPointerCapture = vi.fn();
    separator.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(separator, { pointerId: 7, clientX: 100 });
    fireEvent.pointerMove(document, { pointerId: 7, clientX: 220 });
    expect(separator).toHaveAttribute("aria-valuenow", "420");
    expect(localStorage.getItem(scopedKey(VIEW_SIDEBAR_STORAGE_KEY, "project-a"))).toBeNull();
    fireEvent.pointerUp(document, { pointerId: 7, clientX: 220 });
    expect(localStorage.getItem(scopedKey(VIEW_SIDEBAR_STORAGE_KEY, "project-a"))).toBe("420");
    expect(separator.releasePointerCapture).toHaveBeenCalledWith(7);

    fireEvent.pointerDown(separator, { pointerId: 8, clientX: 220 });
    fireEvent.pointerMove(document, { pointerId: 8, clientX: 260 });
    fireEvent.pointerUp(document, { pointerId: 8, clientX: 260 });
    expect(separator).toHaveAttribute("aria-valuenow", "460");
    expect(localStorage.getItem(scopedKey(VIEW_SIDEBAR_STORAGE_KEY, "project-a"))).toBe("460");
  });

  it("annule pointercancel et libère la capture sans sauvegarde", () => {
    render(<SidebarHarness />);
    const separator = screen.getByRole("separator") as HTMLElement;
    separator.setPointerCapture = vi.fn();
    separator.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(separator, { pointerId: 3, clientX: 100 });
    fireEvent.pointerMove(document, { pointerId: 3, clientX: 180 });
    expect(separator).toHaveAttribute("aria-valuenow", "380");
    fireEvent.pointerCancel(document, { pointerId: 3 });
    expect(separator).toHaveAttribute("aria-valuenow", "300");
    expect(localStorage.getItem(scopedKey(VIEW_SIDEBAR_STORAGE_KEY, "project-a"))).toBeNull();
  });

  it("clôture l’ancien geste lors d’un changement de projet", () => {
    const { rerender } = render(<SidebarHarness projectId="project-a" />);
    const oldSeparator = screen.getByRole("separator") as HTMLElement;
    oldSeparator.setPointerCapture = vi.fn();
    oldSeparator.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(oldSeparator, { pointerId: 4, clientX: 100 });
    fireEvent.pointerMove(document, { pointerId: 4, clientX: 200 });
    rerender(<SidebarHarness projectId="project-b" />);
    const nextSeparator = screen.getByRole("separator");
    expect(nextSeparator).toHaveAttribute("aria-valuenow", "300");
    fireEvent.pointerUp(document, { pointerId: 4, clientX: 200 });
    expect(localStorage.getItem(scopedKey(VIEW_SIDEBAR_STORAGE_KEY, "project-a"))).toBeNull();
    expect(localStorage.getItem(scopedKey(VIEW_SIDEBAR_STORAGE_KEY, "project-b"))).toBeNull();
  });

  it("retire le séparateur et annule le drag au passage téléphone", () => {
    const { rerender } = render(<SidebarHarness />);
    const separator = screen.getByRole("separator") as HTMLElement;
    separator.setPointerCapture = vi.fn();
    separator.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(separator, { pointerId: 9, clientX: 100 });
    fireEvent.pointerMove(document, { pointerId: 9, clientX: 160 });
    rerender(<SidebarHarness mobile />);
    expect(screen.queryByRole("separator")).toBeNull();
    fireEvent.pointerUp(document, { pointerId: 9, clientX: 160 });
    expect(localStorage.getItem(scopedKey(VIEW_SIDEBAR_STORAGE_KEY, "project-a"))).toBeNull();
  });
});
