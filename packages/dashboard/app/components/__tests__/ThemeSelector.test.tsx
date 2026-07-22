import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ColorTheme } from "@fusion/core";
import { ThemeSelector } from "../ThemeSelector";

// FNXC:Theme 2026-07-16-14:30: FN-8146 pins the historical Settings-grid set, including restored shadcn-mono, so a removal from COLOR_THEMES cannot make the all-themes checks pass circularly.
const EXPECTED_THEME_IDS = ['default', 'ocean', 'forest', 'sunset', 'zen', 'berry', 'high-contrast', 'industrial', 'monochrome', 'slate', 'ash', 'air', 'graphite', 'silver', 'solarized', 'factory', 'factory-mono', 'ayu', 'one-dark', 'nord', 'dracula', 'gruvbox', 'tokyo-night', 'catppuccin-mocha', 'github-dark', 'everforest', 'rose-pine', 'kanagawa', 'night-owl', 'palenight', 'monokai-pro', 'slime', 'brutalist', 'neon-city', 'parchment', 'terminal', 'glass', 'glass-silver', 'horizon', 'vitesse', 'outrun', 'snazzy', 'porple', 'espresso', 'mars', 'poimandres', 'ember', 'rust', 'copper', 'foundry', 'carbon', 'sandstone', 'lagoon', 'frost', 'lavender', 'neon-bloom', 'sepia', 'cobalt', 'clay', 'moss', 'aurora', 'calm', 'shadcn', 'shadcn-ember', 'shadcn-custom', 'shadcn-blue', 'shadcn-green', 'shadcn-red', 'shadcn-purple', 'shadcn-pink', 'shadcn-orange', 'shadcn-yellow', 'shadcn-mono', 'shadcn-mono-red', 'shadcn-mono-blue', 'shadcn-mono-green', 'shadcn-mono-purple', 'shadcn-mono-pink', 'shadcn-mono-orange', 'shadcn-mono-yellow', 'shadcn-black', 'shadcn-gray', 'shadcn-gray-blue'] as const;

function renderedThemeIds(listbox: HTMLElement) {
  return within(listbox).getAllByRole("option").map((option) => {
    const swatch = option.querySelector<HTMLElement>(".theme-option-swatch");
    expect(swatch).toBeTruthy();
    return [...(swatch?.classList ?? [])].find((className) => className.startsWith("theme-swatch-"))?.replace("theme-swatch-", "");
  });
}

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

    const currentThemeTrigger = screen.getByRole("button", { name: /current theme dark \/ ocean/i });
    expect(currentThemeTrigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(currentThemeTrigger.querySelector(".theme-dropdown-current-row-icon svg")).toBeTruthy();
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
    const trigger = screen.getByRole("button", { name: /current theme dark \/ forest/i });

    fireEvent.click(trigger);

    const listbox = screen.getByRole("listbox", { name: "Color theme" });
    expect(renderedThemeIds(listbox)).toEqual(EXPECTED_THEME_IDS);
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
    const trigger = screen.getByRole("button", { name: new RegExp(`current theme dark / ${expectedLabel}`, "i") });

    expect(trigger).toHaveTextContent(`Dark / ${expectedLabel}`);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "Ocean" }));
    expect(onColorThemeChange).toHaveBeenCalledWith("ocean");
  });

  it("uses one merged current-theme trigger and renders Shadcn Custom's picker exactly once", () => {
    renderSelector("shadcn-custom");

    expect(document.querySelector(".theme-current-preview")).toBeNull();
    expect(screen.getAllByTestId("shadcn-color-picker")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /current theme dark \/ shadcn custom/i })).toBeInTheDocument();
  });
});
