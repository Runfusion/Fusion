import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import { EngineControlMenu } from "../EngineControlMenu";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";
import { readAppFile } from "../../test/cssFixture";

const engineControlMenuCss = readAppFile("components/EngineControlMenu.css");

const commandCenterControlsCss = readAppFile("components/command-center/CommandCenterControls.css");

const defaultSettings = {
  maxConcurrent: 2,
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
      maxWorktrees: 25,
    });
    await openMenu();

    expect(await screen.findByLabelText(/max concurrent tasks/i)).toHaveAttribute("max", "50");
    expect(screen.getByLabelText(/max worktrees/i)).toHaveAttribute("max", "50");
  });







  // FNXC:GlobalConcurrencyControls 2026-07-15-12:00: FN-8007 replaces FN-7160/FN-7235's utilization ratio with native range-thumb coordinates so markers share the running value's min-relative track position.





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


  /*
  FNXC:CapacityModel 2026-07-29-00:25 (drop the cross-project cap — settings half):
  The footer global-cap tests are DELETED with the slider they covered: confirm /
  cancel / dedupe-dialog / flush-on-close / no-op-when-unchanged / disabled-while-
  loading, and the global marker geometry cases.

  All of them pinned the machinery that held an edit un-persisted until the operator
  confirmed. That machinery existed because the slider WROTE a machine-wide cap; the
  cap is gone (capacity is two numbers PER PROJECT) and so is the PUT route, so there
  is no write left to guard. The PROJECT-side equivalents of every one of these cases
  are retained above — they still guard a real write.

  The surviving "suppresses footer running counts and markers while utilization is
  loading" case still covers the live-telemetry readout, which is the only part of
  this surface that remains.
  */

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

  // FNXC:EngineControls 2026-08-08-15:40 (FN-8802 width-collapse regression, RUFU-042):
  // The open popover carries the shared `.card` class, whose base now sets `min-width: 0` and
  // `max-width: 100%` (TaskCard.css). Its containing block is `.engine-control-menu` which sizes
  // to the narrow trigger button, so `.card`'s `max-width: 100%` clamped the popover's intended
  // grid width down to ~the trigger's width (~5mm). The footer-scoped rule (0,3,0) must re-assert
  // a VIEWPORT-clamped min/max width that beats `.card` (0,1,0), so the menu can never collapse
  // to a sliver. Keep this guard asserted so the fix cannot silently regress.
  it("keeps the footer-scoped popover width immune to the shared `.card` clamp on desktop", () => {
    const footerPopover = cssRule(engineControlMenuCss, ".executor-status-bar__segment--engine-controls .engine-control-menu > .engine-control-menu__popover.card");
    expect(footerPopover).toContain("position: absolute;");
    expect(footerPopover).toContain("min-width: min(24rem, calc(100vw - (var(--space-lg) * 2)));");
    expect(footerPopover).toContain("max-width: calc(100vw - (var(--space-lg) * 2));");
  });

  // FNXC:EngineControls 2026-08-08-15:40 (FN-8802 width-collapse regression, RUFU-042):
  // On narrow/tablet widths the popover becomes a full-width gutter panel (`left/right: var(--space-sm)`).
  // It must reset the desktop min/max floor and defeat `.card`'s `max-width: 100%` so the phone panel
  // stays full-width without overflowing. Assert the media-query rules only (cssRule grabs the first
  // selector match, which is the desktop base rule, so match the @media block explicitly).
  it("keeps the mobile popover full-width and never overflowed by the desktop min-width floor", () => {
    const mobileBlock = engineControlMenuCss.match(/@media \(max-width: 1024px\) \{([\s\S]*?)\}/)?.[1] ?? "";
    expect(mobileBlock).toContain("left: var(--space-sm);");
    expect(mobileBlock).toContain("right: var(--space-sm);");
    expect(mobileBlock).toContain("max-width: none;");
    expect(mobileBlock).toContain("min-width: 0;");
    expect(mobileBlock).toContain("width: auto;");
  });
});
