import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AlphaMobileDrawer } from "../AlphaMobileDrawer";

function DrawerHarness({ keepMounted = false }: { keepMounted?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open drawer</button>
      <AlphaMobileDrawer open={open} title="Task detail" onClose={() => setOpen(false)} keepMounted={keepMounted}>
        <button type="button">First action</button>
        <button type="button">Last action</button>
        <div style={{ minHeight: "200vh" }}>Long content</div>
      </AlphaMobileDrawer>
    </>
  );
}

describe("AlphaMobileDrawer", () => {
  it("rend un drawer borné avec poignée, titre et corps scrollable", async () => {
    render(<DrawerHarness />);
    await userEvent.click(screen.getByRole("button", { name: "Open drawer" }));

    const dialog = screen.getByRole("dialog", { name: "Task detail" });
    expect(dialog).toHaveClass("alpha-mobile-drawer__panel");
    expect(dialog.querySelector(".alpha-mobile-drawer__handle")).toBeInTheDocument();
    expect(dialog.querySelector(".alpha-mobile-drawer__body")).toHaveTextContent("Long content");
  });

  it.each(["Escape", "drag", "backdrop"])("se ferme une seule fois via %s et restaure le focus", async (method) => {
    const user = userEvent.setup();
    render(<DrawerHarness />);
    const trigger = screen.getByRole("button", { name: "Open drawer" });
    await user.click(trigger);
    const drawer = screen.getByTestId("alpha-mobile-drawer");

    if (method === "Escape") fireEvent.keyDown(document, { key: "Escape" });
    else if (method === "drag") {
      const handle = drawer.querySelector(".alpha-mobile-drawer__handle-target")!;
      fireEvent.pointerDown(handle, { pointerId: 1, clientY: 0, button: 0, isPrimary: true });
      fireEvent.pointerMove(handle, { pointerId: 1, clientY: 200 });
      fireEvent.pointerUp(handle, { pointerId: 1, clientY: 200 });
    } else fireEvent.mouseDown(drawer);

    expect(screen.queryByRole("dialog", { name: "Task detail" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("ferme depuis le corps au bord haut mais préserve un corps déjà scrollé", async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <AlphaMobileDrawer open title="Drawer" onClose={onClose}>
        <div data-testid="drawer-body-content">Body</div>
      </AlphaMobileDrawer>,
    );
    const dialog = screen.getByRole("dialog", { name: "Drawer" });
    const body = screen.getByTestId("drawer-body-content");
    fireEvent.pointerDown(body, { pointerId: 1, clientY: 0, button: 0, isPrimary: true });
    fireEvent.pointerMove(body, { pointerId: 1, clientY: 200 });
    await waitFor(() => expect(dialog.style.transform).toContain("200px"));
    fireEvent.pointerUp(body, { pointerId: 1, clientY: 200 });
    expect(onClose).toHaveBeenCalledOnce();

    onClose.mockClear();
    rerender(
      <AlphaMobileDrawer open title="Drawer" onClose={onClose}>
        <div data-testid="drawer-body-content">Body</div>
      </AlphaMobileDrawer>,
    );
    const reopenedDialog = screen.getByRole("dialog", { name: "Drawer" });
    reopenedDialog.scrollTop = 10;
    const reopenedBody = screen.getByTestId("drawer-body-content");
    fireEvent.pointerDown(reopenedBody, { pointerId: 2, clientY: 0, button: 0, isPrimary: true });
    fireEvent.pointerMove(reopenedBody, { pointerId: 2, clientY: 200 });
    fireEvent.pointerUp(reopenedBody, { pointerId: 2, clientY: 200 });
    expect(onClose).not.toHaveBeenCalled();
    expect(reopenedDialog.style.transform).toBe("");
  });

  it("piège le focus et peut garder un contenu monté sans shell interactif", async () => {
    render(<DrawerHarness keepMounted />);
    const hiddenDrawer = screen.getByTestId("alpha-mobile-drawer");
    expect(hiddenDrawer).toHaveAttribute("aria-hidden", "true");
    expect(hiddenDrawer).toHaveClass("alpha-mobile-drawer--hidden");

    await userEvent.click(screen.getByRole("button", { name: "Open drawer" }));
    const first = screen.getByRole("button", { name: "First action" });
    const last = screen.getByRole("button", { name: "Last action" });
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();
  });

  it("laisse le contenu propriétaire du seul en-tête visible sans croix", () => {
    render(
      <AlphaMobileDrawer open title="Chat" onClose={vi.fn()} contentOwnsHeader>
        <header className="view-header"><h1>Chat</h1><button type="button">New Chat</button></header>
      </AlphaMobileDrawer>,
    );

    const dialog = screen.getByRole("dialog", { name: "Chat" });
    expect(dialog.querySelector(".alpha-mobile-drawer__header")).not.toBeInTheDocument();
    expect(screen.getAllByText("Chat").filter((element) => !element.classList.contains("visually-hidden"))).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Chat", level: 1 })).toBeVisible();
    expect(screen.getByRole("button", { name: "New Chat" })).toBeVisible();
    expect(dialog.querySelector(".alpha-mobile-drawer__close")).not.toBeInTheDocument();
    expect(dialog.querySelectorAll(".alpha-mobile-drawer__handle-target")).toHaveLength(1);
    expect(dialog).not.toHaveClass("alpha-mobile-drawer__panel--content-scroll");
  });

  it("désactive le scroll du shell uniquement pour une chaîne interne explicitement bornée", () => {
    render(
      <AlphaMobileDrawer open title="Chat" onClose={vi.fn()} contentOwnsHeader contentOwnsScroll>
        <div className="chat-view"><div className="chat-messages">Messages</div></div>
      </AlphaMobileDrawer>,
    );

    const dialog = screen.getByRole("dialog", { name: "Chat" });
    expect(dialog).toHaveClass("alpha-mobile-drawer__panel--content-header", "alpha-mobile-drawer__panel--content-scroll");
    expect(dialog.querySelector(".alpha-mobile-drawer__body")).toContainElement(screen.getByText("Messages"));
  });

  it("utilise un contrat géométrique unique avec un enfant minimal", () => {
    render(
      <AlphaMobileDrawer open title="Drawer" onClose={vi.fn()}>
        {null}
      </AlphaMobileDrawer>,
    );

    const drawer = screen.getByTestId("alpha-mobile-drawer");
    expect(drawer).toHaveClass("alpha-mobile-drawer", "alpha-mobile-drawer--open");
    expect(drawer.className).toBe("alpha-mobile-drawer alpha-mobile-drawer--open");
    expect(screen.getByRole("dialog", { name: "Drawer" }).querySelector(".alpha-mobile-drawer__body")).toBeEmptyDOMElement();
  });

  it("n'appelle pas la fermeture pour une interaction dans le panneau", async () => {
    const onClose = vi.fn();
    render(<AlphaMobileDrawer open title="Drawer" onClose={onClose}><button>Action</button></AlphaMobileDrawer>);
    fireEvent.mouseDown(screen.getByRole("dialog", { name: "Drawer" }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
