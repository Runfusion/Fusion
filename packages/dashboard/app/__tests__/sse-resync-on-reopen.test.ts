/*
FNXC:DashboardSSE 2026-07-26-15:30:
Invariant coverage for the sse-bus missed-event contract.

The requirement: the bus tears every EventSource down after SSE_HIDDEN_SUSPEND_DELAY_MS hidden (the
mobile page-discard fix) and /api/events has NO replay buffer, so every event emitted during that
window is lost forever. A subscriber that mutates state only from event handlers therefore diverges
permanently from the server. The invariant every subscriber must satisfy is: hidden -> suspend ->
server state changes while suspended -> visible -> reopen CONVERGES the hook on the server's state.

This is asserted as a general invariant, not one repro: three representative hooks exercise the full
suspend/reopen cycle (an approval raised while suspended, a merge landed while suspended, a chat
reply arrived while suspended), and a coverage ratchet asserts that EVERY subscriber hook declares a
resync path (onReconnect) or an explicit reviewed `replaySafe` opt-out, so a new non-resyncing
subscriber cannot be added silently.

Fake timers (the suspend delay is 60s of wall clock) and mocked fetch — no real I/O.
*/
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { act, renderHook } from "@testing-library/react";
import { MockEventSource } from "../../vitest.setup";
import { __resetSseBus, SSE_HIDDEN_SUSPEND_DELAY_MS } from "../sse-bus";

const fetchApprovalsMock = vi.fn();
const fetchChatSessionsMock = vi.fn();
const apiMock = vi.fn();

vi.mock("../api", () => ({
  fetchApprovals: (...args: unknown[]) => fetchApprovalsMock(...args),
  fetchChatSessions: (...args: unknown[]) => fetchChatSessionsMock(...args),
  api: (...args: unknown[]) => apiMock(...args),
  ApiRequestError: class ApiRequestError extends Error {},
}));

const { useApprovalBanner } = await import("../hooks/useApprovalBanner");
const { useMergeAdvanceNotice } = await import("../hooks/useMergeAdvanceNotice");
const { useChatUnreadBadge } = await import("../hooks/useChatUnreadBadge");

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
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

/**
 * The shared suspend/reopen cycle every assertion below runs: open the stream, background the tab
 * long enough to suspend, let the server move on unobserved, then come back.
 */
async function suspendAndReopen(mutateServerWhileSuspended: () => void): Promise<void> {
  latestStream()._emit("open");

  setVisibility("hidden");
  await advanceWithHeartbeats(SSE_HIDDEN_SUSPEND_DELAY_MS);

  mutateServerWhileSuspended();

  setVisibility("visible");
  latestStream()._emit("open");
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  fetchApprovalsMock.mockReset();
  fetchChatSessionsMock.mockReset();
  apiMock.mockReset();
});

afterEach(() => {
  __resetSseBus();
  setVisibility("visible");
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("sse-bus subscribers resync after a hidden-tab suspend", () => {
  it("useApprovalBanner surfaces an approval raised while the tab was suspended", async () => {
    fetchApprovalsMock.mockResolvedValue({ requests: [], total: 0, pendingCount: 0 });

    const { result } = renderHook(() =>
      useApprovalBanner({
        tasks: [],
        currentProjectId: "p-approval",
        gitHubStarPromptShown: true,
        onStarPrompt: () => {},
      }),
    );
    await flush();
    expect(result.current.candidate).toBeNull();

    await suspendAndReopen(() => {
      // The agent raised an approval while the socket was down; its approval:requested event is gone.
      fetchApprovalsMock.mockResolvedValue({
        requests: [
          {
            id: "ar-1",
            status: "pending",
            actionCategory: "shell",
            actionSummary: "rm -rf build",
            agentId: "agent-1",
            createdAt: "2026-07-26T10:00:00.000Z",
            updatedAt: "2026-07-26T10:00:00.000Z",
          },
        ],
        total: 1,
        pendingCount: 1,
      });
    });

    expect(result.current.candidate).toMatchObject({ dedupeKey: "approval:ar-1" });
  });

  it("useApprovalBanner clears a banner whose approval was decided while suspended", async () => {
    fetchApprovalsMock.mockResolvedValue({ requests: [], total: 0, pendingCount: 0 });

    const { result } = renderHook(() =>
      useApprovalBanner({
        tasks: [],
        currentProjectId: "p-approval-decided",
        gitHubStarPromptShown: true,
        onStarPrompt: () => {},
      }),
    );
    await flush();

    // A live event put a banner on screen before the tab was backgrounded.
    latestStream()._emit("approval:requested", { id: "ar-2", updatedAt: "2026-07-26T10:00:00.000Z" });
    await flush();
    expect(result.current.candidate).toMatchObject({ dedupeKey: "approval:ar-2" });

    await suspendAndReopen(() => {
      // Decided from another device while we were disconnected: nothing pending remains.
      fetchApprovalsMock.mockResolvedValue({ requests: [], total: 0, pendingCount: 0 });
    });

    expect(result.current.candidate).toBeNull();
  });

  it("useMergeAdvanceNotice surfaces a merge that landed while the tab was suspended", async () => {
    const behindNotice = {
      taskId: "FN-1",
      integrationBranch: "main",
      refName: "refs/heads/main",
      toSha: "sha-new",
      fromSha: "sha-old",
      advanceMode: "fast-forward",
      succeeded: true,
      advancedAt: "2026-07-26T10:00:00.000Z",
      userCheckout: { worktreePath: "/checkout", dirty: false, untrackedCount: 0 },
    };

    apiMock.mockImplementation((path: string) => {
      if (typeof path === "string" && path.includes("merge-advance-events")) {
        return Promise.resolve({ events: [] });
      }
      return Promise.reject(new Error("no push status"));
    });

    const { result } = renderHook(() => useMergeAdvanceNotice({ projectId: "p-merge" }));
    await flush();
    expect(result.current.notice).toBeUndefined();

    await suspendAndReopen(() => {
      apiMock.mockImplementation((path: string) => {
        if (typeof path === "string" && path.includes("merge-advance-events")) {
          return Promise.resolve({ events: [behindNotice] });
        }
        return Promise.reject(new Error("no push status"));
      });
    });

    expect(result.current.notice).toMatchObject({ toSha: "sha-new" });
  });

  it("useChatUnreadBadge counts a reply that arrived while the tab was suspended", async () => {
    fetchChatSessionsMock.mockResolvedValue({ sessions: [] });

    const { result } = renderHook(() =>
      useChatUnreadBadge("p-chat", { taskView: "board", quickChatOpen: false }),
    );
    await flush();
    expect(result.current.chatHasUnreadResponse).toBe(false);

    await suspendAndReopen(() => {
      fetchChatSessionsMock.mockResolvedValue({
        sessions: [
          {
            id: "s-1",
            agentId: "agent-1",
            // Far in the future relative to the read watermark taken at mount.
            lastMessageAt: "2999-01-01T00:00:00.000Z",
          },
        ],
      });
    });

    expect(result.current.chatHasUnreadResponse).toBe(true);
  });
});

/*
FNXC:DashboardSSE 2026-07-26-15:38:
Coverage ratchet. The regressions this file was written for were all the same shape — a subscriber
added with event handlers and no way back to authoritative state — so per-hook cases alone would keep
letting the NEXT one through. Every caller of subscribeSse must declare `onReconnect` or the explicit
`replaySafe` opt-out documented on SseSubscription.
`useAgentLogs.ts` is knowingly absent from the exemptions: if it fails here it needs a resync, not an
exemption.

FNXC:DashboardSSE 2026-07-26-17:25:
CORRECTION to the original ratchet, which scanned `app/hooks/` ONLY and was described as covering
"every subscriber hook". That framing was wrong about what it protected: subscribeSse is not a
hooks-only API. Thirteen COMPONENT files subscribe directly (TaskDetailModal, MailboxModal,
GroupTaskModal, MailboxView, PluginManager, WorkflowNodeEditor, PlanningModeModal, BranchGroupCard,
SettingsModal, MissionManager, command-center/MissionControlPanel, command-center/areas/
SystemControlsArea, AgentDetailView). All comply today, but a NEW non-compliant component subscriber —
precisely the regression this ratchet exists to stop, and precisely how two subscribers slipped through
in the change set that motivated it — was invisible to the scan. The walk is now recursive over both
`app/hooks/` and `app/components/` (nested `command-center/` and `command-center/areas/` included).

The walker itself is guarded: a scan that silently stops finding files would pass with zero offenders,
which is the same silent-incorrectness failure mode the SSE work keeps producing. `scanSubscribers`
therefore returns what it examined and the test below asserts the known nested subscribers were
actually reached. Shape follows the repo's existing static call-site gate,
`packages/engine/src/__tests__/engine-no-blocking-shellout.test.ts`.
*/
const SUBSCRIBER_ROOTS = ["hooks", "components"] as const;

/**
 * Nested subscriber files the walk must reach. Not an allowlist — these already comply. They exist so
 * a broken/shallow walker fails loudly instead of reporting an empty offenders array. Paths are
 * relative to `app/`, POSIX-separated.
 */
const REQUIRED_SCAN_WITNESSES = [
  "hooks/useTasks.ts",
  "components/TaskDetailModal.tsx",
  "components/command-center/MissionControlPanel.tsx",
  "components/command-center/areas/SystemControlsArea.tsx",
] as const;

type ScanResult = { offenders: string[]; subscribers: string[] };

function scanSubscribers(): ScanResult {
  const appDir = join(__dirname, "..");
  const offenders: string[] = [];
  const subscribers: string[] = [];

  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // Test fixtures may legitimately subscribe without resyncing.
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(join(dir, entry.name), relativePath);
        continue;
      }
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      if (entry.name.includes(".test.")) continue;
      const source = readFileSync(join(dir, entry.name), "utf8");
      if (!source.includes("subscribeSse(")) continue;
      subscribers.push(relativePath);
      if (source.includes("onReconnect") || source.includes("replaySafe")) continue;
      offenders.push(relativePath);
    }
  };

  for (const root of SUBSCRIBER_ROOTS) walk(join(appDir, root), root);
  return { offenders, subscribers };
}

describe("sse-bus subscriber resync contract (hooks and components)", () => {
  it("every subscribeSse call site declares onReconnect or an explicit replaySafe opt-out", () => {
    const { offenders } = scanSubscribers();
    expect(
      offenders,
      [
        "SSE RESYNC REGRESSION: the listed files call subscribeSse() with no `onReconnect` and no",
        "`replaySafe` opt-out. The bus tears every EventSource down after SSE_HIDDEN_SUSPEND_DELAY_MS",
        "hidden and /api/events has NO replay buffer, so every event emitted while suspended is lost",
        "forever. Without a resync path the surface renders state that looks complete and is not.",
        "Add `onReconnect: () => void refetch()`, or `replaySafe: true` if — and only if — the",
        "subscriber derives nothing durable from events.",
      ].join(" "),
    ).toEqual([]);
  });

  it("the scan actually reaches nested component subscribers (walker self-check)", () => {
    const { subscribers } = scanSubscribers();
    for (const witness of REQUIRED_SCAN_WITNESSES) {
      expect(
        subscribers,
        `sse-resync ratchet: the walker did not reach ${witness}. Either the file moved (re-point this witness) or the walk broke — a broken walk reports zero offenders and the ratchet silently stops guarding anything.`,
      ).toContain(witness);
    }
    // Guard against a filter that quietly drops most of the tree.
    expect(subscribers.length).toBeGreaterThanOrEqual(REQUIRED_SCAN_WITNESSES.length);
  });
});
