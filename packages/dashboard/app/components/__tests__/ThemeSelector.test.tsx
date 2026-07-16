import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ColorTheme } from "@fusion/core";
import { ThemeSelector } from "../ThemeSelector";
import { COLOR_THEMES } from "../themeOptions";

function renderSelector(colorTheme: ColorTheme | undefined) {
  const onThemeModeChange = vi.fn();
  const onColorThemeChange = vi.fn();
  const onDashboardFontScaleChange = vi.fn();
  const onShadcnCustomColorsChange = vi.fn();

  render(
    <ThemeSelector
      themeMode="dark"
      colorTheme={colorTheme as ColorTheme}
      shadcnCustomColors={{ "--accent": "#123456" }}
      onThemeModeChange={onThemeModeChange}
      onColorThemeChange={onColorThemeChange}
      onDashboardFontScaleChange={onDashboardFontScaleChange}
      onShadcnCustomColorsChange={onShadcnCustomColorsChange}
    />,
  );

  return { onThemeModeChange, onColorThemeChange, onDashboardFontScaleChange, onShadcnCustomColorsChange };
}

describe("ThemeSelector", () => {
  it("uses the shared dropdown and preserves Settings mode, font-size, and reset controls", () => {
    const { onThemeModeChange, onColorThemeChange, onDashboardFontScaleChange, onShadcnCustomColorsChange } = renderSelector("ocean");

    expect(screen.getByRole("button", { name: "Ocean" })).toHaveAttribute("aria-haspopup", "listbox");
    expect(screen.getAllByRole("radiogroup")).toHaveLength(2);
    expect(screen.getByLabelText("Light mode")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Small" })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Light mode"));
    fireEvent.click(screen.getByRole("button", { name: "Small" }));
    fireEvent.click(screen.getByLabelText("Reset to default theme"));

    expect(onThemeModeChange).toHaveBeenCalledWith("light");
    expect(onThemeModeChange).toHaveBeenCalledWith("system");
    expect(onColorThemeChange).toHaveBeenCalledWith("shadcn-ember");
    expect(onDashboardFontScaleChange).toHaveBeenCalledWith(90);
    expect(onDashboardFontScaleChange).toHaveBeenCalledWith(100);
    expect(onShadcnCustomColorsChange).toHaveBeenCalledWith({});
  });

  it("opens shared swatched options and selects a color theme", () => {
    const { onColorThemeChange } = renderSelector("forest");
    const trigger = screen.getByRole("button", { name: "Forest" });

    fireEvent.click(trigger);

    const listbox = screen.getByRole("listbox", { name: "Color theme" });
    expect(within(listbox).getAllByRole("option")).toHaveLength(COLOR_THEMES.length);
    const oceanOption = within(listbox).getByRole("option", { name: "Ocean" });
    expect(oceanOption.querySelector(".theme-swatch-ocean")).toBeTruthy();
    fireEvent.click(oceanOption);

    expect(onColorThemeChange).toHaveBeenCalledWith("ocean");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it.each([
    [undefined as unknown as ColorTheme, "Fusion Legacy"],
    ["not-a-theme" as unknown as ColorTheme, "Fusion Legacy"],
    ["default" as ColorTheme, "Fusion Legacy"],
    ["ocean" as ColorTheme, "Ocean"],
    ["forest" as ColorTheme, "Forest"],
  ])("uses the dashboard fallback and label for %s", (colorTheme, expectedLabel) => {
    const { onColorThemeChange } = renderSelector(colorTheme);
    const trigger = screen.getByRole("button", { name: expectedLabel });

    expect(trigger).toHaveTextContent(expectedLabel);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "Ocean" }));
    expect(onColorThemeChange).toHaveBeenCalledWith("ocean");
  });

  it("renders Shadcn Custom's picker exactly once through the shared dropdown", () => {
    renderSelector("shadcn-custom");

    expect(screen.getAllByTestId("shadcn-color-picker")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Shadcn Custom" })).toBeInTheDocument();
  });
});
