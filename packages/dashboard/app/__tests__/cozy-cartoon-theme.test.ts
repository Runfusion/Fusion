import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { COLOR_THEMES as CORE_COLOR_THEMES, type ColorTheme } from "@fusion/core";
import { fetchGlobalSettings, updateGlobalSettings } from "../api";
import { resolveColorTheme } from "../components/ThemeDropdown";
import { ThemeSelector } from "../components/ThemeSelector";
import { COLOR_THEMES as DASHBOARD_COLOR_THEMES } from "../components/themeOptions";
import { useTheme } from "../hooks/useTheme";
import { loadStylesCss, loadThemeDataCss, readAppFile } from "../test/cssFixture";

vi.mock("../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../api")>(), {
    fetchGlobalSettings: vi.fn(),
    updateGlobalSettings: vi.fn(),
  });
});

const mockFetchGlobalSettings = vi.mocked(fetchGlobalSettings);
const mockUpdateGlobalSettings = vi.mocked(updateGlobalSettings);

/*
FNXC:DashboardTheming 2026-08-28-07:45:
Cozy Cartoon is complete only when persistence, both selector hosts, web and Electron first paint, mode-specific pastel tokens and previews, and its oversized ordinary-button contract agree. Compact controls, mobile touch floors, and the desktop ViewHeader remain shared invariants rather than theme-specific geometry.
*/
describe("Cozy Cartoon color theme", () => {
  const themeData = loadThemeDataCss();
  const themeSelectorCss = readAppFile("components/ThemeSelector.css");
  const styles = loadStylesCss();
  const cssNoComments = styles.replace(/\/\*[\s\S]*?\*\//g, "");
  const dashboardIndexHtml = readAppFile("index.html");
  const desktopIndexHtml = readAppFile("../../desktop/src/renderer/index.html");
  const settingsReference = readAppFile("../../../docs/settings-reference.md");
  const dashboardGuide = readAppFile("../../../docs/dashboard-guide.md");
  let stylesheet: HTMLStyleElement | undefined;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-color-theme");
    document.documentElement.style.cssText = "";
    mockFetchGlobalSettings.mockReset();
    mockFetchGlobalSettings.mockImplementation(() => new Promise(() => {}));
    mockUpdateGlobalSettings.mockReset();
    mockUpdateGlobalSettings.mockResolvedValue({});
    stylesheet = document.createElement("style");
    stylesheet.textContent = `${themeData}\n${styles}`;
    document.head.appendChild(stylesheet);
  });

  afterEach(() => {
    stylesheet?.remove();
    vi.clearAllMocks();
  });

  it("keeps persisted, selector, and first-paint registries in exact order", () => {
    const coreIds = [...CORE_COLOR_THEMES];
    const dashboardIds = DASHBOARD_COLOR_THEMES.map((theme) => theme.value);
    const dashboardValidThemes = extractValidThemes(dashboardIndexHtml);
    const desktopValidThemes = extractValidThemes(desktopIndexHtml);

    expect(CORE_COLOR_THEMES.filter((theme) => theme === "cozy-cartoon")).toHaveLength(1);
    expect(DASHBOARD_COLOR_THEMES.filter((theme) => theme.value === "cozy-cartoon")).toEqual([{
      value: "cozy-cartoon",
      label: "Cozy Cartoon",
      className: "theme-swatch-cozy-cartoon",
    }]);
    expect(dashboardIds).toEqual(coreIds);
    expect(dashboardValidThemes).toEqual(coreIds);
    expect(desktopValidThemes).toEqual(coreIds);
    for (const ids of [coreIds, dashboardIds, dashboardValidThemes, desktopValidThemes]) {
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.filter((id) => id === "cozy-cartoon")).toHaveLength(1);
      expect(ids[ids.indexOf("flexoki") + 1]).toBe("cozy-cartoon");
    }
    expect(dashboardIndexHtml).toContain("colorTheme = 'shadcn-ember'");
    expect(desktopIndexHtml).toContain('colorTheme = "shadcn-ember"');
  });

  it("keeps both selector hosts on the shared ThemeDropdown registry", () => {
    const dropdown = readAppFile("components/ThemeDropdown.tsx");
    const commandCenter = readAppFile("components/command-center/CommandCenterControls.tsx");
    const settingsSelector = readAppFile("components/ThemeSelector.tsx");

    expect(dropdown).toContain('from "./themeOptions"');
    expect(dropdown).toContain("COLOR_THEMES");
    expect(dropdown).toContain("export function resolveColorTheme");
    expect(dropdown).toContain("COLOR_THEMES.find");
    expect(commandCenter).toContain('from "../ThemeDropdown"');
    expect(commandCenter).toContain("<ThemeDropdown");
    expect(commandCenter).not.toContain("themeOptions");
    expect(commandCenter).not.toContain("COLOR_THEMES");
    expect(commandCenter).not.toContain("cozy-cartoon");
    expect(settingsSelector).toContain("<ThemeDropdown");
    expect(settingsSelector).not.toContain("COLOR_THEMES");
  });

  it("falls back unknown ids and resolves Cozy Cartoon from the canonical registry", () => {
    expect(resolveColorTheme("not-a-theme" as ColorTheme)).toBe(DASHBOARD_COLOR_THEMES[0]);
    expect(resolveColorTheme("cozy-cartoon")).toEqual({
      value: "cozy-cartoon",
      label: "Cozy Cartoon",
      className: "theme-swatch-cozy-cartoon",
    });
  });

  it.each(["dark", "light"] as const)("selects and persists Cozy Cartoon through Settings in %s mode", (themeMode) => {
    localStorage.setItem("kb-dashboard-theme-mode", themeMode);
    render(h(CozyCartoonThemeFixture));

    fireEvent.click(screen.getByRole("button", { name: /^current theme/i }));
    const listbox = screen.getByRole("listbox", { name: "Color theme" });
    fireEvent.change(screen.getByRole("searchbox", { name: /filter color themes/i }), { target: { value: "cozy" } });
    fireEvent.click(within(listbox).getByRole("option", { name: "Cozy Cartoon" }));

    expect(document.documentElement).toHaveAttribute("data-theme", themeMode);
    expect(document.documentElement).toHaveAttribute("data-color-theme", "cozy-cartoon");
    expect(localStorage.getItem("kb-dashboard-color-theme")).toBe("cozy-cartoon");
  });

  it("defines complete readable token blocks with pinned WCAG contrast", () => {
    const darkBlock = extractSelectorBlock(themeData, '[data-color-theme="cozy-cartoon"]');
    const lightBlock = extractSelectorBlock(themeData, '[data-color-theme="cozy-cartoon"][data-theme="light"]');
    const requiredTokens = [
      "--bg:", "--surface:", "--card:", "--card-hover:", "--surface-hover:", "--border:",
      "--text:", "--text-muted:", "--text-dim:", "--todo:", "--in-progress:", "--in-progress-rgb:",
      "--in-review:", "--triage:", "--done:", "--color-success:", "--color-warning:",
      "--color-error:", "--color-info:", "--cta-bg:", "--cta-border:", "--cta-text:",
      "--cta-bg-hover:", "--cta-border-hover:", "--cta-glow:", "--accent:", "--accent-text:",
      "--logo-accent:", "--shadow-glow:", "--focus-ring:", "--focus-ring-strong:",
    ];

    for (const block of [darkBlock, lightBlock]) {
      for (const token of requiredTokens) expect(block).toContain(token);
      expect(block).not.toMatch(/rgba?\(/);
      for (const [foreground, background] of [
        ["--text", "--bg"],
        ["--text", "--card"],
        ["--text-muted", "--bg"],
        ["--cta-text", "--cta-bg"],
        ["--accent-text", "--accent"],
      ] as const) {
        expect(contrastRatio(tokenHex(block, foreground), tokenHex(block, background))).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(tokenHex(block, "--text-dim"), tokenHex(block, "--bg"))).toBeGreaterThanOrEqual(3);
    }
    expect(darkBlock).toContain("--bg: #241d24;");
    expect(darkBlock).toContain("--accent: #f4a7a3;");
    expect(lightBlock).toContain("--bg: #fff7ef;");
    expect(lightBlock).toContain("--accent: #e07a6a;");
  });

  it("keeps the Cozy button rule top-level and inherits the existing mobile touch floors", () => {
    const idx = cssNoComments.indexOf('[data-color-theme="cozy-cartoon"]');
    expect(idx).not.toBe(-1);
    const before = cssNoComments.slice(0, idx);
    expect((before.match(/\{/g)?.length ?? 0) - (before.match(/\}/g)?.length ?? 0)).toBe(0);

    const mobileSelectorIdx = cssNoComments.indexOf(".btn:not(.btn-icon):not(.btn-badge):not(.btn-sm):not(.btn--sm)", idx);
    const mobileMediaIdx = cssNoComments.lastIndexOf("@media (max-width: 768px)", mobileSelectorIdx);
    expect(mobileMediaIdx).not.toBe(-1);
    const mobileBlock = extractAtRuleBlock(cssNoComments, mobileMediaIdx);
    expect(extractSelectorBlock(mobileBlock, ".btn:not(.btn-icon):not(.btn-badge):not(.btn-sm):not(.btn--sm)")).toContain("min-height: 36px");
    const iconRule = extractSelectorBlock(mobileBlock, ".btn-icon");
    expect(iconRule).toContain("min-width: 36px");
    expect(iconRule).toContain("min-height: 36px");
  });

  it("enlarges token geometry without overriding ViewHeader height contracts", () => {
    const rootBlock = extractSelectorBlock(styles, ":root");
    const themeBlock = extractSelectorBlock(themeData, '[data-color-theme="cozy-cartoon"]');
    const scopedButton = extractSelectorBlock(styles, '[data-color-theme="cozy-cartoon"] .btn:not(.btn-sm):not(.btn--sm)');
    const declaredProperties = [...scopedButton.matchAll(/^\s*([a-z-]+)\s*:/gm)].map((match) => match[1]);

    expect(declaredProperties).toEqual(["font-size", "font-weight"]);
    expect(scopedButton).not.toMatch(/min-height/);
    expect(scopedButton).not.toMatch(/(?:^|\n)\s*height\s*:/);
    for (const token of ["--btn-padding", "--btn-border-width", "--radius-md", "--radius-lg", "--icon-size-md"] as const) {
      expect(cssTokenValue(themeBlock, token)).not.toBe(cssTokenValue(rootBlock, token));
    }
    expect(themeData).not.toContain("--quick-entry-action-row-height-desktop");
    expect(themeData).not.toContain("--quick-entry-action-row-height-mobile");
    expect(themeBlock).not.toContain("--icon-size-sm");
  });

  it("excludes compact controls by selector shape without changing shared button rules", () => {
    const cozySelectors = [...cssNoComments.matchAll(/([^{}]*\[data-color-theme="cozy-cartoon"\][^{}]*)\{/g)]
      .map((match) => match[1].trim());
    expect(cozySelectors).toEqual(['[data-color-theme="cozy-cartoon"] .btn:not(.btn-sm):not(.btn--sm)']);

    const selector = cozySelectors[0];
    expect(selector).toContain(":not(.btn-sm)");
    expect(selector).toContain(":not(.btn--sm)");
    const targetedCompound = selector.replace(/:not\([^)]*\)/g, "");
    for (const compactTarget of [".btn-sm", ".btn--sm", ".quick-entry", ".view-header"]) {
      expect(targetedCompound).not.toContain(compactTarget);
    }
    expect(extractSelectorBlock(styles, ".btn-sm")).toContain("padding: 4px 10px");
    expect(extractSelectorBlock(styles, ".btn")).toContain("padding: var(--btn-padding)");
  });

  it("uses globally resolvable Cozy Cartoon swatches in both modes", () => {
    const darkGlobals = extractSelectorBlock(themeData, ":root");
    const lightGlobals = extractSelectorBlock(themeData, '[data-theme="light"]');
    const darkSwatch = extractSelectorBlock(themeSelectorCss, ".theme-swatch-cozy-cartoon");
    const lightSwatch = extractSelectorBlock(themeSelectorCss, '[data-theme="light"] .theme-swatch-cozy-cartoon');

    for (const block of [darkGlobals, lightGlobals]) {
      for (const sample of [1, 2, 3, 4]) expect(block).toContain(`--cozy-cartoon-swatch-sample-${sample}:`);
    }
    for (const block of [darkSwatch, lightSwatch]) {
      for (const sample of [1, 2, 3, 4]) {
        expect(block).toContain(`--swatch-sample-${sample}: var(--cozy-cartoon-swatch-sample-${sample});`);
      }
      expect(block).not.toContain("var(--accent)");
      expect(block).not.toContain("var(--bg)");
    }
  });

  it("publishes Cozy Cartoon in the operator theme catalogs", () => {
    const colorThemeRow = settingsReference.split("\n").find((line) => line.startsWith("| `colorTheme` |"));
    expect(colorThemeRow).toContain("Cozy Cartoon");
    expect(dashboardGuide).toContain("Cozy Cartoon");
    expect(dashboardGuide).toContain("93 color themes");
  });
});

function CozyCartoonThemeFixture() {
  const theme = useTheme();
  return h(ThemeSelector, {
    themeMode: theme.themeMode,
    colorTheme: theme.colorTheme as ColorTheme,
    dashboardFontScalePct: theme.dashboardFontScalePct,
    resolvedThemeMode: theme.resolvedThemeMode,
    shadcnCustomColors: theme.shadcnCustomColors,
    onThemeModeChange: theme.setThemeMode,
    onColorThemeChange: theme.setColorTheme,
    onDashboardFontScaleChange: theme.setDashboardFontScalePct,
    onShadcnCustomColorsChange: theme.setShadcnCustomColors,
  });
}

function extractValidThemes(html: string): string[] {
  const match = html.match(/var validThemes = \[([\s\S]*?)\];/);
  if (!match) throw new Error("Could not find pre-hydration validThemes array");
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((themeMatch) => themeMatch[1]);
}

function extractSelectorBlock(css: string, selector: string): string {
  const startIdx = css.indexOf(`${selector} {`);
  if (startIdx === -1) throw new Error(`Could not find selector block: ${selector}`);
  return extractBraceBlock(css, startIdx);
}

function extractAtRuleBlock(css: string, startIdx: number): string {
  return extractBraceBlock(css, startIdx);
}

function extractBraceBlock(css: string, startIdx: number): string {
  const openBraceIdx = css.indexOf("{", startIdx);
  if (openBraceIdx === -1) throw new Error("Could not find opening brace");
  let depth = 1;
  for (let index = openBraceIdx + 1; index < css.length; index++) {
    if (css[index] === "{") depth++;
    if (css[index] === "}") depth--;
    if (depth === 0) return css.slice(startIdx, index + 1);
  }
  throw new Error("Could not find closing brace");
}

function cssTokenValue(block: string, token: string): string {
  const match = block.match(new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*([^;]+);`));
  if (!match) throw new Error(`Could not find token: ${token}`);
  return match[1].trim();
}

function tokenHex(block: string, token: string): string {
  const value = cssTokenValue(block, token);
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${token} is not a six-digit hex color: ${value}`);
  return value;
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
