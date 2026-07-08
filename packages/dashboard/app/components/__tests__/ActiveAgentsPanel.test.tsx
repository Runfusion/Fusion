import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import i18next from "i18next";
import { ActiveAgentsPanel } from "../ActiveAgentsPanel";
import type { Agent } from "../../api";
import { useLiveTranscript } from "../../hooks/useLiveTranscript";
import { ToastProvider } from "../../hooks/useToast";
import esApp from "../../../../i18n/locales/es/app.json";
import frApp from "../../../../i18n/locales/fr/app.json";
import koApp from "../../../../i18n/locales/ko/app.json";
import zhCNApp from "../../../../i18n/locales/zh-CN/app.json";
import zhTWApp from "../../../../i18n/locales/zh-TW/app.json";

// Mock useLiveTranscript
vi.mock("../../hooks/useLiveTranscript", () => ({
  useLiveTranscript: vi.fn().mockReturnValue({
    entries: [],
    isConnected: false,
  }),
}));

// Mock the runtime-fallback endpoint consumed (indirectly, via
// useRuntimeFallbackStatus) by RuntimeFallbackBadge for the FUX-039
// viewport-gating regression suite below.
const legacyMocks = vi.hoisted(() => ({
  fetchTaskRuntimeFallback: vi.fn(),
}));
vi.mock("../../api/legacy", () => legacyMocks);

// Default resolution for every test in this file (regardless of describe
// block): RuntimeFallbackBadge is now rendered for any agent with a taskId
// and, once viewport-gated visible, polls this endpoint. Individual tests in
// the FUX-039 describe block below override this via mockResolvedValue.
legacyMocks.fetchTaskRuntimeFallback.mockResolvedValue({
  taskId: "",
  hasEvent: false,
  wasConfigured: null,
  runtimeHint: null,
  reason: null,
  eventId: null,
  timestamp: null,
  showFallbackBadge: false,
});

const mockUseLiveTranscript = vi.mocked(useLiveTranscript);

// FUX-039: RuntimeFallbackBadge (rendered unconditionally for any agent with
// a taskId) calls useToast() unconditionally, which throws outside a
// ToastProvider. Route every ActiveAgentsPanel render through this helper so
// that requirement is satisfied consistently across the suite.
function renderPanel(ui: Parameters<typeof render>[0]) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

// Minimal IntersectionObserver mock that records every constructed instance
// so tests can drive `isIntersecting` transitions manually. Real jsdom has no
// IntersectionObserver implementation.
class MockIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin: string = "";
  readonly thresholds: ReadonlyArray<number> = [];
  callback: IntersectionObserverCallback;
  observedElements = new Set<Element>();
  static instances: MockIntersectionObserver[] = [];

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observedElements.add(el);
  }
  unobserve(el: Element) {
    this.observedElements.delete(el);
  }
  disconnect() {
    this.observedElements.clear();
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  /** Test helper: fire a visibility transition for a specific observed element. */
  fire(el: Element, isIntersecting: boolean) {
    this.callback(
      [{ target: el, isIntersecting } as IntersectionObserverEntry],
      this,
    );
  }
}

const nonEnglishAppCatalogs = [
  ["es", esApp],
  ["fr", frApp],
  ["ko", koApp],
  ["zh-CN", zhCNApp],
  ["zh-TW", zhTWApp],
] as const;

describe("ActiveAgentsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseLiveTranscript.mockReturnValue({
      entries: [],
      isConnected: false,
    });
  });

  afterEach(async () => {
    await i18next.changeLanguage("en");
    for (const [locale] of nonEnglishAppCatalogs) {
      if (i18next.hasResourceBundle(locale, "app")) {
        i18next.removeResourceBundle(locale, "app");
      }
    }
    i18next.options.returnEmptyString = true;
  });

  it("renders live transcript text from entries", async () => {
    mockUseLiveTranscript.mockReturnValue({
      entries: [
        { type: "text", text: "Processing request...", timestamp: "2026-01-01T00:01:00Z" },
        { type: "text", text: "Analyzing code...", timestamp: "2026-01-01T00:02:00Z" },
      ],
      isConnected: true,
    });

    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    renderPanel(<ActiveAgentsPanel agents={[mockAgent]} />);

    expect(screen.getByText("Processing request...")).toBeInTheDocument();
    expect(screen.getByText("Analyzing code...")).toBeInTheDocument();
  });

  it("passes projectId from props to useLiveTranscript hook", async () => {
    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    renderPanel(<ActiveAgentsPanel agents={[mockAgent]} projectId="my-project" />);

    // Verify the hook was called with the projectId
    expect(mockUseLiveTranscript).toHaveBeenCalledWith("FN-001", "my-project");
  });

  it("passes undefined projectId when not provided", async () => {
    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    renderPanel(<ActiveAgentsPanel agents={[mockAgent]} />);

    // Verify the hook was called without projectId
    expect(mockUseLiveTranscript).toHaveBeenCalledWith("FN-001", undefined);
  });

  it("renders next-heartbeat labels without raw placeholders across non-English locales", async () => {
    i18next.options.returnEmptyString = false;

    for (const [locale, appCatalog] of nonEnglishAppCatalogs) {
      i18next.addResourceBundle(locale, "app", appCatalog, true, true);
      await i18next.changeLanguage(locale);

      const futureAgent: Agent = {
        id: `agent-future-${locale}`,
        name: `Future Agent ${locale}`,
        role: "executor",
        state: "running",
        taskId: `FN-${locale}`,
        lastHeartbeatAt: new Date().toISOString(),
      } as Agent;

      const futureRender = renderPanel(<ActiveAgentsPanel agents={[futureAgent]} />);
      const futureBadge = futureRender.container.querySelector(".live-agent-card-next-heartbeat");
      expect(futureBadge, `${locale} next-heartbeat badge`).toBeInTheDocument();
      expect(futureBadge?.textContent?.trim(), `${locale} next-heartbeat text`).not.toBe("");
      expect(futureBadge?.textContent, `${locale} next-heartbeat raw placeholder`).not.toContain("{{");
      futureRender.unmount();

      const overdueAgent: Agent = {
        id: `agent-overdue-${locale}`,
        name: `Overdue Agent ${locale}`,
        role: "executor",
        state: "running",
        taskId: `FN-overdue-${locale}`,
        lastHeartbeatAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      } as Agent;

      const overdueRender = renderPanel(<ActiveAgentsPanel agents={[overdueAgent]} />);
      const overdueBadge = overdueRender.container.querySelector(".live-agent-card-next-heartbeat");
      expect(overdueBadge, `${locale} heartbeat-overdue badge`).toBeInTheDocument();
      expect(overdueBadge?.textContent?.trim(), `${locale} heartbeat-overdue text`).not.toBe("");
      expect(overdueBadge?.textContent, `${locale} heartbeat-overdue raw placeholder`).not.toContain("{{");
      overdueRender.unmount();

      i18next.removeResourceBundle(locale, "app");
    }
  });

  it("renders empty state when no entries yet", async () => {
    mockUseLiveTranscript.mockReturnValue({
      entries: [],
      isConnected: false,
    });

    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    renderPanel(<ActiveAgentsPanel agents={[mockAgent]} />);

    expect(screen.getByText("Connecting...")).toBeInTheDocument();
  });

  it("renders 'Waiting for output...' when connected but no entries", async () => {
    mockUseLiveTranscript.mockReturnValue({
      entries: [],
      isConnected: true,
    });

    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    renderPanel(<ActiveAgentsPanel agents={[mockAgent]} />);

    expect(screen.getByText("Waiting for output...")).toBeInTheDocument();
  });

  it("shows idle copy (not 'Connecting...') when an active agent has no taskId", async () => {
    mockUseLiveTranscript.mockReturnValue({
      entries: [],
      isConnected: false,
    });

    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "active",
      // taskId intentionally omitted — agent is available but not running
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    renderPanel(<ActiveAgentsPanel agents={[mockAgent]} />);

    expect(screen.getByText("Idle — no task assigned")).toBeInTheDocument();
    expect(screen.queryByText("Connecting...")).toBeNull();
  });

  it("shows 'Starting...' for running agents that haven't picked up a task yet", async () => {
    mockUseLiveTranscript.mockReturnValue({
      entries: [],
      isConnected: false,
    });

    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "running",
      // taskId intentionally omitted — race between state flip and task bind
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    renderPanel(<ActiveAgentsPanel agents={[mockAgent]} />);

    expect(screen.getByText("Starting...")).toBeInTheDocument();
    expect(screen.queryByText("Connecting...")).toBeNull();
  });

  it("renders multiple agent cards with separate transcript streams", async () => {
    // Keyed by taskId (not call order) so this stays correct regardless of
    // how many render passes each card takes (e.g. the FUX-039 viewport-
    // gating effect's own settle-render).
    mockUseLiveTranscript.mockImplementation((taskId?: string) => {
      if (taskId === "FN-001") {
        return {
          entries: [{ type: "text", text: "Agent 1 output", timestamp: "2026-01-01T00:01:00Z" }],
          isConnected: true,
        };
      }
      if (taskId === "FN-002") {
        return {
          entries: [{ type: "text", text: "Agent 2 output", timestamp: "2026-01-01T00:02:00Z" }],
          isConnected: true,
        };
      }
      return { entries: [], isConnected: false };
    });

    const mockAgent1: Agent = {
      id: "agent-001",
      name: "Agent One",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    const mockAgent2: Agent = {
      id: "agent-002",
      name: "Agent Two",
      role: "reviewer",
      state: "running",
      taskId: "FN-002",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    renderPanel(<ActiveAgentsPanel agents={[mockAgent1, mockAgent2]} />);

    expect(screen.getByText("Agent 1 output")).toBeInTheDocument();
    expect(screen.getByText("Agent 2 output")).toBeInTheDocument();
  });

  it("renders up to 20 transcript lines per card", async () => {
    // The component receives entries and slices to first 20
    // In real usage, the hook prepends new entries, so most recent first
    // For the mock, we simulate this by providing entries in reverse order
    const manyEntries = Array.from({ length: 25 }, (_, i) => ({
      type: "text" as const,
      text: `Line ${24 - i}`, // Reversed: 24, 23, 22, ..., 1, 0
      timestamp: new Date().toISOString(),
    }));

    mockUseLiveTranscript.mockReturnValue({
      entries: manyEntries,
      isConnected: true,
    });

    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    renderPanel(<ActiveAgentsPanel agents={[mockAgent]} />);

    // Should show the first 20 entries (most recent first)
    // With reversed entries, slice(0, 20) gives us Line 24 through Line 5
    expect(screen.getByText("Line 24")).toBeInTheDocument();
    expect(screen.queryByText("Line 4")).not.toBeInTheDocument(); // Line 4 is beyond index 20
  });

  it("returns null when agents array is empty", async () => {
    const { container } = renderPanel(<ActiveAgentsPanel agents={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("displays agent task badges with column context and unresolved fallback", async () => {
    mockUseLiveTranscript.mockReturnValue({
      entries: [],
      isConnected: false,
    });

    const agents: Agent[] = [
      {
        id: "agent-001",
        name: "Triage Agent",
        role: "executor",
        state: "running",
        taskId: "FN-TRIAGE",
        taskColumn: "triage",
        lastHeartbeatAt: new Date().toISOString(),
      } as Agent,
      {
        id: "agent-002",
        name: "Progress Agent",
        role: "executor",
        state: "running",
        taskId: "FN-PROGRESS",
        taskColumn: "in-progress",
        lastHeartbeatAt: new Date().toISOString(),
      } as Agent,
      {
        id: "agent-003",
        name: "Bare Agent",
        role: "executor",
        state: "running",
        taskId: "FN-BARE",
        taskColumn: "unresolved",
        lastHeartbeatAt: new Date().toISOString(),
      } as Agent,
      {
        id: "agent-004",
        name: "No Task Agent",
        role: "executor",
        state: "active",
        lastHeartbeatAt: new Date().toISOString(),
      } as Agent,
    ];

    const { container } = renderPanel(<ActiveAgentsPanel agents={agents} />);

    expect(screen.getByText("Triage Agent")).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.textContent === "FN-TRIAGE · Planning")).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.textContent === "FN-PROGRESS · In Progress")).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.textContent === "FN-BARE · Unresolved task")).toBeInTheDocument();
    expect(container.querySelectorAll(".live-agent-task")).toHaveLength(3);
  });

  it("calls onAgentSelect with agent ID when card is clicked", async () => {
    mockUseLiveTranscript.mockReturnValue({
      entries: [],
      isConnected: false,
    });

    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    const handleSelect = vi.fn();
    renderPanel(<ActiveAgentsPanel agents={[mockAgent]} onAgentSelect={handleSelect} />);

    fireEvent.click(screen.getByRole("button", { name: /select agent test agent/i }));

    expect(handleSelect).toHaveBeenCalledWith("agent-001");
  });

  it("shows active indicator when connected", async () => {
    mockUseLiveTranscript.mockReturnValue({
      entries: [{ type: "text", text: "Test", timestamp: "2026-01-01T00:00:00Z" }],
      isConnected: true,
    });

    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    const { container } = renderPanel(<ActiveAgentsPanel agents={[mockAgent]} />);

    // The streaming dot should be present when connected
    const streamingDot = container.querySelector(".live-agent-streaming-dot");
    expect(streamingDot).toBeInTheDocument();
  });

  it("passes projectId through to hook for each agent card", async () => {
    mockUseLiveTranscript.mockReturnValue({
      entries: [],
      isConnected: false,
    });

    const mockAgent1: Agent = {
      id: "agent-001",
      name: "Agent One",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    const mockAgent2: Agent = {
      id: "agent-002",
      name: "Agent Two",
      role: "executor",
      state: "running",
      taskId: "FN-002",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    renderPanel(<ActiveAgentsPanel agents={[mockAgent1, mockAgent2]} projectId="shared-project" />);

    // Both agents should receive the same projectId
    expect(mockUseLiveTranscript).toHaveBeenCalledWith("FN-001", "shared-project");
    expect(mockUseLiveTranscript).toHaveBeenCalledWith("FN-002", "shared-project");
  });
});

describe("ActiveAgentsPanel — RuntimeFallbackBadge viewport gating (FUX-039)", () => {
  const realIntersectionObserver = globalThis.IntersectionObserver;

  beforeEach(() => {
    vi.useFakeTimers();
    legacyMocks.fetchTaskRuntimeFallback.mockReset();
    legacyMocks.fetchTaskRuntimeFallback.mockResolvedValue({
      taskId: "FN-001",
      hasEvent: true,
      wasConfigured: false,
      runtimeHint: "hermes",
      reason: "init_error",
      eventId: "audit-1",
      timestamp: "2026-07-08T00:00:00.000Z",
      showFallbackBadge: true,
    });
    MockIntersectionObserver.instances = [];
    // @ts-expect-error test-only override
    globalThis.IntersectionObserver = MockIntersectionObserver;
    mockUseLiveTranscript.mockReturnValue({ entries: [], isConnected: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.IntersectionObserver = realIntersectionObserver;
  });

  function agentWithTask(): Agent {
    return {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;
  }

  it("does not poll the runtime-fallback endpoint until the card's own IntersectionObserver reports it visible, and stops/resumes on transitions", async () => {
    const { container } = render(
      <ToastProvider>
        <ActiveAgentsPanel agents={[agentWithTask()]} />
      </ToastProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    // Not yet observed as intersecting — no poll should have fired.
    expect(legacyMocks.fetchTaskRuntimeFallback).not.toHaveBeenCalled();

    const cardEl = container.querySelector(".live-agent-card") as Element;
    expect(cardEl).toBeTruthy();
    const observer = MockIntersectionObserver.instances.find((o) => o.observedElements.has(cardEl));
    expect(observer).toBeTruthy();

    // Transition to visible: polling should start.
    await act(async () => {
      observer!.fire(cardEl, true);
      await Promise.resolve();
    });
    expect(legacyMocks.fetchTaskRuntimeFallback).toHaveBeenCalledTimes(1);

    // Transition to hidden mid-session: further 30s poll ticks must NOT fire.
    await act(async () => {
      observer!.fire(cardEl, false);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(legacyMocks.fetchTaskRuntimeFallback).toHaveBeenCalledTimes(1);

    // Transition back to visible: polling resumes.
    await act(async () => {
      observer!.fire(cardEl, true);
      await Promise.resolve();
    });
    expect(legacyMocks.fetchTaskRuntimeFallback.mock.calls.length).toBeGreaterThan(1);
  });

  it("gates the runtime-fallback poll the same way at a 375x812 mobile viewport", async () => {
    Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 812, configurable: true });

    const { container } = render(
      <ToastProvider>
        <ActiveAgentsPanel agents={[agentWithTask()]} />
      </ToastProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(legacyMocks.fetchTaskRuntimeFallback).not.toHaveBeenCalled();

    const cardEl = container.querySelector(".live-agent-card") as Element;
    const observer = MockIntersectionObserver.instances.find((o) => o.observedElements.has(cardEl));
    expect(observer).toBeTruthy();

    await act(async () => {
      observer!.fire(cardEl, true);
      await Promise.resolve();
    });
    expect(legacyMocks.fetchTaskRuntimeFallback).toHaveBeenCalledTimes(1);
  });
});
