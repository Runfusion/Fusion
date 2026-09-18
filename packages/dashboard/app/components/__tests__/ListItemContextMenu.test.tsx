import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ListItemContextMenu, type ListItemMenuAction } from "../ListItemContextMenu";
import { isInsidePortalSafeSurface } from "../../utils/portalSurfaces";

const anchor = { key: "p1:note:a", x: 40, y: 60 };

function actions(overrides: Partial<ListItemMenuAction>[] = []): ListItemMenuAction[] {
  return [
    { id: "rename", label: "Rename", onSelect: vi.fn(), ...overrides[0] },
    { id: "delete", label: "Delete", tone: "danger", onSelect: vi.fn(), ...overrides[1] },
  ];
}

describe("ListItemContextMenu", () => {
  it("renders nothing without an anchor or without actions", () => {
    const { rerender } = render(<ListItemContextMenu anchor={null} ariaLabel="Note actions" actions={actions()} onClose={vi.fn()} />);
    expect(screen.queryByRole("menu")).toBeNull();
    rerender(<ListItemContextMenu anchor={anchor} ariaLabel="Note actions" actions={[]} onClose={vi.fn()} />);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("portals into the body as a portal-safe surface positioned at the anchor", () => {
    render(<ListItemContextMenu anchor={anchor} ariaLabel="Note actions" actions={actions()} onClose={vi.fn()} />);
    const menu = screen.getByRole("menu", { name: "Note actions" });
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.left).toBe("40px");
    expect(menu.style.top).toBe("60px");
    expect(isInsidePortalSafeSurface(menu)).toBe(true);
  });

  /*
  FNXC:ContextMenuLayering 2026-09-18-01:13:
  FN-521 : le menu ne fige plus de calque au montage. Un `zIndex` inline issu du compteur de fenêtres est
  toujours ≤ au plafond publié, donc il perdait contre l'hôte déclaré à `calc(var(--fusion-max-z) + 3)`.
  Le calque vient désormais du CSS de `.list-item-context-menu`, dérivé du plafond vivant.
  */
  it("renders without an inline layer so the ceiling-derived CSS step owns stacking", () => {
    render(<ListItemContextMenu anchor={anchor} ariaLabel="Note actions" actions={actions()} onClose={vi.fn()} />);
    const menu = screen.getByRole("menu", { name: "Note actions" });
    expect(menu.style.zIndex).toBe("");
    expect(menu.getAttribute("style")).not.toContain("z-index");
    expect(menu.classList.contains("list-item-context-menu")).toBe(true);
  });

  it("selects an action once, closes first, and never runs a disabled action", () => {
    const list = actions([{}, { disabled: true }]);
    const onClose = vi.fn();
    render(<ListItemContextMenu anchor={anchor} ariaLabel="Note actions" actions={list} onClose={onClose} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(list[1].onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(list[0].onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("commits a touch activation on pointer-up without repeating it on the synthetic click", () => {
    const list = actions();
    render(<ListItemContextMenu anchor={anchor} ariaLabel="Note actions" actions={list} onClose={vi.fn()} />);
    const item = screen.getByRole("menuitem", { name: "Rename" });
    fireEvent.pointerUp(item, { pointerType: "touch" });
    fireEvent.click(item);
    expect(list[0].onSelect).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape, on a real outside press and on an ancestor scroll, but not on an inside press", () => {
    const onClose = vi.fn();
    render(<ListItemContextMenu anchor={anchor} ariaLabel="Note actions" actions={actions()} onClose={onClose} />);
    fireEvent.pointerDown(screen.getByRole("menuitem", { name: "Rename" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event("scroll"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("keeps the keyboard collection contract of the shared menu primitive", () => {
    render(<ListItemContextMenu anchor={anchor} ariaLabel="Note actions" actions={actions()} onClose={vi.fn()} />);
    const menu = screen.getByRole("menu");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }));
  });

  it("releases its document listeners on unmount", () => {
    const onClose = vi.fn();
    const { unmount } = render(<ListItemContextMenu anchor={anchor} ariaLabel="Note actions" actions={actions()} onClose={onClose} />);
    unmount();
    fireEvent.pointerDown(document.body);
    window.dispatchEvent(new Event("scroll"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
