import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { CommandCenter } from "../CommandCenter";
import { STORED_COMMAND_CENTER_KEY, saveCommandCenterState } from "../../../hooks/modalPersistence";

/*
FNXC:CommandCenter 2026-09-17-11:22:
FN-508 : sur téléphone, atteindre une autre rubrique du Dashboard imposait une flèche de retour placée avant le titre,
qui remplaçait aussi « Dashboard » par le nom de la rubrique et basculait l'écran vers un panneau liste. Ce fichier
rejoue ce symptôme (palier téléphone simulé par `matchMedia`) et prouve l'invariant sur toutes les surfaces recensées :
téléphone portrait et paysage court, tablette, ordinateur, changement de palier en cours de session, et états persistés
absents, illisibles, inconnus ou change­ment de projet. L'en-tête reste « Dashboard », aucun retour n'existe, et la
bande de rubriques pleine largeur rend toutes les rubriques atteignables sans quitter l'écran.
*/

const apiMock = vi.fn();

vi.mock("../../../api/legacy", () => ({
  fetchCodebaseMetrics: vi.fn().mockResolvedValue({ tokenEstimate: 0, sourceFileCount: 0, sourceByteCount: 0, diskBytes: 0, diskFileCount: 0, method: "local", truncated: false }),
  api: (path: string, opts?: RequestInit) => apiMock(path, opts),
  withProjectId: (path: string, projectId?: string) =>
    projectId ? `${path}${path.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}` : path,
  fetchOrgTree: vi.fn().mockResolvedValue([]),
  fetchExecutorStats: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false, maxConcurrent: 2 }),
  fetchSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 5 }),
  fetchConfig: vi.fn().mockResolvedValue({ maxConcurrent: 2, rootDir: "/" }),
  updateSettings: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../../hooks/useAppSettings", () => ({
  useAppSettings: () => ({
    globalPaused: false,
    enginePaused: false,
    toggleGlobalPause: vi.fn(),
    toggleEnginePause: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../../../api", () => ({
  fetchSystemStats: () => Promise.resolve(systemStatsFixture()),
  fetchNodeSystemStats: () => Promise.resolve(systemStatsFixture()),
  fetchGlobalSettings: () => Promise.resolve({ vitestAutoKillEnabled: true, vitestKillThresholdPct: 90 }),
  fetchNodes: () => Promise.resolve([]),
  killVitestProcesses: () => Promise.resolve({ killed: 0, pids: [] }),
  updateGlobalSettings: () => Promise.resolve({}),
}));

function systemStatsFixture() {
  const gb = 1024 * 1024 * 1024;
  return {
    systemStats: {
      rss: gb,
      heapUsed: gb / 2,
      heapTotal: gb,
      heapLimit: gb,
      external: 0,
      arrayBuffers: 0,
      cpuPercent: 5,
      loadAvg: [0.1, 0.1, 0.1] as [number, number, number],
      cpuCount: 8,
      systemTotalMem: 8 * gb,
      systemFreeMem: 4 * gb,
      pid: 1,
      nodeVersion: "v22.0.0",
      platform: "linux/x64",
    },
    taskStats: { total: 0, byColumn: {}, active: 0, agents: { idle: 0, active: 0, running: 0, error: 0 } },
    vitestProcessCount: 0,
    vitestLastAutoKillAt: null,
  };
}

function mockEmptyCommandCenterApi() {
  apiMock.mockImplementation((path: string) => {
    if (path.startsWith("/command-center/tokens")) {
      return Promise.resolve({
        totals: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 0, nTasks: 0 },
        cost: { usd: null, unavailable: true, stale: false },
        groups: [],
      });
    }
    if (path.startsWith("/command-center/tools")) {
      return Promise.resolve({ toolCalls: 0, byCategory: [], sessions: 0, interventions: { approvals: 0, userSteers: 0, total: 0 }, autonomyRatio: 0, fullyAutonomous: true });
    }
    if (path.startsWith("/command-center/activity")) {
      return Promise.resolve({
        sessions: 0,
        messages: 0,
        activeNodes: 0,
        activeAgents: 0,
        daily: [],
        stickiness: 0,
        mttr: { value: null, unavailable: true },
        monitor: { mttr: { value: null, unavailable: true }, incidents: 0, deployments: 0 },
        funnel: { stages: [{ stage: "triage", entered: 0, current: 0 }, { stage: "done", entered: 0, current: 0 }], enteredInRange: 0, doneInRange: 0, completionRate: 0, throughputPerDay: 0, rangeDays: 7 },
      });
    }
    if (path.startsWith("/command-center/signals")) {
      return Promise.resolve({ totalSignals: 0, open: 0, resolved: 0, mttr: { value: null, unavailable: true }, bySource: [], bySeverity: [] });
    }
    if (path === "/command-center/live") {
      return Promise.resolve({ capturedAt: "2026-09-17T00:00:00.000Z", activeSessions: 0, activeRuns: 0, activeNodes: 0, sessions: [], runs: [], columns: [] });
    }
    if (path === "/system-stats") return Promise.resolve(systemStatsFixture());
    if (path === "/settings/global") return Promise.resolve({ vitestAutoKillEnabled: true, vitestKillThresholdPct: 90 });
    return Promise.resolve({});
  });
}

type ViewportTier = "desktop" | "tablet" | "mobile" | "mobile-landscape";

function mockViewportMatchMedia(tier: ViewportTier) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches:
        (tier === "mobile" && query.includes("max-width: 768px")) ||
        (tier === "mobile-landscape" && (query.includes("max-height: 480px") || query.includes("max-width: 768px"))) ||
        (tier === "tablet" && query.includes("min-width: 769px") && query.includes("max-width: 1023.98px")) ||
        (tier === "desktop" && query.includes("min-width: 1025px")),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function readMobilePane() {
  return screen.getByTestId("command-center").getAttribute("data-mobile-pane");
}

function headingText() {
  return screen.getByRole("heading", { level: 2 }).textContent;
}

function openSectionDropdown() {
  const trigger = screen.getByTestId("command-center-section-nav-trigger");
  if (!screen.queryByTestId("command-center-section-nav-menu")) fireEvent.click(trigger);
  return screen.getByTestId("command-center-section-nav-menu");
}

function chooseSection(id: string) {
  openSectionDropdown();
  fireEvent.click(screen.getByTestId(`command-center-section-option-${id}`));
}

function expectNoBackAffordance(container: HTMLElement) {
  expect(screen.queryByLabelText("Back to dashboard sections")).toBeNull();
  expect(container.querySelector(".view-back-button")).toBeNull();
  expect(container.querySelector("[aria-label*='Back']")).toBeNull();
}

function persistTokensSection() {
  saveCommandCenterState({ activeTab: "tokens", range: { from: null, to: null, preset: "30d" } });
}

const PHONE_TIERS: ViewportTier[] = ["mobile", "mobile-landscape"];

describe("CommandCenter phone section drop list (FN-508)", () => {
  beforeEach(() => {
    localStorage.clear();
    apiMock.mockReset();
    mockEmptyCommandCenterApi();
    mockViewportMatchMedia("mobile");
  });

  it.each(PHONE_TIERS)("keeps a fixed Dashboard heading and no back affordance on %s", (tier) => {
    mockViewportMatchMedia(tier);
    persistTokensSection();
    const { container } = render(<CommandCenter />);

    expect(headingText()).toContain("Dashboard");
    expectNoBackAffordance(container);
    expect(screen.getByTestId("view-layout-tabs")).toContainElement(screen.getByTestId("command-center-section-nav-trigger"));
    expect(container.querySelector(".cc-section-nav--full")).not.toBeNull();
    expect(readMobilePane()).toBe("detail");

    chooseSection("team");
    expect(headingText()).toContain("Dashboard");
    expect(screen.getByTestId("command-center-panel-team")).toBeTruthy();
    expectNoBackAffordance(container);
  });

  it("lists every default section and keeps the detail pane while switching sections", () => {
    const { container } = render(<CommandCenter />);

    expect(openSectionDropdown().querySelectorAll("[role='option']")).toHaveLength(17);

    chooseSection("tokens");
    expect(screen.getByTestId("command-center-panel-tokens")).toBeTruthy();
    expect(screen.queryByTestId("command-center-section-nav-menu")).toBeNull();
    expect(readMobilePane()).toBe("detail");

    chooseSection("team");
    expect(screen.getByTestId("command-center-panel-team")).toBeTruthy();
    expect(screen.queryByTestId("command-center-panel-tokens")).toBeNull();
    expect(readMobilePane()).toBe("detail");
    expectNoBackAffordance(container);
  });

  it("includes the Nodes section when it is enabled", () => {
    render(<CommandCenter nodesEnabled />);
    expect(openSectionDropdown().querySelectorAll("[role='option']")).toHaveLength(18);
    expect(screen.getByTestId("command-center-section-option-nodes")).toBeTruthy();
  });

  it("opens on Overview for absent, unreadable, unknown, and disabled persisted sections", () => {
    const withoutState = render(<CommandCenter />);
    expect(screen.getByTestId("command-center-panel-overview")).toBeTruthy();
    expect(readMobilePane()).toBe("detail");
    withoutState.unmount();

    localStorage.setItem(STORED_COMMAND_CENTER_KEY, "{not json");
    const unreadable = render(<CommandCenter />);
    expect(screen.getByTestId("command-center-panel-overview")).toBeTruthy();
    expect(screen.queryByLabelText("Back to dashboard sections")).toBeNull();
    unreadable.unmount();

    localStorage.clear();
    saveCommandCenterState({ activeTab: "nodes", range: { from: null, to: null, preset: "30d" } });
    const disabledSection = render(<CommandCenter />);
    expect(screen.getByTestId("command-center-panel-overview")).toBeTruthy();
    expect(readMobilePane()).toBe("detail");
    disabledSection.unmount();

    localStorage.clear();
    saveCommandCenterState({ activeTab: "does-not-exist", range: { from: null, to: null, preset: "30d" } } as never);
    render(<CommandCenter />);
    expect(screen.getByTestId("command-center-panel-overview")).toBeTruthy();
  });

  it("returns to Overview when the mounted view switches project, still without a list pane", () => {
    const { rerender, container } = render(<CommandCenter projectId="alpha" />);
    chooseSection("tokens");
    expect(screen.getByTestId("command-center-panel-tokens")).toBeTruthy();

    rerender(<CommandCenter projectId="beta" />);
    expect(screen.getByTestId("command-center-panel-overview")).toBeTruthy();
    expect(readMobilePane()).toBe("detail");
    expectNoBackAffordance(container);
  });

  it("still restores the persisted date range on a phone", () => {
    saveCommandCenterState({ activeTab: "tokens", range: { from: "2026-01-01", to: "2026-01-31", preset: "custom" } });
    render(<CommandCenter />);

    expect(screen.getByTestId("command-center-panel-overview")).toBeTruthy();
    expect(localStorage.getItem(STORED_COMMAND_CENTER_KEY)).toContain("2026-01-31");
  });

  it("renders the section content under the strip while the panel stays the only scroll owner", () => {
    render(<CommandCenter />);
    const layout = screen.getByTestId("command-center");
    const strip = screen.getByTestId("view-layout-tabs");
    const panel = screen.getByTestId("command-center-panel-overview");

    expect(strip.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(layout.querySelectorAll("[data-testid='view-layout-tabs']")).toHaveLength(1);
    expect(panel.className).toContain("cc-tabpanel");
  });
});

describe("CommandCenter tablet and desktop keep the section rail (FN-508)", () => {
  beforeEach(() => {
    localStorage.clear();
    apiMock.mockReset();
    mockEmptyCommandCenterApi();
  });

  it.each(["tablet", "desktop"] as ViewportTier[])("keeps the sidebar rail and list pane on %s", (tier) => {
    mockViewportMatchMedia(tier);
    persistTokensSection();
    const { container } = render(<CommandCenter />);

    expect(screen.queryByTestId("view-layout-tabs")).toBeNull();
    expect(container.querySelector(".cc-section-nav--rail")).not.toBeNull();
    expect(readMobilePane()).toBe("list");
    expect(screen.getByTestId("command-center-panel-tokens")).toBeTruthy();
    expect(headingText()).toContain("Dashboard");
  });

  it("never resets the active section when the viewport tier changes mid-session", () => {
    mockViewportMatchMedia("desktop");
    persistTokensSection();
    render(<CommandCenter />);
    expect(screen.getByTestId("command-center-panel-tokens")).toBeTruthy();

    mockViewportMatchMedia("mobile");
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(screen.getByTestId("command-center-panel-tokens")).toBeTruthy();
    expect(screen.queryByTestId("command-center-panel-overview")).toBeNull();
    expect(screen.queryByLabelText("Back to dashboard sections")).toBeNull();
  });
});
