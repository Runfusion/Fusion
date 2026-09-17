/*
FNXC:UiStyleAxis 2026-09-15-00:20:
The interface style is a second appearance axis with ONE shared control rendered by both entry points.
This suite proves the control's own contract (both options visible, keyboard reachable, selection
published exactly once, preview purely local) and that ThemeSelector — the component Settings → Appearance
and the Command Center theme card both render — exposes the two axes independently: choosing a style never
emits a colour change, choosing a colour never emits a style change, and an Appearance reset restores the
default style together with the other appearance defaults.
*/

import "../UiStyleSelector.css";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UiStyleSelector } from "../UiStyleSelector";
import { ThemeSelector } from "../ThemeSelector";

vi.mock("../ThemeDropdown", () => ({
  ThemeDropdown: ({ onColorThemeChange }: { onColorThemeChange: (theme: string) => void }) => (
    <button type="button" onClick={() => onColorThemeChange("shadcn-purple")}>Pick colour</button>
  ),
}));

afterEach(() => {
  document.documentElement.removeAttribute("data-ui-style");
});

describe("UiStyleSelector", () => {
  it("renders both styles as one radiogroup with the current value selected", () => {
    render(<UiStyleSelector uiStyle="classic" onChange={vi.fn()} />);

    const group = screen.getByRole("radiogroup", { name: "Interface style" });
    const options = screen.getAllByRole("radio");
    expect(options).toHaveLength(2);
    expect(group).toContainElement(options[0]!);
    expect(screen.getByTestId("ui-style-option-classic")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("ui-style-option-clean")).toHaveAttribute("aria-checked", "false");
  });

  it("publishes exactly one selection and does not touch the document", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<UiStyleSelector uiStyle="classic" onChange={onChange} />);

    await user.click(screen.getByTestId("ui-style-option-clean"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("clean");
    // The selector is controlled: applying the choice is the owner's job, not a local document write.
    expect(document.documentElement.hasAttribute("data-ui-style")).toBe(false);
  });

  it("is selectable from the keyboard", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<UiStyleSelector uiStyle="classic" onChange={onChange} />);

    screen.getByTestId("ui-style-option-clean").focus();
    expect(screen.getByTestId("ui-style-option-clean")).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledWith("clean");
  });

  it("previews each style locally without writing anything on hover or focus", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(<UiStyleSelector uiStyle="classic" onChange={onChange} />);

    const previews = container.querySelectorAll<HTMLElement>(".ui-style-preview");
    expect(previews).toHaveLength(2);
    expect(previews[0]!.dataset.uiStyle).toBe("classic");
    expect(previews[1]!.dataset.uiStyle).toBe("clean");

    await user.hover(screen.getByTestId("ui-style-option-clean"));
    screen.getByTestId("ui-style-option-clean").focus();

    expect(onChange).not.toHaveBeenCalled();
    expect(document.documentElement.hasAttribute("data-ui-style")).toBe(false);
  });
});

describe("ThemeSelector exposes both appearance axes independently", () => {
  function renderSelector(overrides: Record<string, unknown> = {}) {
    const handlers = {
      onThemeModeChange: vi.fn(),
      onColorThemeChange: vi.fn(),
      onUiStyleChange: vi.fn(),
      onDashboardFontScaleChange: vi.fn(),
      onShadcnCustomColorsChange: vi.fn(),
    };
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="ocean"
        uiStyle="classic"
        {...handlers}
        {...overrides}
      />,
    );
    return handlers;
  }

  it("renders the style selector beside the colour controls", () => {
    renderSelector();
    expect(screen.getByRole("radiogroup", { name: "Interface style" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pick colour" })).toBeInTheDocument();
  });

  it("changing the style emits no colour change", async () => {
    const user = userEvent.setup();
    const handlers = renderSelector();

    await user.click(screen.getByTestId("ui-style-option-clean"));

    expect(handlers.onUiStyleChange).toHaveBeenCalledWith("clean");
    expect(handlers.onColorThemeChange).not.toHaveBeenCalled();
    expect(handlers.onThemeModeChange).not.toHaveBeenCalled();
    expect(handlers.onDashboardFontScaleChange).not.toHaveBeenCalled();
  });

  it("changing the colour emits no style change", async () => {
    const user = userEvent.setup();
    const handlers = renderSelector();

    await user.click(screen.getByRole("button", { name: "Pick colour" }));

    expect(handlers.onColorThemeChange).toHaveBeenCalledWith("shadcn-purple");
    expect(handlers.onUiStyleChange).not.toHaveBeenCalled();
  });

  it("resetting appearance restores the default style with the other defaults", async () => {
    const user = userEvent.setup();
    const handlers = renderSelector({ uiStyle: "clean" });

    await user.click(screen.getByRole("button", { name: "Reset to default theme" }));

    expect(handlers.onUiStyleChange).toHaveBeenCalledWith("classic");
    expect(handlers.onThemeModeChange).toHaveBeenCalledWith("system");
    expect(handlers.onColorThemeChange).toHaveBeenCalledWith("shadcn-ember");
    expect(handlers.onDashboardFontScaleChange).toHaveBeenCalledWith(100);
  });

  it("reflects the current style so both entry points show the same selection", () => {
    renderSelector({ uiStyle: "clean" });
    expect(screen.getByTestId("ui-style-option-clean")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("ui-style-option-classic")).toHaveAttribute("aria-checked", "false");
  });
});
