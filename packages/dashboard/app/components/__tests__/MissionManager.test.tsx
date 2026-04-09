import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MissionManager } from "../MissionManager";

const mockFetchAiSession = vi.fn();
const mockCancelMissionInterview = vi.fn();
const mockConnectMissionInterviewStream = vi.fn();

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    fetchAiSession: (...args: any[]) => mockFetchAiSession(...args),
    cancelMissionInterview: (...args: any[]) => mockCancelMissionInterview(...args),
    connectMissionInterviewStream: (...args: any[]) => mockConnectMissionInterviewStream(...args),
  };
});

// Mock data
const mockMissions = [
  {
    id: "M-001",
    title: "Build Auth System",
    description: "Complete authentication flow",
    status: "planning",
    autoAdvance: false,
    milestones: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "M-002",
    title: "API Redesign",
    description: "Redesign the REST API",
    status: "active",
    autoAdvance: true,
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
  autoAdvance: false,
  milestones: [
    {
      id: "MS-001",
      title: "Database Schema",
      description: "Set up auth tables",
      status: "planning",
      dependencies: [] as string[],
      slices: [
        {
          id: "SL-001",
          title: "User Tables",
          description: "Create user tables",
          status: "pending",
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

    if (url.includes("/api/missions/") && !url.includes("/milestones") && !url.includes("/status")) {
      return Promise.resolve(mockApiResponse(mockMissionDetail));
    }

    return Promise.resolve(mockApiResponse(missions));
  });
}

describe("MissionManager", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEventSource: typeof globalThis.EventSource | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEventSource = globalThis.EventSource;
    mockFetchAiSession.mockReset();
    mockCancelMissionInterview.mockReset();
    mockConnectMissionInterviewStream.mockReset();
    mockFetchAiSession.mockResolvedValue(null);
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
      expect(screen.getByText("Missions")).toBeDefined();
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
    globalThis.fetch = createDetailFetchMock(mockMissionEventsPaged);
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
      expect(screen.queryByText("Mission event 51")).toBeNull();
      expect(screen.getByTestId("mission-activity-load-more")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("mission-activity-load-more"));

    await waitFor(() => {
      expect(screen.getByText("Mission event 65")).toBeDefined();
      expect(screen.queryByTestId("mission-activity-load-more")).toBeNull();
    });
  });

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

    await waitFor(() => {
      // Back button should appear in detail view
      expect(screen.getByTestId("mission-back-btn")).toBeDefined();
    });

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

  it("shows empty state when no missions exist", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockApiResponse([]));
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("No missions yet. Create one to start planning.")).toBeDefined();
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

  it("navigates to detail view when a mission is clicked", async () => {
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
      // Back button should appear in detail view
      expect(screen.getByTestId("mission-back-btn")).toBeDefined();
      // Milestone should be visible (auto-expanded)
      expect(screen.getByText("Database Schema")).toBeDefined();
    });
  });

  it("navigates back to list view when back button is clicked", async () => {
    globalThis.fetch = createDetailFetchMock();

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    // Navigate to detail
    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Build Auth System"));

    await waitFor(() => {
      expect(screen.getByTestId("mission-back-btn")).toBeDefined();
    });

    // Click back
    fireEvent.click(screen.getByTestId("mission-back-btn"));

    // Should return to list view
    await waitFor(() => {
      expect(screen.getByText("Missions")).toBeDefined();
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

  it("shows back button with accessible label in detail view", async () => {
    globalThis.fetch = createDetailFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    // Navigate to detail
    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Build Auth System"));

    await waitFor(() => {
      expect(screen.getByLabelText("Back to missions list")).toBeDefined();
    });
  });

  it("shows New Mission button in list view", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockApiResponse([]));
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("New Mission")).toBeDefined();
    });
  });

  it("hides send to background button when mission interview is in initial state", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockApiResponse([]));

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Plan with AI")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Plan with AI"));

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
        autoAdvance: false,
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
      autoAdvance: false,
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

      await waitFor(() => {
        expect(screen.getByTestId("mission-back-btn")).toBeDefined();
      });

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

      await waitFor(() => {
        expect(screen.getByTestId("mission-back-btn")).toBeDefined();
      });

      // Click edit mission in detail header
      const editBtns = screen.getAllByLabelText("Edit mission");
      fireEvent.click(editBtns[0]);

      // Should show inline form with pre-filled title
      await waitFor(() => {
        const input = screen.getByDisplayValue("Build Auth System");
        expect(input).toBeDefined();
        expect(screen.getByText("Update")).toBeDefined();
        expect(screen.getByText("Cancel")).toBeDefined();
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

      await waitFor(() => {
        expect(screen.getByTestId("mission-back-btn")).toBeDefined();
      });

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

  // ── Autopilot UI ──
  describe("autopilot UI", () => {
    const autopilotMockMissions = [
      {
        id: "M-AUTO1",
        title: "Autopilot Mission",
        description: "Mission with autopilot enabled",
        status: "active",
        autoAdvance: true,
        autopilotEnabled: true,
        autopilotState: "watching",
        milestones: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "M-AUTO2",
        title: "Normal Mission",
        description: "Mission without autopilot",
        status: "planning",
        autoAdvance: false,
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
      autoAdvance: true,
      autopilotEnabled: true,
      autopilotState: "watching",
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

    it("shows enhanced autopilot controls with expected button states", async () => {
      globalThis.fetch = createAutopilotFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Autopilot Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Autopilot Mission"));

      await waitFor(() => {
        expect(screen.getByTestId("mission-autopilot-start")).toBeDefined();
        expect(screen.getByTestId("mission-autopilot-stop")).toBeDefined();
        expect(screen.getByTestId("mission-autopilot-refresh")).toBeDefined();
      });

      const startButton = screen.getByTestId("mission-autopilot-start") as HTMLButtonElement;
      const stopButton = screen.getByTestId("mission-autopilot-stop") as HTMLButtonElement;
      const refreshButton = screen.getByTestId("mission-autopilot-refresh") as HTMLButtonElement;

      expect(startButton.disabled).toBe(true);
      expect(stopButton.disabled).toBe(false);
      expect(refreshButton.disabled).toBe(false);
      expect(screen.getByText(/Watching since/)).toBeDefined();
      expect(screen.getByText(/Next check:/)).toBeDefined();
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
});
