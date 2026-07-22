import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import { EngineControlMenu } from "../EngineControlMenu";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";

const engineControlMenuCss = readFileSync(
  join(process.cwd(), "app/components/EngineControlMenu.css"),
  "utf8",
);

const commandCenterControlsCss = readFileSync(
  join(process.cwd(), "app/components/command-center/CommandCenterControls.css"),
  "utf8",
);

const defaultSettings = {
  maxConcurrent: 2,
  maxTriageConcurrent: 1,
  maxWorktrees: 4,
  globalPause: false,
  enginePaused: false,
  autoMerge: true,
  experimentalFeatures: {},
};

const apiMocks = vi.hoisted(() => ({
  fetchConfig: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));

const legacyMocks = vi.hoisted(() => ({
  fetchConfig: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  fetchGlobalConcurrency: vi.fn(),
  updateGlobalConcurrency: vi.fn(),
}));

vi.mock("../../api", () => apiMocks);
vi.mock("../../api/legacy", () => legacyMocks);
vi.mock("../../versionCheck", () => ({
  setAutoReloadEnabled: vi.fn(),
}));

async function openMenu(projectId: string | undefined = "proj_123") {
  render(
    <ConfirmDialogProvider>
      <EngineControlMenu projectId={projectId} />
    </ConfirmDialogProvider>,
  );
  fireEvent.click(screen.getByTestId("engine-control-menu-trigger"));
  await screen.findByTestId("engine-control-menu");
}

function mockGlobalConcurrency(overrides: Partial<{
  globalMaxConcurrent: number;
  currentlyActive: number;
  queuedCount: number;
  projectsActive: Record<string, number>;
}> = {}) {
  legacyMocks.fetchGlobalConcurrency.mockResolvedValue({
    globalMaxConcurrent: 6,
    currentlyActive: 3,
    queuedCount: 0,
    projectsActive: { proj_123: 2 },
    ...overrides,
  });
}

// FNXC:EngineControls 2026-06-29-12:00: FN-7235 reproduces the footer mismatch by asserting running-count markers use the loaded cap (`current / cap`) rather than expanded slider-track coordinates; both global and project renderers must move 1 running agent above zero.
// FNXC:EngineControls 2026-06-29-13:25: Keep the footer marker guard aligned with the Command Center representative states: zero, one active, mid-track utilization, over-cap clamping, loading, and error.
function expectUseMarkerPct(testId: string, pct: string) {
  expect(screen.getByTestId(testId).style.getPropertyValue("--use-pct")).toBe(pct);
}

function expectFooterUseOffset(testId: string, ratio: number) {
  expect(screen.getByTestId(testId).style.getPropertyValue("--use-offset")).toBe(
    `calc((var(--engine-control-range-thumb-size) / 2) + ((100% - var(--engine-control-range-thumb-size)) * ${ratio}))`,
  );
}

function cssRule(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  expect(match, `Expected CSS rule for ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("EngineControlMenu", () => {
  beforeEach(() => {
    vi.useRealTimers();
    apiMocks.fetchConfig.mockResolvedValue({ maxConcurrent: 2, rootDir: "/workspace/project" });
    apiMocks.fetchSettings.mockResolvedValue({ ...defaultSettings });
    apiMocks.updateSettings.mockResolvedValue({ ...defaultSettings });
    apiMocks.updateGlobalSettings.mockResolvedValue({});
    legacyMocks.fetchConfig.mockResolvedValue({ maxConcurrent: 2, rootDir: "/workspace/project" });
    legacyMocks.fetchSettings.mockResolvedValue({ ...defaultSettings });
    legacyMocks.updateSettings.mockResolvedValue({ ...defaultSettings });
    mockGlobalConcurrency();
    legacyMocks.updateGlobalConcurrency.mockResolvedValue({
      globalMaxConcurrent: 6,
      currentlyActive: 3,
      queuedCount: 0,
      projectsActive: { proj_123: 2 },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });


  // FNXC:GlobalConcurrencyControls 2026-07-15-00:00: FN-7973 requires touch-action:none on both concurrency slider surfaces because the mobile pan-y ancestor lock otherwise steals horizontal native thumb drags.
  it("matches the Command Center slider geometry and mobile touch contract for footer current-use markers", () => {
    const footerWrap = cssRule(engineControlMenuCss, ".engine-control-menu__range-wrap");
    const footerRange = cssRule(engineControlMenuCss, ".engine-control-menu__range");
    const footerMarker = cssRule(engineControlMenuCss, ".engine-control-menu__use-marker");
    const commandWrap = cssRule(commandCenterControlsCss, ".cc-controls-range-wrap");
    const commandTouchSliderRule = commandCenterControlsCss.match(/\.cc-controls-slider input\[type="range"\],\n\.cc-controls-touch-slider\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    const commandMarker = cssRule(commandCenterControlsCss, ".cc-controls-use-marker");

    expect(footerWrap).toContain("--engine-control-range-thumb-size: calc(var(--space-lg) + var(--space-xs) / 2);");
    expect(commandWrap).toContain("--cc-controls-range-thumb-size: calc(var(--space-lg) + var(--space-xs) / 2);");
    expect(footerWrap).toContain("position: relative;");
    expect(footerWrap).toContain("display: flex;");
    expect(footerWrap).toContain("align-items: center;");
    expect(footerRange).toContain("inline-size: 100%;");
    expect(footerRange).toContain("min-block-size: var(--space-xl);");
    expect(footerRange).toContain("accent-color: var(--accent);");
    expect(footerRange).toContain("touch-action: none;");
    expect(footerRange).not.toContain("touch-action: pan-y;");
    // FNXC:GlobalConcurrencyControls 2026-07-15-18:10: FN-8007 must locally size WebKit and Gecko desktop thumbs from the same token used by the marker inset, rather than relying on browser defaults.
    for (const selector of [".engine-control-menu__range::-webkit-slider-thumb", ".engine-control-menu__range::-moz-range-thumb"]) {
      const thumb = cssRule(engineControlMenuCss, selector);
      expect(thumb).toContain("width: var(--engine-control-range-thumb-size);");
      expect(thumb).toContain("height: var(--engine-control-range-thumb-size);");
    }
    expect(commandTouchSliderRule).toContain("inline-size: 100%;");
    expect(commandTouchSliderRule).toContain("min-block-size: var(--space-xl);");
    expect(commandTouchSliderRule).toContain("accent-color: var(--accent);");
    expect(commandTouchSliderRule).toContain("touch-action: none;");
    expect(commandTouchSliderRule).not.toContain("touch-action: pan-y;");
    for (const declaration of ["position: absolute;", "inset-block-start: 50%;", "inset-inline-start: var(--use-offset, var(--use-pct));", "transform: translate(-50%, -50%);", "pointer-events: none;"]) {
      expect(footerMarker).toContain(declaration);
      expect(commandMarker).toContain(declaration);
    }
    expect(engineControlMenuCss).toContain("@media (max-width: 768px)");
    expect(engineControlMenuCss).toContain("--engine-control-range-thumb-size: var(--space-xl);");
  });

  it("renders an explicit close button when opened", async () => {
    await openMenu();

    expect(screen.getByTestId("engine-control-menu-close")).toBeInTheDocument();
    expect(screen.getByLabelText(/close engine controls/i)).toBeInTheDocument();
  });

  it("closes the menu when the explicit close button is clicked", async () => {
    await openMenu();

    fireEvent.click(screen.getByTestId("engine-control-menu-close"));

    await waitFor(() => expect(screen.queryByTestId("engine-control-menu")).not.toBeInTheDocument());
  });

  it("reverts pending project concurrency changes when the explicit close button is clicked", async () => {
    await openMenu();

    const maxConcurrent = await screen.findByLabelText(/max concurrent tasks/i);
    vi.useFakeTimers();

    fireEvent.change(maxConcurrent, { target: { value: "7" } });
    fireEvent.click(screen.getByTestId("engine-control-menu-close"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(legacyMocks.updateSettings).not.toHaveBeenCalled();
    expect(screen.queryByTestId("engine-control-menu")).not.toBeInTheDocument();
  });

  it("keeps the close button available when concurrency settings fail to load", async () => {
    legacyMocks.fetchSettings.mockRejectedValue(new Error("settings unavailable"));
    await openMenu();

    expect(await screen.findByRole("alert")).toHaveTextContent("settings unavailable");
    expect(screen.getByTestId("engine-control-menu-close")).toBeInTheDocument();
  });

  it("stops and starts the global AI engine via settings", async () => {
    apiMocks.fetchSettings.mockResolvedValue({ ...defaultSettings, globalPause: false });
    await openMenu();

    fireEvent.click(screen.getByTestId("engine-control-stop-btn"));

    await waitFor(() => expect(apiMocks.updateSettings).toHaveBeenCalledWith(
      { globalPause: true, globalPauseReason: "manual" },
      "proj_123",
    ));
  });

  it("starts the global AI engine when currently stopped", async () => {
    apiMocks.fetchSettings.mockResolvedValue({ ...defaultSettings, globalPause: true });
    await openMenu();

    await waitFor(() => expect(screen.getByTestId("engine-control-stop-btn")).toHaveTextContent(/start ai engine/i));
    fireEvent.click(screen.getByTestId("engine-control-stop-btn"));

    await waitFor(() => expect(apiMocks.updateSettings).toHaveBeenCalledWith(
      { globalPause: false, globalPauseReason: undefined },
      "proj_123",
    ));
  });

  it("pauses and resumes triage, and disables triage while globally stopped", async () => {
    apiMocks.fetchSettings.mockResolvedValue({ ...defaultSettings, enginePaused: false });
    await openMenu();

    fireEvent.click(screen.getByTestId("engine-control-pause-triage-btn"));

    await waitFor(() => expect(apiMocks.updateSettings).toHaveBeenCalledWith({ enginePaused: true }, "proj_123"));

    vi.clearAllMocks();
    apiMocks.fetchConfig.mockResolvedValue({ maxConcurrent: 2, rootDir: "/workspace/project" });
    apiMocks.fetchSettings.mockResolvedValue({ ...defaultSettings, globalPause: true, enginePaused: true });
    legacyMocks.fetchConfig.mockResolvedValue({ maxConcurrent: 2, rootDir: "/workspace/project" });
    legacyMocks.fetchSettings.mockResolvedValue({ ...defaultSettings });
    render(
      <ConfirmDialogProvider>
        <EngineControlMenu projectId="proj_123" />
      </ConfirmDialogProvider>,
    );
    fireEvent.click(screen.getAllByTestId("engine-control-menu-trigger")[1]);

    await waitFor(() => expect(screen.getAllByTestId("engine-control-pause-triage-btn")).toHaveLength(2));
    const pauseButton = screen.getAllByTestId("engine-control-pause-triage-btn")[1];
    await waitFor(() => expect(pauseButton).toBeDisabled());
    expect(pauseButton).toHaveTextContent(/resume scheduling/i);
  });

  it("cancels a confirmed project concurrency edit by reverting to persisted values without saving", async () => {
    await openMenu();

    const maxConcurrent = await screen.findByLabelText(/max concurrent tasks/i);
    vi.useFakeTimers();

    fireEvent.change(maxConcurrent, { target: { value: "7" } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(screen.getByRole("dialog", { name: /confirm concurrency change/i })).toHaveTextContent("Max concurrent tasks from 2 to 7");
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: /confirm concurrency change/i })).not.toBeInTheDocument());
    await waitFor(() => expect(maxConcurrent).toHaveValue("2"));
    expect(legacyMocks.updateSettings).not.toHaveBeenCalled();
  });

  it("does not silently save project concurrency edits on Escape or outside dismissal", async () => {
    await openMenu();
    const maxConcurrent = await screen.findByLabelText(/max concurrent tasks/i);
    vi.useFakeTimers();

    fireEvent.change(maxConcurrent, { target: { value: "7" } });
    fireEvent.keyDown(document, { key: "Escape" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(legacyMocks.updateSettings).not.toHaveBeenCalled();
    expect(screen.queryByTestId("engine-control-menu")).not.toBeInTheDocument();

    vi.useRealTimers();
    cleanup();
    legacyMocks.updateSettings.mockClear();
    await openMenu();
    const reopenedMaxConcurrent = await screen.findByLabelText(/max concurrent tasks/i);
    vi.useFakeTimers();

    fireEvent.change(reopenedMaxConcurrent, { target: { value: "8" } });
    fireEvent.mouseDown(document.body);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(legacyMocks.updateSettings).not.toHaveBeenCalled();
    expect(screen.queryByTestId("engine-control-menu")).not.toBeInTheDocument();
  });

  it("confirms debounced concurrency and worktree slider changes before persisting and refreshing settings", async () => {
    legacyMocks.fetchSettings.mockResolvedValue({
      ...defaultSettings,
      maxConcurrent: 60,
      maxTriageConcurrent: 70,
      maxWorktrees: 80,
    });
    await openMenu();

    const maxConcurrent = await screen.findByLabelText(/max concurrent tasks/i);
    const maxWorktrees = screen.getByLabelText(/max worktrees/i);

    vi.useFakeTimers();

    expect(maxConcurrent).toHaveAttribute("max", "60");
    expect(maxConcurrent).toHaveValue("60");
    expect(maxWorktrees).toHaveAttribute("max", "80");
    expect(maxWorktrees).toHaveValue("80");

    fireEvent.change(maxConcurrent, { target: { value: "9" } });
    fireEvent.change(maxWorktrees, { target: { value: "8" } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(screen.getByRole("dialog", { name: /confirm concurrency change/i })).toHaveTextContent("Max concurrent tasks from 60 to 9");
    expect(screen.getByRole("dialog", { name: /confirm concurrency change/i })).toHaveTextContent("Max worktrees from 80 to 8");
    expect(legacyMocks.updateSettings).not.toHaveBeenCalled();

    vi.useRealTimers();
    const saveButton = screen.getByRole("button", { name: /save change/i });
    fireEvent.mouseDown(saveButton);
    fireEvent.click(saveButton);

    await waitFor(() => expect(legacyMocks.updateSettings).toHaveBeenCalledWith(
      { maxConcurrent: 9, maxWorktrees: 8 },
      "proj_123",
    ));
    expect(apiMocks.fetchSettings).toHaveBeenCalledTimes(2);
  });

  it("uses a 50 max for all in-range concurrency sliders", async () => {
    legacyMocks.fetchSettings.mockResolvedValue({
      ...defaultSettings,
      maxConcurrent: 12,
      maxTriageConcurrent: 3,
      maxWorktrees: 25,
    });
    await openMenu();

    expect(await screen.findByLabelText(/max concurrent tasks/i)).toHaveAttribute("max", "50");
    expect(screen.getByLabelText(/max worktrees/i)).toHaveAttribute("max", "50");
  });

  it("confirms footer global cap edits before writing through the shared hook", async () => {
    await openMenu();

    const globalMaxConcurrent = await screen.findByLabelText(/maximum concurrent agents across all projects/i);
    vi.useFakeTimers();

    fireEvent.change(globalMaxConcurrent, { target: { value: "9" } });

    expect(globalMaxConcurrent).toHaveValue("9");
    expect(globalMaxConcurrent.closest("label")).toHaveTextContent("9");
    expect(legacyMocks.updateGlobalConcurrency).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    const dialog = screen.getByRole("dialog", { name: /confirm concurrency change/i });
    expect(dialog).toHaveTextContent("Change Global Max Concurrent from 6 to 9?");
    expect(screen.getByRole("button", { name: /save change/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    expect(globalMaxConcurrent).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save change/i }));
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog", { name: /confirm concurrency change/i })).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
    });

    expect(legacyMocks.updateGlobalConcurrency).toHaveBeenCalledWith({ globalMaxConcurrent: 9 });
  });

  it("prevents duplicate footer confirmation dialogs while a concurrency confirmation is open", async () => {
    await openMenu();

    const maxConcurrent = await screen.findByLabelText(/max concurrent tasks/i);
    const globalMaxConcurrent = screen.getByLabelText(/maximum concurrent agents across all projects/i);
    vi.useFakeTimers();

    fireEvent.change(maxConcurrent, { target: { value: "7" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getAllByRole("dialog", { name: /confirm concurrency change/i })).toHaveLength(1);

    fireEvent.change(maxConcurrent, { target: { value: "8" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getAllByRole("dialog", { name: /confirm concurrency change/i })).toHaveLength(1);
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /confirm concurrency change/i })).not.toBeInTheDocument());

    vi.useFakeTimers();
    fireEvent.change(globalMaxConcurrent, { target: { value: "9" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getAllByRole("dialog", { name: /confirm concurrency change/i })).toHaveLength(1);
    fireEvent.change(globalMaxConcurrent, { target: { value: "10" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getAllByRole("dialog", { name: /confirm concurrency change/i })).toHaveLength(1);
    expect(legacyMocks.updateSettings).not.toHaveBeenCalled();
    expect(legacyMocks.updateGlobalConcurrency).not.toHaveBeenCalled();
  });

  it("flushes already-confirmed global cap saves when the footer closes", async () => {
    await openMenu();

    const globalMaxConcurrent = await screen.findByLabelText(/maximum concurrent agents across all projects/i);
    vi.useFakeTimers();

    fireEvent.change(globalMaxConcurrent, { target: { value: "9" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save change/i }));
      await Promise.resolve();
    });

    fireEvent.click(screen.getByTestId("engine-control-menu-close"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
    });

    expect(screen.queryByTestId("engine-control-menu")).not.toBeInTheDocument();
    expect(legacyMocks.updateGlobalConcurrency).toHaveBeenCalledWith({ globalMaxConcurrent: 9 });
  });

  it("cancels footer global cap edits without triggering a global write", async () => {
    await openMenu();

    const globalMaxConcurrent = await screen.findByLabelText(/maximum concurrent agents across all projects/i);
    vi.useFakeTimers();

    fireEvent.change(globalMaxConcurrent, { target: { value: "8" } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(screen.getByRole("dialog", { name: /confirm concurrency change/i })).toHaveTextContent("Global Max Concurrent from 6 to 8");
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: /confirm concurrency change/i })).not.toBeInTheDocument());
    await waitFor(() => expect(globalMaxConcurrent).toHaveValue("6"));
    expect(legacyMocks.updateGlobalConcurrency).not.toHaveBeenCalled();
  });

  it("does not prompt or write when a footer global cap edit matches the persisted value", async () => {
    await openMenu();

    const globalMaxConcurrent = await screen.findByLabelText(/maximum concurrent agents across all projects/i);
    vi.useFakeTimers();

    fireEvent.change(globalMaxConcurrent, { target: { value: "6" } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(screen.queryByRole("dialog", { name: /confirm concurrency change/i })).not.toBeInTheDocument();
    expect(legacyMocks.updateGlobalConcurrency).not.toHaveBeenCalled();
  });

  it("keeps loading and error global cap states disabled so they cannot prompt", async () => {
    let resolveGlobalConcurrency!: (value: {
      globalMaxConcurrent: number;
      currentlyActive: number;
      queuedCount: number;
      projectsActive: Record<string, number>;
    }) => void;
    legacyMocks.fetchGlobalConcurrency.mockReturnValue(new Promise((resolve) => {
      resolveGlobalConcurrency = resolve;
    }));

    await openMenu();

    const loadingGlobalMaxConcurrent = await screen.findByLabelText(/maximum concurrent agents across all projects/i);
    // FNXC:GlobalConcurrencyControls 2026-07-15-00:00: FN-7973 restores native touch dragging only for enabled ranges; loading caps remain disabled no-ops.
    expect(loadingGlobalMaxConcurrent).toHaveAttribute("disabled");
    expect(loadingGlobalMaxConcurrent).toBeDisabled();

    vi.useFakeTimers();
    fireEvent.change(loadingGlobalMaxConcurrent, { target: { value: "7" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.queryByRole("dialog", { name: /confirm concurrency change/i })).not.toBeInTheDocument();
    expect(legacyMocks.updateGlobalConcurrency).not.toHaveBeenCalled();

    await act(async () => {
      resolveGlobalConcurrency({
        globalMaxConcurrent: 6,
        currentlyActive: 3,
        queuedCount: 0,
        projectsActive: { proj_123: 2 },
      });
    });

    vi.useRealTimers();
    cleanup();
    legacyMocks.updateGlobalConcurrency.mockClear();
    legacyMocks.fetchGlobalConcurrency.mockRejectedValue(new Error("global concurrency unavailable"));

    await openMenu();

    const errorGlobalMaxConcurrent = await screen.findByLabelText(/maximum concurrent agents across all projects/i);
    await screen.findByRole("alert");
    expect(errorGlobalMaxConcurrent).toBeDisabled();

    vi.useFakeTimers();
    fireEvent.change(errorGlobalMaxConcurrent, { target: { value: "7" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.queryByRole("dialog", { name: /confirm concurrency change/i })).not.toBeInTheDocument();
    expect(legacyMocks.updateGlobalConcurrency).not.toHaveBeenCalled();
  });

  // FNXC:GlobalConcurrencyControls 2026-07-15-12:00: FN-8007 replaces FN-7160/FN-7235's utilization ratio with native range-thumb coordinates so markers share the running value's min-relative track position.
  it("aligns footer global and project markers with their native thumbs", async () => {
    legacyMocks.fetchSettings.mockResolvedValue({ ...defaultSettings, maxConcurrent: 12 });
    mockGlobalConcurrency({
      globalMaxConcurrent: 10,
      currentlyActive: 10,
      projectsActive: { proj_123: 10 },
    });

    await openMenu();

    await screen.findByTestId("engine-control-global-use-marker");
    expectUseMarkerPct("engine-control-global-use-marker", `${((10 - 1) / (32 - 1)) * 100}%`);
    expectUseMarkerPct("engine-control-project-use-marker", `${((10 - 1) / (50 - 1)) * 100}%`);
    expectFooterUseOffset("engine-control-global-use-marker", (10 - 1) / (32 - 1));
    expectFooterUseOffset("engine-control-project-use-marker", (10 - 1) / (50 - 1));
  });

  it("pins footer over-cap markers at the cap thumb instead of the track end", async () => {
    legacyMocks.fetchSettings.mockResolvedValue({ ...defaultSettings, maxConcurrent: 12 });
    mockGlobalConcurrency({
      globalMaxConcurrent: 10,
      currentlyActive: 40,
      projectsActive: { proj_123: 40 },
    });

    await openMenu();

    await screen.findByTestId("engine-control-global-use-marker");
    expectUseMarkerPct("engine-control-global-use-marker", `${((10 - 1) / (32 - 1)) * 100}%`);
    expectUseMarkerPct("engine-control-project-use-marker", `${((12 - 1) / (50 - 1)) * 100}%`);
    expect(screen.getByTestId("engine-control-global-use-marker").style.getPropertyValue("--use-pct")).not.toBe("100%");
    expect(screen.getByTestId("engine-control-project-use-marker").style.getPropertyValue("--use-pct")).not.toBe("100%");
  });

  it("maps one running agent to the visible footer slider start", async () => {
    legacyMocks.fetchSettings.mockResolvedValue({ ...defaultSettings, maxConcurrent: 12 });
    mockGlobalConcurrency({
      globalMaxConcurrent: 10,
      currentlyActive: 1,
      projectsActive: { proj_123: 1 },
    });

    await openMenu();

    await screen.findByTestId("engine-control-global-use-marker");
    expectUseMarkerPct("engine-control-global-use-marker", "0%");
    expectUseMarkerPct("engine-control-project-use-marker", "0%");
    expectFooterUseOffset("engine-control-global-use-marker", 0);
    expectFooterUseOffset("engine-control-project-use-marker", 0);
  });

  it("positions zero running at the start of both footer markers", async () => {
    mockGlobalConcurrency({
      globalMaxConcurrent: 6,
      currentlyActive: 0,
      projectsActive: {},
    });

    await openMenu(undefined);

    expect(await screen.findByTestId("engine-control-global-running")).toHaveTextContent("0 running (all projects)");
    expect(screen.getByTestId("engine-control-project-running")).toHaveTextContent("0 running (this project)");
    expect(screen.getByTestId("engine-control-global-use-marker")).toHaveStyle({ "--use-pct": "0%" });
    expect(screen.getByTestId("engine-control-project-use-marker")).toHaveStyle({ "--use-pct": "0%" });
    expectFooterUseOffset("engine-control-global-use-marker", 0);
    expectFooterUseOffset("engine-control-project-use-marker", 0);
  });

  it("recomputes footer project marker positions from the visible pending cap", async () => {
    legacyMocks.fetchSettings.mockResolvedValue({
      ...defaultSettings,
      maxConcurrent: 60,
    });
    mockGlobalConcurrency({
      globalMaxConcurrent: 48,
      currentlyActive: 16,
      projectsActive: { proj_123: 30 },
    });

    await openMenu();

    await screen.findByLabelText(/maximum concurrent agents across all projects/i);
    const maxConcurrent = screen.getByLabelText(/max concurrent tasks/i);
    vi.useFakeTimers();

    expectUseMarkerPct("engine-control-global-use-marker", `${((16 - 1) / (48 - 1)) * 100}%`);
    expectUseMarkerPct("engine-control-project-use-marker", `${((30 - 1) / (60 - 1)) * 100}%`);

    fireEvent.change(maxConcurrent, { target: { value: "50" } });

    expectUseMarkerPct("engine-control-global-use-marker", `${((16 - 1) / (48 - 1)) * 100}%`);
    expectUseMarkerPct("engine-control-project-use-marker", `${((30 - 1) / (50 - 1)) * 100}%`);
    expectFooterUseOffset("engine-control-global-use-marker", (16 - 1) / (48 - 1));
    expectFooterUseOffset("engine-control-project-use-marker", (30 - 1) / (50 - 1));
  });

  it("suppresses footer running counts and markers while utilization is loading", async () => {
    let resolveGlobalConcurrency!: (value: {
      globalMaxConcurrent: number;
      currentlyActive: number;
      queuedCount: number;
      projectsActive: Record<string, number>;
    }) => void;
    legacyMocks.fetchGlobalConcurrency.mockReturnValue(new Promise((resolve) => {
      resolveGlobalConcurrency = resolve;
    }));

    await openMenu();

    expect(screen.queryByTestId("engine-control-global-running")).not.toBeInTheDocument();
    expect(screen.queryByTestId("engine-control-project-running")).not.toBeInTheDocument();
    expect(screen.queryByTestId("engine-control-global-use-marker")).not.toBeInTheDocument();
    expect(screen.queryByTestId("engine-control-project-use-marker")).not.toBeInTheDocument();

    await act(async () => {
      resolveGlobalConcurrency({
        globalMaxConcurrent: 6,
        currentlyActive: 3,
        queuedCount: 0,
        projectsActive: { proj_123: 2 },
      });
    });
  });

  it("suppresses footer running counts and markers when utilization fails", async () => {
    legacyMocks.fetchGlobalConcurrency.mockRejectedValue(new Error("global concurrency unavailable"));

    await openMenu();

    await screen.findByRole("alert");
    expect(screen.queryByTestId("engine-control-global-running")).not.toBeInTheDocument();
    expect(screen.queryByTestId("engine-control-project-running")).not.toBeInTheDocument();
    expect(screen.queryByTestId("engine-control-global-use-marker")).not.toBeInTheDocument();
    expect(screen.queryByTestId("engine-control-project-use-marker")).not.toBeInTheDocument();
  });

  it("persists a slider value of 50 after confirmation", async () => {
    await openMenu();

    const maxConcurrent = await screen.findByLabelText(/max concurrent tasks/i);
    vi.useFakeTimers();

    expect(maxConcurrent).toHaveAttribute("max", "50");

    fireEvent.change(maxConcurrent, { target: { value: "50" } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: /save change/i }));

    await waitFor(() => expect(legacyMocks.updateSettings).toHaveBeenCalledWith(
      { maxConcurrent: 50, maxWorktrees: 4 },
      "proj_123",
    ));
  });

  it("renders a load error state without crashing", async () => {
    legacyMocks.fetchSettings.mockRejectedValue(new Error("settings unavailable"));
    await openMenu();

    expect(await screen.findByRole("alert")).toHaveTextContent("settings unavailable");
  });
});
