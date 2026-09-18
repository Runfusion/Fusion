import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useListItemContextMenu } from "../useListItemContextMenu";
import { LIST_ITEM_LONG_PRESS_DELAY_MS, LIST_ITEM_MENU_VIEWPORT_MARGIN, LIST_ITEM_ROW_ATTRIBUTE, registerDrawerGestureCanceller } from "../../utils/listItemGesture";

/*
FNXC:ListItemContextMenu 2026-09-17-03:18:
FN-486 : ces cas prouvent l'EXCLUSIVITÉ des deux ordonnancements (mouvement avant délai → aucun menu ;
délai avant mouvement → menu et invalidation du candidat de fermeture) et l'absence de `preventDefault`
au démarrage, sans lequel le défilement natif serait perdu.
*/

function Host({ onSelect, contextId, enabled }: { onSelect?: () => void; contextId?: string; enabled?: boolean }) {
  const menu = useListItemContextMenu({ contextId, enabled });
  return (
    <div>
      <button type="button" data-testid="row" {...menu.getRowProps("p1:note:a")} onClick={() => onSelect?.()}>
        <span data-testid="row-label">Row A</span>
        <input aria-label="rename" />
      </button>
      <span data-testid="anchor">{menu.anchor ? `${menu.anchor.key}@${menu.anchor.x},${menu.anchor.y}` : "none"}</span>
      <button type="button" data-testid="close" onClick={menu.close}>close</button>
      {/*
      FNXC:ListItemContextMenu 2026-09-17-10:37:
      FN-506 : déclencheur HORS ligne (l'en-tête contextuel d'une destination) qui ouvre le même menu par
      `openAt`, avec la même clé composée.
      */}
      <button type="button" data-testid="header-trigger" aria-expanded={menu.isOpen("p1:header-note:a")} onClick={() => menu.openAt("p1:header-note:a", 200, 300)}>header</button>
      <button type="button" data-testid="header-trigger-offscreen" onClick={() => menu.openAt("p1:header-note:a", 99999, -50)}>offscreen</button>
    </div>
  );
}

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); });

describe("useListItemContextMenu", () => {
  it("qualifies the row for the drawer dismiss gesture and announces a menu", () => {
    render(<Host />);
    const row = screen.getByTestId("row");
    expect(row.getAttribute(LIST_ITEM_ROW_ATTRIBUTE)).toBe("true");
    expect(row.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("opens on right-click at the pointer coordinates without suppressing the next real click", () => {
    const onSelect = vi.fn();
    render(<Host onSelect={onSelect} />);
    const row = screen.getByTestId("row");
    fireEvent.contextMenu(row, { clientX: 120, clientY: 240 });
    expect(screen.getByTestId("anchor").textContent).toBe("p1:note:a@120,240");
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("opens from the keyboard menu key with no coordinates", () => {
    render(<Host />);
    const row = screen.getByTestId("row");
    row.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 40, right: 110, bottom: 60, x: 10, y: 20, toJSON: () => ({}) }) as DOMRect;
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    expect(screen.getByTestId("anchor").textContent).toBe("p1:note:a@26,36");
  });

  it("ignores gestures whose nearest interactive control is a nested field", () => {
    render(<Host />);
    fireEvent.contextMenu(screen.getByLabelText("rename"), { clientX: 5, clientY: 5 });
    expect(screen.getByTestId("anchor").textContent).toBe("none");
  });

  it("opens after the long-press delay, invalidates the drawer candidate and swallows only the synthetic click", () => {
    const cancel = vi.fn();
    const unregister = registerDrawerGestureCanceller(cancel);
    const onSelect = vi.fn();
    render(<Host onSelect={onSelect} />);
    const row = screen.getByTestId("row");
    const down = fireEvent.pointerDown(row, { pointerType: "touch", pointerId: 1, isPrimary: true, clientX: 30, clientY: 40, cancelable: true });
    expect(down).toBe(true); // aucun preventDefault : le défilement natif reste possible
    act(() => { vi.advanceTimersByTime(LIST_ITEM_LONG_PRESS_DELAY_MS); });
    expect(screen.getByTestId("anchor").textContent).toBe("p1:note:a@30,40");
    expect(cancel).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(row, { pointerType: "touch", pointerId: 1 });
    fireEvent.click(row);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
    unregister();
  });

  /*
  FNXC:LongPressTextSelection 2026-09-18-01:13:
  FN-521 : la suppression du surlignement au long press est portée par le CSS (`user-select`/
  `-webkit-touch-callout` sur `[data-drawer-dismiss-row]`), JAMAIS par un `preventDefault` au `pointerdown`.
  Ce cas pine la règle n°1 du geste partagé : ni la ligne ni son libellé ne voient leur événement annulé,
  ni avant ni après l'expiration du délai, sinon le défilement natif et le geste de tiroir seraient perdus.
  */
  it("never prevents the touch pointerdown, before or after the long-press delay", () => {
    render(<Host />);
    const row = screen.getByTestId("row");

    for (const target of [row, screen.getByTestId("row-label")]) {
      const event = new Event("pointerdown", { bubbles: true, cancelable: true });
      Object.assign(event, { pointerType: "touch", pointerId: 1, isPrimary: true, clientX: 30, clientY: 40 });
      fireEvent(target, event);
      expect(event.defaultPrevented).toBe(false);
      act(() => { vi.advanceTimersByTime(LIST_ITEM_LONG_PRESS_DELAY_MS); });
      expect(event.defaultPrevented).toBe(false);
      // Le geste a bien été pris en charge : sans cette preuve le cas passerait trivialement.
      expect(screen.getByTestId("anchor").textContent).toBe("p1:note:a@30,40");
      fireEvent.pointerUp(target, { pointerType: "touch", pointerId: 1 });
      fireEvent.click(screen.getByTestId("close"));
    }

    expect(screen.getByTestId("anchor").textContent).toBe("none");
  });

  it("cancels the long press when the finger moves past the threshold before the delay", () => {
    render(<Host />);
    const row = screen.getByTestId("row");
    fireEvent.pointerDown(row, { pointerType: "touch", pointerId: 1, isPrimary: true, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(row, { pointerType: "touch", pointerId: 1, clientX: 0, clientY: 60 });
    act(() => { vi.advanceTimersByTime(LIST_ITEM_LONG_PRESS_DELAY_MS * 2); });
    expect(screen.getByTestId("anchor").textContent).toBe("none");
  });

  it("cancels a pending long press on a second finger, pointer cancel and outside scroll", () => {
    render(<Host />);
    const row = screen.getByTestId("row");
    fireEvent.pointerDown(row, { pointerType: "touch", pointerId: 1, isPrimary: true, clientX: 0, clientY: 0 });
    fireEvent.pointerDown(row, { pointerType: "touch", pointerId: 2, isPrimary: false, clientX: 4, clientY: 4 });
    act(() => { vi.advanceTimersByTime(LIST_ITEM_LONG_PRESS_DELAY_MS * 2); });
    expect(screen.getByTestId("anchor").textContent).toBe("none");

    fireEvent.pointerDown(row, { pointerType: "touch", pointerId: 3, isPrimary: true, clientX: 0, clientY: 0 });
    fireEvent.pointerCancel(row, { pointerType: "touch", pointerId: 3 });
    act(() => { vi.advanceTimersByTime(LIST_ITEM_LONG_PRESS_DELAY_MS * 2); });
    expect(screen.getByTestId("anchor").textContent).toBe("none");

    fireEvent.pointerDown(row, { pointerType: "touch", pointerId: 4, isPrimary: true, clientX: 0, clientY: 0 });
    fireEvent.scroll(document, {});
    window.dispatchEvent(new Event("scroll", { bubbles: false }));
    document.dispatchEvent(new Event("scroll"));
    act(() => { vi.advanceTimersByTime(LIST_ITEM_LONG_PRESS_DELAY_MS * 2); });
    expect(screen.getByTestId("anchor").textContent).toBe("none");
  });

  it("never starts a long press for a mouse pointer", () => {
    render(<Host />);
    const row = screen.getByTestId("row");
    fireEvent.pointerDown(row, { pointerType: "mouse", pointerId: 1, isPrimary: true, clientX: 0, clientY: 0 });
    act(() => { vi.advanceTimersByTime(LIST_ITEM_LONG_PRESS_DELAY_MS * 2); });
    expect(screen.getByTestId("anchor").textContent).toBe("none");
  });

  it("closes when the context identity changes or the host is disabled", () => {
    const { rerender } = render(<Host contextId="project-a" />);
    fireEvent.contextMenu(screen.getByTestId("row"), { clientX: 10, clientY: 10 });
    expect(screen.getByTestId("anchor").textContent).not.toBe("none");
    rerender(<Host contextId="project-b" />);
    expect(screen.getByTestId("anchor").textContent).toBe("none");

    fireEvent.contextMenu(screen.getByTestId("row"), { clientX: 10, clientY: 10 });
    expect(screen.getByTestId("anchor").textContent).not.toBe("none");
    rerender(<Host contextId="project-b" enabled={false} />);
    expect(screen.getByTestId("anchor").textContent).toBe("none");
  });

  /*
  FNXC:ListItemContextMenu 2026-09-17-10:37:
  FN-506 : l'ouverture programmatique partage exactement le contrat de l'ouverture par geste — clé composée,
  bornage au viewport, garde `enabled`, fermeture sur changement de contexte.
  */
  it("opens programmatically at the requested key and coordinates", () => {
    render(<Host />);
    fireEvent.click(screen.getByTestId("header-trigger"));
    expect(screen.getByTestId("anchor").textContent).toBe("p1:header-note:a@200,300");
    expect(screen.getByTestId("header-trigger")).toHaveAttribute("aria-expanded", "true");
  });

  it("clamps a programmatic anchor to the viewport margins", () => {
    render(<Host />);
    fireEvent.click(screen.getByTestId("header-trigger-offscreen"));
    const anchor = screen.getByTestId("anchor").textContent ?? "";
    const [, coords] = anchor.split("@");
    const [x, y] = coords.split(",").map(Number);
    expect(x).toBeLessThanOrEqual(Math.max(LIST_ITEM_MENU_VIEWPORT_MARGIN, window.innerWidth - LIST_ITEM_MENU_VIEWPORT_MARGIN));
    expect(x).toBeGreaterThanOrEqual(LIST_ITEM_MENU_VIEWPORT_MARGIN);
    expect(y).toBeGreaterThanOrEqual(LIST_ITEM_MENU_VIEWPORT_MARGIN);
  });

  it("closes a programmatic menu when the context identity changes", () => {
    const { rerender } = render(<Host contextId="project-a" />);
    fireEvent.click(screen.getByTestId("header-trigger"));
    expect(screen.getByTestId("anchor").textContent).not.toBe("none");
    rerender(<Host contextId="project-b" />);
    expect(screen.getByTestId("anchor").textContent).toBe("none");
  });

  it("opens nothing programmatically while the host is disabled", () => {
    render(<Host enabled={false} />);
    fireEvent.click(screen.getByTestId("header-trigger"));
    expect(screen.getByTestId("anchor").textContent).toBe("none");
  });

  it("leaves no timer behind after unmount", () => {
    const { unmount } = render(<Host />);
    fireEvent.pointerDown(screen.getByTestId("row"), { pointerType: "touch", pointerId: 1, isPrimary: true, clientX: 0, clientY: 0 });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
