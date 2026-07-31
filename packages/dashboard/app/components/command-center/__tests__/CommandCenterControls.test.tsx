import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CommandCenterControls } from "../CommandCenterControls";
import { ConfirmDialogProvider } from "../../../hooks/useConfirm";
import { readAppFile } from "../../../test/cssFixture";

const commandCenterControlsCss = readAppFile("components/command-center/CommandCenterControls.css");

const legacyMocks = vi.hoisted(() => ({
  fetchConfig: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  fetchGlobalConcurrency: vi.fn(),
  updateGlobalConcurrency: vi.fn(),
}));

vi.mock("../../../api/legacy", () => legacyMocks);
vi.mock("../../../hooks/useAppSettings", () => ({
  useAppSettings: () => ({
    globalPaused: false,
    toggleGlobalPause: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

const defaultSettings = {
  maxConcurrent: 12,
  maxWorktrees: 4,
};

function renderControls(projectId = "proj_123") {
  const onColorThemeChange = vi.fn();
  render(
    <ConfirmDialogProvider>
      <CommandCenterControls
        projectId={projectId}
        colorTheme="default"
        themeMode="dark"
        onColorThemeChange={onColorThemeChange}
        onThemeModeChange={vi.fn()}
      />
    </ConfirmDialogProvider>,
  );
  return { onColorThemeChange };
}

function mockGlobalConcurrency(overrides: Partial<{
  currentlyActive: number;
  projectsActive: Record<string, number>;
}> = {}) {
  legacyMocks.fetchGlobalConcurrency.mockResolvedValue({
    currentlyActive: 10,
    queuedCount: 0,
    projectsActive: { proj_123: 10 },
    ...overrides,
  });
}

function expectUseMarkerPct(testId: string, pct: string) {
  expect(screen.getByTestId(testId).style.getPropertyValue("--use-pct")).toBe(pct);
}

function expectCommandCenterUseOffset(testId: string, ratio: number) {
  expect(screen.getByTestId(testId).style.getPropertyValue("--use-offset")).toBe(
    `calc((var(--cc-controls-range-thumb-size) / 2) + ((100% - var(--cc-controls-range-thumb-size)) * ${ratio}))`,
  );
}

// FNXC:Theme 2026-07-16-14:30: FN-8146 pins the historical Settings-grid set, including restored shadcn-mono, so a removal from COLOR_THEMES cannot make the all-themes checks pass circularly.
const EXPECTED_THEME_IDS = ['default', 'ocean', 'forest', 'sunset', 'zen', 'berry', 'high-contrast', 'industrial', 'monochrome', 'slate', 'ash', 'air', 'graphite', 'silver', 'solarized', 'factory', 'factory-mono', 'ayu', 'one-dark', 'nord', 'dracula', 'gruvbox', 'tokyo-night', 'catppuccin-mocha', 'github-dark', 'everforest', 'rose-pine', 'kanagawa', 'night-owl', 'palenight', 'monokai-pro', 'slime', 'brutalist', 'neon-city', 'parchment', 'terminal', 'glass', 'glass-silver', 'horizon', 'vitesse', 'outrun', 'snazzy', 'porple', 'espresso', 'mars', 'poimandres', 'ember', 'rust', 'copper', 'foundry', 'carbon', 'sandstone', 'lagoon', 'frost', 'lavender', 'neon-bloom', 'sepia', 'cobalt', 'clay', 'moss', 'aurora', 'calm', 'dawn', 'shadcn', 'shadcn-ember', 'shadcn-custom', 'shadcn-blue', 'shadcn-green', 'shadcn-red', 'shadcn-purple', 'shadcn-pink', 'shadcn-orange', 'shadcn-yellow', 'shadcn-mono', 'shadcn-mono-red', 'shadcn-mono-blue', 'shadcn-mono-green', 'shadcn-mono-purple', 'shadcn-mono-pink', 'shadcn-mono-orange', 'shadcn-mono-yellow', 'shadcn-black', 'shadcn-gray', 'shadcn-gray-blue'] as const;

function renderedThemeIds(listbox: HTMLElement) {
  return within(listbox).getAllByRole("option").map((option) => {
    const swatch = option.querySelector<HTMLElement>(".theme-option-swatch");
    expect(swatch).toBeTruthy();
    return [...(swatch?.classList ?? [])].find((className) => className.startsWith("theme-swatch-"))?.replace("theme-swatch-", "");
  });
}

describe("CommandCenterControls concurrency markers", () => {
  beforeEach(() => {
    legacyMocks.fetchConfig.mockResolvedValue({ maxConcurrent: 12, rootDir: "/workspace/project" });
    legacyMocks.fetchSettings.mockResolvedValue({ ...defaultSettings });
    legacyMocks.updateSettings.mockResolvedValue({ ...defaultSettings });
    legacyMocks.updateGlobalConcurrency.mockResolvedValue({});
    mockGlobalConcurrency();
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("keeps organization portability out of Overview controls", () => {
    renderControls();

    expect(screen.queryByTestId("cc-controls-org-portability")).not.toBeInTheDocument();
  });

  it("keeps the Theme card's compact dropdown interactive", () => {
    const { onColorThemeChange } = renderControls();
    const themeCard = screen.getByTestId("cc-controls-theme");
    const trigger = screen.getByRole("button", { name: "Fusion Legacy" });

    expect(themeCard).toContainElement(trigger);
    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox", { name: "Color theme" });
    expect(renderedThemeIds(listbox)).toEqual(EXPECTED_THEME_IDS);
    fireEvent.change(screen.getByRole("searchbox", { name: /filter color themes/i }), { target: { value: "dawn" } });
    fireEvent.click(screen.getByRole("option", { name: "Dawn" }));

    expect(onColorThemeChange).toHaveBeenCalledWith("dawn");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  // FNXC:GlobalConcurrencyControls 2026-07-15-12:00: FN-8007 requires dashboard markers to use the exact native-thumb coordinate system when the expanded range max exceeds the persisted cap.




  it("matches the desktop and mobile native thumb-size CSS contract", () => {
    expect(commandCenterControlsCss).toContain(
      "--cc-controls-range-thumb-size: calc(var(--space-lg) + var(--space-xs) / 2);",
    );
    // FNXC:GlobalConcurrencyControls 2026-07-15-18:10: FN-8007 keeps desktop browser thumb travel deterministic by sizing both pseudo-thumb implementations from the marker inset token.
    for (const selector of [
      ".cc-controls-slider input[type=\"range\"]::-webkit-slider-thumb,\n.cc-controls-touch-slider::-webkit-slider-thumb",
      ".cc-controls-slider input[type=\"range\"]::-moz-range-thumb,\n.cc-controls-touch-slider::-moz-range-thumb",
    ]) {
      expect(commandCenterControlsCss).toContain(selector);
    }
    expect(commandCenterControlsCss).toContain("width: var(--cc-controls-range-thumb-size);");
    expect(commandCenterControlsCss).toContain("height: var(--cc-controls-range-thumb-size);");
    expect(commandCenterControlsCss).toContain("@media (max-width: 768px)");
    expect(commandCenterControlsCss).toContain("--cc-controls-range-thumb-size: var(--space-xl);");
  });

  /*
  FNXC:CapacityModel 2026-07-29-00:25 (drop the cross-project cap — settings half):
  The Command Center global-cap marker tests are DELETED with the slider they
  measured. They asserted thumb-alignment and over-cap pinning for a control that
  wrote a machine-wide limit; the limit is gone (capacity is two numbers PER PROJECT)
  and the PUT route with it. The equivalent PROJECT-slider marker cases are retained.

  The live "N running (all projects)" readout survives and moved onto the project
  row — it is telemetry, so it has no cap to align a marker against.
  */
});
