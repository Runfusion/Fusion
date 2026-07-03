import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { COLOR_THEMES } from "@fusion/core";
import { ThemeSelector } from "../ThemeSelector";
import { COLOR_THEMES as THEME_OPTIONS } from "../themeOptions";

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

    // FNXC:Theme 2026-06-22-09:30: Assert the accessibility invariant — every theme in the
    // shared COLOR_THEMES list renders an accessibly-labeled option — instead of a frozen
    // hardcoded label list that drifts whenever themes are renamed/added (e.g. FN-6813 mono variants).
    const colorThemeGroup = screen.getByRole("radiogroup", { name: "Color theme" });
    const themeButtons = within(colorThemeGroup).getAllByRole("button");

    expect(themeButtons).toHaveLength(THEME_OPTIONS.length);
    for (const theme of THEME_OPTIONS) {
      expect(screen.getByLabelText(`${theme.label} theme`)).toBeDefined();
    }
    expect(THEME_OPTIONS.map((theme) => theme.value)).toEqual([...COLOR_THEMES]);
    /*
    FNXC:Theme 2026-06-25-16:55:
    The default color theme can be renamed for users without changing its persisted value; assert the selected default option through shared theme metadata so tests do not go stale on label-only copy changes.
    */
    const defaultTheme = THEME_OPTIONS.find((theme) => theme.value === "default")!;
    expect(screen.getByLabelText(`${defaultTheme.label} theme`).getAttribute("aria-pressed")).toBe("true");
  });

  it("marks only Shadcn Ember as the default color theme label", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="shadcn-ember"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.getByLabelText("Shadcn Ember (Default) theme")).toBeDefined();
    expect(screen.getByLabelText("Ocean theme")).toBeDefined();
    expect(screen.queryByLabelText("Ocean (Default) theme")).toBeNull();
    expect(THEME_OPTIONS.filter((theme) => theme.label.includes("(Default)")).map((theme) => theme.value)).toEqual([
      "shadcn-ember",
    ]);
  });

  it("renders every shared swatch class from themeOptions", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="default"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    for (const theme of THEME_OPTIONS) {
      const option = screen.getByLabelText(`${theme.label} theme`);
      expect(option.querySelector(`.${theme.className}`)).toBeTruthy();
    }
    expect(THEME_OPTIONS.map((theme) => theme.value)).toEqual([...COLOR_THEMES]);
  });

  it("renders the Glass Silver affordance with a non-empty label and swatch", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="glass-silver"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    const option = screen.getByLabelText("Glass Silver theme");
    expect(option).toHaveTextContent("Glass Silver");
    expect(option.querySelector(".theme-swatch-glass-silver")).toBeTruthy();
    expect(option.getAttribute("aria-pressed")).toBe("true");
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
      ["rust", "Rust"],
      ["copper", "Copper"],
      ["foundry", "Foundry"],
      ["carbon", "Carbon"],
      ["sandstone", "Sandstone"],
      ["lagoon", "Lagoon"],
      ["frost", "Frost"],
      ["lavender", "Lavender"],
      ["neon-bloom", "Neon Bloom"],
      ["sepia", "Sepia"],
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
    expect(onThemeModeChange).toHaveBeenCalledWith("system");
    expect(onColorThemeChange).toHaveBeenCalledWith("shadcn-ember");
  });

  it("shows the shadcn custom picker only for shadcn-custom", () => {
    const { rerender } = render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="default"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    expect(screen.queryByTestId("shadcn-color-picker")).toBeNull();

    rerender(
      <ThemeSelector
        themeMode="dark"
        colorTheme="shadcn"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );
    expect(screen.queryByTestId("shadcn-color-picker")).toBeNull();

    rerender(
      <ThemeSelector
        themeMode="light"
        colorTheme="shadcn-custom"
        shadcnCustomColors={{ "--accent": "#123456" }}
        resolvedThemeMode="light"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );
    expect(screen.getByTestId("shadcn-color-picker")).toBeDefined();
    const showCustomColors = screen.getByRole("button", { name: "Show custom colors" });
    expect(showCustomColors).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("shadcn-color-picker-controls")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset custom colors" })).toBeNull();
    expect(screen.queryByTestId("shadcn-color---accent")).toBeNull();

    fireEvent.click(showCustomColors);
    expect(screen.getByRole("button", { name: "Collapse custom colors" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("shadcn-color-picker-controls")).toBeDefined();
    const accentRow = screen.getByTestId("shadcn-color---accent");
    expect(within(accentRow).getByRole("textbox")).toHaveValue("#123456");
    expect(screen.getByLabelText("Shadcn Custom theme").getAttribute("aria-pressed")).toBe("true");
  });

  it("reset to defaults clears shadcn custom color overrides", () => {
    const onShadcnCustomColorsChange = vi.fn();
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="shadcn-custom"
        shadcnCustomColors={{ "--accent": "#123456" }}
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
        onShadcnCustomColorsChange={onShadcnCustomColorsChange}
      />
    );

    fireEvent.click(screen.getByLabelText("Reset to default theme"));
    expect(onShadcnCustomColorsChange).toHaveBeenCalledWith({});
  });

  it("each color theme has a swatch with four explicit sample colors", () => {
    render(
      <ThemeSelector
        themeMode="dark"
        colorTheme="default"
        onThemeModeChange={vi.fn()}
        onColorThemeChange={vi.fn()}
      />
    );

    const themeOptions = screen.getAllByRole("button").filter(
      (btn) => btn.className.includes("theme-option")
    );
    expect(themeOptions.length).toBe(COLOR_THEMES.length);

    themeOptions.forEach((btn) => {
      const swatch = btn.querySelector(".theme-option-swatch");
      expect(swatch).toBeDefined();

      const samples = swatch?.querySelectorAll(".theme-option-swatch-sample");
      expect(samples?.length).toBe(4);
    });
  });
});
