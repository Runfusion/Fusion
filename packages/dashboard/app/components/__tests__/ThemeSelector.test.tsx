import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
    expect(screen.getByLabelText("Berry theme")).toBeDefined();
    expect(screen.getByLabelText("Mono theme")).toBeDefined();
    expect(screen.getByLabelText("High Contrast theme")).toBeDefined();
    expect(screen.getByLabelText("Solarized theme")).toBeDefined();
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
    expect(themeOptions.length).toBe(8);

    themeOptions.forEach((btn) => {
      const swatch = btn.querySelector(".theme-option-swatch");
      expect(swatch).toBeDefined();
    });
  });
});
