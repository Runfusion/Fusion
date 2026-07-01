import { readFileSync } from "node:fs";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShadcnColorPicker } from "../ShadcnColorPicker";
import { SHADCN_CUSTOM_COLOR_TOKENS } from "../shadcnCustomColors";

function expandCustomColors() {
  const toggle = screen.getByRole("button", { name: "Show custom colors" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(toggle).toHaveAttribute("aria-controls");
  fireEvent.click(toggle);
  expect(screen.getByRole("button", { name: "Collapse custom colors" })).toHaveAttribute("aria-expanded", "true");
}

describe("ShadcnColorPicker", () => {
  it("is collapsed by default and toggles all custom color controls without dangling shells", () => {
    render(<ShadcnColorPicker value={{}} onChange={vi.fn()} resolvedThemeMode="dark" />);

    expect(screen.getByTestId("shadcn-color-picker")).toBeDefined();
    expect(screen.getByText("Custom shadcn colors")).toBeDefined();
    expect(screen.getByText("Override shadcn design tokens with hex colors. Blank tokens use the theme defaults.")).toBeDefined();
    expect(screen.queryByTestId("shadcn-color-picker-controls")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset custom colors" })).toBeNull();
    for (const token of SHADCN_CUSTOM_COLOR_TOKENS) {
      expect(screen.queryByTestId(`shadcn-color-${token.cssVar}`)).toBeNull();
    }

    expandCustomColors();
    expect(screen.getByTestId("shadcn-color-picker-controls")).toBeDefined();
    expect(screen.getByRole("button", { name: "Reset custom colors" })).toBeDefined();
    for (const token of SHADCN_CUSTOM_COLOR_TOKENS) {
      expect(screen.getByTestId(`shadcn-color-${token.cssVar}`)).toBeDefined();
      expect(screen.getByText(token.cssVar)).toBeDefined();
    }

    fireEvent.click(screen.getByRole("button", { name: "Collapse custom colors" }));
    expect(screen.getByRole("button", { name: "Show custom colors" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("shadcn-color-picker-controls")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset custom colors" })).toBeNull();
  });

  it("uses light defaults when no override exists after expansion", () => {
    render(<ShadcnColorPicker value={{}} onChange={vi.fn()} resolvedThemeMode="light" />);

    expandCustomColors();
    const bgRow = screen.getByTestId("shadcn-color---bg");
    expect(within(bgRow).getByRole("textbox")).toHaveValue("#ffffff");
  });

  it("emits sanitized changes and rejects invalid hex input after expansion", () => {
    const onChange = vi.fn();
    render(<ShadcnColorPicker value={{}} onChange={onChange} resolvedThemeMode="dark" />);

    expandCustomColors();
    const accentRow = screen.getByTestId("shadcn-color---accent");
    fireEvent.change(within(accentRow).getByRole("textbox"), { target: { value: "red" } });
    expect(onChange).toHaveBeenLastCalledWith({});

    fireEvent.change(within(accentRow).getByRole("textbox"), { target: { value: "#FF8800" } });
    expect(onChange).toHaveBeenLastCalledWith({ "--accent": "#FF8800" });
  });

  it("normalizes short hex values for the native color input after expansion", () => {
    render(<ShadcnColorPicker value={{ "--accent": "#fff" }} onChange={vi.fn()} resolvedThemeMode="dark" />);

    expandCustomColors();
    const accentRow = screen.getByTestId("shadcn-color---accent");
    expect(within(accentRow).getByLabelText("Pick Accent color")).toHaveValue("#ffffff");
  });

  it("reset clears all custom color overrides after expansion", () => {
    const onChange = vi.fn();
    render(<ShadcnColorPicker value={{ "--accent": "#123456" }} onChange={onChange} resolvedThemeMode="dark" />);

    expect(screen.queryByRole("button", { name: "Reset custom colors" })).toBeNull();
    expandCustomColors();
    fireEvent.click(screen.getByRole("button", { name: "Reset custom colors" }));
    expect(onChange).toHaveBeenCalledWith({});
  });

  it("keeps mobile collapsed and expanded layout rules tokenized", () => {
    const css = readFileSync("app/components/ShadcnColorPicker.css", "utf8");

    expect(css).toMatch(/@media \(max-width: 768px\) \{[\s\S]*?\.shadcn-color-picker-toggle \{[\s\S]*?align-self: flex-start;/);
    expect(css).toMatch(/\.shadcn-color-picker-controls-panel \{[\s\S]*?gap: var\(--space-sm\);/);
    expect(css).not.toMatch(/#[\da-f]{3,8}\b|rgb\(/i);
  });
});
