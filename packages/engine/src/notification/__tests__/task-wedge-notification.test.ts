import { describe, expect, it, vi } from "vitest";
import { WEDGE_RENOTIFY_COOLDOWN_MS, type NotificationProvider, type Settings, type Task } from "@fusion/core";
import { NotificationService } from "../notification-service.js";
import { describeSelfHealingNoActionWedge, describeTaskWedge } from "../task-wedge-notification.js";

type Listener = (task: Task) => void;

/*
FNXC:WorkflowResolvedColumns 2026-07-31-21:35:
A board whose lanes carry no legacy id: hold `drafting`, wip `building`, review `checking`,
complete `shipped`. Supplied through `listWorkflowDefinitions`, the only store read
`resolveProjectColumnsForRoles` makes and one that is answerable under PostgreSQL.
*/
const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "drafting", name: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "checking", name: "Checking", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
};

function fixture(workflowIr?: unknown) {
  const listeners = new Set<Listener>();
  let wedge: Task["wedgeNotification"];
  const store = {
    getSettings: async () => ({ ntfyEnabled: true, ntfyTopic: "test" }) as Settings,
    on: (event: string, listener: Listener) => { if (event === "task:updated") listeners.add(listener); },
    off: () => undefined,
    emit: (task: Task) => listeners.forEach((listener) => listener(task)),
    claimTaskWedgeNotificationEpisode: async (taskId: string, reasonKey: string | null) => {
      if (reasonKey === null) {
        if (wedge?.status === "active") wedge = { ...wedge, status: "resolved" };
        return { claimed: false };
      }
      if (wedge?.status === "active" && wedge.reasonKey === reasonKey) return { claimed: false };
      wedge = { reasonKey, episodeId: `${taskId}-${reasonKey}-${Date.now()}`, status: "active", transitionedAt: new Date().toISOString() };
      return { claimed: true, episodeId: wedge.episodeId };
    },
    /* Absent → the helper keeps the legacy ids, which is every pre-existing case in this file. */
    ...(workflowIr ? { listWorkflowDefinitions: async () => [{ ir: workflowIr }] } : {}),
  };
  const sendMessageOnce = vi.fn(async (_input: unknown, _key: string) => ({ message: {} as any, inserted: true }));
  const service = new NotificationService(store as any, { messageStore: { on: () => undefined, sendMessageOnce } as any, failedNotificationGraceMs: 60_000 });
  const sendNotification = vi.fn(async () => ({ success: true, providerId: "test" }));
  const provider: NotificationProvider = { getProviderId: () => "test", isEventSupported: () => true, sendNotification };
  service.registerProvider(provider);
  const task = (overrides: Partial<Task> = {}): Task => ({ id: "FN-8501", title: "Fix changeset", description: "", column: "in-review", status: "failed", error: "merge verification failed: check:changeset-format", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-07-22T12:00:00.000Z", updatedAt: "2026-07-22T12:00:00.000Z", ...overrides } as Task);
  return { store, service, sendMessageOnce, sendNotification, task, getWedge: () => wedge };
}

/* Creates a restart-safe claim fake so NotificationService tests exercise delivery policy, not storage implementation. */
function cooldownFixture({ durable = true }: { durable?: boolean } = {}) {
  const listeners = new Set<Listener>();
  let wedge: Task["wedgeNotification"];
  const stamps = new Map<string, number>();
  const store = {
    getSettings: async () => ({ ntfyEnabled: true, ntfyTopic: "test" }) as Settings,
    on: (event: string, listener: Listener) => { if (event === "task:updated") listeners.add(listener); },
    off: () => undefined,
    emit: (task: Task) => listeners.forEach((listener) => listener(task)),
    ...(durable ? {
      claimTaskWedgeNotificationEpisode: async (taskId: string, reasonKey: string | null) => {
        if (reasonKey === null) {
          if (wedge?.status === "active") wedge = { ...wedge, status: "resolved" };
          return { claimed: false };
        }
        if (wedge?.status === "active" && wedge.reasonKey === reasonKey) return { claimed: false };
        const now = Date.now();
        for (const [key, notifiedAt] of stamps) {
          if (now - notifiedAt >= WEDGE_RENOTIFY_COOLDOWN_MS) stamps.delete(key);
        }
        const episodeId = `${taskId}-${reasonKey}-${now}`;
        wedge = { reasonKey, episodeId, status: "active", transitionedAt: new Date(now).toISOString() };
        if (stamps.has(reasonKey)) return { claimed: false };
        stamps.set(reasonKey, now);
        return { claimed: true, episodeId };
      },
    } : {}),
  };
  const sendMessageOnce = vi.fn(async (_input: unknown, _key: string) => ({ message: {} as any, inserted: true }));
  const service = new NotificationService(store as any, { messageStore: { on: () => undefined, sendMessageOnce } as any });
  const sendNotification = vi.fn(async () => ({ success: true, providerId: "test" }));
  service.registerProvider({ getProviderId: () => "test", isEventSupported: () => true, sendNotification });
  const task = (overrides: Partial<Task> = {}): Task => ({ id: "FN-8691", title: "Blocked task", description: "", column: "in-review", status: "failed", error: "BLOCKED: dependency unavailable", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-08-01T12:00:00.000Z", updatedAt: new Date().toISOString(), ...overrides } as Task);
  return { store, service, sendMessageOnce, sendNotification, task };
}

async function flushWedgeHandling() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("task wedge notifications", () => {
  /*
  FNXC:TaskWedgeNotifications 2026-08-01-15:35:
  A BLOCKED task can resolve and re-wedge as scheduler/self-healing touch it. A
  fresh episode id previously defeated sendMessageOnce; both delivery lanes now
  notify once per reason cooldown and re-open only after that window expires.
  */
  it("suppresses five resolve/re-wedge execution-blocked flaps until the cooldown expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    const { store, service, sendMessageOnce, sendNotification, task } = cooldownFixture();
    await service.start();

    for (let index = 0; index < 5; index += 1) {
      store.emit(task({ updatedAt: new Date().toISOString() }));
      await flushWedgeHandling();
      store.emit(task({ status: "in-progress", error: undefined, column: "in-progress", updatedAt: new Date().toISOString() }));
      await flushWedgeHandling();
    }
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(WEDGE_RENOTIFY_COOLDOWN_MS);
    store.emit(task({ updatedAt: new Date().toISOString() }));
    await flushWedgeHandling();
    expect(sendMessageOnce).toHaveBeenCalledTimes(2);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    await service.stop();
    vi.useRealTimers();
  });

  it("retains X cooldown across Y, preserves distinct gates, and covers self-healing entry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    const { store, service, sendMessageOnce, task } = cooldownFixture();
    await service.start();
    const executionBlocked = describeTaskWedge(task())!;
    const lint = describeTaskWedge(task({ error: "merge verification failed: check:lint" }))!;
    const changeset = describeTaskWedge(task({ error: "merge verification failed: check:changeset-format" }))!;

    await service.notifyTaskWedge(task(), executionBlocked);
    await service.notifyTaskWedge(task(), lint);
    await service.notifyTaskWedge(task(), executionBlocked);
    await service.notifyTaskWedge(task(), changeset);
    expect(sendMessageOnce).toHaveBeenCalledTimes(3);

    const noAction = describeSelfHealingNoActionWedge(task({ status: "in-review", error: undefined }), "reconcile-in-review-unmet-dependencies", { taskActive: false });
    await service.notifyTaskWedge(task({ status: "in-review", error: undefined }), noAction!);
    store.emit(task({ status: "in-progress", error: undefined, column: "in-progress" }));
    await flushWedgeHandling();
    await service.notifyTaskWedge(task({ status: "in-review", error: undefined }), noAction!);
    expect(sendMessageOnce).toHaveBeenCalledTimes(4);
    await service.stop();
    vi.useRealTimers();
  });

  it("gives the in-memory fallback the same resolve/re-wedge cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    const { store, service, sendMessageOnce, sendNotification, task } = cooldownFixture({ durable: false });
    await service.start();
    for (let index = 0; index < 5; index += 1) {
      store.emit(task());
      await flushWedgeHandling();
      store.emit(task({ status: "in-progress", error: undefined, column: "in-progress" }));
      await flushWedgeHandling();
    }
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    await service.stop();
    vi.useRealTimers();
  });

  it("sends one actionable push and mailbox message per active terminal episode", async () => {
    const { store, service, sendMessageOnce, sendNotification, task } = fixture();
    await service.start();
    store.emit(task());
    store.emit(task({ updatedAt: "2026-07-22T12:01:00.000Z" }));
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));
    expect(sendNotification).toHaveBeenCalledWith("task-wedged", expect.objectContaining({ taskId: "FN-8501", metadata: expect.objectContaining({ gate: "check:changeset-format" }) }));
    const firstMessage = sendMessageOnce.mock.calls[0]?.[0] as { content: string } | undefined;
    expect(firstMessage?.content).toContain("Fix changeset");
    expect(firstMessage?.content).toContain("Recommended action");
    store.emit(task({ status: "queued", error: undefined, column: "todo", updatedAt: "2026-07-22T12:02:00.000Z" }));
    store.emit(task({ updatedAt: "2026-07-22T12:03:00.000Z" }));
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(2));
    await service.stop();
  });

  /*
  FNXC:TaskWedgeNotifications 2026-08-01-07:44:
  A recovery and re-wedge can be emitted back-to-back by synchronous task lifecycle writers. The
  per-task chain must run the recovery's resolve before the second wedge's claim; otherwise the old
  active episode rejects the claim and drops the second operator alert.
  */
  it("serializes back-to-back recovery and re-wedge task updates", async () => {
    const { store, service, sendMessageOnce, task } = fixture();
    await service.start();

    store.emit(task());
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));
    store.emit(task({ status: "queued", error: undefined, column: "todo", updatedAt: "2026-07-22T12:02:00.000Z" }));
    store.emit(task({ updatedAt: "2026-07-22T12:03:00.000Z" }));

    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(2));
    await service.stop();
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-18:50 (fleet):
  Clearing a wedge episode asks "has the card moved on?", which was four column literals. On a renamed
  board none matched, so a RECOVERED card never cleared its episode and the operator kept an alert for
  work that had already progressed — and, because the stale episode stays active, the NEXT genuine wedge
  is refused its claim and never announced at all.

  The board below recovers into `backlog` (hold). The assertion is the second message: with the literals
  it never arrives, because the first episode was never resolved.
  */
  it("clears a wedge episode when the card recovers into a RENAMED hold lane", async () => {
    const RENAMED_IR = {
      version: "v2",
      name: "renamed-notify",
      columns: [
        { id: "backlog", name: "Backlog", traits: [{ trait: "hold" }] },
        { id: "building", name: "Building", traits: [{ trait: "wip" }] },
        { id: "signoff", name: "Signoff", traits: [{ trait: "merge" }] },
        { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
      ],
      nodes: [],
      edges: [],
    };
    const { store, service, sendMessageOnce, task } = fixture();
    /* `resolveProjectColumnsForRoles` unions lanes across the PROJECT's workflows, so the fake needs
       `listWorkflowDefinitions` — the per-task selection readers alone leave it resolving nothing. */
    Object.assign(store, {
      getTaskWorkflowSelection: () => ({ workflowId: "custom:renamed", stepIds: [] }),
      getTaskWorkflowSelectionAsync: async () => ({ workflowId: "custom:renamed", stepIds: [] }),
      getWorkflowDefinition: async () => ({ ir: RENAMED_IR }),
      listWorkflowDefinitions: async () => [{ id: "custom:renamed", ir: RENAMED_IR }],
    });

    await service.start();
    store.emit(task({ column: "signoff" }));
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));

    // Recovered into the board's own hold lane — the episode must close.
    /* status stays "failed" ON PURPOSE: the status disjunct (`status !== "failed"`) would otherwise
       satisfy hasProgressed on its own and the column term would never decide anything. */
    store.emit(task({ status: "failed", error: undefined, column: "backlog", updatedAt: "2026-07-22T12:02:00.000Z" }));
    // Wedged again: only claimable if the previous episode actually cleared.
    store.emit(task({ column: "signoff", updatedAt: "2026-07-22T12:03:00.000Z" }));
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(2));
    await service.stop();
  });

  it("does not re-deliver an unchanged durable episode after service restart", async () => {
    const { store, service, sendNotification, sendMessageOnce, task } = fixture();
    await service.start();
    store.emit(task());
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));
    await service.stop();

    const restarted = new NotificationService(store as any, { messageStore: { on: () => undefined, sendMessageOnce } as any });
    restarted.registerProvider({ getProviderId: () => "restarted", isEventSupported: () => true, sendNotification });
    await restarted.start();
    store.emit(task({ updatedAt: "2026-07-22T12:01:00.000Z" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    await restarted.stop();
  });

  it("delivers one durable episode for an ownerless self-healing no-action escalation", async () => {
    const { service, sendMessageOnce, sendNotification, task } = fixture();
    await service.start();
    const ownerless = task({ status: "in-review", error: undefined, paused: false, userPaused: false });
    const descriptor = describeSelfHealingNoActionWedge(ownerless, "reconcile-in-review-unmet-dependencies", {
      taskActive: false,
      hasExecutingTaskLock: false,
      livePaths: [],
    });
    expect(descriptor).toMatchObject({ reasonKey: "self-healing-no-action:reconcile-in-review-unmet-dependencies" });
    await service.notifyTaskWedge(ownerless, descriptor!);
    await service.notifyTaskWedge(ownerless, descriptor!);
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));
    expect(sendNotification).toHaveBeenCalledWith("task-wedged", expect.objectContaining({ taskId: "FN-8501" }));
    expect(describeSelfHealingNoActionWedge(ownerless, "reconcile-in-review-unmet-dependencies", { taskActive: true })).toBeNull();
    await service.stop();
  });

  it("does not resolve an ownerless no-action episode on an incidental in-review update", async () => {
    const { store, service, sendMessageOnce, task, getWedge } = fixture();
    await service.start();
    const ownerless = task({ status: "in-review", error: undefined, paused: false, userPaused: false });
    const descriptor = describeSelfHealingNoActionWedge(ownerless, "reconcile-in-review-unmet-dependencies", {
      taskActive: false,
      hasExecutingTaskLock: false,
      livePaths: [],
    });
    await service.notifyTaskWedge(ownerless, descriptor!);
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));

    store.emit({ ...ownerless, title: "Unrelated update", wedgeNotification: getWedge() });
    await Promise.resolve();
    await Promise.resolve();
    expect(getWedge()?.status).toBe("active");
    await service.notifyTaskWedge(ownerless, descriptor!);
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it.each([
    ["branch-cross-contamination", "branch-cross-contamination"],
    ["branch-conflict-tripwire", "branch-conflict-tripwire"],
    ["branch-conflict-recovery-exhausted", "branch-conflict-recovery-exhausted"],
    ["branch-conflict-unrecoverable", "branch-conflict-unrecoverable"],
    ["stuck-loop-exhausted-manual-intervention-required", "stuck-loop-exhausted"],
    ["non-retryable-provider-error", "non-retryable-provider-error"],
    ["in-review-stall-deadlock", "in-review-stall-deadlock"],
  ])("classifies automated terminal pause %s as %s", (pausedReason, reasonKey) => {
    const { task } = fixture();
    expect(describeTaskWedge(task({ status: "failed", paused: true, pausedReason }))).toMatchObject({ reasonKey });
  });

  it("classifies an otherwise unknown persisted failure with a bounded fallback", () => {
    const { task } = fixture();
    expect(describeTaskWedge(task({ error: "internal stack trace or opaque failure" }))).toMatchObject({ reasonKey: "terminal-failed" });
  });

  it("changes the active reason into a new episode without raw error keys", async () => {
    const { store, service, sendMessageOnce, task } = fixture();
    await service.start();
    store.emit(task({ error: "EXECUTION_DISPATCH_LOOP_EXHAUSTED: details" }));
    store.emit(task({ error: "Tool failure retries exhausted", updatedAt: "2026-07-22T12:01:00.000Z", column: "in-progress" }));
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(2));
    expect(sendMessageOnce.mock.calls.map((call) => call[1])).not.toContain(expect.stringContaining("details"));
    await service.stop();
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-21:35:
  A RECOVERED CARD ON A RENAMED BOARD MUST CLOSE ITS WEDGE EPISODE.

  The resolve branch tested "has this card moved on" by comparing against `todo`/`in-progress`/
  `done`/`archived`. On a board using none of those ids nothing matched, so the episode stayed
  `active` after the card visibly recovered — the operator kept an open "needs operator action"
  alert for work that had moved on, and (because an active episode suppresses re-claim) the NEXT
  genuine wedge on that task was never delivered either.

  The observable is the second delivery, not the episode record: an episode that resolves but
  delivers nothing new would be a silent regression of the same alert.
  */
  it("resolves an episode when the card recovers into a RENAMED lane, and re-delivers on re-wedge", async () => {
    const { store, service, sendMessageOnce, task } = fixture(RENAMED_IR);
    await service.start();

    const wedged = (updatedAt: string) => task({ column: "checking" as never, updatedAt });
    store.emit(wedged("2026-07-22T12:00:00.000Z"));
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));

    /*
    THE RECOVERY CARRIES NO STATUS, and that is what makes this test about the column at all.
    `hasProgressed` is an OR whose other arm is "status is a non-failed string" — my first version
    recovered with `status: "queued"`, that arm answered true, and the case passed against the
    literals. Measured: the mutation did not fail it. With `status` and `error` both cleared, the
    column membership is the ONLY thing that can resolve this episode.
    */
    store.emit(task({ status: undefined, error: undefined, column: "building" as never, updatedAt: "2026-07-22T12:02:00.000Z" }));
    store.emit(wedged("2026-07-22T12:03:00.000Z"));

    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(2));
    await service.stop();
  });

  /*
  The paired negative. The conversion widens membership over four roles, so it must not treat the
  REVIEW lane as progress — a wedged card sitting in review has not moved on, and resolving there
  would clear every episode on the next incidental update and re-alert forever.
  */
  it("does NOT resolve on a status-less update while the card sits in the renamed REVIEW lane", async () => {
    const { store, service, sendMessageOnce, task } = fixture(RENAMED_IR);
    await service.start();

    store.emit(task({ column: "checking" as never, updatedAt: "2026-07-22T12:00:00.000Z" }));
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));

    /* Same shape as the positive — no status, no error — so only the lane differs. Review is not
       progress: resolving here would clear the episode on any incidental update and re-alert. */
    store.emit(task({ status: undefined, error: undefined, column: "checking" as never, updatedAt: "2026-07-22T12:01:00.000Z" }));
    store.emit(task({ column: "checking" as never, updatedAt: "2026-07-22T12:02:00.000Z" }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    await service.stop();
  });
});
