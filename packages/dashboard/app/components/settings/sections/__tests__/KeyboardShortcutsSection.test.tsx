import { readFileSync } from "node:fs";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShortcutCaptureInput } from "../ShortcutCaptureInput";
import { readAppFile } from "../../../../test/cssFixture";

const settingsModalCss = readAppFile("components/SettingsModal.css");

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

  /*
  FNXC:DashboardShortcuts 2026-07-05-00:00:
  Regression for FN-7602 (IMG_1305): Record/Clear previously carried the
  icon-only `btn-icon` class (line-height:0 + mobile 36px square), which
  clipped/overlapped the text labels against the input and each other. These
  tests assert the buttons use a text-appropriate class across idle,
  recording, invalid, and cleared/disabled states, and that the
  `.shortcut-capture` CSS locks a non-overlapping desktop row / mobile stack.
  */
  describe("row layout (FN-7602 no-overlap regression)", () => {
    it("never applies the icon-only btn-icon class to the Record or Clear buttons, idle", () => {
      render(
        <ShortcutCaptureInput id="test-shortcut" value="Ctrl+E" defaultValue="Ctrl+E" invalid={false} describedById="test-hint" onChange={vi.fn()} />,
      );
      const recordBtn = screen.getByRole("button", { name: /^record$/i });
      const clearBtn = screen.getByRole("button", { name: /clear/i });

      for (const btn of [recordBtn, clearBtn]) {
        expect(btn.className.split(/\s+/)).not.toContain("btn-icon");
        expect(btn.className.split(/\s+/)).toContain("btn");
        expect(btn.className).toMatch(/\bbtn-sm\b|\bbtn--sm\b/);
      }
    });

    it("keeps the Record button text-classed and readable while recording (longer label)", () => {
      render(
        <ShortcutCaptureInput id="test-shortcut" value="Ctrl+E" defaultValue="Ctrl+E" invalid={false} describedById="test-hint" onChange={vi.fn()} />,
      );
      fireEvent.click(screen.getByRole("button", { name: /^record$/i }));

      const recordingBtn = screen.getByRole("button", { name: /recording/i });
      expect(recordingBtn.className.split(/\s+/)).not.toContain("btn-icon");
      expect(recordingBtn.className).toContain("shortcut-capture__record--active");
      expect(recordingBtn).toHaveAttribute("aria-pressed", "true");
      // Only a single Record/Recording control exists — no duplicate/overlapping control.
      expect(screen.getAllByRole("button", { name: /record/i })).toHaveLength(1);

      fireEvent.keyDown(document, { key: "Escape" });
    });

    it("keeps the invalid-binding style and buttons off btn-icon while invalid", () => {
      render(
        <ShortcutCaptureInput id="test-shortcut" value="Bogus" defaultValue="Ctrl+E" invalid={true} describedById="test-hint" onChange={vi.fn()} />,
      );
      expect(screen.getByRole("textbox").className).toContain("shortcut-capture__input--invalid");
      for (const btn of [screen.getByRole("button", { name: /^record$/i }), screen.getByRole("button", { name: /clear/i })]) {
        expect(btn.className.split(/\s+/)).not.toContain("btn-icon");
      }
    });

    it("still clears a bound value without btn-icon interfering", () => {
      const onChange = vi.fn();
      render(
        <ShortcutCaptureInput id="test-shortcut" value="Ctrl+E" defaultValue="Ctrl+E" invalid={false} describedById="test-hint" onChange={onChange} />,
      );
      fireEvent.click(screen.getByRole("button", { name: /clear/i }));
      expect(onChange).toHaveBeenCalledWith("");
    });

    it("locks the desktop .shortcut-capture row so the input shrinks and buttons never overlap", () => {
      const rowRule = settingsModalCss.match(/(?<!__record--active|__input--invalid)\.shortcut-capture\s*\{([^}]*)\}/)?.[1] ?? "";
      const inputRule = settingsModalCss.match(/\.shortcut-capture__input\s*\{([^}]*)\}/)?.[1] ?? "";
      const buttonRule = settingsModalCss.match(/\.shortcut-capture__record,\s*\n?\s*\.shortcut-capture__clear\s*\{([^}]*)\}/)?.[1] ?? "";

      expect(rowRule).toContain("display: flex;");
      expect(inputRule).toContain("flex: 1 1 auto;");
      expect(inputRule).toContain("min-width: 0;");
      expect(buttonRule).toContain("flex-shrink: 0;");
      expect(buttonRule).toContain("white-space: nowrap;");
    });

    it("stacks .shortcut-capture on mobile with a full-width input and no overlapping buttons", () => {
      // Anchor to the specific shortcut-capture mobile media block (the one
      // immediately following `.shortcut-conflict-banner`) rather than a
      // lazily-scoped regex, since the stylesheet has several unrelated
      // `@media (max-width: 768px)` blocks earlier in the file that a naive
      // lazy `[\s\S]*?` could otherwise bleed across.
      const shortcutMediaStart = settingsModalCss.indexOf(".shortcut-conflict-banner");
      const shortcutMediaBlock = settingsModalCss.slice(shortcutMediaStart).match(/@media \(max-width: 768px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
      const mobileRowRule = shortcutMediaBlock.match(/\.shortcut-capture\s*\{([^}]*)\}/)?.[1] ?? "";
      const mobileInputRule = shortcutMediaBlock.match(/\.shortcut-capture__input\s*\{([^}]*)\}/)?.[1] ?? "";

      expect(mobileRowRule).toContain("flex-direction: column;");
      expect(mobileInputRule).toContain("width: 100%;");

      // The buttons' flex-shrink/nowrap rule is declared once (not overridden away)
      // and still applies at mobile widths, so "Recording…" cannot overflow its box.
      const buttonRule = settingsModalCss.match(/\.shortcut-capture__record,\s*\n?\s*\.shortcut-capture__clear\s*\{([^}]*)\}/)?.[1] ?? "";
      expect(buttonRule).toContain("flex-shrink: 0;");
    });
  });
});
