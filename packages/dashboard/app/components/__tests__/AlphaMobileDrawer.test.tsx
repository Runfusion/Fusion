import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AlphaMobileDrawer } from "../AlphaMobileDrawer";

function DrawerHarness({ keepMounted = false }: { keepMounted?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open drawer</button>
      <AlphaMobileDrawer open={open} title="Task detail" closeLabel="Close" onClose={() => setOpen(false)} keepMounted={keepMounted}>
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

  it.each(["Escape", "close", "backdrop"])("se ferme une seule fois via %s et restaure le focus", async (method) => {
    const user = userEvent.setup();
    render(<DrawerHarness />);
    const trigger = screen.getByRole("button", { name: "Open drawer" });
    await user.click(trigger);
    const drawer = screen.getByTestId("alpha-mobile-drawer");

    if (method === "Escape") fireEvent.keyDown(document, { key: "Escape" });
    else if (method === "close") await user.click(screen.getByRole("button", { name: "Close" }));
    else fireEvent.mouseDown(drawer);

    expect(screen.queryByRole("dialog", { name: "Task detail" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("piège le focus et peut garder un contenu monté sans shell interactif", async () => {
    render(<DrawerHarness keepMounted />);
    const hiddenDrawer = screen.getByTestId("alpha-mobile-drawer");
    expect(hiddenDrawer).toHaveAttribute("aria-hidden", "true");
    expect(hiddenDrawer).toHaveClass("alpha-mobile-drawer--hidden");

    await userEvent.click(screen.getByRole("button", { name: "Open drawer" }));
    const close = screen.getByRole("button", { name: "Close" });
    const last = screen.getByRole("button", { name: "Last action" });
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();
  });

  it("laisse le contenu propriétaire du seul en-tête visible sans perdre le nom ou la fermeture", () => {
    render(
      <AlphaMobileDrawer open title="Chat" closeLabel="Close chat" onClose={vi.fn()} contentOwnsHeader>
        <header className="view-header"><h1>Chat</h1><button type="button">New Chat</button></header>
      </AlphaMobileDrawer>,
    );

    const dialog = screen.getByRole("dialog", { name: "Chat" });
    expect(dialog.querySelector(".alpha-mobile-drawer__header")).not.toBeInTheDocument();
    expect(screen.getAllByText("Chat").filter((element) => !element.classList.contains("visually-hidden"))).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Chat", level: 1 })).toBeVisible();
    expect(screen.getByRole("button", { name: "New Chat" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close chat" })).toBeVisible();
    expect(dialog).not.toHaveClass("alpha-mobile-drawer__panel--content-scroll");
  });

  it("désactive le scroll du shell uniquement pour une chaîne interne explicitement bornée", () => {
    render(
      <AlphaMobileDrawer open title="Chat" closeLabel="Close chat" onClose={vi.fn()} contentOwnsHeader contentOwnsScroll>
        <div className="chat-view"><div className="chat-messages">Messages</div></div>
      </AlphaMobileDrawer>,
    );

    const dialog = screen.getByRole("dialog", { name: "Chat" });
    expect(dialog).toHaveClass("alpha-mobile-drawer__panel--content-header", "alpha-mobile-drawer__panel--content-scroll");
    expect(dialog.querySelector(".alpha-mobile-drawer__body")).toContainElement(screen.getByText("Messages"));
  });

  it("utilise un contrat géométrique unique avec un enfant minimal", () => {
    render(
      <AlphaMobileDrawer open title="Drawer" closeLabel="Close" onClose={vi.fn()}>
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
    render(<AlphaMobileDrawer open title="Drawer" closeLabel="Close" onClose={onClose}><button>Action</button></AlphaMobileDrawer>);
    fireEvent.mouseDown(screen.getByRole("dialog", { name: "Drawer" }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
