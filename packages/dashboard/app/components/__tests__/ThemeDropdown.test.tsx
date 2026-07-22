import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ThemeDropdown } from "../ThemeDropdown";

// FNXC:Theme 2026-07-16-14:30: FN-8146 pins the historical Settings-grid set, including restored shadcn-mono, so a removal from COLOR_THEMES cannot make the all-themes checks pass circularly.
const EXPECTED_THEME_IDS = ['default', 'ocean', 'forest', 'sunset', 'zen', 'berry', 'high-contrast', 'industrial', 'monochrome', 'slate', 'ash', 'air', 'graphite', 'silver', 'solarized', 'factory', 'factory-mono', 'ayu', 'one-dark', 'nord', 'dracula', 'gruvbox', 'tokyo-night', 'catppuccin-mocha', 'github-dark', 'everforest', 'rose-pine', 'kanagawa', 'night-owl', 'palenight', 'monokai-pro', 'slime', 'brutalist', 'neon-city', 'parchment', 'terminal', 'glass', 'glass-silver', 'horizon', 'vitesse', 'outrun', 'snazzy', 'porple', 'espresso', 'mars', 'poimandres', 'ember', 'rust', 'copper', 'foundry', 'carbon', 'sandstone', 'lagoon', 'frost', 'lavender', 'neon-bloom', 'sepia', 'cobalt', 'clay', 'moss', 'aurora', 'calm', 'shadcn', 'shadcn-ember', 'shadcn-custom', 'shadcn-blue', 'shadcn-green', 'shadcn-red', 'shadcn-purple', 'shadcn-pink', 'shadcn-orange', 'shadcn-yellow', 'shadcn-mono', 'shadcn-mono-red', 'shadcn-mono-blue', 'shadcn-mono-green', 'shadcn-mono-purple', 'shadcn-mono-pink', 'shadcn-mono-orange', 'shadcn-mono-yellow', 'shadcn-black', 'shadcn-gray', 'shadcn-gray-blue'] as const;

function renderedThemeIds(listbox: HTMLElement) {
  return within(listbox).getAllByRole("option").map((option) => {
    const swatch = option.querySelector<HTMLElement>(".theme-option-swatch");
    expect(swatch).toBeTruthy();
    return [...(swatch?.classList ?? [])].find((className) => className.startsWith("theme-swatch-"))?.replace("theme-swatch-", "");
  });
}

describe("ThemeDropdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the current theme chip and opens all swatched theme options", () => {
    render(<ThemeDropdown colorTheme="shadcn-ember" onColorThemeChange={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: /shadcn ember/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(within(trigger).getByText("Shadcn Ember (Default)")).toBeDefined();
    expect(trigger.querySelector(".theme-swatch-shadcn-ember")).toBeTruthy();

    fireEvent.click(trigger);

    const listbox = screen.getByRole("listbox", { name: /color theme/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(renderedThemeIds(listbox)).toEqual(EXPECTED_THEME_IDS);
  });

  it("renders a current-row trigger with mode context and all historical theme options", () => {
    render(
      <ThemeDropdown
        triggerVariant="current-row"
        colorTheme="forest"
        themeMode="system"
        resolvedThemeMode="light"
        onColorThemeChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: /current theme system \/ forest/i });
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger.querySelector(".theme-dropdown-current-row-icon svg")).toBeTruthy();
    expect(trigger.querySelector(".theme-swatch-forest")).toBeTruthy();

    fireEvent.click(trigger);
    expect(renderedThemeIds(screen.getByRole("listbox", { name: /color theme/i }))).toEqual(EXPECTED_THEME_IDS);
  });

  it("keeps tokenized space below the Settings current-theme row", () => {
    const css = readFileSync("app/components/ThemeDropdown.css", "utf8");

    expect(css).toMatch(/\.theme-dropdown--current-row\s*\{\s*margin-bottom:\s*var\(--space-lg\);\s*\}/);
  });

  it("labels only Shadcn Ember as the default option", () => {
    render(<ThemeDropdown colorTheme="ocean" onColorThemeChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: /ocean/i }).textContent).toContain("Ocean");
    expect(screen.getByRole("button", { name: /ocean/i }).textContent).not.toContain("Default");

    fireEvent.click(screen.getByRole("button", { name: /ocean/i }));
    const defaultOptions = screen.getAllByRole("option").filter((option) => option.textContent?.includes("(Default)"));
    expect(defaultOptions).toHaveLength(1);
    expect(defaultOptions[0]).toHaveTextContent("Shadcn Ember (Default)");
  });

  it("renders Glass Silver as a non-empty compact dropdown option", () => {
    render(<ThemeDropdown colorTheme="glass-silver" onColorThemeChange={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: /glass silver/i });
    expect(trigger).toHaveTextContent("Glass Silver");
    expect(trigger.querySelector(".theme-swatch-glass-silver")).toBeTruthy();

    fireEvent.click(trigger);
    const glassSilverOption = screen.getByRole("option", { name: /glass silver/i });
    expect(glassSilverOption).toHaveTextContent("Glass Silver");
    expect(glassSilverOption.querySelector(".theme-swatch-glass-silver")).toBeTruthy();
  });

  it.each([
    ["compact", "compact" as const, /ocean/i],
    ["current-row", "current-row" as const, /current theme dark \/ ocean/i],
  ])("selects Calm with a non-empty preview from the shared %s trigger", (_label, triggerVariant, triggerName) => {
    document.documentElement.setAttribute("data-color-theme", "ocean");
    document.documentElement.setAttribute("data-theme", "dark");
    const previewTokens = document.createElement("style");
    previewTokens.textContent = `
      :root { --calm-swatch-sample-1: #111d2b; --calm-swatch-sample-2: #1b2a3a; --calm-swatch-sample-3: #8fc9b5; --calm-swatch-sample-4: #7da9c4; }
      [data-theme="light"] { --calm-swatch-sample-1: #f4f8fb; --calm-swatch-sample-2: #e1ebf0; --calm-swatch-sample-3: #2f7260; --calm-swatch-sample-4: #396f91; }
    `;
    document.head.appendChild(previewTokens);
    const onColorThemeChange = vi.fn();

    const { rerender } = render(
      <ThemeDropdown
        triggerVariant={triggerVariant}
        colorTheme="ocean"
        themeMode="dark"
        onColorThemeChange={onColorThemeChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: triggerName }));
    const calmOption = screen.getByRole("option", { name: "Calm" });
    expect(calmOption.querySelector(".theme-swatch-calm")).toBeTruthy();
    expect(calmOption.querySelectorAll(".theme-option-swatch-sample")).toHaveLength(4);
    for (const sample of [1, 2, 3, 4]) {
      expect(getComputedStyle(document.documentElement).getPropertyValue(`--calm-swatch-sample-${sample}`).trim()).not.toBe("");
    }
    fireEvent.click(calmOption);
    expect(onColorThemeChange).toHaveBeenCalledWith("calm");
    expect(screen.queryByRole("listbox")).toBeNull();

    document.documentElement.setAttribute("data-theme", "light");
    rerender(
      <ThemeDropdown
        triggerVariant={triggerVariant}
        colorTheme="ocean"
        themeMode="light"
        onColorThemeChange={onColorThemeChange}
      />,
    );
    for (const sample of [1, 2, 3, 4]) {
      expect(getComputedStyle(document.documentElement).getPropertyValue(`--calm-swatch-sample-${sample}`).trim()).not.toBe("");
    }
    previewTokens.remove();
  });

  it("selects themes and closes from click, escape, and outside click", () => {
    const onColorThemeChange = vi.fn();
    render(<ThemeDropdown colorTheme="default" onColorThemeChange={onColorThemeChange} />);

    fireEvent.click(screen.getByRole("button", { name: /fusion legacy/i }));
    fireEvent.click(screen.getAllByRole("option").find((element) => element.textContent?.trim() === "Forest")!);
    expect(onColorThemeChange).toHaveBeenCalledWith("forest");
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /fusion legacy/i }));
    fireEvent.keyDown(screen.getByRole("option", { name: /fusion legacy/i }), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /fusion legacy/i }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("is keyboard-operable with arrows and enter", () => {
    const onColorThemeChange = vi.fn();
    render(<ThemeDropdown colorTheme="default" onColorThemeChange={onColorThemeChange} />);

    const trigger = screen.getByRole("button", { name: /fusion legacy/i });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("option", { name: /fusion legacy/i }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("option", { name: /ocean/i }), { key: "Enter" });

    expect(onColorThemeChange).toHaveBeenCalledWith("ocean");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows the shadcn custom picker only for shadcn-custom", () => {
    const { rerender } = render(<ThemeDropdown colorTheme="default" onColorThemeChange={vi.fn()} />);
    expect(screen.queryByTestId("shadcn-color-picker")).toBeNull();

    rerender(<ThemeDropdown colorTheme="shadcn" onColorThemeChange={vi.fn()} />);
    expect(screen.queryByTestId("shadcn-color-picker")).toBeNull();

    rerender(
      <ThemeDropdown
        colorTheme="shadcn-custom"
        themeMode="light"
        resolvedThemeMode="light"
        shadcnCustomColors={{ "--accent": "#123456" }}
        onColorThemeChange={vi.fn()}
      />,
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
  });

  it("renders compact theme mode controls when mode props are supplied", () => {
    const onThemeModeChange = vi.fn();
    render(
      <ThemeDropdown
        colorTheme="default"
        themeMode="system"
        onColorThemeChange={vi.fn()}
        onThemeModeChange={onThemeModeChange}
      />,
    );

    const modeGroup = screen.getByRole("radiogroup", { name: /theme mode/i });
    expect(within(modeGroup).getByRole("button", { name: /light/i })).toHaveAttribute("aria-pressed", "false");
    expect(within(modeGroup).getByRole("button", { name: /dark/i })).toHaveAttribute("aria-pressed", "false");
    expect(within(modeGroup).getByRole("button", { name: /system/i })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(within(modeGroup).getByRole("button", { name: /light/i }));
    expect(onThemeModeChange).toHaveBeenCalledWith("light");
  });

  it.each([
    ["without mode controls", undefined, undefined],
    ["with mode controls", "dark" as const, vi.fn()],
  ])("elevates the open popover above Command Center sibling cards %s", (_label, themeMode, onThemeModeChange) => {
    render(
      <ThemeDropdown
        colorTheme="default"
        themeMode={themeMode}
        onColorThemeChange={vi.fn()}
        onThemeModeChange={onThemeModeChange}
      />,
    );

    const trigger = screen.getByRole("button", { name: /fusion legacy/i });
    const root = trigger.closest(".theme-dropdown");
    expect(root).toBeTruthy();
    expect(root?.classList.contains("open")).toBe(false);
    expect(getComputedStyle(root!).zIndex).not.toBe("10002");

    fireEvent.click(trigger);

    const popover = document.querySelector<HTMLElement>(".theme-dropdown-popover");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(root?.classList.contains("open")).toBe(true);
    expect(getComputedStyle(root!).position).toBe("relative");
    expect(getComputedStyle(root!).zIndex).toBe("10002");
    expect(popover).toBeTruthy();
    expect(getComputedStyle(popover!).position).toBe("absolute");
    expect(getComputedStyle(popover!).zIndex).toBe("10002");
  });

  it("keeps Shadcn Mono and Mono Red swatches scoped to the active light mode", () => {
    const css = readFileSync("app/components/ThemeSelector.css", "utf8");

    expect(css).toContain('[data-theme="light"] .theme-swatch-shadcn-mono,\n[data-theme="light"] .theme-swatch-shadcn-mono-red');
    expect(css).not.toContain('[data-theme="light"] .theme-swatch-shadcn-mono,\n.theme-swatch-shadcn-mono-red');
  });

  it("preserves the mobile static in-flow popover branch without dropdown elevation", () => {
    const css = readFileSync("app/components/ThemeDropdown.css", "utf8");

    expect(css).toMatch(
      /@media \(max-width: 768px\) \{[\s\S]*?\.theme-dropdown\.open \{[\s\S]*?z-index: auto;[\s\S]*?\.theme-dropdown-popover \{[\s\S]*?position: static;[\s\S]*?z-index: auto;/,
    );
  });
});
