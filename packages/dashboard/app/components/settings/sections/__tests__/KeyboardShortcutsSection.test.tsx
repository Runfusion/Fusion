import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShortcutCaptureInput } from "../ShortcutCaptureInput";

/*
FNXC:DashboardShortcuts 2026-07-04-00:00:
FN-7553 covers the press-to-record capture control in isolation before the
dedicated KeyboardShortcutsSection (which composes one row per action from
this control) lands in Step 4. Recording must fill the value from a real
keydown, must not leak the recorded combination to the document-level
dashboard shortcut listener, Escape must cancel (not bind), and Clear must
disable (blank) the value.
*/
describe("ShortcutCaptureInput", () => {
  it("fills the value from a recorded key combination", () => {
    const onChange = vi.fn();
    render(
      <ShortcutCaptureInput id="test-shortcut" value="Ctrl+E" defaultValue="Ctrl+E" invalid={false} describedById="test-hint" onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /record/i }));
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });

    expect(onChange).toHaveBeenCalledWith("Ctrl+K");
  });

  it("cancels recording on Escape instead of binding Escape", () => {
    const onChange = vi.fn();
    render(
      <ShortcutCaptureInput id="test-shortcut" value="Ctrl+E" defaultValue="Ctrl+E" invalid={false} describedById="test-hint" onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /record/i }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /record/i })).toBeInTheDocument();
  });

  it("does not leak the recorded keystroke to a separate global document listener", () => {
    const onChange = vi.fn();
    const globalListener = vi.fn();
    document.addEventListener("keydown", globalListener);

    render(
      <ShortcutCaptureInput id="test-shortcut" value="Ctrl+E" defaultValue="Ctrl+E" invalid={false} describedById="test-hint" onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /record/i }));
    const event = fireEvent.keyDown(document, { key: "k", ctrlKey: true, cancelable: true });

    // The capture listener runs in the capture phase and calls
    // stopPropagation, so a bubble-phase document listener (matching how the
    // dashboard shortcut hook attaches) never observes the recorded keydown.
    expect(globalListener).not.toHaveBeenCalled();
    expect(event).toBe(false);

    document.removeEventListener("keydown", globalListener);
  });

  it("clears (disables) the value via the Clear action", () => {
    const onChange = vi.fn();
    render(
      <ShortcutCaptureInput id="test-shortcut" value="Ctrl+E" defaultValue="Ctrl+E" invalid={false} describedById="test-hint" onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("supports manual typing as a fallback", () => {
    const onChange = vi.fn();
    render(
      <ShortcutCaptureInput id="test-shortcut" value="Ctrl+E" defaultValue="Ctrl+E" invalid={false} describedById="test-hint" onChange={onChange} />,
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Alt+F" } });
    expect(onChange).toHaveBeenCalledWith("Alt+F");
  });

  /*
  FNXC:DashboardShortcuts 2026-07-04-01:30:
  Regression for an abandoned-recording leak: unmounting while armed (e.g. the
  operator closes Settings or switches sections without pressing a key) must
  tear down the capture-phase document listener. Otherwise the very next
  keydown anywhere in the app gets swallowed and silently fires a stale
  onChange.
  */
  it("tears down the capture listener on unmount while still recording", () => {
    const onChange = vi.fn();
    const globalListener = vi.fn();
    document.addEventListener("keydown", globalListener);

    const { unmount } = render(
      <ShortcutCaptureInput id="test-shortcut" value="Ctrl+E" defaultValue="Ctrl+E" invalid={false} describedById="test-hint" onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /record/i }));
    unmount();

    fireEvent.keyDown(document, { key: "k", ctrlKey: true, cancelable: true });

    expect(onChange).not.toHaveBeenCalled();
    expect(globalListener).toHaveBeenCalledTimes(1);

    document.removeEventListener("keydown", globalListener);
  });

  it("marks the capture surface with data-shortcuts-ignore so the global guard excludes it", () => {
    const { container } = render(
      <ShortcutCaptureInput id="test-shortcut" value="Ctrl+E" defaultValue="Ctrl+E" invalid={false} describedById="test-hint" onChange={vi.fn()} />,
    );
    expect(container.querySelector('[data-shortcuts-ignore="true"]')).toBeTruthy();
  });
});
