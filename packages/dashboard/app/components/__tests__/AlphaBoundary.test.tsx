import "../../alpha-ui.css";
import "../QuickEntryBox.css";
import { createPortal } from "react-dom";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlphaProvider, AlphaBoundary } from "../../context/AlphaContext";
import { listComponentFiles, readAppFile } from "../../test/cssFixture";
import { AlphaButton, AlphaDialog, AlphaInput, AlphaListBox, AlphaListBoxItem, AlphaMenu, AlphaMenuItem, AlphaPortalSurface } from "../alpha-ui";

function Fixture({ enabled }: { enabled: boolean }) {
  const [draft, setDraft] = useState("retained draft");
  return (
    <AlphaProvider enabled={enabled}>
      <AlphaButton data-testid="outside">Stable screen</AlphaButton>
      <AlphaBoundary>
        <AlphaInput
          aria-label="Message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <AlphaButton data-testid="disabled" disabled>Send</AlphaButton>
        <AlphaListBox aria-label="Suggestions"><AlphaListBoxItem id="one" textValue="One">One</AlphaListBoxItem></AlphaListBox>
        <AlphaMenu aria-label="Actions"><AlphaMenuItem id="open">Open</AlphaMenuItem></AlphaMenu>
        <AlphaDialog labelledBy="alpha-dialog-title"><h2 id="alpha-dialog-title">Alpha dialog</h2></AlphaDialog>
        {createPortal(<AlphaPortalSurface data-testid="portal-surface"><AlphaButton className="quick-entry-toggle" data-testid="portal">Portal action</AlphaButton></AlphaPortalSurface>, document.body)}
      </AlphaBoundary>
    </AlphaProvider>
  );
}

describe("homemade Alpha surface boundary", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-color-theme");
  });

  it("keeps official Board/Chat primitives active without leaking to an outside screen", () => {
    const view = render(<Fixture enabled={false} />);
    expect(screen.getByTestId("outside")).not.toHaveAttribute("data-alpha-ui");
    expect(screen.getByLabelText("Message")).toHaveAttribute("data-alpha-ui", "input");
    expect(screen.getByTestId("disabled")).toBeDisabled();
    expect(screen.getByTestId("disabled")).toHaveAttribute("data-alpha-ui", "button");

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "draft survives" } });
    view.rerender(<Fixture enabled />);

    expect(screen.getByLabelText("Message")).toHaveValue("draft survives");
    expect(screen.getByTestId("portal")).toHaveAttribute("data-alpha-ui", "button");
    expect(document.querySelector('[data-alpha-ui="listbox"]')).toHaveAccessibleName("Suggestions");
    expect(document.querySelector('[data-alpha-ui="menu"]')).toHaveAccessibleName("Actions");
    expect(screen.getByRole("dialog", { name: "Alpha dialog" })).toHaveAttribute("data-alpha-ui", "dialog");
    expect(screen.getByTestId("portal-surface")).toHaveAttribute("data-alpha-portal", "true");
    expect(screen.getByTestId("outside")).not.toHaveAttribute("data-alpha-ui");

    view.rerender(<Fixture enabled={false} />);
    expect(screen.getByLabelText("Message")).toHaveValue("draft survives");
    expect(screen.getByLabelText("Message")).toHaveAttribute("data-alpha-ui", "input");
    expect(screen.getByTestId("portal-surface")).toHaveAttribute("data-alpha-portal", "true");
  });

  it("keeps root and portal colors stable across Fusion color themes and distinct across light/dark", () => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.dataset.colorTheme = "cozy-cartoon";
    render(<Fixture enabled />);

    const surface = document.querySelector<HTMLElement>('[data-alpha-surface="true"]');
    const portal = screen.getByTestId("portal-surface");
    const palette = (element: Element) => {
      const style = getComputedStyle(element);
      return [
        style.getPropertyValue("--alpha-neutral-background"),
        style.getPropertyValue("--alpha-neutral-foreground"),
        style.getPropertyValue("--alpha-neutral-border"),
        style.getPropertyValue("--alpha-neutral-accent"),
        style.getPropertyValue("--todo"),
        style.getPropertyValue("--triage"),
        style.getPropertyValue("--in-progress"),
        style.getPropertyValue("--in-review"),
        style.getPropertyValue("--done"),
        style.getPropertyValue("--status-todo-bg"),
        style.getPropertyValue("--status-error-bg"),
        style.getPropertyValue("--color-info"),
        style.getPropertyValue("--color-success"),
      ];
    };
    const lightRoot = palette(surface!);
    const lightPortal = palette(portal);
    expect(lightRoot.every(Boolean)).toBe(true);
    expect(lightPortal).toEqual(lightRoot);

    document.documentElement.dataset.colorTheme = "shadcn-purple";
    expect(palette(surface!)).toEqual(lightRoot);
    expect(palette(portal)).toEqual(lightPortal);

    document.documentElement.dataset.theme = "dark";
    const darkRoot = palette(surface!);
    expect(darkRoot).not.toEqual(lightRoot);
    expect(palette(portal)).toEqual(darkRoot);

    document.documentElement.dataset.colorTheme = "default";
    expect(palette(surface!)).toEqual(darkRoot);
    expect(palette(portal)).toEqual(darkRoot);
    expect(getComputedStyle(screen.getByTestId("outside")).getPropertyValue("--alpha-neutral-background")).toBe("");
  });

  it("renders a valid neutral focus shadow on a portaled production control", () => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.dataset.colorTheme = "cozy-cartoon";
    render(<Fixture enabled />);

    const portalControl = screen.getByTestId("portal");
    portalControl.focus();
    expect(portalControl).toHaveFocus();
    const lightStyle = getComputedStyle(portalControl);
    const lightRing = lightStyle.getPropertyValue("--focus-ring-strong");
    const lightAccent = lightStyle.getPropertyValue("--alpha-neutral-accent");
    expect(lightRing).toMatch(/^\s*0 0 0 0\.125rem color-mix\(/);

    document.documentElement.dataset.colorTheme = "shadcn-purple";
    expect(getComputedStyle(portalControl).getPropertyValue("--focus-ring-strong")).toBe(lightRing);

    document.documentElement.dataset.theme = "dark";
    const darkStyle = getComputedStyle(portalControl);
    expect(darkStyle.getPropertyValue("--focus-ring-strong")).toBe(lightRing);
    expect(darkStyle.getPropertyValue("--alpha-neutral-accent")).not.toBe(lightAccent);
  });

  it("keeps one navigable collection before sibling auxiliary actions", async () => {
    const user = userEvent.setup();
    const onAuxiliary = vi.fn();
    render(
      <AlphaProvider enabled>
        <AlphaBoundary>
          <AlphaListBox aria-label="Complex models">
            <AlphaListBoxItem id="model-one" textValue="Model one">Model one</AlphaListBoxItem>
            <AlphaListBoxItem id="model-two" textValue="Model two">Model two</AlphaListBoxItem>
          </AlphaListBox>
          <AlphaButton onClick={onAuxiliary}>Favorite model</AlphaButton>
        </AlphaBoundary>
      </AlphaProvider>,
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

  it("refuses new native custom controls in the owned Board and Chat trees", () => {
    const boardOwners = [
      "Board.tsx", "Column.tsx", "TaskCard.tsx", "WorktreeGroup.tsx", "QuickEntryBox.tsx",
      "TaskContextMenu.tsx", "WorkflowSwitcher.tsx", "WorkflowOptionalStepsDropdown.tsx",
      "CustomModelDropdown.tsx", "DuplicateWarningModal.tsx", "TaskResetDialog.tsx", "PrCreateModal.tsx",
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
      const genericAlphaPortals = source.includes("<AlphaPortalSurface") ? [`${file}:generic-alpha-portal`] : [];
      return [...nativeControls, ...customRoles, ...customPrimitiveShells, ...genericAlphaPortals];
    });
    expect(violations).toEqual([]);
    expect(readAppFile("components/Column.tsx")).toContain("<AlphaMenu");
    expect(readAppFile("components/WorkflowSwitcher.tsx")).toContain("<AlphaListBox");
    expect(readAppFile("components/ChatView.tsx")).toContain("<AlphaDialogBackdrop");
    expect(readAppFile("components/PrCreateModal.tsx")).toContain("<AlphaDialogPanel");
  });

  it("keeps theme adaptation scoped and token-only", () => {
    const css = readAppFile("alpha-ui.css");
    const globalCss = readAppFile("styles.css");
    const viteConfig = readAppFile("../vite.config.ts");
    expect(css).toContain('[data-alpha-surface="true"]');
    expect(css).toContain('[data-alpha-portal="true"]');
    expect(css).toContain("@scope");
    expect(globalCss).not.toContain('@import "tailwindcss"');
    expect(css).not.toContain("@reference");
    expect(css).not.toContain("@source");
    expect(css).not.toContain("@apply");
    expect(viteConfig).toContain("react()");
    expect(css).toContain('[data-theme="light"]');
    expect(css).toContain('[data-theme="dark"]');
    expect(css).not.toContain('[data-color-theme');
    expect(css).not.toContain("--background: var(--bg)");
    expect(css).not.toContain("--focus: var(--accent)");
    expect(css).toContain("--danger: var(--alpha-neutral-danger)");
    expect(css).toContain("--warning: var(--alpha-neutral-warning)");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(css).not.toMatch(/\d+px\b/);
  });
});
