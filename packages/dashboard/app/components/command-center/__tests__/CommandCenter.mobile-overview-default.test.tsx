import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { CommandCenter } from "../CommandCenter";
import { STORED_COMMAND_CENTER_KEY, saveCommandCenterState } from "../../../hooks/modalPersistence";
import { selectCommandCenterSection } from "./sectionNavTestUtils";

/*
FNXC:CommandCenter 2026-09-17-06:20:
FN-492: le menu « Dashboard » du pied de page mobile ouvrait la liste des rubriques et, si une rubrique avait déjà été
consultée, cette rubrique mémorisée — jamais Overview. Ce fichier rejoue exactement ce symptôme (mode téléphone simulé
par `matchMedia` + état persisté `activeTab: "tokens"`) et prouve l'invariant sur toutes les surfaces recensées :
téléphone portrait et paysage court, tablette, ordinateur, états persistés absents/illisibles/inconnus, retour vers la
liste des rubriques, remontage et changement de projet.
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

/*
FNXC:CommandCenterTesting 2026-09-17-06:20:
`useViewportMode` classe le téléphone par largeur (`max-width: 768px`) et le paysage court par hauteur
(`max-height: 480px`); les deux surfaces téléphone recensées sont donc simulées séparément.
*/
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

function persistTokensSection() {
  saveCommandCenterState({ activeTab: "tokens", range: { from: null, to: null, preset: "30d" } });
}

describe("CommandCenter phone opens on Overview (FN-492)", () => {
  beforeEach(() => {
    localStorage.clear();
    apiMock.mockReset();
    mockEmptyCommandCenterApi();
    mockViewportMatchMedia("mobile");
  });

  it("lands on the Overview content even when another section was persisted", () => {
    persistTokensSection();
    render(<CommandCenter />);

    expect(screen.getByTestId("command-center-panel-overview")).toBeTruthy();
    expect(screen.queryByTestId("command-center-panel-tokens")).toBeNull();
    expect(readMobilePane()).toBe("detail");
    expect(screen.getByTestId("command-center-controls")).toBeTruthy();
  });

  it("lands on Overview on a short landscape phone as well", () => {
    persistTokensSection();
    mockViewportMatchMedia("mobile-landscape");
    render(<CommandCenter />);

    expect(screen.getByTestId("command-center-panel-overview")).toBeTruthy();
    expect(readMobilePane()).toBe("detail");
  });

  it("keeps the section list reachable through the header back action", () => {
    render(<CommandCenter />);

    fireEvent.click(screen.getByLabelText("Back to dashboard sections"));
    expect(readMobilePane()).toBe("list");

    selectCommandCenterSection("tokens");
    expect(screen.getByTestId("command-center-panel-tokens")).toBeTruthy();
    expect(readMobilePane()).toBe("detail");
  });

  it("returns to Overview on remount after another section was selected", () => {
    const first = render(<CommandCenter />);
    fireEvent.click(screen.getByLabelText("Back to dashboard sections"));
    selectCommandCenterSection("tokens");
    expect(screen.getByTestId("command-center-panel-tokens")).toBeTruthy();
    first.unmount();

    render(<CommandCenter />);
    expect(screen.getByTestId("command-center-panel-overview")).toBeTruthy();
    expect(readMobilePane()).toBe("detail");
  });

  it("returns to Overview when the mounted view switches project", () => {
    const { rerender } = render(<CommandCenter projectId="alpha" />);
    fireEvent.click(screen.getByLabelText("Back to dashboard sections"));
    selectCommandCenterSection("tokens");
    expect(readMobilePane()).toBe("detail");

    rerender(<CommandCenter projectId="beta" />);
    expect(screen.getByTestId("command-center-panel-overview")).toBeTruthy();
    expect(readMobilePane()).toBe("detail");
  });

  it("opens on Overview for absent, unreadable, and unknown persisted state", () => {
    const withoutState = render(<CommandCenter />);
    expect(screen.getByTestId("command-center-panel-overview")).toBeTruthy();
    withoutState.unmount();

    localStorage.setItem(STORED_COMMAND_CENTER_KEY, "{not json");
    const withUnreadableState = render(<CommandCenter />);
    expect(screen.getByTestId("command-center-panel-overview")).toBeTruthy();
    expect(readMobilePane()).toBe("detail");
    withUnreadableState.unmount();

    localStorage.clear();
    saveCommandCenterState({ activeTab: "nodes", range: { from: null, to: null, preset: "30d" } });
    render(<CommandCenter />);
    expect(screen.getByTestId("command-center-panel-overview")).toBeTruthy();
    expect(readMobilePane()).toBe("detail");
  });

  it("still restores the persisted date range on a phone", () => {
    saveCommandCenterState({ activeTab: "tokens", range: { from: "2026-01-01", to: "2026-01-31", preset: "custom" } });
    render(<CommandCenter />);

    expect(screen.getByTestId("command-center-panel-overview")).toBeTruthy();
    expect(localStorage.getItem(STORED_COMMAND_CENTER_KEY)).toContain("2026-01-31");
  });
});

describe("CommandCenter tablet and desktop keep the persisted section (FN-492)", () => {
  beforeEach(() => {
    localStorage.clear();
    apiMock.mockReset();
    mockEmptyCommandCenterApi();
  });

  it("restores the persisted section on desktop with the list pane", () => {
    mockViewportMatchMedia("desktop");
    persistTokensSection();
    render(<CommandCenter />);

    expect(screen.getByTestId("command-center-panel-tokens")).toBeTruthy();
    expect(readMobilePane()).toBe("list");
  });

  it("restores the persisted section on tablet with the list pane", () => {
    mockViewportMatchMedia("tablet");
    persistTokensSection();
    render(<CommandCenter />);

    expect(screen.getByTestId("command-center-panel-tokens")).toBeTruthy();
    expect(readMobilePane()).toBe("list");
  });

  it("never resets the active section when the viewport mode changes mid-session", () => {
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
  });
});
