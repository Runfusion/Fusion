/*
FNXC:DashboardSSE 2026-07-26-17:05:
Component-level coverage for the sse-bus missed-event contract (the hook-level twin lives in
`sse-resync-on-reopen.test.ts`).

The requirement: the bus tears every EventSource down after SSE_HIDDEN_SUSPEND_DELAY_MS hidden — the
mobile page-discard fix — and /api/events keeps NO replay buffer, so every event emitted during that
window is lost forever. A COMPONENT that mutates its rendered state only from event handlers therefore
diverges permanently from the server, and the operator sees a frozen view with no indication it is
stale.

Asserted as an invariant, not one repro:
1. Per-surface cycles for MailboxView (inbox) and TaskDetailModal (workflow-step results, CLI session)
   run the full hidden -> suspend -> server moves on unobserved -> visible -> reopen sequence and
   assert the surface CONVERGES on the server's state.
2. A coverage ratchet asserts every `components/` subscriber declares `onReconnect` or the reviewed
   `replaySafe` opt-out, so the next non-resyncing component subscription cannot land silently.

Fake timers (the suspend delay is 60s of wall clock) and mocked api module — no real I/O.
*/
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { act, render, screen } from "@testing-library/react";
import type { Column, TaskDetail, Task, MergeResult } from "@fusion/core";
import { MockEventSource } from "../../vitest.setup";
import { __resetSseBus, SSE_HIDDEN_SUSPEND_DELAY_MS } from "../sse-bus";

const fetchInboxMock = vi.fn();
const fetchUnreadCountMock = vi.fn();
const fetchWorkflowResultsMock = vi.fn();
const apiMock = vi.fn();

vi.mock("../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../test/mockApi");
  return createDashboardApiMock(() => importOriginal<Record<string, unknown>>(), {
    fetchInbox: fetchInboxMock,
    fetchUnreadCount: fetchUnreadCountMock,
    fetchWorkflowResults: fetchWorkflowResultsMock,
    api: apiMock,
    fetchTaskEffectiveSettings: vi.fn().mockResolvedValue({}),
    fetchGlobalSettings: vi.fn().mockResolvedValue({}),
    fetchAgents: vi.fn().mockResolvedValue([]),
    fetchAgent: vi.fn().mockResolvedValue(null),
    fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
    fetchTaskDetail: vi.fn().mockResolvedValue(null),
    fetchTaskVerificationRequest: vi.fn().mockResolvedValue(null),
    fetchAgentLogs: vi.fn().mockResolvedValue([]),
    fetchWorkflows: vi.fn().mockResolvedValue([]),
    fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
    fetchWorkflowOptionalSteps: vi.fn().mockResolvedValue([]),
    fetchTaskWorkflow: vi.fn().mockResolvedValue({ workflowId: null }),
    fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, defaults: {} }),
    fetchTaskReview: vi.fn().mockResolvedValue({ reviewState: undefined, automationStatus: null, emptyMessage: "" }),
  }) as unknown as Promise<Record<string, unknown>>;
});

vi.mock("../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  isFullScreenSheetViewport: () => false,
  isShortViewport: () => false,
  getViewportMode: () => "desktop",
  isMobileViewport: () => false,
  isTabletTouchViewport: (mode?: string) => mode === "tablet",
  useViewportMode: () => "desktop",
}));

vi.mock("../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: () => ({ keyboardOpen: false, viewportHeight: 800 }),
}));

vi.mock("../hooks/useAgentLogs", () => ({
  useAgentLogs: () => ({ entries: [], loading: false, clear: vi.fn(), loadMore: vi.fn(async () => {}), hasMore: false, total: null, loadingMore: false }),
}));

vi.mock("../hooks/usePluginUiSlots", () => ({
  usePluginUiSlots: () => ({ slots: [], getSlotsForId: () => [], loading: false, error: null }),
}));

const { MailboxView } = await import("../components/MailboxView");
const { TaskDetailModal } = await import("../components/TaskDetailModal");

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

/*
FNXC:DashboardSSE 2026-07-26-17:52:
Emit as the SERVER does: into whatever socket exists, with no guarantee anyone is listening. The mock
EventSource keeps its listener array after `close()`, so a bare `_emit` on a torn-down stream would
still reach the component and silently make every case below vacuous (it did: two cases passed with
the onReconnect handlers deleted). A real closed EventSource delivers nothing, so drop the event when
the stream is CLOSED — that is precisely the loss this contract exists to survive.
*/
function emitFromServer(type: string, data?: unknown): void {
  const stream = latestStream();
  if (stream.readyState === MockEventSource.CLOSED) return;
  stream._emit(type, data);
}

function latestStream(): MockEventSource {
  const instance = MockEventSource.instances[MockEventSource.instances.length - 1];
  if (!instance) throw new Error("no EventSource opened");
  return instance;
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
}

/** Advance while feeding the heartbeats a real stream sends, so the 45s heartbeat timeout is not what fires. */
async function advanceWithHeartbeats(ms: number): Promise<void> {
  const STEP_MS = 20_000;
  let remaining = ms;
  while (remaining > STEP_MS) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STEP_MS);
    });
    latestStream()._emit("heartbeat");
    remaining -= STEP_MS;
  }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(remaining);
  });
}

/**
 * The shared cycle every case runs. `mutateServerWhileSuspended` stands in for the server moving on
 * while the tab is backgrounded: it updates what the mocked endpoints will return AND emits the SSE
 * event the server would have pushed — which must land on a torn-down socket and be lost, exactly as
 * production loses it.
 */
async function suspendAndReopen(mutateServerWhileSuspended: () => void): Promise<void> {
  const preSuspendStream = latestStream();
  preSuspendStream._emit("open");
  await flush();

  setVisibility("hidden");
  await advanceWithHeartbeats(SSE_HIDDEN_SUSPEND_DELAY_MS);

  mutateServerWhileSuspended();
  await flush();

  setVisibility("visible");
  await flush();
  latestStream()._emit("open");
  await flush();
}

function makeMessage(id: string, subject: string) {
  return {
    id,
    fromType: "agent",
    fromId: "agent-1",
    toType: "user",
    toId: "user",
    subject,
    content: subject,
    type: "info",
    read: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-099",
    description: "Resync task",
    column: "in-progress" as Column,
    dependencies: [],
    prompt: "",
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as TaskDetail;
}

function makeWorkflowResult(status: string) {
  return {
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    status,
    phase: "pre-merge",
    startedAt: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchInboxMock.mockReset();
  fetchUnreadCountMock.mockReset();
  fetchWorkflowResultsMock.mockReset();
  apiMock.mockReset();
  fetchUnreadCountMock.mockResolvedValue({ unreadCount: 0, pendingApprovalCount: 0 });
  apiMock.mockResolvedValue({ sessions: [] });
});

afterEach(() => {
  __resetSseBus();
  setVisibility("visible");
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("component SSE subscribers resync after a hidden-tab suspend", () => {
  it("MailboxView shows a message that arrived while the tab was suspended", async () => {
    fetchInboxMock.mockResolvedValue({ messages: [makeMessage("m1", "First message")], total: 1 });

    render(
      <MailboxView
        projectId="p-mailbox"
        onOpenNativeStructure={() => {}}
        nativeStructureCandidates={[]}
      />,
    );
    await flush();
    expect(screen.getByText("First message")).toBeTruthy();

    await suspendAndReopen(() => {
      // Server state moves on, and the push that would have announced it hits a torn-down socket.
      fetchInboxMock.mockResolvedValue({
        messages: [makeMessage("m1", "First message"), makeMessage("m2", "Arrived while hidden")],
        total: 2,
      });
      emitFromServer("message:received", { id: "m2" });
    });

    expect(screen.getByText("Arrived while hidden")).toBeTruthy();
  });

  it("TaskDetailModal workflow tab converges on a step verdict decided while suspended", async () => {
    fetchWorkflowResultsMock.mockResolvedValue([makeWorkflowResult("pending")]);

    render(
      <TaskDetailModal
        task={makeTask()}
        initialTab="workflow"
        onClose={() => {}}
        onMoveTask={(async () => ({}) as Task) as never}
        onDeleteTask={(async () => ({}) as Task) as never}
        onMergeTask={(async () => ({ merged: false }) as MergeResult) as never}
        onOpenDetail={() => {}}
        addToast={() => {}}
      />,
    );
    await flush();

    const badge = screen.getByTestId("workflow-result-badge-code-review");
    expect(badge.className).toContain("workflow-result-badge--pending");

    await suspendAndReopen(() => {
      fetchWorkflowResultsMock.mockResolvedValue([makeWorkflowResult("failed")]);
      emitFromServer("task:updated", { id: "FN-099", workflowStepResults: [makeWorkflowResult("failed")] });
    });

    expect(screen.getByTestId("workflow-result-badge-code-review").className).toContain(
      "workflow-result-badge--failed",
    );
  });

  it("TaskDetailModal re-reads the authoritative CLI session after a suspend", async () => {
    const busySession = { id: "cli-1", taskId: "FN-099", agentState: "busy", adapterId: "claude-local" };
    apiMock.mockImplementation(async (path: string) =>
      typeof path === "string" && path.startsWith("/cli-sessions") ? { sessions: [busySession] } : undefined,
    );

    render(
      <TaskDetailModal
        task={makeTask()}
        onClose={() => {}}
        onMoveTask={(async () => ({}) as Task) as never}
        onDeleteTask={(async () => ({}) as Task) as never}
        onMergeTask={(async () => ({ merged: false }) as MergeResult) as never}
        onOpenDetail={() => {}}
        addToast={() => {}}
      />,
    );
    await flush();

    const cliSessionCalls = () =>
      apiMock.mock.calls.filter(([path]) => typeof path === "string" && path.startsWith("/cli-sessions")).length;
    const initialCalls = cliSessionCalls();
    expect(initialCalls).toBeGreaterThan(0);

    await suspendAndReopen(() => {
      // The terminal transition the operator must see. It is pushed onto a dead socket, so only an
      // authoritative re-read can recover it.
      apiMock.mockImplementation(async (path: string) =>
        typeof path === "string" && path.startsWith("/cli-sessions")
          ? { sessions: [{ ...busySession, agentState: "waitingOnInput" }] }
          : undefined,
      );
      emitFromServer("cli:session:state", { sessionId: "cli-1", taskId: "FN-099", state: "waitingOnInput" });
    });

    expect(cliSessionCalls()).toBeGreaterThan(initialCalls);
  });
});

/*
FNXC:DashboardSSE 2026-07-26-17:20:
Coverage ratchet for `components/`. The hook-level ratchet in sse-resync-on-reopen.test.ts only walks
`hooks/`, which is exactly why these component subscriptions survived two rounds of the same fix. Every
component that calls subscribeSse must declare `onReconnect` or the reviewed `replaySafe` opt-out
documented on SseSubscription.
Test files are excluded: they mock the bus rather than subscribe to it.
*/
describe("sse-bus subscriber resync contract (components)", () => {
  it("every subscribing component declares onReconnect or an explicit replaySafe opt-out", () => {
    const roots = [join(__dirname, "..", "components"), join(__dirname, "..")];
    const offenders: string[] = [];

    const walk = (dir: string, recurse: boolean): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!recurse || entry.name === "__tests__" || entry.name === "node_modules") continue;
          walk(join(dir, entry.name), recurse);
          continue;
        }
        if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
        if (entry.name.includes(".test.")) continue;
        const source = readFileSync(join(dir, entry.name), "utf8");
        if (!source.includes("subscribeSse(")) continue;
        if (source.includes("onReconnect") || source.includes("replaySafe")) continue;
        offenders.push(entry.name);
      }
    };

    walk(roots[0], true);
    walk(roots[1], false);

    expect(offenders).toEqual([]);
  });
});
