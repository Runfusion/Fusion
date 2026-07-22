import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import i18next from "i18next";
import { ThemeDropdown } from "../ThemeDropdown";

// FNXC:Theme 2026-07-16-14:30: FN-8146 pins the historical Settings-grid set, including restored shadcn-mono, so a removal from COLOR_THEMES cannot make the all-themes checks pass circularly.
const EXPECTED_THEME_IDS = ['default', 'ocean', 'forest', 'sunset', 'zen', 'berry', 'high-contrast', 'industrial', 'monochrome', 'slate', 'ash', 'air', 'graphite', 'silver', 'solarized', 'factory', 'factory-mono', 'ayu', 'one-dark', 'nord', 'dracula', 'gruvbox', 'tokyo-night', 'catppuccin-mocha', 'github-dark', 'everforest', 'rose-pine', 'kanagawa', 'night-owl', 'palenight', 'monokai-pro', 'slime', 'brutalist', 'neon-city', 'parchment', 'terminal', 'glass', 'glass-silver', 'horizon', 'vitesse', 'outrun', 'snazzy', 'porple', 'espresso', 'mars', 'poimandres', 'ember', 'rust', 'copper', 'foundry', 'carbon', 'sandstone', 'lagoon', 'frost', 'lavender', 'neon-bloom', 'sepia', 'cobalt', 'clay', 'moss', 'aurora', 'calm', 'dawn', 'shadcn', 'shadcn-ember', 'shadcn-custom', 'shadcn-blue', 'shadcn-green', 'shadcn-red', 'shadcn-purple', 'shadcn-pink', 'shadcn-orange', 'shadcn-yellow', 'shadcn-mono', 'shadcn-mono-red', 'shadcn-mono-blue', 'shadcn-mono-green', 'shadcn-mono-purple', 'shadcn-mono-pink', 'shadcn-mono-orange', 'shadcn-mono-yellow', 'shadcn-black', 'shadcn-gray', 'shadcn-gray-blue'] as const;

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
  ])("selects Dawn with a non-empty preview from the shared %s trigger", (_label, triggerVariant, triggerName) => {
    document.documentElement.setAttribute("data-color-theme", "ocean");
    document.documentElement.setAttribute("data-theme", "dark");
    const previewTokens = document.createElement("style");
    previewTokens.textContent = `
      :root { --dawn-swatch-sample-1: #151229; --dawn-swatch-sample-2: #2a2248; --dawn-swatch-sample-3: #efb66a; --dawn-swatch-sample-4: #c8a4ff; }
      [data-theme="light"] { --dawn-swatch-sample-1: #fff8f2; --dawn-swatch-sample-2: #f1ddd7; --dawn-swatch-sample-3: #9b5618; --dawn-swatch-sample-4: #704eaa; }
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
    const dawnOption = screen.getByRole("option", { name: "Dawn" });
    expect(dawnOption.querySelector(".theme-swatch-dawn")).toBeTruthy();
    expect(dawnOption.querySelectorAll(".theme-option-swatch-sample")).toHaveLength(4);
    for (const sample of [1, 2, 3, 4]) {
      expect(getComputedStyle(document.documentElement).getPropertyValue(`--dawn-swatch-sample-${sample}`).trim()).not.toBe("");
    }
    fireEvent.click(dawnOption);
    expect(onColorThemeChange).toHaveBeenCalledWith("dawn");
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
      expect(getComputedStyle(document.documentElement).getPropertyValue(`--dawn-swatch-sample-${sample}`).trim()).not.toBe("");
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

  it("filters rendered labels case- and diacritic-insensitively without changing canonical order", () => {
    render(<ThemeDropdown colorTheme="ocean" onColorThemeChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /ocean/i }));
    const filter = screen.getByRole("searchbox", { name: /filter color themes/i });

    fireEvent.change(filter, { target: { value: "  shadcn mono red  " } });
    expect(renderedThemeIds(screen.getByRole("listbox"))).toEqual(["shadcn-mono-red"]);

    fireEvent.change(filter, { target: { value: "rose pine" } });
    expect(renderedThemeIds(screen.getByRole("listbox"))).toEqual(["rose-pine"]);

    fireEvent.change(filter, { target: { value: "   " } });
    expect(renderedThemeIds(screen.getByRole("listbox"))).toEqual(EXPECTED_THEME_IDS);
    expect(new Set(renderedThemeIds(screen.getByRole("listbox"))).size).toBe(EXPECTED_THEME_IDS.length);
  });

  it("filters the translated display label and falls back to theme metadata", () => {
    i18next.addResourceBundle("en", "app", { theme: { colorTheme: { ocean: "Marée" } } }, true, true);
    const { unmount } = render(<ThemeDropdown colorTheme="ocean" onColorThemeChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /marée/i }));
    const filter = screen.getByRole("searchbox", { name: /filter color themes/i });
    fireEvent.change(filter, { target: { value: "maree" } });
    expect(screen.getByRole("option", { name: "Marée" })).toBeDefined();
    fireEvent.change(filter, { target: { value: "forest" } });
    expect(screen.getByRole("option", { name: "Forest" })).toBeDefined();
    unmount();
    i18next.removeResourceBundle("en", "app");
  });

  it("keeps no-result filtering non-selectable and restores a valid filtered roving option", () => {
    const onColorThemeChange = vi.fn();
    render(<ThemeDropdown colorTheme="ocean" onColorThemeChange={onColorThemeChange} />);
    fireEvent.click(screen.getByRole("button", { name: /ocean/i }));
    const filter = screen.getByRole("searchbox", { name: /filter color themes/i });
    fireEvent.change(filter, { target: { value: "missing theme" } });
    expect(screen.getByText(/no color themes found/i)).toBeDefined();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    expect(onColorThemeChange).not.toHaveBeenCalled();
    fireEvent.change(filter, { target: { value: "ocean" } });
    expect(screen.getByRole("option", { name: "Ocean" })).toHaveAttribute("tabindex", "0");
  });

  it("uses pointer and trigger keyboard origins to focus the specified targets", () => {
    const { unmount } = render(<ThemeDropdown colorTheme="forest" onColorThemeChange={vi.fn()} />);
    const pointerTrigger = screen.getByRole("button", { name: /forest/i });
    expect(pointerTrigger).not.toHaveAttribute("aria-controls");
    fireEvent.click(pointerTrigger);
    expect(screen.getByRole("searchbox", { name: /filter color themes/i })).toHaveFocus();
    expect(pointerTrigger).toHaveAttribute("aria-controls", "theme-dropdown-listbox");
    unmount();

    for (const [key, expected] of [["ArrowDown", "Fusion Legacy"], ["ArrowUp", "Shadcn Gray Blue"], ["Enter", "Forest"], [" ", "Forest"]]) {
      const { unmount: close } = render(<ThemeDropdown colorTheme="forest" onColorThemeChange={vi.fn()} />);
      const trigger = screen.getByRole("button", { name: /forest/i });
      fireEvent.keyDown(trigger, { key });
      expect(screen.getByRole("option", { name: expected })).toHaveFocus();
      expect(screen.getByRole("searchbox", { name: /filter color themes/i })).not.toHaveFocus();
      close();
    }
  });

  it("transfers input focus and navigates only filtered options before selecting once", () => {
    const onColorThemeChange = vi.fn();
    render(<ThemeDropdown colorTheme="ocean" onColorThemeChange={onColorThemeChange} />);
    fireEvent.click(screen.getByRole("button", { name: /ocean/i }));
    const filter = screen.getByRole("searchbox", { name: /filter color themes/i });
    fireEvent.change(filter, { target: { value: "shadcn mono" } });
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "Shadcn Mono" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("option", { name: "Shadcn Mono" }), { key: "ArrowUp" });
    expect(screen.getByRole("option", { name: "Shadcn Mono Yellow" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("option", { name: "Shadcn Mono Yellow" }), { key: "Home" });
    expect(screen.getByRole("option", { name: "Shadcn Mono" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("option", { name: "Shadcn Mono" }), { key: "End" });
    expect(screen.getByRole("option", { name: "Shadcn Mono Yellow" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("option", { name: "Shadcn Mono Yellow" }), { key: "Enter" });
    expect(onColorThemeChange).toHaveBeenCalledTimes(1);
    expect(onColorThemeChange).toHaveBeenCalledWith("shadcn-mono-yellow");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("removes conditional listbox linkage and filter shell for all close paths", () => {
    render(<ThemeDropdown colorTheme="ocean" onColorThemeChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /ocean/i });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("searchbox", { name: /filter color themes/i }), { key: "Escape" });
    expect(trigger).not.toHaveAttribute("aria-controls");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(trigger).not.toHaveAttribute("aria-controls");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("uses tokenized filter styles within the existing mobile static popover", () => {
    const css = readFileSync("app/components/ThemeDropdown.css", "utf8");
    expect(css).toMatch(/\.theme-dropdown-filter \.input:focus-visible[\s\S]*?var\(--accent\)[\s\S]*?var\(--focus-ring\)/);
    expect(css).toMatch(/\.theme-dropdown-no-results[\s\S]*?var\(--space-sm\)[\s\S]*?var\(--text-muted\)/);
  });

  it("preserves the mobile static in-flow popover branch without dropdown elevation", () => {
    const css = readFileSync("app/components/ThemeDropdown.css", "utf8");

    expect(css).toMatch(
      /@media \(max-width: 768px\) \{[\s\S]*?\.theme-dropdown\.open \{[\s\S]*?z-index: auto;[\s\S]*?\.theme-dropdown-popover \{[\s\S]*?position: static;[\s\S]*?z-index: auto;/,
    );
  });
});
