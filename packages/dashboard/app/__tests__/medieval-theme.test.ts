import { createElement as h } from "react";
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { COLOR_THEMES as CORE_COLOR_THEMES, type ColorTheme, type MergeResult, type Task, type TaskDetail } from "@fusion/core";
import { COLOR_THEMES as DASHBOARD_COLOR_THEMES } from "../components/themeOptions";
import { TaskDetailModal } from "../components/TaskDetailModal";
import { ThemeSelector } from "../components/ThemeSelector";
import { useTheme } from "../hooks/useTheme";
import { readAppFile } from "../test/cssFixture";
import { fetchGlobalSettings, updateGlobalSettings } from "../api";

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
FNXC:DashboardTheming 2026-08-19-19:23:
Medieval must remain one persisted theme across core, selectors, and web/Electron first paint. Its visual contract is intentionally limited to parchment tokens and generic modal paint so the existing modal interaction and mobile layout remain unchanged.
*/
describe("Medieval color theme", () => {
  const themeData = readAppFile("public/theme-data.css");
  const themeSelector = readAppFile("components/ThemeSelector.css");
  const styles = readAppFile("styles.css");
  const documentsStyles = readAppFile("components/DocumentsView.css");
  const dashboardIndexHtml = readAppFile("index.html");
  const desktopIndexHtml = readAppFile("../../desktop/src/renderer/index.html");
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
    stylesheet.textContent = `${themeData}\n${styles}\n${documentsStyles}`;
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

    expect(CORE_COLOR_THEMES.filter((theme) => theme === "medieval")).toHaveLength(1);
    expect(DASHBOARD_COLOR_THEMES).toContainEqual({ value: "medieval", label: "Medieval", className: "theme-swatch-medieval" });
    expect(dashboardIds).toEqual(coreIds);
    expect(dashboardValidThemes).toEqual(coreIds);
    expect(desktopValidThemes).toEqual(coreIds);
  });

  it("defines readable bundled Pixelify Sans and paper tokens in both modes", () => {
    for (const selector of ['[data-color-theme="medieval"]', '[data-color-theme="medieval"][data-theme="light"]']) {
      const block = extractSelectorBlock(themeData, selector);
      for (const token of ["--bg:", "--surface:", "--card:", "--surface-hover:", "--border:", "--text:", "--color-success:", "--color-warning:", "--color-error:", "--color-info:", "--cta-bg:", "--cta-text:", "--accent:", "--focus-ring:", "--shadow-glow:", "--font-primary:", "--medieval-paper-fiber:", "--medieval-paper-mottle:", "--medieval-wood-light:", "--medieval-wood-dark:"]) expect(block).toContain(token);
      expect(block).toContain('"Pixelify Sans", system-ui, sans-serif');
    }
    const paperCanvas = extractSelectorBlock(themeData, '[data-color-theme="medieval"] body');
    expect(paperCanvas).toContain("radial-gradient");
    expect(paperCanvas).toContain("repeating-linear-gradient");
    expect(themeData).not.toMatch(new RegExp(["Press", "Start", "2P"].join(" ")));
    expect(paperCanvas).not.toMatch(/::before|backdrop-filter|\bfilter\s*:/);
    expect(readAppFile("main.tsx")).toContain('@fontsource/pixelify-sans/400.css');
    expect(readAppFile("main.tsx")).not.toContain("press-start");
  });

  it.each(["dark", "light"] as const)("selects Medieval through Settings and applies every supported scale in %s mode", (themeMode) => {
    localStorage.setItem("kb-dashboard-theme-mode", themeMode);
    render(h(MedievalSymptomFixture));

    fireEvent.click(screen.getByRole("button", { name: new RegExp(`current theme ${themeMode} / shadcn ember`, "i") }));
    const listbox = screen.getByRole("listbox", { name: "Color theme" });
    fireEvent.change(screen.getByRole("searchbox", { name: /filter color themes/i }), { target: { value: "medieval" } });
    fireEvent.click(within(listbox).getByRole("option", { name: "Medieval" }));

    expect(document.documentElement).toHaveAttribute("data-color-theme", "medieval");
    expect(document.documentElement).toHaveAttribute("data-theme", themeMode);
    for (const [label, scale] of [["Small", "90%"], ["Default", "100%"], ["Large", "110%"], ["Largest", "120%"]] as const) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(document.documentElement.style.fontSize).toBe(scale);
    }
  });

  it("renders the Settings date/link/modal symptom fixture with ordinary Pixelify type and mono exceptions", () => {
    localStorage.setItem("kb-dashboard-theme-mode", "dark");
    render(h(MedievalSymptomFixture));

    /* FNXC:DashboardTheming 2026-08-20-01:25: Visual proof must use the shipped selector controls, not a lookalike settings fixture. */
    for (const name of ["Light mode", "Dark mode", "System mode", "Small", "Default", "Large", "Largest", "Reset to default theme"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(getComputedStyle(screen.getByRole("radiogroup", { name: "Dashboard font size" })).gridTemplateColumns).toContain("minmax(0, 1fr)");
    selectMedievalFromSettings();

    expect(document.documentElement).toHaveAttribute("data-color-theme", "medieval");
    const taskDetail = document.querySelector<HTMLElement>(".modal.task-detail-modal");
    expect(taskDetail).not.toBeNull();
    const modalPaint = getComputedStyle(taskDetail!);
    expect(modalPaint.backgroundImage).toContain("repeating-linear-gradient");
    expect(modalPaint.backgroundClip).toBe("padding-box, border-box");
    expect(getComputedStyle(screen.getByRole("link", { name: "#61" })).fontFamily).toBe("var(--font-primary)");
    expect(getComputedStyle(taskDetail!.querySelector("time")!).fontFamily).toBe("var(--font-primary)");

    const ordinaryType = extractSelectorBlock(styles, '[data-color-theme="medieval"] :where(a, time, button, label, input, textarea, select, option, [role="button"], [role="link"], [role="textbox"], [role="option"])');
    expect(ordinaryType).toContain("font-family: var(--font-primary);");
    expect(ordinaryType).not.toContain("!important");
    expect(styles).not.toContain('[data-color-theme="medieval"] *');
    expect(extractSelectorBlock(documentsStyles, ".markdown-file-item-path")).toContain("font-family: var(--font-mono)");
    expect(extractSelectorBlock(documentsStyles, ".documents-file-path-header")).toContain("font-family: var(--font-mono)");
  });

  it("uses mode-specific swatches and border-box wood frames without changing modal behavior", () => {
    for (const block of [extractSelectorBlock(themeData, ":root"), extractSelectorBlock(themeData, '[data-theme="light"]'), extractSelectorBlock(themeSelector, ".theme-swatch-medieval"), extractSelectorBlock(themeSelector, '[data-theme="light"] .theme-swatch-medieval')]) {
      for (const sample of [1, 2, 3, 4]) expect(block).toContain(`medieval-swatch-sample-${sample}`);
    }
    const medievalModal = extractSelectorBlock(styles, '[data-color-theme="medieval"] .modal');
    for (const property of ["border-color:", "border-width:", "background-image:", "background-origin: border-box", "background-clip: padding-box, border-box", "repeating-linear-gradient"]) expect(medievalModal).toContain(property);
    expect(medievalModal).not.toMatch(/(?:^|\n)\s*(?:position|width|max-height|z-index|resize|touch-action|padding|height)\s*:/);
    const mobileFrameStart = styles.indexOf('[data-color-theme="medieval"] .modal:not(.confirm-dialog)');
    const mobileFrame = styles.slice(mobileFrameStart, styles.indexOf("}", mobileFrameStart));
    for (const variant of [".modal-lg", ".modal-md", ".gm-modal", "border-style: solid", "background-clip: padding-box, border-box"]) expect(mobileFrame).toContain(variant);
    expect(styles).toContain("Mobile's generic modal reset removes all borders");
  });
});

/*
FNXC:DashboardTheming 2026-08-20-01:13:
FN-061 must prove the shipped Settings selector and TaskDetailModal rather than a lookalike modal. The fixture keeps production ownership of the date, link, and generic modal frame while adapters only make unrelated task actions inert.
*/
function MedievalSymptomFixture() {
  const theme = useTheme();
  return h(
    "div",
    undefined,
    h(ThemeSelector, {
      themeMode: theme.themeMode,
      colorTheme: theme.colorTheme as ColorTheme,
      dashboardFontScalePct: theme.dashboardFontScalePct,
      resolvedThemeMode: theme.resolvedThemeMode,
      shadcnCustomColors: theme.shadcnCustomColors,
      onThemeModeChange: theme.setThemeMode,
      onColorThemeChange: theme.setColorTheme,
      onDashboardFontScaleChange: theme.setDashboardFontScalePct,
      onShadcnCustomColorsChange: theme.setShadcnCustomColors,
    }),
    h(TaskDetailModal, {
      task: medievalTask,
      onClose: noop,
      onOpenDetail: noop,
      onMoveTask: async () => medievalTask,
      onDeleteTask: async () => medievalTask,
      onMergeTask: async () => ({ merged: false }) as MergeResult,
      addToast: noop,
    }),
  );
}

const medievalTask = {
  id: "FN-061",
  title: "Readable Medieval task detail",
  description: "Ordinary task detail prose.",
  column: "todo",
  dependencies: [],
  prompt: "",
  steps: [],
  log: [],
  currentStep: 0,
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  prInfo: { number: 61, url: "https://example.test/pull/61" },
} as TaskDetail;

const noop = () => undefined;

function selectMedievalFromSettings(): void {
  fireEvent.click(screen.getByRole("button", { name: /current theme dark \/ shadcn ember/i }));
  const listbox = screen.getByRole("listbox", { name: "Color theme" });
  fireEvent.change(screen.getByRole("searchbox", { name: /filter color themes/i }), { target: { value: "medieval" } });
  fireEvent.click(within(listbox).getByRole("option", { name: "Medieval" }));
}

function extractValidThemes(html: string): string[] {
  const match = html.match(/var validThemes = \[([\s\S]*?)\];/);
  if (!match) throw new Error("Could not find pre-hydration validThemes array");
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((themeMatch) => themeMatch[1]);
}

function extractSelectorBlock(css: string, selector: string): string {
  const startIdx = css.indexOf(`${selector} {`);
  if (startIdx === -1) throw new Error(`Could not find selector block: ${selector}`);
  const openBraceIdx = css.indexOf("{", startIdx);
  let depth = 1;
  for (let index = openBraceIdx + 1; index < css.length; index++) {
    if (css[index] === "{") depth++;
    if (css[index] === "}") depth--;
    if (depth === 0) return css.slice(startIdx, index + 1);
  }
  throw new Error(`Could not find closing brace for selector block: ${selector}`);
}
