import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { COLOR_THEMES } from "../themeOptions";
import { ThemeDropdown } from "../ThemeDropdown";

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
    for (const theme of COLOR_THEMES) {
      const option = within(listbox)
        .getAllByRole("option")
        .find((element) => element.textContent?.trim().startsWith(theme.label));
      expect(option?.querySelector(`.${theme.className}`)).toBeTruthy();
    }
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

  it("preserves the mobile static in-flow popover branch without dropdown elevation", () => {
    const css = readFileSync("app/components/ThemeDropdown.css", "utf8");

    expect(css).toMatch(
      /@media \(max-width: 768px\) \{[\s\S]*?\.theme-dropdown\.open \{[\s\S]*?z-index: auto;[\s\S]*?\.theme-dropdown-popover \{[\s\S]*?position: static;[\s\S]*?z-index: auto;/,
    );
  });
});
