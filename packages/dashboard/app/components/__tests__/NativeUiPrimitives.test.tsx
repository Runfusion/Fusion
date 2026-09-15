/*
FNXC:NativeUiPrimitives 2026-09-15-00:20:
This suite was `AlphaBoundary.test.tsx`. FN-399 deleted the presentation perimeter, so the assertions it
made about "inside vs outside a boundary" no longer describe anything real. Every useful guarantee is
kept and restated against the NATIVE contract:

  * primitives publish their markers and behaviour EVERYWHERE, not only inside a wrapper;
  * one navigable collection precedes sibling auxiliary actions;
  * Board and Chat owners keep routing through the shared primitives instead of re-adding raw controls;
  * the presentation stylesheet stays scoped, token-only and colour-free.

The old "root and portal colours stay stable across Fusion colour themes" cases are DELETED on purpose:
they asserted exactly the defect FN-399 fixes (a fixed palette that themes could not reach). Their
replacement is a real computed-colour proof across themes in the browser lane
(`src/__tests__/ui-style-browser.test.ts`), because JSDOM cannot compose theme stylesheets.
*/

import "../../native-ui.css";
import "../../ui-style-tokens.css";
import "../QuickEntryBox.css";
import { createPortal } from "react-dom";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listComponentFiles, readAppFile } from "../../test/cssFixture";
import { UiButton, UiDialog, UiInput, UiListBox, UiListBoxItem, UiMenu, UiMenuItem, UiPortalSurface } from "../ui";

function Fixture() {
  const [draft, setDraft] = useState("retained draft");
  return (
    <>
      <UiButton data-testid="elsewhere">Another screen</UiButton>
      <UiInput
        aria-label="Message"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <UiButton data-testid="disabled" disabled>Send</UiButton>
      <UiListBox aria-label="Suggestions"><UiListBoxItem id="one" textValue="One">One</UiListBoxItem></UiListBox>
      <UiMenu aria-label="Actions"><UiMenuItem id="open">Open</UiMenuItem></UiMenu>
      <UiDialog labelledBy="native-dialog-title"><h2 id="native-dialog-title">Native dialog</h2></UiDialog>
      {createPortal(<UiPortalSurface data-testid="portal-surface"><UiButton className="quick-entry-toggle" data-testid="portal">Portal action</UiButton></UiPortalSurface>, document.body)}
    </>
  );
}

describe("native UI primitives", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-color-theme");
    document.documentElement.removeAttribute("data-ui-style");
  });

  it("publishes its markers and preserves control contracts on every mount, with no perimeter", () => {
    const view = render(<Fixture />);

    // There is no "outside": a primitive behaves identically wherever it is rendered.
    expect(screen.getByTestId("elsewhere")).toHaveAttribute("data-ui", "button");
    expect(screen.getByLabelText("Message")).toHaveAttribute("data-ui", "input");
    expect(screen.getByTestId("disabled")).toBeDisabled();
    expect(screen.getByTestId("disabled")).toHaveAttribute("data-ui", "button");

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "draft survives" } });
    view.rerender(<Fixture />);

    expect(screen.getByLabelText("Message")).toHaveValue("draft survives");
    expect(screen.getByTestId("portal")).toHaveAttribute("data-ui", "button");
    expect(document.querySelector('[data-ui="listbox"]')).toHaveAccessibleName("Suggestions");
    expect(document.querySelector('[data-ui="menu"]')).toHaveAccessibleName("Actions");
    expect(screen.getByRole("dialog", { name: "Native dialog" })).toHaveAttribute("data-ui", "dialog");
    expect(screen.getByTestId("portal-surface")).toHaveAttribute("data-ui-portal", "true");
  });

  it("keeps markers and values stable when the interface style changes", () => {
    document.documentElement.dataset.uiStyle = "classic";
    render(<Fixture />);

    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "unchanged by style" } });

    document.documentElement.dataset.uiStyle = "clean";

    expect(screen.getByLabelText("Message")).toBe(input);
    expect(input).toHaveValue("unchanged by style");
    expect(input).toHaveAttribute("data-ui", "input");
    expect(screen.getByTestId("portal-surface")).toHaveAttribute("data-ui-portal", "true");
  });

  it("keeps one navigable collection before sibling auxiliary actions", async () => {
    const user = userEvent.setup();
    const onAuxiliary = vi.fn();
    render(
      <>
        <UiListBox aria-label="Complex models">
          <UiListBoxItem id="model-one" textValue="Model one">Model one</UiListBoxItem>
          <UiListBoxItem id="model-two" textValue="Model two">Model two</UiListBoxItem>
        </UiListBox>
        <UiButton onClick={onAuxiliary}>Favorite model</UiButton>
      </>,
    );

    const [first, second] = screen.getAllByRole("option");
    first?.focus();
    await user.keyboard("{ArrowDown}");
    expect(second).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Favorite model" })).toHaveFocus();
    expect(first).not.toContainElement(screen.getByRole("button", { name: "Favorite model" }));
    await user.keyboard("{Enter}");
    expect(onAuxiliary).toHaveBeenCalledTimes(1);
  });

  it("refuses new raw custom controls in the Board and Chat owners", () => {
    const boardOwners = [
      "Board.tsx", "Column.tsx", "TaskCard.tsx", "WorktreeGroup.tsx", "QuickEntryBox.tsx",
      "TaskContextMenu.tsx", "WorkflowSwitcher.tsx", "WorkflowOptionalStepsDropdown.tsx",
      "CustomModelDropdown.tsx", "DuplicateWarningModal.tsx", "TaskRefineDialog.tsx", "TaskResetDialog.tsx", "PrCreateModal.tsx",
    ];
    const chatOwners = [
      ...listComponentFiles().filter((file) => /^Chat.*\.tsx$/.test(file) && !file.includes("/__tests__/")),
      "StandardChatSurface.tsx", "ComposeChatPanel.tsx", "CliChatSurface.tsx", "PendingChatMessageQueue.tsx",
      "AgentMentionPopup.tsx", "FileMentionPopup.tsx", "MicButton.tsx", "ToolCallDetails.tsx", "ThinkingTrace.tsx",
      "TaskChatTab.tsx", "TaskPlannerChatTab.tsx", "PoppedOutChatWindows.tsx", "overflowViewRegistry.tsx",
    ];
    const uniqueOwners = [...new Set([...boardOwners, ...chatOwners])];
    const violations = uniqueOwners.flatMap((file) => {
      const source = readAppFile(`components/${file}`)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      const nativeControls = [...source.matchAll(/<(button|input|textarea|select)\b/g)]
        .map((match) => `${file}:native-${match[1]}`);
      const customRoles = [...source.matchAll(/<(div|ul|li|section)\b[^>]*\brole=["'](menu|dialog|listbox|option|menuitem)["'][^>]*>/gs)]
        .map((match) => `${file}:custom-${match[2]}`);
      const customPrimitiveShells = [...source.matchAll(/<(div|section)\b[^>]*className=["'][^"']*(?:^|\s)(card|btn|input)(?:\s|$)[^"']*["'][^>]*>/gm)]
        .map((match) => `${file}:custom-${match[2]}-shell`);
      const genericPortals = source.includes("<UiPortalSurface") ? [`${file}:generic-portal`] : [];
      return [...nativeControls, ...customRoles, ...customPrimitiveShells, ...genericPortals];
    });
    expect(violations).toEqual([]);
    expect(readAppFile("components/Column.tsx")).toContain("<UiMenu");
    expect(readAppFile("components/WorkflowSwitcher.tsx")).toContain("<UiListBox");
    expect(readAppFile("components/ChatView.tsx")).toContain("<UiDialogBackdrop");
    expect(readAppFile("components/PrCreateModal.tsx")).toContain("<UiDialogPanel");
  });

  it("keeps the native presentation sheet token-only, colour-free and perimeter-free", () => {
    const css = readAppFile("native-ui.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const globalCss = readAppFile("styles.css");
    const viteConfig = readAppFile("../vite.config.ts");

    expect(css).toContain("[data-ui]");
    expect(css).toContain('[data-ui-portal="true"]');
    // No perimeter mechanism of any kind survives in the presentation sheet.
    expect(css).not.toContain("@scope");
    expect(css).not.toContain("data-alpha-surface");
    expect(css).not.toContain("--alpha-neutral-");
    expect(css).not.toContain("[data-color-theme");
    // No Tailwind escape hatches.
    expect(globalCss).not.toContain('@import "tailwindcss"');
    expect(css).not.toContain("@reference");
    expect(css).not.toContain("@source");
    expect(css).not.toContain("@apply");
    expect(viteConfig).toContain("react()");
    // Token-only: no literal colour and no raw pixel dimension.
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(css).not.toMatch(/\d+px\b/);
  });
});
