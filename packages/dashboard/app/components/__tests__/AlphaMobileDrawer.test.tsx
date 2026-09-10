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

  it("retire immédiatement la réserve de pill quand la navigation est masquée par le clavier", () => {
    const { rerender } = render(
      <AlphaMobileDrawer open title="Drawer" closeLabel="Close" onClose={vi.fn()} avoidMobileNav>
        <input aria-label="Composer" />
      </AlphaMobileDrawer>,
    );
    expect(screen.getByTestId("alpha-mobile-drawer")).not.toHaveClass("alpha-mobile-drawer--without-pill");

    rerender(
      <AlphaMobileDrawer open title="Drawer" closeLabel="Close" onClose={vi.fn()} avoidMobileNav={false}>
        <input aria-label="Composer" />
      </AlphaMobileDrawer>,
    );
    expect(screen.getByTestId("alpha-mobile-drawer")).toHaveClass("alpha-mobile-drawer--without-pill");
  });

  it("n'appelle pas la fermeture pour une interaction dans le panneau", async () => {
    const onClose = vi.fn();
    render(<AlphaMobileDrawer open title="Drawer" closeLabel="Close" onClose={onClose}><button>Action</button></AlphaMobileDrawer>);
    fireEvent.mouseDown(screen.getByRole("dialog", { name: "Drawer" }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
