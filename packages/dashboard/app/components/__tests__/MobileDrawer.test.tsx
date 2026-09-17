import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { readAppFile } from "../../test/cssFixture";
import { MobileDrawer } from "../MobileDrawer";

const drawerCss = readAppFile("components/MobileDrawer.css");
const stylesCss = readAppFile("styles.css");

function DrawerHarness({ keepMounted = false }: { keepMounted?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open drawer</button>
      <MobileDrawer open={open} title="Task detail" onClose={() => setOpen(false)} keepMounted={keepMounted}>
        <button type="button">First action</button>
        <button type="button">Last action</button>
        <div style={{ minHeight: "200vh" }}>Long content</div>
      </MobileDrawer>
    </>
  );
}

describe("MobileDrawer", () => {
  it("anime le panneau ouvert depuis le bas et neutralise le mouvement réduit", () => {
    expect(drawerCss).toMatch(/\.mobile-drawer--open \.mobile-drawer__panel\s*\{[^}]*animation: mobile-drawer-rise-in/);
    expect(stylesCss).toMatch(/@keyframes mobile-drawer-rise-in\s*\{[\s\S]*?from\s*\{[^}]*translate: 0 var\(--space-xl\)/);
    expect(stylesCss).not.toMatch(/@keyframes mobile-drawer-rise-in\s*\{[\s\S]*?translateX/);
    expect(drawerCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.mobile-drawer--open \.mobile-drawer__panel\s*\{[^}]*animation: none/);
  });

  it("rend un drawer borné avec poignée, titre et corps scrollable", async () => {
    render(<DrawerHarness />);
    await userEvent.click(screen.getByRole("button", { name: "Open drawer" }));

    const dialog = screen.getByRole("dialog", { name: "Task detail" });
    expect(dialog).toHaveClass("mobile-drawer__panel");
    expect(dialog.querySelector(".mobile-drawer__handle")).toBeInTheDocument();
    expect(dialog.querySelector(".mobile-drawer__body")).toHaveTextContent("Long content");
  });

  it.each(["Escape", "drag", "backdrop"])("se ferme une seule fois via %s et restaure le focus", async (method) => {
    const user = userEvent.setup();
    render(<DrawerHarness />);
    const trigger = screen.getByRole("button", { name: "Open drawer" });
    await user.click(trigger);
    const drawer = screen.getByTestId("mobile-drawer");

    if (method === "Escape") fireEvent.keyDown(document, { key: "Escape" });
    else if (method === "drag") {
      const handle = drawer.querySelector(".mobile-drawer__handle-target")!;
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
      <MobileDrawer open title="Drawer" onClose={onClose}>
        <div data-testid="drawer-body-content">Body</div>
      </MobileDrawer>,
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
      <MobileDrawer open title="Drawer" onClose={onClose}>
        <div data-testid="drawer-body-content">Body</div>
      </MobileDrawer>,
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
    const hiddenDrawer = screen.getByTestId("mobile-drawer");
    expect(hiddenDrawer).toHaveAttribute("aria-hidden", "true");
    expect(hiddenDrawer).toHaveClass("mobile-drawer--hidden");

    await userEvent.click(screen.getByRole("button", { name: "Open drawer" }));
    const first = screen.getByRole("button", { name: "First action" });
    const last = screen.getByRole("button", { name: "Last action" });
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();
  });

  it("laisse le contenu propriétaire du seul en-tête visible sans croix", () => {
    render(
      <MobileDrawer open title="Chat" onClose={vi.fn()} contentOwnsHeader>
        <header className="view-header"><h1>Chat</h1><button type="button">New Chat</button></header>
      </MobileDrawer>,
    );

    const dialog = screen.getByRole("dialog", { name: "Chat" });
    expect(dialog.querySelector(".mobile-drawer__header")).not.toBeInTheDocument();
    expect(screen.getAllByText("Chat").filter((element) => !element.classList.contains("visually-hidden"))).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Chat", level: 1 })).toBeVisible();
    expect(screen.getByRole("button", { name: "New Chat" })).toBeVisible();
    expect(dialog.querySelector(".mobile-drawer__close")).not.toBeInTheDocument();
    expect(dialog.querySelectorAll(".mobile-drawer__handle-target")).toHaveLength(1);
    expect(dialog).not.toHaveClass("mobile-drawer__panel--content-scroll");
  });

  it("désactive le scroll du shell uniquement pour une chaîne interne explicitement bornée", () => {
    render(
      <MobileDrawer open title="Chat" onClose={vi.fn()} contentOwnsHeader contentOwnsScroll>
        <div className="chat-view"><div className="chat-messages">Messages</div></div>
      </MobileDrawer>,
    );

    const dialog = screen.getByRole("dialog", { name: "Chat" });
    expect(dialog).toHaveClass("mobile-drawer__panel--content-header", "mobile-drawer__panel--content-scroll");
    expect(dialog.querySelector(".mobile-drawer__body")).toContainElement(screen.getByText("Messages"));
  });

  it("utilise un contrat géométrique unique avec un enfant minimal", () => {
    render(
      <MobileDrawer open title="Drawer" onClose={vi.fn()}>
        {null}
      </MobileDrawer>,
    );

    const drawer = screen.getByTestId("mobile-drawer");
    expect(drawer).toHaveClass("mobile-drawer", "mobile-drawer--open");
    expect(drawer.className).toBe("mobile-drawer mobile-drawer--open");
    expect(screen.getByRole("dialog", { name: "Drawer" }).querySelector(".mobile-drawer__body")).toBeEmptyDOMElement();
  });

  it("n'appelle pas la fermeture pour une interaction dans le panneau", async () => {
    const onClose = vi.fn();
    render(<MobileDrawer open title="Drawer" onClose={onClose}><button>Action</button></MobileDrawer>);
    fireEvent.mouseDown(screen.getByRole("dialog", { name: "Drawer" }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
