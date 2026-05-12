import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { MissionManager } from "../MissionManager";

/**
 * MissionManager layout reference (post FN-3136):
 * - split container: .mission-manager__split
 * - sidebar: .mission-manager__sidebar
 * - detail pane: .mission-manager__detail-pane
 * - empty detail placeholder: [data-testid="mission-empty-detail"]
 * - back button handling: rendered when mission selected, CSS-hidden on desktop (.mission-manager--desktop .mission-manager__back-btn)
 * - viewport strategy: js_detection via useViewportMode() + matchMedia
 * - sidebar mission items: .mission-list__item
 */

const mockFetchAiSession = vi.fn();
const mockFetchAiSessions = vi.fn();
const mockCancelMissionInterview = vi.fn();
const mockConnectMissionInterviewStream = vi.fn();
const mockPreviewEnrichedDescription = vi.fn();
const mockSkipMilestoneInterview = vi.fn();
const mockSkipSliceInterview = vi.fn();
const mockTriageFeature = vi.fn();

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    fetchAiSession: (...args: any[]) => mockFetchAiSession(...args),
    fetchAiSessions: (...args: any[]) => mockFetchAiSessions(...args),
    cancelMissionInterview: (...args: any[]) => mockCancelMissionInterview(...args),
    connectMissionInterviewStream: (...args: any[]) => mockConnectMissionInterviewStream(...args),
    previewEnrichedDescription: (...args: any[]) => mockPreviewEnrichedDescription(...args),
    skipMilestoneInterview: (...args: any[]) => mockSkipMilestoneInterview(...args),
    skipSliceInterview: (...args: any[]) => mockSkipSliceInterview(...args),
    triageFeature: (...args: any[]) => mockTriageFeature(...args),
    fetchMilestoneValidationTelemetry: (milestoneId: string, projectId?: string) => actual.fetchMilestoneValidationTelemetry(milestoneId, projectId),
    fetchModels: () => Promise.resolve({ models: [], favoriteProviders: [], favoriteModels: [] }),
  };
});

vi.mock("lucide-react", () => ({
  X: () => <span data-testid="x-icon">X</span>,
  Plus: () => <span data-testid="plus-icon">+</span>,
  Pencil: () => <span data-testid="pencil-icon">Pencil</span>,
  Trash2: () => <span data-testid="trash-icon">Trash</span>,
  ChevronRight: () => <span data-testid="chevron-right-icon">ChevronRight</span>,
  ChevronDown: () => <span data-testid="chevron-down-icon">ChevronDown</span>,
  ChevronLeft: () => <span data-testid="chevron-left-icon">ChevronLeft</span>,
  Target: () => <span data-testid="target-icon">Target</span>,
  Layers: () => <span data-testid="layers-icon">Layers</span>,
  Package: () => <span data-testid="package-icon">Package</span>,
  Box: () => <span data-testid="box-icon">Box</span>,
  Check: () => <span data-testid="check-icon">Check</span>,
  Loader2: ({ className }: any) => <span data-testid="loader-icon" className={className}>Loader</span>,
  Link: () => <span data-testid="link-icon">Link</span>,
  Unlink: () => <span data-testid="unlink-icon">Unlink</span>,
  ArrowLeft: () => <span data-testid="arrow-left-icon">ArrowLeft</span>,
  ArrowRight: () => <span data-testid="arrow-right-icon">ArrowRight</span>,
  Play: () => <span data-testid="play-icon">Play</span>,
  Square: () => <span data-testid="square-icon">Square</span>,
  Sparkles: () => <span data-testid="sparkles-icon">Sparkles</span>,
  Zap: () => <span data-testid="zap-icon">Zap</span>,
  Activity: () => <span data-testid="activity-icon">Activity</span>,
  FileText: () => <span data-testid="file-text-icon">FileText</span>,
  Minimize2: () => <span data-testid="minimize-icon">Minimize2</span>,
  Lock: () => <span data-testid="lock-icon">Lock</span>,
  RefreshCw: ({ className }: any) => <span data-testid="refresh-icon" className={className}>Refresh</span>,
  AlertCircle: () => <span data-testid="alert-circle-icon">AlertCircle</span>,
}));

// Mock data
const mockMissions = [
  {
    id: "M-001",
    title: "Build Auth System",
    description: "Complete authentication flow",
    status: "planning",
    interviewState: "not_started",
    milestones: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "M-002",
    title: "API Redesign",
    description: "Redesign the REST API",
    status: "active",
    interviewState: "not_started",
    autopilotEnabled: true,
    autopilotState: "watching",
    milestones: [],
    summary: {
      totalMilestones: 2,
      completedMilestones: 1,
      totalFeatures: 5,
      completedFeatures: 3,
      progressPercent: 60,
    },
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
];

const mockMissionDetail = {
  id: "M-001",
  title: "Build Auth System",
  description: "Complete authentication flow",
  status: "planning",
  milestones: [
    {
      id: "MS-001",
      title: "Database Schema",
      description: "Set up auth tables",
      status: "planning",
      interviewState: "not_started",
      dependencies: [] as string[],
      slices: [
        {
          id: "SL-001",
          title: "User Tables",
          description: "Create user tables",
          status: "pending",
          planState: "not_started",
          features: [
            {
              id: "F-001",
              title: "User model",
              description: "Create user model",
              acceptanceCriteria: "Model exists with required fields",
              status: "defined",
              taskId: null,
              sliceId: "SL-001",
              missionId: "M-001",
            },
          ],
          milestoneId: "MS-001",
          missionId: "M-001",
        },
      ],
      missionId: "M-001",
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const mockAutopilotStatus = {
  enabled: false,
  state: "inactive",
  watched: false,
};

const mockMilestoneValidationRollup = {
  milestoneId: "MS-001",
  totalAssertions: 0,
  passedAssertions: 0,
  failedAssertions: 0,
  blockedAssertions: 0,
  pendingAssertions: 0,
  unlinkedAssertions: 0,
  state: "not_started" as const,
};

/** Extended mock telemetry for parity tests — mirrors FN-1569 schema */
const mockMilestoneValidationTelemetryWithRounds = {
  validationContract: {
    assertions: [
      { id: "CA-001", title: "Auth works", assertion: "Users can log in", status: "pending" as const, orderIndex: 0 },
      { id: "CA-002", title: "Session persists", assertion: "Token refresh works", status: "pending" as const, orderIndex: 1 },
    ],
    featureFulfillment: {
      "F-001": { assertionIds: ["CA-001"], featureTitle: "User model", featureStatus: "in-progress" },
    },
  },
  validationTelemetry: {
    validationRounds: [
      {
        roundId: "VR-001",
        featureId: "F-001",
        featureTitle: "User model",
        validatorStatus: "failed" as const,
        implementationAttempt: 1,
        validatorAttempt: 2, // retry count (validatorAttempt = retry count)
        failedAssertionIds: ["CA-001"],
        generatedFixFeatureIds: [],
        startedAt: "2026-04-10T09:00:00.000Z",
        completedAt: "2026-04-10T09:05:00.000Z",
      },
      {
        roundId: "VR-002",
        featureId: "F-001",
        featureTitle: "User model",
        validatorStatus: "failed" as const,
        implementationAttempt: 2,
        validatorAttempt: 3, // higher retry count — iterating surface
        failedAssertionIds: ["CA-002"],
        generatedFixFeatureIds: [],
        startedAt: "2026-04-10T09:10:00.000Z",
        completedAt: "2026-04-10T09:15:00.000Z",
      },
    ],
    lastValidatorStatus: "failed" as const,
    totalRuns: 2,
  },
  fixFeatures: [
    {
      id: "FF-001",
      title: "Fix: token refresh",
      sourceFeatureId: "F-001",
      runId: "VR-001",
      failedAssertionIds: ["CA-001"],
      status: "defined" as const,
      loopState: "idle" as const,
    },
  ],
  rollup: {
    milestoneId: "MS-001",
    totalAssertions: 2,
    passedAssertions: 0,
    failedAssertions: 2,
    blockedAssertions: 0,
    pendingAssertions: 0,
    unlinkedAssertions: 0,
    state: "failed" as const,
  },
};

/** Blocked milestone telemetry — mirrors FN-1569 blocked state */
const mockBlockedMilestoneTelemetry = {
  validationContract: {
    assertions: [
      { id: "CA-003", title: "API reachable", assertion: "External API responds", status: "blocked" as const, orderIndex: 0 },
    ],
    featureFulfillment: {},
  },
  validationTelemetry: {
    validationRounds: [
      {
        roundId: "VR-BLK",
        featureId: "F-BLK",
        featureTitle: "API integration",
        validatorStatus: "blocked" as const,
        implementationAttempt: 1,
        validatorAttempt: 1,
        failedAssertionIds: ["CA-003"],
        generatedFixFeatureIds: [],
        blockedReason: "External API unavailable — connection refused after 3 retries",
        startedAt: "2026-04-10T10:00:00.000Z",
        completedAt: "2026-04-10T10:01:00.000Z",
      },
    ],
    lastValidatorStatus: "blocked" as const,
    totalRuns: 1,
  },
  fixFeatures: [],
  rollup: {
    milestoneId: "MS-001",
    totalAssertions: 1,
    passedAssertions: 0,
    failedAssertions: 0,
    blockedAssertions: 1,
    pendingAssertions: 0,
    unlinkedAssertions: 0,
    state: "blocked" as const,
  },
};

const mockMilestoneValidationTelemetry = {
  validationContract: {
    assertions: [],
    featureFulfillment: {},
  },
  validationTelemetry: {
    validationRounds: [],
    lastValidatorStatus: null,
    totalRuns: 0,
  },
  fixFeatures: [],
  rollup: mockMilestoneValidationRollup,
};

const mockMissionEvents = [
  {
    id: "E-001",
    missionId: "M-001",
    eventType: "mission_started",
    description: "Mission started",
    metadata: null,
    timestamp: "2026-01-03T10:00:00.000Z",
  },
  {
    id: "E-002",
    missionId: "M-001",
    eventType: "warning",
    description: "Task queue is delayed",
    metadata: { queueDepth: 4 },
    timestamp: "2026-01-03T10:10:00.000Z",
  },
  {
    id: "E-003",
    missionId: "M-001",
    eventType: "feature_completed",
    description: "Feature F-001 completed",
    metadata: { featureId: "F-001" },
    timestamp: "2026-01-03T10:20:00.000Z",
  },
  {
    id: "E-004",
    missionId: "M-001",
    eventType: "autopilot_state_changed",
    description: "Autopilot moved to watching",
    metadata: { previous: "inactive", next: "watching" },
    timestamp: "2026-01-03T10:30:00.000Z",
  },
];

const mockMissionEventsPaged = Array.from({ length: 65 }, (_, index) => ({
  id: `E-${String(index + 1).padStart(3, "0")}`,
  missionId: "M-001",
  eventType: index % 2 === 0 ? "feature_completed" : "slice_activated",
  description: `Mission event ${index + 1}`,
  metadata: { index: index + 1 },
  timestamp: new Date(Date.UTC(2026, 0, 3, 10, index)).toISOString(),
}));

/** Create a mock Response that matches the real api() function's expectations (text + content-type headers) */
function mockApiResponse(data: unknown) {
  return {
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

const mockMissionHealthById: Record<string, unknown> = {
  "M-001": {
    missionId: "M-001",
    status: "planning",
    tasksCompleted: 0,
    tasksFailed: 0,
    tasksInFlight: 0,
    totalTasks: 0,
    currentSliceId: undefined,
    currentMilestoneId: undefined,
    estimatedCompletionPercent: 0,
    lastErrorAt: undefined,
    lastErrorDescription: undefined,
    autopilotState: "inactive",
    autopilotEnabled: false,
    lastActivityAt: undefined,
  },
  "M-002": {
    missionId: "M-002",
    status: "active",
    tasksCompleted: 3,
    tasksFailed: 0,
    tasksInFlight: 1,
    totalTasks: 5,
    currentSliceId: "SL-API-1",
    currentMilestoneId: "MS-API-1",
    estimatedCompletionPercent: 60,
    lastErrorAt: undefined,
    lastErrorDescription: undefined,
    autopilotState: "watching",
    autopilotEnabled: true,
    lastActivityAt: "2026-01-02T00:00:00.000Z",
  },
};

function getMockMissionHealth(missionId: string) {
  return (
    mockMissionHealthById[missionId] ?? {
      missionId,
      status: "planning",
      tasksCompleted: 0,
      tasksFailed: 0,
      tasksInFlight: 0,
      totalTasks: 0,
      currentSliceId: undefined,
      currentMilestoneId: undefined,
      estimatedCompletionPercent: 0,
      lastErrorAt: undefined,
      lastErrorDescription: undefined,
      autopilotState: "inactive",
      autopilotEnabled: false,
      lastActivityAt: undefined,
    }
  );
}

function extractMissionId(url: string): string | null {
  const match = url.match(/\/api\/missions\/([^/?]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function parseMissionEventsResponse(url: string, events = mockMissionEvents) {
  const parsed = new URL(url, "http://localhost");
  const offset = Number(parsed.searchParams.get("offset") ?? "0");
  const limit = Number(parsed.searchParams.get("limit") ?? "25");
  const eventType = parsed.searchParams.get("eventType");

  const filtered = eventType
    ? events.filter((event) => event.eventType === eventType)
    : events;

  return {
    events: filtered.slice(offset, offset + limit),
    total: filtered.length,
    limit,
    offset,
  };
}

function getValidationApiMock(url: string, telemetryOverride?: unknown): unknown | null {
  const telemetry = telemetryOverride ?? mockMilestoneValidationTelemetry;
  if (url.includes("/validation-telemetry")) {
    return telemetry;
  }

  if (url.includes("/validation-runs")) {
    return { runs: [], total: 0, limit: 10, offset: 0 };
  }

  if (url.includes("/validation-loop")) {
    return {
      featureId: "F-001",
      feature: mockMissionDetail.milestones[0].slices[0].features[0],
      loopState: "idle",
      implementationAttemptCount: 0,
      validatorAttemptCount: 0,
      retryBudgetRemaining: 3,
    };
  }

  if (url.includes("/validation")) {
    return mockMilestoneValidationRollup;
  }

  if (url.includes("/assertions")) {
    return [];
  }

  return null;
}

class MockEventSource {
  static instances: MockEventSource[] = [];

  private readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, callback: (event: MessageEvent<string>) => void) {
    const existing = this.listeners.get(type) ?? new Set();
    existing.add(callback);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, callback: (event: MessageEvent<string>) => void) {
    this.listeners.get(type)?.delete(callback);
  }

  close() {
    this.listeners.clear();
  }

  emit(type: string, payload: unknown) {
    const event = { data: JSON.stringify(payload) } as MessageEvent<string>;
    for (const callback of this.listeners.get(type) ?? []) {
      callback(event);
    }
  }

  static reset() {
    MockEventSource.instances = [];
  }
}

/** Fetch mock that returns mission list, detail, health, autopilot, and events endpoints. */
function createFetchMock() {
  return vi.fn().mockImplementation((url: string) => {
    // Handle batched health endpoint before individual health endpoint
    if (url.includes("/missions/health")) {
      return Promise.resolve(mockApiResponse(mockMissionHealthById));
    }

    if (url.includes("/events")) {
      return Promise.resolve(mockApiResponse(parseMissionEventsResponse(url)));
    }

    if (url.includes("/health")) {
      const missionId = extractMissionId(url) ?? "M-001";
      return Promise.resolve(mockApiResponse(getMockMissionHealth(missionId)));
    }

    if (url.includes("/autopilot")) {
      return Promise.resolve(mockApiResponse(mockAutopilotStatus));
    }

    const validationResponse = getValidationApiMock(url);
    if (validationResponse !== null) {
      return Promise.resolve(mockApiResponse(validationResponse));
    }

    if (url.includes("/api/missions/") && !url.includes("/milestones") && !url.includes("/status")) {
      return Promise.resolve(mockApiResponse(mockMissionDetail));
    }

    return Promise.resolve(mockApiResponse(mockMissions));
  });
}

/** Fetch mock for navigating into a mission detail */
function createDetailFetchMock(events = mockMissionEvents) {
  return vi.fn().mockImplementation((url: string) => {
    // Handle batched health endpoint before individual health endpoint
    if (url.includes("/missions/health")) {
      return Promise.resolve(mockApiResponse(mockMissionHealthById));
    }

    if (url.includes("/events")) {
      return Promise.resolve(mockApiResponse(parseMissionEventsResponse(url, events)));
    }

    if (url.includes("/health")) {
      const missionId = extractMissionId(url) ?? "M-001";
      return Promise.resolve(mockApiResponse(getMockMissionHealth(missionId)));
    }

    if (url.includes("/autopilot")) {
      return Promise.resolve(mockApiResponse(mockAutopilotStatus));
    }

    const validationResponse = getValidationApiMock(url);
    if (validationResponse !== null) {
      return Promise.resolve(mockApiResponse(validationResponse));
    }

    if (url.includes("/api/missions/") && !url.includes("/milestones") && !url.includes("/status")) {
      const missionId = extractMissionId(url);
      if (missionId === "M-001") {
        return Promise.resolve(mockApiResponse(mockMissionDetail));
      }
    }

    return Promise.resolve(mockApiResponse(mockMissions));
  });
}

function createFetchMockWithTelemetry(telemetryOverride: unknown) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.includes("/missions/health")) {
      return Promise.resolve(mockApiResponse(mockMissionHealthById));
    }

    if (url.includes("/events")) {
      return Promise.resolve(mockApiResponse(parseMissionEventsResponse(url)));
    }

    if (url.includes("/health")) {
      const missionId = extractMissionId(url) ?? "M-001";
      return Promise.resolve(mockApiResponse(getMockMissionHealth(missionId)));
    }

    if (url.includes("/autopilot")) {
      return Promise.resolve(mockApiResponse(mockAutopilotStatus));
    }

    const validationResponse = getValidationApiMock(url, telemetryOverride);
    if (validationResponse !== null) {
      return Promise.resolve(mockApiResponse(validationResponse));
    }

    if (url.includes("/api/missions/") && !url.includes("/milestones") && !url.includes("/status")) {
      return Promise.resolve(mockApiResponse(mockMissionDetail));
    }

    return Promise.resolve(mockApiResponse(mockMissions));
  });
}

function createDetailFetchMockWithTelemetry(events: unknown[], telemetryOverride: unknown) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.includes("/missions/health")) {
      return Promise.resolve(mockApiResponse(mockMissionHealthById));
    }

    if (url.includes("/events")) {
      return Promise.resolve(mockApiResponse(parseMissionEventsResponse(url, events as typeof mockMissionEvents)));
    }

    if (url.includes("/health")) {
      const missionId = extractMissionId(url) ?? "M-001";
      return Promise.resolve(mockApiResponse(getMockMissionHealth(missionId)));
    }

    if (url.includes("/autopilot")) {
      return Promise.resolve(mockApiResponse(mockAutopilotStatus));
    }

    const validationResponse = getValidationApiMock(url, telemetryOverride);
    if (validationResponse !== null) {
      return Promise.resolve(mockApiResponse(validationResponse));
    }

    if (url.includes("/api/missions/") && !url.includes("/milestones") && !url.includes("/status")) {
      const missionId = extractMissionId(url);
      if (missionId === "M-001") {
        return Promise.resolve(mockApiResponse(mockMissionDetail));
      }
    }

    return Promise.resolve(mockApiResponse(mockMissions));
  });
}

function createFetchMockWithHealth(
  missions: Array<Record<string, unknown>>,
  healthByMissionId: Record<string, unknown>,
) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.includes("/events")) {
      return Promise.resolve(mockApiResponse(parseMissionEventsResponse(url)));
    }

    // Handle batched health endpoint before individual health endpoint
    // /api/missions/health returns all mission health data
    // /api/missions/:id/health returns individual mission health
    if (url.includes("/missions/health")) {
      return Promise.resolve(mockApiResponse(healthByMissionId));
    }

    if (url.includes("/health")) {
      const missionId = extractMissionId(url) ?? "";
      return Promise.resolve(mockApiResponse(healthByMissionId[missionId] ?? getMockMissionHealth(missionId)));
    }

    if (url.includes("/autopilot")) {
      return Promise.resolve(mockApiResponse(mockAutopilotStatus));
    }

    const validationResponse = getValidationApiMock(url);
    if (validationResponse !== null) {
      return Promise.resolve(mockApiResponse(validationResponse));
    }

    if (url.includes("/api/missions/") && !url.includes("/milestones") && !url.includes("/status")) {
      return Promise.resolve(mockApiResponse(mockMissionDetail));
    }

    return Promise.resolve(mockApiResponse(missions));
  });
}

function mockViewport(mode: "mobile" | "desktop" | "tablet") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const isMobileQuery = query === "(max-width: 768px)";
      const isTabletQuery = query === "(min-width: 769px) and (max-width: 1024px)";
      return {
        matches: mode === "mobile" ? isMobileQuery : mode === "tablet" ? isTabletQuery : false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
    }),
  });
}

async function waitForDetailLoaded(detailContent = "Database Schema") {
  await waitFor(() => {
    expect(screen.getByText(detailContent)).toBeInTheDocument();
  });
}

describe("MissionManager", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEventSource: typeof globalThis.EventSource | undefined;

  beforeEach(() => {
    mockViewport("desktop");
    originalFetch = globalThis.fetch;
    originalEventSource = globalThis.EventSource;
    mockFetchAiSession.mockReset();
    mockFetchAiSessions.mockReset();
    mockCancelMissionInterview.mockReset();
    mockConnectMissionInterviewStream.mockReset();
    mockFetchAiSession.mockResolvedValue(null);
    mockFetchAiSessions.mockResolvedValue([]);
    mockCancelMissionInterview.mockResolvedValue(undefined);
    mockConnectMissionInterviewStream.mockReturnValue({
      close: vi.fn(),
      isConnected: () => true,
    });
    MockEventSource.reset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource as typeof globalThis.EventSource;
    vi.restoreAllMocks();
  });

  it("renders nothing when isOpen is false", () => {
    globalThis.fetch = createFetchMock();
    render(<MissionManager isOpen={false} onClose={vi.fn()} addToast={vi.fn()} />);
    expect(screen.queryByTestId("mission-manager-dialog")).toBeNull();
  });

  it("renders the dialog with accessible attributes when open", async () => {
    globalThis.fetch = createFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      const dialog = screen.getByTestId("mission-manager-dialog");
      expect(dialog).toBeDefined();
      expect(dialog.getAttribute("role")).toBe("dialog");
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(dialog.getAttribute("aria-label")).toBe("Mission Manager");
    });
  });

  it("renders the modal overlay with open class", async () => {
    globalThis.fetch = createFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      const overlay = screen.getByTestId("mission-manager-overlay");
      expect(overlay).toBeDefined();
      expect(overlay.className).toContain("open");
    });
  });

  it("shows the Missions title in list view", async () => {
    globalThis.fetch = createFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("mission-header-title")).toBeDefined();
      expect(screen.getByTestId("mission-header-title").textContent).toContain("Missions");
    });
  });

  describe("desktop header behavior", () => {
    it("shows static Missions title on desktop when no mission is selected", async () => {
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        const header = screen.getByTestId("mission-header-title");
        const desktopSpan = header.querySelector(".mission-manager__title-text--desktop");
        const mobileSpan = header.querySelector(".mission-manager__title-text--mobile");
        expect(desktopSpan?.textContent).toBe("Missions");
        expect(mobileSpan?.textContent).toBe("Missions");
      });
    });

    it("shows static Missions title on desktop when a mission is selected", async () => {
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitFor(() => {
        expect(screen.getByTestId("mission-tab-structure")).toBeDefined();
      });

      const header = screen.getByTestId("mission-header-title");
      const desktopSpan = header.querySelector(".mission-manager__title-text--desktop");
      const mobileSpan = header.querySelector(".mission-manager__title-text--mobile");
      expect(desktopSpan?.textContent).toBe("Missions");
      expect(mobileSpan?.textContent).toBe("Build Auth System");
    });

    it("renders the desktop Plan New Mission CTA in the sidebar footer action region", async () => {
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        const sidebar = screen.getByTestId("mission-sidebar");
        const sidebarFooter = within(sidebar).getByTestId("mission-sidebar-footer");
        const cta = within(sidebarFooter).getByRole("button", { name: "Plan New Mission" });

        expect(cta).toBeInTheDocument();
        expect(within(sidebar).queryByText("No missions yet")).toBeNull();
      });
    });
  });

  it("renders mission items in the list", async () => {
    globalThis.fetch = createFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
      expect(screen.getByText("API Redesign")).toBeDefined();
    });
  });

  it("shows mission status badges", async () => {
    globalThis.fetch = createFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("planning")).toBeDefined();
      expect(screen.getByText("active")).toBeDefined();
    });
  });

  it("shows summary stats when mission has summary data", async () => {
    globalThis.fetch = createFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      // M-002 has summary: { totalMilestones: 2, completedMilestones: 1, totalFeatures: 5, completedFeatures: 3 }
      expect(screen.getByText("1/2 milestones")).toBeDefined();
      expect(screen.getByText("3/5 features")).toBeDefined();
    });
  });

  it("hides summary section for missions without summary data", async () => {
    globalThis.fetch = createFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      // M-001 has no summary — no stats should appear for it
      expect(screen.queryByText("0/0 milestones")).toBeNull();
    });
    // M-002 has summary so these should exist
    expect(screen.getByText("1/2 milestones")).toBeDefined();
  });

  it("renders progress bar for missions with summary", async () => {
    globalThis.fetch = createFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      // Progress bar element should exist for M-002 (has summary with progressPercent: 60)
      const progressBar = document.querySelector(".mission-list__item-progress-bar") as HTMLElement;
      expect(progressBar).toBeDefined();
      expect(progressBar?.style.width).toBe("60%");
    });
  });

  it("renders healthy, warning, and error health badges based on mission health", async () => {
    const missions = [
      { id: "M-H1", title: "Healthy Mission", status: "planning", milestones: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "M-H2", title: "Warning Mission", status: "active", milestones: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "M-H3", title: "Error Mission", status: "active", milestones: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    ];

    globalThis.fetch = createFetchMockWithHealth(missions as Array<Record<string, unknown>>, {
      "M-H1": {
        missionId: "M-H1",
        status: "planning",
        tasksCompleted: 2,
        tasksFailed: 0,
        tasksInFlight: 0,
        totalTasks: 2,
        estimatedCompletionPercent: 100,
        autopilotState: "inactive",
        autopilotEnabled: false,
      },
      "M-H2": {
        missionId: "M-H2",
        status: "active",
        tasksCompleted: 1,
        tasksFailed: 1,
        tasksInFlight: 1,
        totalTasks: 4,
        estimatedCompletionPercent: 25,
        autopilotState: "watching",
        autopilotEnabled: true,
      },
      "M-H3": {
        missionId: "M-H3",
        status: "active",
        tasksCompleted: 3,
        tasksFailed: 4,
        tasksInFlight: 0,
        totalTasks: 10,
        estimatedCompletionPercent: 30,
        lastErrorAt: new Date().toISOString(),
        autopilotState: "activating",
        autopilotEnabled: true,
      },
    });

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("mission-health-badge-M-H1").className).toContain("mission-health-badge--healthy");
      expect(screen.getByTestId("mission-health-badge-M-H2").className).toContain("mission-health-badge--warning");
      expect(screen.getByTestId("mission-health-badge-M-H3").className).toContain("mission-health-badge--error");
    });
  });

  it("shows task progress stats and failed-task indicator", async () => {
    const missions = [
      {
        id: "M-TASKS",
        title: "Task Stats Mission",
        status: "active",
        summary: {
          totalMilestones: 2,
          completedMilestones: 1,
          totalFeatures: 5,
          completedFeatures: 2,
          progressPercent: 40,
        },
        milestones: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    globalThis.fetch = createFetchMockWithHealth(missions as Array<Record<string, unknown>>, {
      "M-TASKS": {
        missionId: "M-TASKS",
        status: "active",
        tasksCompleted: 3,
        tasksFailed: 1,
        tasksInFlight: 1,
        totalTasks: 5,
        estimatedCompletionPercent: 60,
        autopilotState: "watching",
        autopilotEnabled: true,
        lastActivityAt: new Date().toISOString(),
      },
    });

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("mission-task-stats-M-TASKS")).toHaveTextContent("3/5 tasks");
      expect(screen.getByTestId("mission-failed-M-TASKS")).toHaveTextContent("1 failed");
    });
  });

  it("formats mission relative activity time", async () => {
    const missions = [
      { id: "M-TIME", title: "Relative Time Mission", status: "active", milestones: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    ];

    globalThis.fetch = createFetchMockWithHealth(missions as Array<Record<string, unknown>>, {
      "M-TIME": {
        missionId: "M-TIME",
        status: "active",
        tasksCompleted: 0,
        tasksFailed: 0,
        tasksInFlight: 0,
        totalTasks: 1,
        estimatedCompletionPercent: 0,
        autopilotState: "inactive",
        autopilotEnabled: false,
        lastActivityAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      },
    });

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("mission-last-activity-M-TIME").textContent).toMatch(/Activity\s+\d+m ago|Activity just now/);
    });
  });

  it("renders mission activity tab with filter and metadata toggle", async () => {
    globalThis.fetch = createDetailFetchMock(mockMissionEvents);
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Build Auth System"));

    await waitFor(() => {
      expect(screen.getByTestId("mission-tab-activity")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("mission-tab-activity"));

    await waitFor(() => {
      expect(screen.getByTestId("mission-activity-events")).toBeDefined();
      expect(screen.getByText("Mission started")).toBeDefined();
      expect(screen.getByText("Task queue is delayed")).toBeDefined();
    });

    fireEvent.change(screen.getByTestId("mission-activity-filter"), {
      target: { value: "tasks" },
    });

    await waitFor(() => {
      expect(screen.getByText("Feature F-001 completed")).toBeDefined();
      expect(screen.queryByText("Mission started")).toBeNull();
    });

    fireEvent.change(screen.getByTestId("mission-activity-filter"), {
      target: { value: "errors" },
    });

    await waitFor(() => {
      expect(screen.getByText("Task queue is delayed")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("mission-event-metadata-E-002"));
    expect(screen.getByText(/"queueDepth": 4/)).toBeDefined();
    fireEvent.click(screen.getByTestId("mission-event-metadata-E-002"));
    expect(screen.queryByText(/"queueDepth": 4/)).toBeNull();
  });

  it("loads more mission activity events", async () => {
    globalThis.fetch = createDetailFetchMock(mockMissionEventsPaged as unknown as typeof mockMissionEvents);
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Build Auth System"));

    await waitFor(() => {
      expect(screen.getByTestId("mission-tab-activity")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("mission-tab-activity"));

    await waitFor(() => {
      expect(screen.getByText("Mission event 50")).toBeDefined();
      expect(
        screen.getByText("50 of 65", {
          selector: ".mission-detail__activity-count",
        }),
      ).toBeDefined();
      expect(screen.getByTestId("mission-activity-load-more")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("mission-activity-load-more"));

    await waitFor(() => {
      const activityCount = document.querySelector(".mission-detail__activity-count");
      expect(activityCount?.textContent?.trim()).toBe("65 of 65");
      expect(screen.queryByTestId("mission-activity-load-more")).toBeNull();
    }, { timeout: 5000 });
  }, 15000);

  it("auto-scrolls to latest mission activity on initial load", async () => {
    globalThis.fetch = createDetailFetchMock(mockMissionEvents);
    globalThis.EventSource = MockEventSource as unknown as typeof globalThis.EventSource;

    const scrollIntoViewSpy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewSpy,
    });

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Build Auth System"));

    await waitFor(() => {
      expect(screen.getByTestId("mission-tab-activity")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("mission-tab-activity"));

    await waitFor(() => {
      expect(screen.getByText("Mission started")).toBeDefined();
      expect(scrollIntoViewSpy).toHaveBeenCalled();
    });
  });

  it("prepends real-time mission events and scrolls to top when near bottom", async () => {
    globalThis.fetch = createDetailFetchMock(mockMissionEvents);
    globalThis.EventSource = MockEventSource as unknown as typeof globalThis.EventSource;

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Build Auth System"));

    await waitFor(() => {
      expect(screen.getByTestId("mission-tab-activity")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("mission-tab-activity"));

    const eventsContainer = await screen.findByTestId("mission-activity-events");
    Object.defineProperty(eventsContainer, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(eventsContainer, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(eventsContainer, "scrollTop", { configurable: true, value: 650, writable: true });

    await act(async () => {
      for (const source of MockEventSource.instances) {
        source.emit("mission:event", {
          id: "E-REALTIME",
          missionId: "M-001",
          eventType: "warning",
          description: "Real-time warning event",
          metadata: { source: "sse" },
          timestamp: "2026-01-03T11:00:00.000Z",
        });
      }
    });

    await waitFor(() => {
      expect(screen.getByText("Real-time warning event")).toBeDefined();
      expect(eventsContainer.scrollTop).toBe(0);
    });

    const eventDescriptions = Array.from(eventsContainer.querySelectorAll(".mission-event__description"));
    expect(eventDescriptions[0]?.textContent).toBe("Real-time warning event");
  });

  it("ignores real-time mission events for non-selected missions", async () => {
    globalThis.fetch = createDetailFetchMock(mockMissionEvents);
    globalThis.EventSource = MockEventSource as unknown as typeof globalThis.EventSource;

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Build Auth System"));

    await waitFor(() => {
      expect(screen.getByTestId("mission-tab-activity")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("mission-tab-activity"));
    await screen.findByTestId("mission-activity-events");

    await act(async () => {
      for (const source of MockEventSource.instances) {
        source.emit("mission:event", {
          id: "E-OTHER",
          missionId: "M-999",
          eventType: "warning",
          description: "Other mission warning",
          metadata: null,
          timestamp: "2026-01-03T11:00:00.000Z",
        });
      }
    });

    await waitFor(() => {
      expect(screen.queryByText("Other mission warning")).toBeNull();
    });
  });

  it("reloads selected mission detail when feature:updated SSE event arrives", async () => {
    const fetchMock = createDetailFetchMock(mockMissionEvents);
    globalThis.fetch = fetchMock;
    globalThis.EventSource = MockEventSource as unknown as typeof globalThis.EventSource;

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });

    // Click on the mission to open detail view
    fireEvent.click(screen.getByText("Build Auth System"));

    await waitForDetailLoaded();

    // Record initial fetch calls for mission detail
    const initialFetchCount = fetchMock.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("/api/missions/M-001")
    ).length;
    expect(initialFetchCount).toBeGreaterThan(0);

    // Emit a feature:updated SSE event
    await act(async () => {
      for (const source of MockEventSource.instances) {
        source.emit("feature:updated", {
          featureId: "F-001",
          missionId: "M-001",
          sliceId: "SL-001",
          previousStatus: "triaged",
          newStatus: "in-progress",
        });
      }
    });

    // Verify mission detail was reloaded (fetch was called again for the mission)
    await waitFor(() => {
      const updatedFetchCount = fetchMock.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("/api/missions/M-001")
      ).length;
      expect(updatedFetchCount).toBeGreaterThan(initialFetchCount);
    });
  });

  it("fetches milestone validation telemetry when mission detail opens", async () => {
    const fetchMock = createDetailFetchMock(mockMissionEvents);
    globalThis.fetch = fetchMock;

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Build Auth System"));

    await waitFor(() => {
      const telemetryCalls = fetchMock.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("/milestones/MS-001/validation-telemetry")
      ).length;
      expect(telemetryCalls).toBeGreaterThan(0);
    });
  });

  it("refreshes validation telemetry when validator-run SSE event targets selected milestone", async () => {
    const fetchMock = createDetailFetchMock(mockMissionEvents);
    globalThis.fetch = fetchMock;
    globalThis.EventSource = MockEventSource as unknown as typeof globalThis.EventSource;

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Build Auth System"));

    await waitForDetailLoaded();

    const initialTelemetryCalls = fetchMock.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("/milestones/MS-001/validation-telemetry")
    ).length;

    await act(async () => {
      for (const source of MockEventSource.instances) {
        source.emit("validator-run:started", {
          id: "VR-001",
          featureId: "F-001",
          milestoneId: "MS-001",
          status: "running",
        });
      }
    });

    await waitFor(() => {
      const updatedTelemetryCalls = fetchMock.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("/milestones/MS-001/validation-telemetry")
      ).length;
      expect(updatedTelemetryCalls).toBeGreaterThan(initialTelemetryCalls);
    });
  });

  it("reloads selected mission detail when mission:updated SSE event arrives", async () => {
    const fetchMock = createDetailFetchMock(mockMissionEvents);
    globalThis.fetch = fetchMock;
    globalThis.EventSource = MockEventSource as unknown as typeof globalThis.EventSource;

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });

    // Click on the mission to open detail view
    fireEvent.click(screen.getByText("Build Auth System"));

    await waitForDetailLoaded();

    // Record initial fetch calls for mission detail
    const initialFetchCount = fetchMock.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("/api/missions/M-001")
    ).length;
    expect(initialFetchCount).toBeGreaterThan(0);

    // Emit a mission:updated SSE event for the selected mission
    await act(async () => {
      for (const source of MockEventSource.instances) {
        source.emit("mission:updated", {
          id: "M-001",
          title: "Build Auth System",
          status: "active",
          autopilotEnabled: true,
          autopilotState: "watching",
          lastAutopilotActivityAt: new Date().toISOString(),
        });
      }
    });

    // Verify mission detail was reloaded (fetch was called again for the mission)
    await waitFor(() => {
      const updatedFetchCount = fetchMock.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("/api/missions/M-001")
      ).length;
      expect(updatedFetchCount).toBeGreaterThan(initialFetchCount);
    });
  });

  it("updates mission status badge when mission:updated SSE event arrives", async () => {
    globalThis.fetch = createFetchMock();
    globalThis.EventSource = MockEventSource as unknown as typeof globalThis.EventSource;

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    // Wait for initial render — M-001 has status "planning"
    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });

    // Verify initial status badge shows "planning"
    const missionItem = screen.getByText("Build Auth System").closest(".mission-list__item");
    expect(missionItem).toBeDefined();
    const planningBadges = missionItem!.querySelectorAll(".mission-status-badge");
    expect([...planningBadges].some((b) => b.textContent === "planning")).toBe(true);

    // Emit mission:updated SSE event changing M-001 to "active"
    await act(async () => {
      for (const source of MockEventSource.instances) {
        source.emit("mission:updated", {
          id: "M-001",
          title: "Build Auth System",
          status: "active",
        });
      }
    });

    // Verify the badge now shows "active" instead of "planning"
    await waitFor(() => {
      const updatedBadges = missionItem!.querySelectorAll(".mission-status-badge");
      expect([...updatedBadges].some((b) => b.textContent === "active")).toBe(true);
      expect([...updatedBadges].some((b) => b.textContent === "planning")).toBe(false);
    });
  });

  it("reloads selected mission detail when slice:updated SSE event arrives", async () => {
    const fetchMock = createDetailFetchMock(mockMissionEvents);
    globalThis.fetch = fetchMock;
    globalThis.EventSource = MockEventSource as unknown as typeof globalThis.EventSource;

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });

    // Click on the mission to open detail view
    fireEvent.click(screen.getByText("Build Auth System"));

    await waitForDetailLoaded();

    // Record initial fetch calls for mission detail
    const initialFetchCount = fetchMock.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("/api/missions/M-001")
    ).length;
    expect(initialFetchCount).toBeGreaterThan(0);

    // Emit a slice:updated SSE event for a slice in the selected mission
    await act(async () => {
      for (const source of MockEventSource.instances) {
        source.emit("slice:updated", {
          id: "SL-001",
          milestoneId: "MS-001",
          status: "active",
        });
      }
    });

    // Verify mission detail was reloaded (fetch was called again for the mission)
    await waitFor(() => {
      const updatedFetchCount = fetchMock.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("/api/missions/M-001")
      ).length;
      expect(updatedFetchCount).toBeGreaterThan(initialFetchCount);
    });
  });

  it("shows empty state with Plan New Mission CTA when no missions exist", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockApiResponse([]));
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("No missions yet")).toBeDefined();
      expect(screen.getAllByRole("button", { name: "Plan New Mission" }).length).toBeGreaterThan(0);
    });
  });

  it("calls onClose when close button is clicked", async () => {
    globalThis.fetch = createFetchMock();
    const onClose = vi.fn();
    render(<MissionManager isOpen={true} onClose={onClose} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("mission-close-btn")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("mission-close-btn"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when overlay background is clicked", async () => {
    globalThis.fetch = createFetchMock();
    const onClose = vi.fn();
    render(<MissionManager isOpen={true} onClose={onClose} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("mission-manager-overlay")).toBeDefined();
    });

    const overlay = screen.getByTestId("mission-manager-overlay");
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("navigates to detail view when a mission is clicked on desktop", async () => {
    globalThis.fetch = createDetailFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    // Wait for list to load
    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });

    // Click on a mission to open detail
    fireEvent.click(screen.getByText("Build Auth System"));

    // Wait for detail view to render
    await waitFor(() => {
      // Desktop keeps sidebar visible and back button stays mounted (CSS-hidden).
      expect(screen.getByTestId("mission-back-btn")).toBeInTheDocument();
      // Milestone should be visible (auto-expanded)
      expect(screen.getByText("Database Schema")).toBeDefined();
    });
  });

  it("keeps sidebar list visible on desktop after opening detail", async () => {
    globalThis.fetch = createDetailFetchMock();

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Build Auth System"));

    await waitFor(() => {
      expect(screen.getByTestId("mission-back-btn")).toBeInTheDocument();
      expect(screen.getByText("API Redesign")).toBeDefined();
    });
  });

  it("calls onClose on Escape key press", async () => {
    globalThis.fetch = createFetchMock();
    const onClose = vi.fn();
    render(<MissionManager isOpen={true} onClose={onClose} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("mission-manager-dialog")).toBeDefined();
    });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows close button with accessible label", async () => {
    globalThis.fetch = createFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Close Mission Manager")).toBeDefined();
    });
  });

  it("keeps back button mounted on desktop in detail view", async () => {
    globalThis.fetch = createDetailFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    // Navigate to detail
    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Build Auth System"));

    await waitFor(() => {
      expect(screen.getByLabelText("Back to missions list")).toBeInTheDocument();
    });
  });

  it("shows New Mission button in list view", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockApiResponse([]));
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Plan New Mission" })).toBeDefined();
    });
  });

  // ── Inline vs Modal Header Behavior ──────────────────────────────
  describe("inline vs modal header behavior", () => {
    it("renders with page-style header class when isInline is true", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockApiResponse([]));
      render(<MissionManager isOpen={true} isInline={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        const header = document.querySelector(".mission-manager__header--inline");
        expect(header).toBeDefined();
      });
    });

    it("does not show modal close button in inline mode", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockApiResponse([]));
      render(<MissionManager isOpen={true} isInline={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        // The modal close button should not be present in inline mode
        expect(screen.queryByTestId("mission-close-btn")).toBeNull();
      });
    });

    it("shows modal close button in modal mode (isInline=false)", async () => {
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} isInline={false} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByTestId("mission-close-btn")).toBeDefined();
      });
    });

    it("does not show refresh button in inline mode", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockApiResponse([]));
      render(<MissionManager isOpen={true} isInline={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.queryByTestId("mission-refresh-btn")).toBeNull();
      });
    });

    it("does not show refresh button in modal mode", async () => {
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} isInline={false} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.queryByTestId("mission-refresh-btn")).toBeNull();
      });
    });

    it("inline mode header has inline class modifier for styling parity with agents view", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockApiResponse([]));
      render(<MissionManager isOpen={true} isInline={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        const dialog = screen.getByTestId("mission-manager-dialog");
        expect(dialog.className).toContain("mission-manager--inline");
      });
    });

    it("does not render back button in inline desktop detail view", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/health")) {
          return Promise.resolve(mockApiResponse(getMockMissionHealth("M-001")));
        }
        callCount++;
        if (callCount <= 1) {
          return Promise.resolve(mockApiResponse(mockMissions));
        }
        return Promise.resolve(mockApiResponse(mockMissionDetail));
      });

      render(<MissionManager isOpen={true} isInline={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Inline mode auto-selects the first mission, so the detail view is
      // already populated; just wait for the detail content to render.
      await waitForDetailLoaded();
      expect(screen.getByTestId("mission-back-btn")).toBeInTheDocument();
      expect(getComputedStyle(screen.getByTestId("mission-back-btn")).display).toBe("none");
      // Close button should still be absent in inline mode even in detail view
      expect(screen.queryByTestId("mission-close-btn")).toBeNull();
    });
  });

  it("hides send to background button when mission interview is in initial state", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockApiResponse([]));

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Plan New Mission" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Plan New Mission" }));

    await waitFor(() => {
      expect(screen.getByText("Plan Mission with AI")).toBeInTheDocument();
    });

    expect(screen.queryByLabelText("Send to background")).not.toBeInTheDocument();
  });

  it("sends mission interview to background without canceling the session", async () => {
    const closeSpy = vi.fn();
    mockConnectMissionInterviewStream.mockReturnValueOnce({
      close: closeSpy,
      isConnected: () => true,
    });
    mockFetchAiSession.mockResolvedValueOnce({
      id: "session-bg-1",
      type: "mission_interview",
      status: "generating",
      title: "Background mission",
      inputPayload: JSON.stringify({ missionTitle: "Background mission" }),
      conversationHistory: "[]",
      currentQuestion: null,
      result: null,
      thinkingOutput: "",
      error: null,
      projectId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    globalThis.fetch = createFetchMock();

    render(
      <MissionManager
        isOpen={true}
        onClose={vi.fn()}
        addToast={vi.fn()}
        resumeSessionId="session-bg-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Plan Mission with AI")).toBeInTheDocument();
      expect(screen.getByText("Preparing next question...")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Send to background"));

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(mockCancelMissionInterview).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.queryByText("Plan Mission with AI")).not.toBeInTheDocument();
    });
  });

  it("keeps interview-pending rows visible while opened from a resume session", async () => {
    mockFetchAiSession.mockResolvedValueOnce({
      id: "session-bg-1",
      type: "mission_interview",
      status: "generating",
      title: "Mission interview",
      currentQuestion: null,
      result: null,
      thinkingOutput: "",
      error: null,
      projectId: "project-a",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    mockFetchAiSessions.mockResolvedValue([
      {
        id: "session-bg-1",
        type: "mission_interview",
        status: "awaiting_input",
        title: "Project A transient interview",
        projectId: "project-a",
        lockedByTab: null,
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
    ]);

    const missionsWithPersistedInterview = [
      {
        id: "M-PERSISTED-INTERVIEW",
        title: "Persisted mission interview",
        description: "Mission should stay discoverable while interview waits for input",
        status: "planning",
        interviewState: "in_progress",
        milestones: [],
        createdAt: "2026-01-05T00:00:00.000Z",
        updatedAt: "2026-01-05T00:00:00.000Z",
      },
      ...mockMissions,
    ];

    globalThis.fetch = createFetchMockWithHealth(missionsWithPersistedInterview as Array<Record<string, unknown>>, {
      ...mockMissionHealthById,
      "M-PERSISTED-INTERVIEW": {
        missionId: "M-PERSISTED-INTERVIEW",
        status: "planning",
        tasksCompleted: 0,
        tasksFailed: 0,
        tasksInFlight: 0,
        totalTasks: 0,
        estimatedCompletionPercent: 0,
        autopilotState: "inactive",
        autopilotEnabled: false,
      },
    });

    render(
      <MissionManager
        isOpen={true}
        onClose={vi.fn()}
        addToast={vi.fn()}
        projectId="project-a"
        resumeSessionId="session-bg-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Plan Mission with AI")).toBeInTheDocument();
      expect(screen.getByText("Project A transient interview")).toBeInTheDocument();
      expect(screen.getByText("Persisted mission interview")).toBeInTheDocument();
    });

    expect(screen.getByLabelText("Resume interview")).toBeInTheDocument();
  });

  it("re-shows project-scoped transient interview rows after banner resume is backgrounded on mobile", async () => {
    mockViewport("mobile");

    const missionsWithPersistedInterview = [
      {
        id: "M-PERSISTED-INTERVIEW",
        title: "Persisted mission interview",
        description: "Persisted mission row",
        status: "planning",
        interviewState: "in_progress",
        milestones: [],
        createdAt: "2026-01-06T00:00:00.000Z",
        updatedAt: "2026-01-06T00:00:00.000Z",
      },
      ...mockMissions,
    ];

    mockFetchAiSession.mockResolvedValueOnce({
      id: "session-bg-1",
      type: "mission_interview",
      status: "generating",
      title: "Project A transient interview",
      inputPayload: JSON.stringify({ missionTitle: "Project A transient interview" }),
      conversationHistory: "[]",
      currentQuestion: null,
      result: null,
      thinkingOutput: "",
      error: null,
      projectId: "project-a",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    mockFetchAiSessions.mockResolvedValue([
      {
        id: "session-bg-1",
        type: "mission_interview",
        status: "awaiting_input",
        title: "Project A transient interview",
        projectId: "project-a",
        lockedByTab: null,
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
      {
        id: "session-other-project",
        type: "mission_interview",
        status: "awaiting_input",
        title: "Project B transient interview",
        projectId: "project-b",
        lockedByTab: null,
        updatedAt: "2026-01-04T00:00:00.000Z",
      },
    ]);

    globalThis.fetch = createFetchMockWithHealth(missionsWithPersistedInterview as Array<Record<string, unknown>>, {
      ...mockMissionHealthById,
      "M-PERSISTED-INTERVIEW": {
        missionId: "M-PERSISTED-INTERVIEW",
        status: "planning",
        tasksCompleted: 0,
        tasksFailed: 0,
        tasksInFlight: 0,
        totalTasks: 0,
        estimatedCompletionPercent: 0,
        autopilotState: "inactive",
        autopilotEnabled: false,
      },
    });

    render(
      <MissionManager
        isOpen={true}
        onClose={vi.fn()}
        addToast={vi.fn()}
        projectId="project-a"
        resumeSessionId="session-bg-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Plan Mission with AI")).toBeInTheDocument();
      expect(screen.getByText("Preparing next question...")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Send to background"));

    await waitFor(() => {
      expect(screen.queryByText("Plan Mission with AI")).not.toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("Project A transient interview")).toBeInTheDocument();
      expect(screen.getByText("Persisted mission interview")).toBeInTheDocument();
    });

    expect(screen.queryByText("Project B transient interview")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Resume interview")).toBeInTheDocument();
    expect(mockFetchAiSessions).toHaveBeenCalledWith("project-a");
  });

  it("keeps persisted interview-stage missions visible with interview styling and mission selection behavior", async () => {
    const missionsWithInterview = [
      {
        id: "M-INTERVIEW",
        title: "Reliability planning draft",
        description: "Should remain visible while interview planning is in progress",
        status: "planning",
        interviewState: "in_progress",
        milestones: [],
        createdAt: "2026-01-06T00:00:00.000Z",
        updatedAt: "2026-01-06T00:00:00.000Z",
      },
      ...mockMissions,
    ];

    mockFetchAiSessions.mockResolvedValueOnce([]);

    globalThis.fetch = createFetchMockWithHealth(missionsWithInterview as Array<Record<string, unknown>>, {
      ...mockMissionHealthById,
      "M-INTERVIEW": {
        missionId: "M-INTERVIEW",
        status: "planning",
        tasksCompleted: 0,
        tasksFailed: 0,
        tasksInFlight: 0,
        totalTasks: 0,
        estimatedCompletionPercent: 0,
        autopilotState: "inactive",
        autopilotEnabled: false,
      },
    });

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    const interviewMissionTitle = await screen.findByText("Reliability planning draft");
    const interviewMissionRow = interviewMissionTitle.closest(".mission-list__item");
    expect(interviewMissionRow).toBeTruthy();
    expect(interviewMissionRow).toHaveClass("mission-list__item--interview");

    expect(within(interviewMissionRow as HTMLElement).getByText("Interview in progress")).toBeInTheDocument();
    expect(
      within(interviewMissionRow as HTMLElement).getByText(
        "Mission interview is still in progress. Open this mission to continue planning.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(interviewMissionTitle);

    await waitFor(() => {
      expect(screen.getByText("Database Schema")).toBeInTheDocument();
    });
  });

  it("shows in-progress interview sessions in the main mission list without footer resume duplication", async () => {
    mockFetchAiSessions.mockResolvedValueOnce([
      {
        id: "session-awaiting",
        type: "mission_interview",
        status: "awaiting_input",
        title: "Payment workflow planning",
        projectId: null,
        lockedByTab: null,
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
      {
        id: "session-generating",
        type: "mission_interview",
        status: "generating",
        title: "Analytics mission drafting",
        projectId: null,
        lockedByTab: null,
        updatedAt: "2026-01-04T00:00:00.000Z",
      },
      {
        id: "session-error",
        type: "mission_interview",
        status: "error",
        title: "SRE guardrails",
        projectId: null,
        lockedByTab: null,
        updatedAt: "2026-01-05T00:00:00.000Z",
      },
      {
        id: "session-complete",
        type: "mission_interview",
        status: "complete",
        title: "Should not render",
        projectId: null,
        lockedByTab: null,
        updatedAt: "2026-01-06T00:00:00.000Z",
      },
    ]);
    mockFetchAiSession.mockResolvedValue({
      id: "session-awaiting",
      type: "mission_interview",
      status: "awaiting_input",
      title: "Payment workflow planning",
      inputPayload: JSON.stringify({ missionGoal: "Payment workflow planning" }),
      conversationHistory: "[]",
      currentQuestion: JSON.stringify({
        question: "Which payment providers should be supported first?",
        kind: "text",
        key: "provider_scope",
      }),
      result: null,
      thinkingOutput: "",
      error: null,
      projectId: null,
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    globalThis.fetch = createFetchMock();

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeInTheDocument();
      expect(screen.getByText("Payment workflow planning")).toBeInTheDocument();
      expect(screen.getByText("Analytics mission drafting")).toBeInTheDocument();
      expect(screen.getByText("SRE guardrails")).toBeInTheDocument();
    });

    expect(screen.queryByText("Should not render")).not.toBeInTheDocument();
    expect(screen.queryByText(/interview sessions pending/i)).not.toBeInTheDocument();
  });

  it("keeps persisted interview missions distinct from transient interview sessions", async () => {
    const missionsWithInterview = [
      {
        id: "M-PERSISTED-INTERVIEW",
        title: "Persisted mission interview",
        description: "Persisted mission row",
        status: "planning",
        interviewState: "in_progress",
        milestones: [],
        createdAt: "2026-01-06T00:00:00.000Z",
        updatedAt: "2026-01-06T00:00:00.000Z",
      },
      ...mockMissions,
    ];

    mockFetchAiSessions.mockResolvedValueOnce([
      {
        id: "session-awaiting",
        type: "mission_interview",
        status: "awaiting_input",
        title: "Transient interview session",
        projectId: null,
        lockedByTab: null,
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
    ]);

    globalThis.fetch = createFetchMockWithHealth(missionsWithInterview as Array<Record<string, unknown>>, {
      ...mockMissionHealthById,
      "M-PERSISTED-INTERVIEW": {
        missionId: "M-PERSISTED-INTERVIEW",
        status: "planning",
        tasksCompleted: 0,
        tasksFailed: 0,
        tasksInFlight: 0,
        totalTasks: 0,
        estimatedCompletionPercent: 0,
        autopilotState: "inactive",
        autopilotEnabled: false,
      },
    });

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    const persistedTitle = await screen.findByText("Persisted mission interview");
    const transientTitle = await screen.findByText("Transient interview session");

    const persistedRow = persistedTitle.closest(".mission-list__item");
    const transientRow = transientTitle.closest(".mission-list__item");

    expect(persistedRow).toBeTruthy();
    expect(transientRow).toBeTruthy();
    expect(persistedRow).not.toBe(transientRow);

    expect(within(persistedRow as HTMLElement).getByText("Interview in progress")).toBeInTheDocument();
    expect(within(transientRow as HTMLElement).getByText("Awaiting input")).toBeInTheDocument();
    expect(screen.queryByText(/interview sessions pending/i)).not.toBeInTheDocument();

  });

  it("only shows in-progress interview sessions scoped to the active project", async () => {
    mockFetchAiSessions.mockResolvedValueOnce([
      {
        id: "session-project-a",
        type: "mission_interview",
        status: "awaiting_input",
        title: "Project A Interview",
        projectId: "project-a",
        lockedByTab: null,
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
      {
        id: "session-project-b",
        type: "mission_interview",
        status: "awaiting_input",
        title: "Project B Interview",
        projectId: "project-b",
        lockedByTab: null,
        updatedAt: "2026-01-04T00:00:00.000Z",
      },
      {
        id: "session-unscoped",
        type: "mission_interview",
        status: "awaiting_input",
        title: "Unscoped Interview",
        projectId: null,
        lockedByTab: null,
        updatedAt: "2026-01-05T00:00:00.000Z",
      },
    ]);
    globalThis.fetch = createFetchMock();

    render(
      <MissionManager
        isOpen={true}
        onClose={vi.fn()}
        addToast={vi.fn()}
        projectId="project-a"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Project A Interview")).toBeInTheDocument();
    });

    expect(screen.queryByText("Project B Interview")).not.toBeInTheDocument();
    expect(screen.queryByText("Unscoped Interview")).not.toBeInTheDocument();
    expect(mockFetchAiSessions).toHaveBeenCalledWith("project-a");
  });
  it("exposes retry action for errored interview sessions from the mission list", async () => {
    mockFetchAiSessions.mockResolvedValueOnce([
      {
        id: "session-error",
        type: "mission_interview",
        status: "error",
        title: "Mission in error",
        projectId: null,
        lockedByTab: null,
        updatedAt: "2026-01-05T00:00:00.000Z",
      },
    ]);
    mockFetchAiSession.mockResolvedValue({
      id: "session-error",
      type: "mission_interview",
      status: "error",
      title: "Mission in error",
      inputPayload: "{}",
      conversationHistory: "[]",
      currentQuestion: null,
      result: null,
      thinkingOutput: "",
      error: "Planning failed",
      projectId: null,
      createdAt: "2026-01-05T00:00:00.000Z",
      updatedAt: "2026-01-05T00:00:00.000Z",
    });
    globalThis.fetch = createFetchMock();

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Retry interview")).toBeInTheDocument();
      expect(screen.getByText("Needs retry")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Retry interview"));

    await waitFor(() => {
      expect(screen.getByText("Plan Mission with AI")).toBeInTheDocument();
    });
  });

  it("logs a warning when pending interview session fetch fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pendingFetchError = new Error("Pending sessions failed");
    mockFetchAiSessions.mockRejectedValueOnce(pendingFetchError);
    globalThis.fetch = createFetchMock();

    render(<MissionManager isOpen={true} isInline={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        "[MissionManager] Failed to fetch pending interview sessions:",
        pendingFetchError,
      );
    });

    expect(screen.getByTestId("mission-header-title")).toBeInTheDocument();
    warnSpy.mockRestore();
  });

  it("logs a warning when milestone/slice resume session fetch fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resumeFetchError = new Error("Resume session failed");
    const onResumeFetchError = vi.fn();
    mockFetchAiSession.mockRejectedValueOnce(resumeFetchError);
    globalThis.fetch = createFetchMock();

    render(
      <MissionManager
        isOpen={true}
        isInline={true}
        onClose={vi.fn()}
        addToast={vi.fn()}
        milestoneSliceResumeSessionId="sess-resume-1"
        onMilestoneSliceResumeFetchError={onResumeFetchError}
      />,
    );

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        "[MissionManager] Failed to fetch session for milestone/slice resume:",
        resumeFetchError,
      );
    });

    expect(onResumeFetchError).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("shows milestone hierarchy in detail view", async () => {
    globalThis.fetch = createDetailFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    // Navigate to detail
    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Build Auth System"));

    await waitFor(() => {
      // Milestone is auto-expanded, slice and feature visible
      expect(screen.getByText("Database Schema")).toBeDefined();
      expect(screen.getByText("User Tables")).toBeDefined();
      expect(screen.getByText("User model")).toBeDefined();
    });
  });

  // ── Regression: Generated mission ID format in edit/delete flows ──────────
  //
  // MissionStore generates IDs like M-LZ7DN0-A2B5 (base36 timestamp + random).
  // The MissionManager must successfully edit and delete missions with these IDs
  // without surfacing "invalid ID format" errors.
  describe("generated mission ID format regression", () => {
    // Use realistic generated-style IDs matching what MissionStore produces
    const generatedMissionId = "M-LZ7DN0-A2B5";
    const generatedMilestoneId = "MS-M3N8QR-C9F1";
    const generatedSliceId = "SL-P4T2WX-D5E8";
    const generatedFeatureId = "F-J6K9AB-G7H3";

    const generatedMockMissions = [
      {
        id: generatedMissionId,
        title: "Generated Mission",
        description: "Mission with realistic generated ID",
        status: "planning",
        milestones: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const generatedMockDetail = {
      id: generatedMissionId,
      title: "Generated Mission",
      description: "Mission with realistic generated ID",
      status: "planning",
      milestones: [
        {
          id: generatedMilestoneId,
          title: "Generated Milestone",
          description: "Milestone with generated ID",
          status: "planning",
          dependencies: [] as string[],
          slices: [
            {
              id: generatedSliceId,
              title: "Generated Slice",
              description: "Slice with generated ID",
              status: "pending",
              features: [
                {
                  id: generatedFeatureId,
                  title: "Generated Feature",
                  description: "Feature with generated ID",
                  acceptanceCriteria: "Works correctly",
                  status: "defined",
                  taskId: null,
                  sliceId: generatedSliceId,
                  missionId: generatedMissionId,
                },
              ],
              milestoneId: generatedMilestoneId,
              missionId: generatedMissionId,
            },
          ],
          missionId: generatedMissionId,
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    it("renders missions with generated IDs in the list", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockApiResponse(generatedMockMissions));
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Generated Mission")).toBeDefined();
      });
    });

    it("navigates to detail view for a mission with generated ID", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/health")) {
          return Promise.resolve(mockApiResponse(getMockMissionHealth(generatedMissionId)));
        }
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(mockApiResponse(generatedMockMissions));
        }
        return Promise.resolve(mockApiResponse(generatedMockDetail));
      });

      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Generated Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Generated Mission"));

      await waitFor(() => {
        expect(screen.getByText("Generated Milestone")).toBeDefined();
        expect(screen.getByText("Generated Slice")).toBeDefined();
        expect(screen.getByText("Generated Feature")).toBeDefined();
      });
    });

    it("edits a mission with generated ID without error", async () => {
      const addToast = vi.fn();
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation((_url: string) => {
        if (_url.includes("/health")) {
          return Promise.resolve(mockApiResponse(getMockMissionHealth(generatedMissionId)));
        }
        callCount++;
        if (callCount <= 1) {
          // Initial list load
          return Promise.resolve(mockApiResponse(generatedMockMissions));
        }
        if (_url && _url.includes("/api/missions/" + generatedMissionId) && !_url.includes("milestones")) {
          // Detail or PATCH for the generated ID mission
          if (_url.includes("/api/missions/" + generatedMissionId) && callCount > 2) {
            // PATCH response — return updated mission
            return Promise.resolve(mockApiResponse({
              ...generatedMockDetail,
              title: "Updated Generated Mission",
              status: "active",
            }));
          }
          return Promise.resolve(mockApiResponse(generatedMockDetail));
        }
        return Promise.resolve(mockApiResponse(generatedMockMissions));
      });

      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={addToast} />);

      // Wait for list, click to enter detail
      await waitFor(() => {
        expect(screen.getByText("Generated Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Generated Mission"));

      await waitFor(() => {
        expect(screen.getByText("Generated Milestone")).toBeDefined();
      });
    });

    it("deletes a mission with generated ID without surfacing invalid-ID error", async () => {
      const addToast = vi.fn();
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation((_url: string, options?: RequestInit) => {
        if (_url.includes("/health")) {
          return Promise.resolve(mockApiResponse(getMockMissionHealth(generatedMissionId)));
        }
        callCount++;
        // DELETE request — return 204 empty
        if (options?.method === "DELETE") {
          return Promise.resolve({
            ok: true,
            headers: new Headers(),
            text: () => Promise.resolve(""),
          });
        }
        // Initial list load and subsequent reloads
        return Promise.resolve(mockApiResponse(generatedMockMissions));
      });

      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Generated Mission")).toBeDefined();
      });

      // Click the delete button for the mission (uses title attribute)
      const deleteButton = screen.getByTitle("Delete mission");
      fireEvent.click(deleteButton);

      // After clicking delete, a confirmation dialog should appear
      await waitFor(() => {
        // Find and click the confirm delete button
        const confirmBtn = screen.getByText("Delete");
        fireEvent.click(confirmBtn);
      });

      // Verify no "invalid ID format" toast was shown
      await waitFor(() => {
        const errorToasts = addToast.mock.calls.filter(
          (call: any[]) => call[1] === "error" && typeof call[0] === "string" && call[0].toLowerCase().includes("invalid")
        );
        expect(errorToasts).toHaveLength(0);
      });
    });
  });

  // ── Step 2: Detail hierarchy, action layout, confirm panels ──────────
  describe("detail view hierarchy and action layout", () => {
    it("renders full milestone → slice → feature hierarchy in detail", async () => {
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitFor(() => {
        // Milestone auto-expanded
        expect(screen.getByText("Database Schema")).toBeDefined();
        // Slice auto-expanded
        expect(screen.getByText("User Tables")).toBeDefined();
        // Feature visible
        expect(screen.getByText("User model")).toBeDefined();
        // Feature status badge
        expect(screen.getByText("defined")).toBeDefined();
        // Acceptance criteria
        expect(screen.getByText(/Model exists with required fields/)).toBeDefined();
      });
    });

    it("shows edit and delete mission buttons in detail header", async () => {
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitForDetailLoaded();

      // Detail header should have edit/delete buttons
      const editBtns = screen.getAllByLabelText("Edit mission");
      const deleteBtns = screen.getAllByLabelText("Delete mission");
      // At least one of each in the detail header area
      expect(editBtns.length).toBeGreaterThanOrEqual(1);
      expect(deleteBtns.length).toBeGreaterThanOrEqual(1);
    });

    it("opens inline edit form when edit mission is clicked in detail view", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/health")) {
          const missionId = extractMissionId(url) ?? "M-001";
          return Promise.resolve(mockApiResponse(getMockMissionHealth(missionId)));
        }
        callCount++;
        if (callCount === 1) return Promise.resolve(mockApiResponse(mockMissions));
        return Promise.resolve(mockApiResponse(mockMissionDetail));
      });

      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitForDetailLoaded();

      // Click edit mission in detail header
      const editBtns = screen.getAllByLabelText("Edit mission");
      fireEvent.click(editBtns[0]);

      // Should show inline form with pre-filled title
      await waitFor(() => {
        const inputs = screen.getAllByDisplayValue("Build Auth System");
        expect(inputs.length).toBeGreaterThan(0);
        expect(screen.getAllByText("Update").length).toBeGreaterThan(0);
        expect(screen.getAllByText("Cancel").length).toBeGreaterThan(0);
      });
    });

    it("shows delete confirmation with danger variant class", async () => {
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitForDetailLoaded();

      // Click delete mission in detail header
      const deleteBtns = screen.getAllByLabelText("Delete mission");
      fireEvent.click(deleteBtns[0]);

      // Confirmation panel should show
      await waitFor(() => {
        const confirmPanel = screen.getByText(/Delete this mission/).closest(".mission-confirm-panel");
        expect(confirmPanel).toBeDefined();
        expect(confirmPanel!.className).toContain("mission-confirm-panel--danger");
      });
    });

    it("shows milestone count in detail header meta", async () => {
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitFor(() => {
        expect(screen.getByText("1 milestones")).toBeDefined();
      });
    });

    it("shows slice and feature counts in hierarchy headers", async () => {
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitFor(() => {
        expect(screen.getByText("1 slices")).toBeDefined();
        expect(screen.getByText("1 features")).toBeDefined();
      });
    });

    it("renders milestone expand/collapse chevrons", async () => {
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitFor(() => {
        // Milestone is auto-expanded — should see the title visible
        expect(screen.getByText("Database Schema")).toBeDefined();
        // Slice visible (auto-expanded)
        expect(screen.getByText("User Tables")).toBeDefined();
      });
    });

    it("shows add milestone button in detail view", async () => {
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitFor(() => {
        expect(screen.getByText("Add Milestone")).toBeDefined();
      });
    });
  });

  // ── Plan Buttons & Interview ──
  describe("plan buttons and interview modal", () => {
    const mockMissionWithPlanData = {
      id: "M-PLAN1",
      title: "Plan Test Mission",
      description: "Test mission for plan buttons",
      status: "active",
      autopilotEnabled: false,
      autopilotState: "inactive",
      milestones: [
        {
          id: "MS-PLAN1",
          title: "Test Milestone",
          description: "A milestone for testing",
          status: "active",
          interviewState: "not_started",
          dependencies: [] as string[],
          slices: [
            {
              id: "SL-PLAN1",
              title: "Test Slice",
              description: "A slice for testing",
              status: "pending",
              planState: "not_started",
              features: [
                {
                  id: "F-PLAN1",
                  title: "Test Feature",
                  description: "A feature for testing",
                  acceptanceCriteria: "Test criteria",
                  status: "defined",
                  taskId: null,
                  sliceId: "SL-PLAN1",
                  missionId: "M-PLAN1",
                },
              ],
              milestoneId: "MS-PLAN1",
              missionId: "M-PLAN1",
            },
            {
              id: "SL-PLAN2",
              title: "Completed Slice",
              description: "A completed slice",
              status: "complete",
              planState: "planned",
              features: [],
              milestoneId: "MS-PLAN1",
              missionId: "M-PLAN1",
            },
          ],
          missionId: "M-PLAN1",
        },
        {
          id: "MS-PLAN2",
          title: "Completed Milestone",
          description: "A completed milestone",
          status: "complete",
          interviewState: "completed",
          dependencies: [] as string[],
          slices: [],
          missionId: "M-PLAN1",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    function createPlanFetchMock() {
      return vi.fn((url: string) => {
        // Return mission list (array) for the missions endpoint
        if (url.match(/\/api\/missions$/) || url.match(/\/api\/missions\?/)) {
          return Promise.resolve(mockApiResponse([mockMissionWithPlanData]));
        }
        // Return mission detail for specific mission
        if (url.includes("/api/missions/")) {
          return Promise.resolve(mockApiResponse(mockMissionWithPlanData));
        }
        return Promise.resolve(mockApiResponse([]));
      }) as unknown as typeof fetch;
    }

    beforeEach(() => {
      mockFetchAiSession.mockReset();
      mockCancelMissionInterview.mockReset();
      mockConnectMissionInterviewStream.mockReset();
      mockPreviewEnrichedDescription.mockReset();
      mockSkipMilestoneInterview.mockReset();
      mockSkipSliceInterview.mockReset();
      mockTriageFeature.mockReset();

      mockFetchAiSession.mockResolvedValue(null);
      mockCancelMissionInterview.mockResolvedValue(undefined);
      mockConnectMissionInterviewStream.mockReturnValue({ close: vi.fn(), isConnected: vi.fn(() => false) });
      mockPreviewEnrichedDescription.mockReset();
      mockSkipMilestoneInterview.mockResolvedValue({});
      mockSkipSliceInterview.mockResolvedValue({});
      mockTriageFeature.mockResolvedValue({});
    });

    it("shows Plan button next to milestones that are not complete", async () => {
      globalThis.fetch = createPlanFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Plan Test Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Plan Test Mission"));

      await waitFor(() => {
        // Should show Plan button for the active milestone
        const planButton = screen.getByTitle("Plan milestone");
        expect(planButton).toBeDefined();
      });
    });

    it("does NOT show Plan button for completed milestones", async () => {
      globalThis.fetch = createPlanFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Plan Test Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Plan Test Mission"));

      await waitFor(() => {
        // Find the "Completed Milestone" section
        expect(screen.getByText("Completed Milestone")).toBeDefined();
      });

      // Should not have a Plan button for completed milestone
      const completedMilestone = screen.getByText("Completed Milestone").closest(".mission-milestone");
      expect(completedMilestone).toBeDefined();
    });

    it("shows Plan button next to slices that are not complete", async () => {
      globalThis.fetch = createPlanFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Plan Test Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Plan Test Mission"));

      await waitFor(() => {
        // Should show Plan button for the pending slice
        const planButton = screen.getByTitle("Plan slice");
        expect(planButton).toBeDefined();
      });
    });

    it("does NOT show Plan button for completed slices", async () => {
      globalThis.fetch = createPlanFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Plan Test Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Plan Test Mission"));

      await waitFor(() => {
        // Find the "Completed Slice" section
        expect(screen.getByText("Completed Slice")).toBeDefined();
      });

      // Should not have a Plan button for completed slice
      const completedSlice = screen.getByText("Completed Slice").closest(".mission-slice");
      expect(completedSlice).toBeDefined();
    });

    it("shows planning state indicator for milestones", async () => {
      globalThis.fetch = createPlanFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Plan Test Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Plan Test Mission"));

      await waitFor(() => {
        // Should show a plan state indicator
        const indicators = document.querySelectorAll(".mission-plan-state-indicator");
        expect(indicators.length).toBeGreaterThan(0);
      });
    });

    it("shows planning state indicator for slices", async () => {
      globalThis.fetch = createPlanFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Plan Test Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Plan Test Mission"));

      await waitFor(() => {
        // Should show plan state indicator for the slice
        const indicators = document.querySelectorAll(".mission-plan-state-indicator");
        expect(indicators.length).toBeGreaterThan(0);
      });
    });

    it("clicking Plan button opens the MilestoneSliceInterviewModal", async () => {
      globalThis.fetch = createPlanFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Plan Test Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Plan Test Mission"));

      await waitFor(() => {
        const planButton = screen.getByTitle("Plan milestone");
        expect(planButton).toBeDefined();
      });

      // Click Plan button
      fireEvent.click(screen.getByTitle("Plan milestone"));

      // Modal should open
      await waitFor(() => {
        expect(screen.getByTestId("milestone-slice-interview-modal")).toBeDefined();
      });
    });
  });

  // ── Triage Preview ──
  describe("triage preview", () => {
    const mockMissionWithFeature = {
      id: "M-TRIAGE1",
      title: "Triage Test Mission",
      description: "Test mission for triage preview",
      status: "active",
      autopilotEnabled: false,
      autopilotState: "inactive",
      milestones: [
        {
          id: "MS-TRIAGE1",
          title: "Test Milestone",
          description: "A milestone for testing",
          status: "active",
          interviewState: "not_started",
          dependencies: [] as string[],
          slices: [
            {
              id: "SL-TRIAGE1",
              title: "Test Slice",
              description: "A slice for testing",
              status: "pending",
              planState: "not_started",
              features: [
                {
                  id: "F-TRIAGE1",
                  title: "Test Feature",
                  description: "A feature for testing triage preview",
                  acceptanceCriteria: "Test criteria",
                  status: "defined",
                  taskId: null,
                  sliceId: "SL-TRIAGE1",
                  missionId: "M-TRIAGE1",
                },
              ],
              milestoneId: "MS-TRIAGE1",
              missionId: "M-TRIAGE1",
            },
          ],
          missionId: "M-TRIAGE1",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    function createTriageFetchMock() {
      return vi.fn((url: string) => {
        // Return mission list (array) for the missions endpoint
        if (url.match(/\/api\/missions$/) || url.match(/\/api\/missions\?/)) {
          return Promise.resolve(mockApiResponse([mockMissionWithFeature]));
        }
        // Return mission detail for specific mission
        if (url.includes("/api/missions/")) {
          return Promise.resolve(mockApiResponse(mockMissionWithFeature));
        }
        return Promise.resolve(mockApiResponse([]));
      }) as unknown as typeof fetch;
    }

    beforeEach(() => {
      mockFetchAiSession.mockReset();
      mockCancelMissionInterview.mockReset();
      mockConnectMissionInterviewStream.mockReset();
      mockPreviewEnrichedDescription.mockReset();
      mockSkipMilestoneInterview.mockReset();
      mockSkipSliceInterview.mockReset();
      mockTriageFeature.mockReset();

      mockFetchAiSession.mockResolvedValue(null);
      mockCancelMissionInterview.mockResolvedValue(undefined);
      mockConnectMissionInterviewStream.mockReturnValue({ close: vi.fn(), isConnected: vi.fn(() => false) });
      mockPreviewEnrichedDescription.mockResolvedValue({ description: "Enriched description with more details" });
      mockSkipMilestoneInterview.mockResolvedValue({});
      mockSkipSliceInterview.mockResolvedValue({});
      mockTriageFeature.mockResolvedValue({});
    });

    it("shows triage preview when clicking triage button", async () => {
      globalThis.fetch = createTriageFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Triage Test Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Triage Test Mission"));

      await waitFor(() => {
        expect(screen.getByText("Test Feature")).toBeDefined();
      });

      // Click triage button
      fireEvent.click(screen.getByTitle("Triage — create task"));

      // Preview should appear
      await waitFor(() => {
        expect(screen.getByText("Enriched Description Preview")).toBeDefined();
        expect(screen.getByText("Enriched description with more details")).toBeDefined();
      });
    });

    it("Create Task button in preview confirms triage", async () => {
      globalThis.fetch = createTriageFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Triage Test Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Triage Test Mission"));

      await waitFor(() => {
        expect(screen.getByText("Test Feature")).toBeDefined();
      });

      // Click triage button to show preview
      fireEvent.click(screen.getByTitle("Triage — create task"));

      await waitFor(() => {
        expect(screen.getByText("Enriched Description Preview")).toBeDefined();
      });

      // Click Create Task
      fireEvent.click(screen.getByText("Create Task"));

      // triageFeature should have been called
      await waitFor(() => {
        expect(mockTriageFeature).toHaveBeenCalled();
      });
    });

    it("Cancel button in preview dismisses without creating task", async () => {
      globalThis.fetch = createTriageFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Triage Test Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Triage Test Mission"));

      await waitFor(() => {
        expect(screen.getByText("Test Feature")).toBeDefined();
      });

      // Click triage button to show preview
      fireEvent.click(screen.getByTitle("Triage — create task"));

      await waitFor(() => {
        expect(screen.getByText("Enriched Description Preview")).toBeDefined();
      });

      // Click Cancel
      fireEvent.click(screen.getByText("Cancel"));

      // Preview should be gone
      await waitFor(() => {
        expect(screen.queryByText("Enriched Description Preview")).toBeNull();
      });

      // triageFeature should NOT have been called
      expect(mockTriageFeature).not.toHaveBeenCalled();
    });

    it("falls back to direct triage when preview endpoint fails", async () => {
      // Mock preview to reject
      mockPreviewEnrichedDescription.mockRejectedValue(new Error("Preview not available"));

      globalThis.fetch = createTriageFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Triage Test Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Triage Test Mission"));

      await waitFor(() => {
        expect(screen.getByText("Test Feature")).toBeDefined();
      });

      // Click triage button - should fall back to direct triage
      fireEvent.click(screen.getByTitle("Triage — create task"));

      // Should call triageFeature directly
      await waitFor(() => {
        expect(mockTriageFeature).toHaveBeenCalled();
      });
    });
  });

  // ── Autopilot UI ──
  describe("autopilot UI", () => {
    const autopilotMockMissions = [
      {
        id: "M-AUTO1",
        title: "Autopilot Mission",
        description: "Mission with autopilot enabled",
        status: "active",
        autopilotEnabled: true,
        autopilotState: "watching",
        lastAutopilotActivityAt: "2026-01-01T00:00:00.000Z",
        milestones: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "M-AUTO2",
        title: "Normal Mission",
        description: "Mission without autopilot",
        status: "planning",
        autopilotEnabled: false,
        milestones: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const autopilotMockDetail = {
      id: "M-AUTO1",
      title: "Autopilot Mission",
      description: "Mission with autopilot enabled",
      status: "active",
      autopilotEnabled: true,
      autopilotState: "watching",
      lastAutopilotActivityAt: "2026-01-01T00:00:00.000Z",
      milestones: [
        {
          id: "MS-001",
          title: "Phase 1",
          description: "First phase",
          status: "active",
          dependencies: [] as string[],
          slices: [],
          missionId: "M-AUTO1",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    function createAutopilotFetchMock() {
      return vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (url.includes("/health")) {
          const missionId = extractMissionId(url) ?? "M-AUTO1";
          return Promise.resolve(mockApiResponse(getMockMissionHealth(missionId)));
        }

        if (url.includes("/autopilot")) {
          if (options?.method === "PATCH") {
            return Promise.resolve(mockApiResponse({
              enabled: true,
              state: "watching",
              watched: true,
              lastActivityAt: "2026-01-01T12:00:00.000Z",
              nextScheduledCheck: "2026-01-01T12:05:00.000Z",
            }));
          }

          return Promise.resolve(mockApiResponse({
            enabled: true,
            state: "watching",
            watched: true,
            lastActivityAt: "2026-01-01T12:00:00.000Z",
            nextScheduledCheck: "2026-01-01T12:05:00.000Z",
          }));
        }

        if (url.includes("/api/missions/M-AUTO1") && !url.includes("/milestones") && !url.includes("/status")) {
          return Promise.resolve(mockApiResponse(autopilotMockDetail));
        }

        return Promise.resolve(mockApiResponse(autopilotMockMissions));
      });
    }

    it("shows autopilot icon for missions with autopilotEnabled in list view", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockApiResponse(autopilotMockMissions));
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Autopilot Mission")).toBeDefined();
        // Autopilot icon should have title attribute
        expect(screen.getByTitle("Autopilot enabled")).toBeDefined();
      });
    });

    it("does not show autopilot icon for missions without autopilot", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockApiResponse(autopilotMockMissions));
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Normal Mission")).toBeDefined();
      });

      // There should be only one autopilot icon (for Autopilot Mission)
      const autopilotIcons = screen.queryAllByTitle("Autopilot enabled");
      expect(autopilotIcons).toHaveLength(1);
    });

    it("shows autopilot toggle and status badge in detail view", async () => {
      globalThis.fetch = createAutopilotFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Autopilot Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Autopilot Mission"));

      await waitFor(() => {
        // Should show Autopilot label
        expect(screen.getByText("Autopilot")).toBeDefined();
        // Should show status badge with "watching" state
        expect(screen.getByTestId("autopilot-state-badge")).toBeDefined();
      });
    });

    it("shows autopilot toggle and status badge", async () => {
      globalThis.fetch = createAutopilotFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Autopilot Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Autopilot Mission"));

      await waitFor(() => {
        // Should show autopilot toggle and state badge
        expect(screen.getByLabelText("Autopilot")).toBeDefined();
        expect(screen.getByTestId("autopilot-state-badge")).toBeDefined();
        expect(screen.getByText(/Watching since/)).toBeDefined();
      });

      // Verify no action buttons exist (they were removed)
      expect(screen.queryByTestId("mission-autopilot-start")).toBeNull();
      expect(screen.queryByTestId("mission-autopilot-stop")).toBeNull();
      expect(screen.queryByTestId("mission-autopilot-refresh")).toBeNull();
    });

    it("toggles autopilot with a PATCH request", async () => {
      const fetchMock = createAutopilotFetchMock();
      globalThis.fetch = fetchMock;
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Autopilot Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Autopilot Mission"));

      const toggle = await screen.findByLabelText("Autopilot");
      fireEvent.click(toggle);

      await waitFor(() => {
        const patchCall = fetchMock.mock.calls.find((call) => {
          const [url, options] = call as [string, RequestInit | undefined];
          return url.includes("/api/missions/M-AUTO1/autopilot") && options?.method === "PATCH";
        });
        expect(patchCall).toBeDefined();
        expect((patchCall?.[1] as RequestInit | undefined)?.body).toContain('"enabled":false');
      });
    });

    it("shows pulse indicator in the autopilot state badge for active states", async () => {
      globalThis.fetch = createAutopilotFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Autopilot Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Autopilot Mission"));

      await waitFor(() => {
        const badge = screen.getByTestId("autopilot-state-badge");
        expect(badge.querySelector(".mission-detail__autopilot-pulse")).not.toBeNull();
      });
    });

    it("shows pulsing dot when autopilot is watching in detail view", async () => {
      globalThis.fetch = createAutopilotFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Autopilot Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Autopilot Mission"));

      await waitFor(() => {
        const dot = document.querySelector(".mission-detail__autopilot-dot");
        expect(dot).toBeDefined();
      });
    });
  });

  // ── Step 2: Factory parity — contract/telemetry/fix-feature coverage ────────
  //
  // Validates FN-1569 schema parity from API telemetry payloads through UI rendering.
  // Extends test fixtures with validationContract, validationTelemetry, and fixFeatures
  // mirroring the exact schema fields used by MissionManager.tsx telemetry section.
  describe("Factory parity — contract/telemetry/fix-feature coverage", () => {
    it("renders validation telemetry section in detail view after API response", async () => {
      globalThis.fetch = createDetailFetchMockWithTelemetry(mockMissionEvents, mockMilestoneValidationTelemetryWithRounds);
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitForDetailLoaded();

      // After async telemetry loads, validation telemetry section should appear
      await waitFor(() => {
        expect(screen.getByText("Validation Telemetry")).toBeDefined();
      }, { timeout: 3000 });

      // Total runs shown in header meta
      await waitFor(() => {
        expect(screen.getByText(/2 rounds/)).toBeDefined();
      }, { timeout: 3000 });

      // Last validator status shown in header meta
      await waitFor(() => {
        expect(screen.getByText(/Last failed/)).toBeDefined();
      }, { timeout: 3000 });
    });

    it("shows blocked reason surface when validation round is blocked", async () => {
      globalThis.fetch = createDetailFetchMockWithTelemetry(mockMissionEvents, mockBlockedMilestoneTelemetry);
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      // Wait for telemetry to load
      await waitFor(() => {
        expect(screen.getByText("Validation Telemetry")).toBeDefined();
      }, { timeout: 3000 });

      // Last validator status shows blocked
      await waitFor(() => {
        expect(screen.getByText(/Last blocked/)).toBeDefined();
      }, { timeout: 3000 });

      // Blocked reason surface should appear (.mission-blocked-reason class)
      await waitFor(() => {
        expect(document.querySelector(".mission-blocked-reason")).not.toBeNull();
      }, { timeout: 3000 });

      // Blocked reason text should be visible (use getAllByText since it may appear in both milestone-blocked-reason and round-blocked-reason)
      await waitFor(() => {
        const matches = screen.getAllByText(/External API unavailable/);
        expect(matches.length).toBeGreaterThan(0);
      }, { timeout: 3000 });
    });

    it("does not show blocked-reason surface for failed (non-blocked) rounds", async () => {
      // Regression: failed rounds should NOT show blocked-reason surface
      globalThis.fetch = createDetailFetchMockWithTelemetry(mockMissionEvents, mockMilestoneValidationTelemetryWithRounds);
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      // Wait for telemetry to load
      await waitFor(() => {
        expect(screen.getByText("Validation Telemetry")).toBeDefined();
      }, { timeout: 3000 });

      // Blocked reason text from the blocked telemetry should NOT appear
      // (the mockMissionDetail has a milestone without blocked telemetry)
      expect(screen.queryByText(/External API unavailable/)).toBeNull();
    });

    it("displays fix-features with source linkage in telemetry section", async () => {
      globalThis.fetch = createDetailFetchMockWithTelemetry(mockMissionEvents, mockMilestoneValidationTelemetryWithRounds);
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      // Wait for telemetry to load
      await waitFor(() => {
        expect(screen.getByText(/Validation Telemetry/)).toBeDefined();
      }, { timeout: 3000 });

      // Fix features should appear with their source linkage
      await waitFor(() => {
        expect(screen.getByText("Fix: token refresh")).toBeDefined();
      }, { timeout: 3000 });

      // Source feature ID should be visible (clickable link to source feature)
      await waitFor(() => {
        expect(screen.getByText("F-001")).toBeDefined();
      }, { timeout: 3000 });
    });

    it("blocked mission exposes resume affordance with aria-label", async () => {
      // Test that a mission with blocked status shows the Resume button
      const blockedMission = {
        ...mockMissionDetail,
        status: "blocked" as const,
      };

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/missions/health")) {
          return Promise.resolve(mockApiResponse(mockMissionHealthById));
        }
        if (url.includes("/events")) {
          return Promise.resolve(mockApiResponse(parseMissionEventsResponse(url)));
        }
        if (url.includes("/health")) {
          const missionId = extractMissionId(url) ?? "M-001";
          return Promise.resolve(mockApiResponse(getMockMissionHealth(missionId)));
        }
        if (url.includes("/autopilot")) {
          return Promise.resolve(mockApiResponse(mockAutopilotStatus));
        }
        const validationResponse = getValidationApiMock(url);
        if (validationResponse !== null) {
          return Promise.resolve(mockApiResponse(validationResponse));
        }
        if (url.includes("/api/missions/") && !url.includes("/milestones") && !url.includes("/status")) {
          return Promise.resolve(mockApiResponse(blockedMission));
        }
        return Promise.resolve(mockApiResponse(mockMissions));
      });

      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitForDetailLoaded();

      // Resume button with aria-label="Resume mission" should appear for blocked mission
      await waitFor(() => {
        const resumeButton = screen.getByLabelText("Resume mission");
        expect(resumeButton).toBeDefined();
      }, { timeout: 3000 });
    });

    it("activity tab metadata toggle still works after telemetry changes", async () => {
      // Regression: mission events metadata toggle (mission-event-metadata-*) must remain functional
      // Uses same pattern as existing passing test (lines ~912-923)
      globalThis.fetch = createDetailFetchMockWithTelemetry(mockMissionEvents, mockMilestoneValidationTelemetryWithRounds);
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitFor(() => {
        expect(screen.getByTestId("mission-tab-activity")).toBeDefined();
      });

      fireEvent.click(screen.getByTestId("mission-tab-activity"));

      await waitFor(() => {
        expect(screen.getByTestId("mission-activity-events")).toBeDefined();
        expect(screen.getByText("Mission started")).toBeDefined();
      });

      // Toggle metadata for event E-002 which has metadata { queueDepth: 4 }
      fireEvent.click(screen.getByTestId("mission-event-metadata-E-002"));
      expect(screen.getByText(/"queueDepth": 4/)).toBeDefined();
    });
  });

  describe("desktop split layout", () => {
    it("renders split container with sidebar and detail pane", async () => {
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);
      await waitFor(() => expect(screen.getByText("Build Auth System")).toBeDefined());
      expect(document.querySelector(".mission-manager__split")).toBeTruthy();
      expect(document.querySelector(".mission-manager__sidebar")).toBeTruthy();
      expect(document.querySelector(".mission-manager__detail-pane")).toBeTruthy();
      expect(document.querySelector(".mission-manager__body--stacked")).toBeNull();
    });

    it("shows empty placeholder when no mission selected", async () => {
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);
      await waitFor(() => expect(screen.getByText("Select a mission to view details")).toBeDefined());
      expect(document.querySelector(".mission-manager__detail-pane-empty")).toBeTruthy();
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });

    it("sidebar remains visible after selecting a mission", async () => {
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);
      await waitFor(() => expect(screen.getByText("Build Auth System")).toBeDefined());
      const sidebar = document.querySelector(".mission-manager__sidebar") as HTMLElement;
      fireEvent.click(within(sidebar).getByText("Build Auth System"));
      await waitFor(() => expect(document.querySelector(".mission-manager__detail-pane .mission-detail")).toBeTruthy());
      expect(document.querySelector(".mission-manager__sidebar .mission-list__item")).toBeTruthy();
      expect(screen.getByTestId("mission-tab-structure")).toBeDefined();
      expect(screen.getByTestId("mission-tab-activity")).toBeDefined();
      expect(document.querySelector(".mission-manager__detail-pane-empty")).toBeNull();
    });

    it("clicking different mission updates detail pane", async () => {
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);
      await waitFor(() => expect(screen.getByText("Build Auth System")).toBeDefined());
      const sidebar = document.querySelector(".mission-manager__sidebar") as HTMLElement;
      fireEvent.click(within(sidebar).getByText("Build Auth System"));
      await waitFor(() => expect(screen.getByTestId("mission-tab-structure")).toBeDefined());
      fireEvent.click(within(sidebar).getByText("API Redesign"));
      await waitFor(() => expect(screen.getByText("API Redesign")).toBeDefined());
      expect(document.querySelectorAll(".mission-manager__sidebar .mission-list__item").length).toBeGreaterThan(1);
    });

    it("keeps desktop back button mounted but CSS-hidden", async () => {
      mockViewport("desktop");
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);
      await waitFor(() => expect(screen.getByText("Build Auth System")).toBeDefined());
      const sidebar = document.querySelector(".mission-manager__sidebar") as HTMLElement;
      fireEvent.click(within(sidebar).getByText("Build Auth System"));
      await waitForDetailLoaded();
      expect(screen.getByTestId("mission-back-btn")).toBeInTheDocument();
      expect(getComputedStyle(screen.getByTestId("mission-back-btn")).display).toBe("none");
    });

    it("delete confirmation renders inside detail pane", async () => {
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);
      await waitFor(() => expect(screen.getByText("Build Auth System")).toBeDefined());
      const sidebar = document.querySelector(".mission-manager__sidebar") as HTMLElement;
      fireEvent.click(within(sidebar).getByText("Build Auth System"));
      await waitFor(() => expect(screen.getByLabelText("Delete mission")).toBeDefined());
      fireEvent.click(screen.getByLabelText("Delete mission"));
      await waitFor(() => expect(document.querySelector(".mission-manager__detail-pane .mission-confirm-panel")).toBeTruthy());
    });

    it("renders sidebar header with Plan New Mission CTA button", async () => {
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);
      await waitFor(() => expect(document.querySelector(".mission-manager__sidebar-cta")).toBeInTheDocument());
      expect(screen.getByLabelText("Plan New Mission")).toBeInTheDocument();
    });
  });

  describe("detail pane", () => {
    it("shows empty placeholder when no mission is selected", async () => {
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => expect(screen.getByText("Select a mission to view details")).toBeInTheDocument());
      expect(document.querySelector(".mission-manager__detail-pane-empty")).toBeTruthy();
      expect(document.querySelector(".mission-manager__detail-pane .mission-detail")).toBeNull();
      const placeholder = document.querySelector(".mission-manager__detail-pane-empty") as HTMLElement;
      expect(within(placeholder).getByTestId("target-icon")).toBeInTheDocument();
    });

    it("shows loading spinner when detail is loading", async () => {
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => expect(screen.getByText("Build Auth System")).toBeInTheDocument());
      const sidebar = document.querySelector(".mission-manager__sidebar") as HTMLElement;
      fireEvent.click(within(sidebar).getByText("Build Auth System"));

      expect(screen.getByText("Loading mission details...")).toBeInTheDocument();
      expect(document.querySelector(".mission-manager__detail-pane .spinner")).toBeTruthy();
    });

    it("renders mission detail when a mission is selected", async () => {
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => expect(screen.getByText("Build Auth System")).toBeInTheDocument());
      fireEvent.click(within(document.querySelector(".mission-manager__sidebar") as HTMLElement).getByText("Build Auth System"));

      const detailPane = document.querySelector(".mission-manager__detail-pane") as HTMLElement;
      await waitFor(() => expect(within(detailPane).getByTestId("mission-tab-structure")).toBeInTheDocument());
      expect(detailPane.querySelector(".mission-detail")).toBeTruthy();
      expect(within(detailPane).getByText("Build Auth System")).toBeInTheDocument();
      expect(detailPane.querySelector(".mission-status-badge")).toBeTruthy();
      expect(within(detailPane).getByTestId("mission-tab-activity")).toBeInTheDocument();
    });

    it("updates detail pane when a different mission is selected", async () => {
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/missions/health")) {
          return Promise.resolve(mockApiResponse(mockMissionHealthById));
        }
        if (url.includes("/events")) {
          return Promise.resolve(mockApiResponse(parseMissionEventsResponse(url)));
        }
        if (url.includes("/health")) {
          const missionId = extractMissionId(url) ?? "M-001";
          return Promise.resolve(mockApiResponse(getMockMissionHealth(missionId)));
        }
        if (url.includes("/autopilot")) {
          return Promise.resolve(mockApiResponse(mockAutopilotStatus));
        }
        const validationResponse = getValidationApiMock(url);
        if (validationResponse !== null) {
          return Promise.resolve(mockApiResponse(validationResponse));
        }
        if (url.includes("/api/missions/M-001") && !url.includes("/milestones") && !url.includes("/status")) {
          return Promise.resolve(mockApiResponse(mockMissionDetail));
        }
        if (url.includes("/api/missions/M-002") && !url.includes("/milestones") && !url.includes("/status")) {
          return Promise.resolve(mockApiResponse({ ...mockMissionDetail, id: "M-002", title: "API Redesign" }));
        }
        return Promise.resolve(mockApiResponse(mockMissions));
      });

      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);
      await waitFor(() => expect(screen.getByText("Build Auth System")).toBeInTheDocument());

      const sidebar = document.querySelector(".mission-manager__sidebar") as HTMLElement;
      fireEvent.click(within(sidebar).getByText("Build Auth System"));
      await waitFor(() => expect(document.querySelector(".mission-detail__title")?.textContent).toBe("Build Auth System"));

      fireEvent.click(within(sidebar).getByText("API Redesign"));
      await waitFor(() => expect(document.querySelector(".mission-detail__title")?.textContent).toBe("API Redesign"));
      expect(document.querySelector(".mission-manager__detail-pane-empty")).toBeNull();
    });

    it("renders delete confirmation inside detail pane", async () => {
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => expect(screen.getByText("Build Auth System")).toBeInTheDocument());
      fireEvent.click(within(document.querySelector(".mission-manager__sidebar") as HTMLElement).getByText("Build Auth System"));
      await waitFor(() => expect(screen.getByLabelText("Delete mission")).toBeInTheDocument());
      fireEvent.click(screen.getByLabelText("Delete mission"));

      await waitFor(() => expect(document.querySelector(".mission-manager__detail-pane .mission-confirm-panel")).toBeTruthy());
    });

    it("renders link-task panel inside detail pane", async () => {
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/missions/health")) {
          return Promise.resolve(mockApiResponse(mockMissionHealthById));
        }
        if (url.includes("/events")) {
          return Promise.resolve(mockApiResponse(parseMissionEventsResponse(url)));
        }
        if (url.includes("/health")) {
          const missionId = extractMissionId(url) ?? "M-001";
          return Promise.resolve(mockApiResponse(getMockMissionHealth(missionId)));
        }
        if (url.includes("/autopilot")) {
          return Promise.resolve(mockApiResponse(mockAutopilotStatus));
        }
        const validationResponse = getValidationApiMock(url);
        if (validationResponse !== null) {
          return Promise.resolve(mockApiResponse(validationResponse));
        }
        if (url.includes("/api/missions/") && !url.includes("/milestones") && !url.includes("/status")) {
          return Promise.resolve(
            mockApiResponse({
              ...mockMissionDetail,
              milestones: [
                {
                  ...mockMissionDetail.milestones[0],
                  slices: [
                    {
                      ...mockMissionDetail.milestones[0].slices[0],
                      features: [
                        {
                          ...mockMissionDetail.milestones[0].slices[0].features[0],
                          status: "triaged",
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
          );
        }
        return Promise.resolve(mockApiResponse(mockMissions));
      });

      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => expect(screen.getByText("Build Auth System")).toBeInTheDocument());
      fireEvent.click(screen.getByText("Build Auth System"));
      await waitFor(() => expect(screen.getByText("Database Schema")).toBeInTheDocument());
      await waitFor(() => expect(screen.getByText("User Tables")).toBeInTheDocument());
      await waitFor(() => expect(screen.getByTitle("Link to task")).toBeInTheDocument());
      fireEvent.click(screen.getByTitle("Link to task"));

      await waitFor(() => expect(document.querySelector(".mission-manager__detail-pane .mission-confirm-panel")).toBeTruthy());
      expect(screen.getByText("Link feature to task:")).toBeInTheDocument();
    });

    it("detail pane shows milestones and features hierarchy", async () => {
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => expect(screen.getByText("Build Auth System")).toBeInTheDocument());
      fireEvent.click(screen.getByText("Build Auth System"));
      await waitFor(() => expect(screen.getByText("Database Schema")).toBeInTheDocument());
      await waitFor(() => expect(screen.getByText("User Tables")).toBeInTheDocument());
      await waitFor(() => expect(screen.getByText("User model")).toBeInTheDocument());
    });
  });

  describe("sidebar selected highlighting", () => {
    it("applies selected class to clicked mission and not others", async () => {
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => expect(screen.getByText("Build Auth System")).toBeInTheDocument());
      const sidebar = document.querySelector(".mission-manager__sidebar") as HTMLElement;
      fireEvent.click(within(sidebar).getByText("Build Auth System"));

      await waitFor(() => {
        const items = Array.from(document.querySelectorAll(".mission-manager__sidebar .mission-list__item"));
        const selected = items.filter((item) => item.classList.contains("mission-list__item--selected"));
        expect(selected).toHaveLength(1);
        expect(selected[0]?.textContent).toContain("Build Auth System");
      });
    });

    it("moves selected class when a different mission is clicked", async () => {
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/missions/health")) {
          return Promise.resolve(mockApiResponse(mockMissionHealthById));
        }
        if (url.includes("/events")) {
          return Promise.resolve(mockApiResponse(parseMissionEventsResponse(url)));
        }
        if (url.includes("/health")) {
          const missionId = extractMissionId(url) ?? "M-001";
          return Promise.resolve(mockApiResponse(getMockMissionHealth(missionId)));
        }
        if (url.includes("/autopilot")) {
          return Promise.resolve(mockApiResponse(mockAutopilotStatus));
        }
        const validationResponse = getValidationApiMock(url);
        if (validationResponse !== null) {
          return Promise.resolve(mockApiResponse(validationResponse));
        }
        if (url.includes("/api/missions/M-001") && !url.includes("/milestones") && !url.includes("/status")) {
          return Promise.resolve(mockApiResponse(mockMissionDetail));
        }
        if (url.includes("/api/missions/M-002") && !url.includes("/milestones") && !url.includes("/status")) {
          return Promise.resolve(mockApiResponse({ ...mockMissionDetail, id: "M-002", title: "API Redesign" }));
        }
        return Promise.resolve(mockApiResponse(mockMissions));
      });
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => expect(screen.getByText("Build Auth System")).toBeInTheDocument());
      fireEvent.click(within(document.querySelector(".mission-manager__sidebar") as HTMLElement).getByText("Build Auth System"));
      await waitFor(() => expect(screen.getByTestId("mission-tab-structure")).toBeInTheDocument());
      fireEvent.click(within(document.querySelector(".mission-manager__sidebar") as HTMLElement).getByText("API Redesign"));

      await waitFor(() => {
        const items = Array.from(document.querySelectorAll(".mission-manager__sidebar .mission-list__item"));
        const selected = items.filter((item) => item.classList.contains("mission-list__item--selected"));
        expect(selected).toHaveLength(1);
        expect(selected[0]?.querySelector(".mission-list__item-title")?.textContent).toBe("API Redesign");
      });
    });
  });

  describe("desktop back button behavior", () => {
    it("back button element exists when mission is selected and root uses desktop shell class", async () => {
      mockViewport("desktop");
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => expect(screen.getByText("Build Auth System")).toBeInTheDocument());
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitFor(() => {
        expect(screen.getByTestId("mission-back-btn")).toBeInTheDocument();
      });

      expect(screen.getByTestId("mission-manager-dialog")).toHaveClass("mission-manager--desktop");
    });

    it("clicking back button clears selected mission", async () => {
      mockViewport("desktop");
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => expect(screen.getByText("Build Auth System")).toBeInTheDocument());
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitFor(() => expect(document.querySelector(".mission-manager__detail-pane .mission-detail")).toBeTruthy());
      fireEvent.click(screen.getByTestId("mission-back-btn"));

      await waitFor(() => {
        expect(document.querySelector(".mission-manager__detail-pane .mission-detail")).toBeNull();
        expect(screen.getByText("API Redesign")).toBeInTheDocument();
      });
    });

    it("back button does not render when no mission is selected", async () => {
      mockViewport("desktop");
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => expect(screen.getByText("Build Auth System")).toBeInTheDocument());
      expect(screen.queryByTestId("mission-back-btn")).toBeNull();
    });
  });

  describe("mobile stacked layout", () => {
    it("shows a single top-of-list Plan New Mission CTA above mission cards", async () => {
      mockViewport("mobile");
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => expect(screen.getByText("Build Auth System")).toBeInTheDocument());

      const missionList = document.querySelector(".mission-list") as HTMLElement;
      const topAction = missionList.querySelector(".mission-list__top-action") as HTMLElement;
      expect(topAction).toBeInTheDocument();

      const missionItems = missionList.querySelectorAll(".mission-list__item");
      expect(missionItems.length).toBeGreaterThan(0);
      const firstItem = missionItems[0] as HTMLElement;
      expect(topAction.compareDocumentPosition(firstItem) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      const topCtas = missionList.querySelectorAll(".mission-list__primary-cta");
      expect(topCtas).toHaveLength(1);
      expect(topCtas[0]).toHaveTextContent("Plan New Mission");
      expect(document.querySelector(".mission-list__footer-actions")).toBeNull();
    });

    it("renders stacked body on mobile and hides desktop split", async () => {
      mockViewport("mobile");
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => expect(document.querySelector(".mission-manager__body--stacked")).toBeTruthy());
      expect(document.querySelector(".mission-manager__split")).toBeNull();
    });

    it("shows back button in detail view and returns to list", async () => {
      mockViewport("mobile");
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => expect(screen.getByText("Build Auth System")).toBeInTheDocument());
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitFor(() => {
        expect(screen.getByTestId("mission-back-btn")).toBeInTheDocument();
        expect(screen.queryByText("API Redesign")).not.toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId("mission-back-btn"));
      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeInTheDocument();
        expect(screen.queryByTestId("mission-back-btn")).not.toBeInTheDocument();
      });
    });
  });

  describe("sidebar always visible on desktop", () => {
    it("keeps all mission list items rendered after selecting a mission", async () => {
      mockViewport("desktop");
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeInTheDocument();
        expect(screen.getByText("API Redesign")).toBeInTheDocument();
      });

      const sidebar = document.querySelector(".mission-manager__sidebar") as HTMLElement;
      fireEvent.click(within(sidebar).getByText("Build Auth System"));

      await waitFor(() => expect(document.querySelector(".mission-manager__detail-pane .mission-detail")).toBeTruthy());
      expect(within(sidebar).getByText("Build Auth System")).toBeInTheDocument();
      expect(within(sidebar).getByText("API Redesign")).toBeInTheDocument();
      const sidebarList = document.querySelector(".mission-manager__sidebar-list") as HTMLElement;
      expect(getComputedStyle(sidebarList).overflowY).toBe("auto");
    });
  });

  describe("two-panel layout test IDs", () => {
    it("renders sidebar and empty detail pane on desktop via test IDs", async () => {
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByTestId("mission-sidebar")).toBeInTheDocument();
        expect(screen.getByTestId("mission-empty-detail")).toBeInTheDocument();
      });
    });

    it("shows mission detail in right pane when mission is selected from sidebar", async () => {
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeInTheDocument();
      });

      const sidebar = screen.getByTestId("mission-sidebar");
      fireEvent.click(within(sidebar).getByText("Build Auth System"));

      await waitForDetailLoaded();
      expect(screen.getByTestId("mission-sidebar")).toBeInTheDocument();
      expect(within(sidebar).getByText("API Redesign")).toBeInTheDocument();
      expect(screen.getByTestId("mission-tab-structure")).toBeInTheDocument();
    });

    it("applies desktop class to shell on desktop viewport", async () => {
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        const dialog = screen.getByTestId("mission-manager-dialog");
        expect(dialog.className).toContain("mission-manager--desktop");
      });
    });

    it("works in inline mode with split layout", async () => {
      globalThis.fetch = createFetchMock();
      render(<MissionManager isOpen={true} isInline={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        const dialog = screen.getByTestId("mission-manager-dialog");
        expect(dialog.className).toContain("mission-manager--inline");
        expect(dialog.className).toContain("mission-manager--desktop");
        expect(screen.getByTestId("mission-sidebar")).toBeInTheDocument();
      });
    });
  });
});
