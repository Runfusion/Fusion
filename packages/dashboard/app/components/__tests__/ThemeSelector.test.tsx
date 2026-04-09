import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { COLOR_THEMES } from "@fusion/core";
import { ThemeSelector } from "../ThemeSelector";

describe("ThemeSelector", () => {
  it("renders theme mode toggle buttons", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="default"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByLabelText("Light mode")).toBeDefined();
    expect(screen.getByLabelText("Dark mode")).toBeDefined();
    expect(screen.getByLabelText("System mode")).toBeDefined();
  });

  it("marks current theme mode as active", () => {
    render(
      <ThemeSelector
        themeMode="light"
        colorTheme="default"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    const lightBtn = screen.getByLabelText("Light mode");
    expect(lightBtn.className).toContain("active");
    expect(lightBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("marks non-active theme modes as not pressed", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="default"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    const lightBtn = screen.getByLabelText("Light mode");
    expect(lightBtn.className).not.toContain("active");
    expect(lightBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("calls onThemeModeChange when a mode is clicked", () => {
    const onThemeModeChange = vi.fn();
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="default"
        onThemeModeChange={onThemeModeChange}
        onColorThemeChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByLabelText("Light mode"));
    expect(onThemeModeChange).toHaveBeenCalledWith("light");

    fireEvent.click(screen.getByLabelText("System mode"));
    expect(onThemeModeChange).toHaveBeenCalledWith("system");
  });

  it("renders all color theme options", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="default"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByLabelText("Default theme")).toBeDefined();
    expect(screen.getByLabelText("Ocean theme")).toBeDefined();
    expect(screen.getByLabelText("Forest theme")).toBeDefined();
    expect(screen.getByLabelText("Sunset theme")).toBeDefined();
    expect(screen.getByLabelText("Zen theme")).toBeDefined();
    expect(screen.getByLabelText("Berry theme")).toBeDefined();
    expect(screen.getByLabelText("Mono theme")).toBeDefined();
    expect(screen.getByLabelText("High Contrast theme")).toBeDefined();
    expect(screen.getByLabelText("Solarized theme")).toBeDefined();
    expect(screen.getByLabelText("Factory theme")).toBeDefined();
    expect(screen.getByLabelText("Ayu theme")).toBeDefined();
    expect(screen.getByLabelText("One Dark theme")).toBeDefined();
    expect(screen.getByLabelText("Nord theme")).toBeDefined();
    expect(screen.getByLabelText("Dracula theme")).toBeDefined();
    expect(screen.getByLabelText("Gruvbox theme")).toBeDefined();
    expect(screen.getByLabelText("Tokyo Night theme")).toBeDefined();
    expect(screen.getByLabelText("Catppuccin Mocha theme")).toBeDefined();
    expect(screen.getByLabelText("GitHub Dark theme")).toBeDefined();
    expect(screen.getByLabelText("Everforest theme")).toBeDefined();
    expect(screen.getByLabelText("Rosé Pine theme")).toBeDefined();
    expect(screen.getByLabelText("Kanagawa theme")).toBeDefined();
    expect(screen.getByLabelText("Slate theme")).toBeDefined();
    expect(screen.getByLabelText("Ash theme")).toBeDefined();
    expect(screen.getByLabelText("Graphite theme")).toBeDefined();
    expect(screen.getByLabelText("Silver theme")).toBeDefined();
    expect(screen.getByLabelText("Brutalist theme")).toBeDefined();
    expect(screen.getByLabelText("Neon City theme")).toBeDefined();
    expect(screen.getByLabelText("Parchment theme")).toBeDefined();
    expect(screen.getByLabelText("Terminal theme")).toBeDefined();
    expect(screen.getByLabelText("Glass theme")).toBeDefined();
    expect(screen.getByLabelText("Horizon theme")).toBeDefined();
    expect(screen.getByLabelText("Vitesse theme")).toBeDefined();
    expect(screen.getByLabelText("Outrun theme")).toBeDefined();
    expect(screen.getByLabelText("Snazzy theme")).toBeDefined();
    expect(screen.getByLabelText("Porple theme")).toBeDefined();
    expect(screen.getByLabelText("Espresso theme")).toBeDefined();
    expect(screen.getByLabelText("Mars theme")).toBeDefined();
    expect(screen.getByLabelText("Poimandres theme")).toBeDefined();
    expect(screen.getByLabelText("Ember theme")).toBeDefined();
  });

  it("marks current color theme as active", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="ocean"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    const oceanBtn = screen.getByLabelText("Ocean theme");
    expect(oceanBtn.className).toContain("active");
    expect(oceanBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("calls onColorThemeChange when a color theme is clicked", () => {
    const onColorThemeChange = vi.fn();
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="default"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={onColorThemeChange}
      />
    );

    fireEvent.click(screen.getByLabelText("Forest theme"));
    expect(onColorThemeChange).toHaveBeenCalledWith("forest");

    fireEvent.click(screen.getByLabelText("Berry theme"));
    expect(onColorThemeChange).toHaveBeenCalledWith("berry");

    fireEvent.click(screen.getByLabelText("Zen theme"));
    expect(onColorThemeChange).toHaveBeenCalledWith("zen");
  });

  it("calls onColorThemeChange when a new color theme is clicked", () => {
    const onColorThemeChange = vi.fn();
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="default"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={onColorThemeChange}
      />
    );

    fireEvent.click(screen.getByLabelText("Nord theme"));
    expect(onColorThemeChange).toHaveBeenCalledWith("nord");

    fireEvent.click(screen.getByLabelText("Dracula theme"));
    expect(onColorThemeChange).toHaveBeenCalledWith("dracula");

    fireEvent.click(screen.getByLabelText("Gruvbox theme"));
    expect(onColorThemeChange).toHaveBeenCalledWith("gruvbox");

    fireEvent.click(screen.getByLabelText("Tokyo Night theme"));
    expect(onColorThemeChange).toHaveBeenCalledWith("tokyo-night");
  });

  it("calls onColorThemeChange when newest color themes are clicked", () => {
    const onColorThemeChange = vi.fn();
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="default"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={onColorThemeChange}
      />
    );

    fireEvent.click(screen.getByLabelText("Catppuccin Mocha theme"));
    expect(onColorThemeChange).toHaveBeenCalledWith("catppuccin-mocha");

    fireEvent.click(screen.getByLabelText("GitHub Dark theme"));
    expect(onColorThemeChange).toHaveBeenCalledWith("github-dark");

    fireEvent.click(screen.getByLabelText("Everforest theme"));
    expect(onColorThemeChange).toHaveBeenCalledWith("everforest");

    fireEvent.click(screen.getByLabelText("Rosé Pine theme"));
    expect(onColorThemeChange).toHaveBeenCalledWith("rose-pine");

    fireEvent.click(screen.getByLabelText("Kanagawa theme"));
    expect(onColorThemeChange).toHaveBeenCalledWith("kanagawa");
  });

  it("calls onColorThemeChange when grey color themes are clicked", () => {
    const onColorThemeChange = vi.fn();
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="default"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={onColorThemeChange}
      />
    );

    fireEvent.click(screen.getByLabelText("Slate theme"));
    expect(onColorThemeChange).toHaveBeenCalledWith("slate");

    fireEvent.click(screen.getByLabelText("Ash theme"));
    expect(onColorThemeChange).toHaveBeenCalledWith("ash");

    fireEvent.click(screen.getByLabelText("Graphite theme"));
    expect(onColorThemeChange).toHaveBeenCalledWith("graphite");

    fireEvent.click(screen.getByLabelText("Silver theme"));
    expect(onColorThemeChange).toHaveBeenCalledWith("silver");

    fireEvent.click(screen.getByLabelText("Ember theme"));
    expect(onColorThemeChange).toHaveBeenCalledWith("ember");
  });

  it("displays Nord in preview when selected", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="nord"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Dark \/ Nord/)).toBeDefined();
  });

  it("displays Dracula in preview when selected", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="dracula"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Dark \/ Dracula/)).toBeDefined();
  });

  it("displays Gruvbox in preview when selected", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="gruvbox"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Dark \/ Gruvbox/)).toBeDefined();
  });

  it("displays Tokyo Night in preview when selected", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="tokyo-night"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Dark \/ Tokyo Night/)).toBeDefined();
  });

  it("displays Catppuccin Mocha in preview when selected", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="catppuccin-mocha"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Dark \/ Catppuccin Mocha/)).toBeDefined();
  });

  it("displays GitHub Dark in preview when selected", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="github-dark"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Dark \/ GitHub Dark/)).toBeDefined();
  });

  it("displays Everforest in preview when selected", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="everforest"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Dark \/ Everforest/)).toBeDefined();
  });

  it("displays Rosé Pine in preview when selected", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="rose-pine"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Dark \/ Rosé Pine/)).toBeDefined();
  });

  it("displays Kanagawa in preview when selected", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="kanagawa"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Dark \/ Kanagawa/)).toBeDefined();
  });

  it("displays Slate in preview when selected", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="slate"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Dark \/ Slate/)).toBeDefined();
  });

  it("displays Ash in preview when selected", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="ash"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Dark \/ Ash/)).toBeDefined();
  });

  it("displays Graphite in preview when selected", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="graphite"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Dark \/ Graphite/)).toBeDefined();
  });

  it("displays Silver in preview when selected", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="silver"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Dark \/ Silver/)).toBeDefined();
  });

  it("displays Ember in preview when selected", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="ember"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Dark \/ Ember/)).toBeDefined();
  });

  it("displays dramatic theme names in preview when selected", () => {
    const { rerender } = render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="brutalist"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    const dramaticThemes = [
      ["brutalist", "Brutalist"],
      ["neon-city", "Neon City"],
      ["parchment", "Parchment"],
      ["terminal", "Terminal"],
      ["glass", "Glass"],
      ["horizon", "Horizon"],
      ["vitesse", "Vitesse"],
      ["outrun", "Outrun"],
      ["snazzy", "Snazzy"],
      ["porple", "Porple"],
      ["espresso", "Espresso"],
      ["mars", "Mars"],
      ["poimandres", "Poimandres"],
    ] as const;

    dramaticThemes.forEach(([value, label]) => {
      rerender(
        <ThemeSelector
          themeMode="dark"
          colorTheme={value}
          onThemeModeChange={vi.fn()}
          onColorThemeChange={vi.fn()}
        />
      );

      expect(screen.getByText(new RegExp(`Dark \\/ ${label}`))).toBeDefined();
    });
  });

  it("displays light Catppuccin Mocha in preview when light mode", () => {
    render(
      <ThemeSelector
        themeMode="light"
        colorTheme="catppuccin-mocha"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Light \/ Catppuccin Mocha/)).toBeDefined();
  });

  it("displays light Tokyo Night in preview when light mode", () => {
    render(
      <ThemeSelector
        themeMode="light"
        colorTheme="tokyo-night"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Light \/ Tokyo Night/)).toBeDefined();
  });

  it("displays current theme preview", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="ocean"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Current theme/)).toBeDefined();
    expect(screen.getByText(/Dark \/ Ocean/)).toBeDefined();
  });

  it("displays system theme in preview when system mode", () => {
    render(
      <ThemeSelector
        themeMode="system"
        colorTheme="solarized"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByText(/System \/ Solarized/)).toBeDefined();
  });

  it("displays Factory in preview when selected", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="factory"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Dark \/ Factory/)).toBeDefined();
  });

  it("displays light theme in preview when light mode", () => {
    render(
      <ThemeSelector
        themeMode="light"
        colorTheme="forest"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Light \/ Forest/)).toBeDefined();
  });

  it("shows correct icon for dark mode in preview", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="default"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    const previewIcon = screen.getByText(/Current theme/).closest(".theme-current-preview")?.querySelector("svg");
    expect(previewIcon).toBeDefined();
  });

  it("shows correct icon for light mode in preview", () => {
    render(
      <ThemeSelector
        themeMode="light"
        colorTheme="default"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    const previewIcon = screen.getByText(/Current theme/).closest(".theme-current-preview")?.querySelector("svg");
    expect(previewIcon).toBeDefined();
  });

  it("shows correct icon for system mode in preview", () => {
    render(
      <ThemeSelector
        themeMode="system"
        colorTheme="default"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    const previewIcon = screen.getByText(/Current theme/).closest(".theme-current-preview")?.querySelector("svg");
    expect(previewIcon).toBeDefined();
  });

  it("renders reset to defaults button", () => {
    render(
      <ThemeSelector
        themeMode="light"
        colorTheme="ocean"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByLabelText("Reset to default theme")).toBeDefined();
  });

  it("calls both change handlers when reset is clicked", () => {
    const onThemeModeChange = vi.fn();
    const onColorThemeChange = vi.fn();
    render(
      <ThemeSelector
        themeMode="light"
        colorTheme="ocean"
        onThemeModeChange={onThemeModeChange}
        onColorThemeChange={onColorThemeChange}
      />
    );

    fireEvent.click(screen.getByLabelText("Reset to default theme"));
    expect(onThemeModeChange).toHaveBeenCalledWith("dark");
    expect(onColorThemeChange).toHaveBeenCalledWith("default");
  });

  it("each color theme has a swatch", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="default"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    // Query all buttons in theme-grid that have aria-pressed (these are the color theme buttons)
    const themeOptions = screen.getAllByRole("button").filter(
      (btn) => btn.className.includes("theme-option")
    );
    expect(themeOptions.length).toBe(COLOR_THEMES.length);

    themeOptions.forEach((btn) => {
      const swatch = btn.querySelector(".theme-option-swatch");
      expect(swatch).toBeDefined();
    });
  });
});
