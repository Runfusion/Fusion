/*
FNXC:WorkflowResolvedColumns 2026-07-30-23:55 (fleet phase — evidence for the notification lifecycle guards):
DIFFERENTIAL: one notification service, one event sequence, two column VOCABULARIES.

`NotificationService` decided which moves are notable by comparing `data.to` against the literals
`in-review` and `done`. On a workflow that names its lanes anything else, both comparisons are simply
false — so the two notifications an operator most relies on (a task reaching review, a task reaching
terminal merge) were SILENTLY not sent. Nothing throws and no log records it; the operator just stops
being told.

The test drives the same store twice, changing only the workflow's column ids, and asserts the same
notifications arrive. `DEFAULT_VOCAB` alone cannot show this — a guard keyed on the literal passes there
for the wrong reason, which is exactly why the shared fixture exists.

REVERT CHECK, measured (both run):
  - `data.to === "in-review"` restored -> "dispatches the review notification on a RENAMED review
    column" fails with 0 calls.
  - `data.to === "done"` restored -> "dispatches the terminal merge notification on a RENAMED complete
    column" fails with 0 calls.
Both pass on the DEFAULT vocabulary before and after, which is the point of running both.
*/
import { describe, expect, it, vi } from "vitest";
import type { NotificationProvider, Settings, Task, TaskMoveLanes, WorkflowIr } from "@fusion/core";
import { NotificationService } from "../notification-service.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "../../__tests__/_workflow-vocabulary-fixture.js";
import { flushAsyncHandlers } from "../../__tests__/_flush-async-handlers.js";

vi.mock("../../logger.js", () => ({
  schedulerLog: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type MovedListener = (data: { task: Task; from: string; to: string }) => void;
type UpdatedListener = (task: Task, meta?: { lanes?: TaskMoveLanes }) => void;

/**
 * A store that resolves a real workflow IR, so `resolveTaskLifecycleColumns` returns the vocabulary
 * under test rather than failing soft to the legacy ids. Failing soft would make the renamed run
 * indistinguishable from the default one and the differential meaningless.
 */
function fixture(vocab: Vocabulary) {
  /*
  `mergeOrchestration: true` is REQUIRED here, and finding that out was the useful part.

  `resolveLifecycleColumns` keys its `review` role on the `mergeOrchestration` flag
  (`LIFECYCLE_ROLE_FLAGS.review`), NOT on `human-review`. The fixture's review column declares
  `human-review` and adds `merge` only on opt-in — so without this option the resolved `review` is
  `undefined`, the guard falls back to `"in-review"`, and the RENAMED case fails. It did.

  That is not just a fixture detail. It means a custom workflow whose review lane carries ONLY
  `human-review` still gets no review notification, because the role it needs is defined as "the
  merge-orchestration column". The dashboard's own `isReviewColumnRole` treats `mergeBlocker` OR
  `humanReview` as review, so the app and the core resolver disagree about what "review" means.
  Reconciling them changes a shared resolver used well beyond notifications, so it is recorded here
  and in the PR rather than changed under a conversion. The default coding workflow's review column
  does carry merge orchestration, which is why this is a gap on custom boards and not a live outage.
  */
  const ir: WorkflowIr = lifecycleIr(vocab, "notif-lifecycle", { mergeOrchestration: true });
  const movedListeners = new Set<MovedListener>();
  const updatedListeners = new Set<UpdatedListener>();
  const store = {
    getSettings: async () => ({ ntfyEnabled: true, ntfyTopic: "test" }) as Settings,
    getTaskWorkflowSelection: () => ({ workflowId: "notif-lifecycle", stepIds: [] }),
    getWorkflowDefinition: async (id: string) => (id === "notif-lifecycle" ? { ir } : undefined),
    on: (event: string, listener: MovedListener | UpdatedListener) => {
      if (event === "task:moved") movedListeners.add(listener as MovedListener);
      if (event === "task:updated") updatedListeners.add(listener as UpdatedListener);
    },
    off: () => undefined,
    emitMoved: (data: { task: Task; from: string; to: string }) => movedListeners.forEach((listener) => listener(data)),
    emitUpdated: (updatedTask: Task, meta?: { lanes?: TaskMoveLanes }) =>
      updatedListeners.forEach((listener) => listener(updatedTask, meta)),
  };

  const sendNotification = vi.fn(async () => ({ success: true, providerId: "test" }));
  const provider: NotificationProvider = {
    getProviderId: () => "test",
    isEventSupported: () => true,
    sendNotification,
  };
  const service = new NotificationService(store as never);
  service.registerProvider(provider);

  const task = (overrides: Partial<Task> = {}): Task => ({
    id: "FN-9001",
    title: "Renamed lifecycle",
    description: "",
    column: vocab.wip,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  } as Task);

  return { store, service, sendNotification, task };
}

/** Both vocabularies, so a literal-keyed guard cannot pass by hitting the legacy ids. */
const VOCABULARIES: ReadonlyArray<readonly [string, Vocabulary]> = [
  ["DEFAULT", DEFAULT_VOCAB],
  ["RENAMED", RENAMED_VOCAB],
];

describe("notification lifecycle guards resolve columns by ROLE, not by id", () => {
  for (const [label, vocab] of VOCABULARIES) {
    it(`dispatches the review notification on a ${label} review column (${vocab.review})`, async () => {
      const { store, service, sendNotification, task } = fixture(vocab);
      await service.start();

      store.emitMoved({ task: task({ column: vocab.review }), from: vocab.wip, to: vocab.review });
      await flushAsyncHandlers();

      /*
      The notification EVENT KIND stays the literal `in-review` on purpose — it is a notification
      channel name in the operator's ntfy config, not a column id. Renaming a board must not rename
      the event, or every existing per-event filter silently stops matching.
      */
      expect(sendNotification).toHaveBeenCalledWith(
        "in-review",
        expect.objectContaining({ taskId: "FN-9001", event: "in-review" }),
      );
      await service.stop();
    });

    it(`dispatches the terminal merge notification on a ${label} complete column (${vocab.complete})`, async () => {
      const { store, service, sendNotification, task } = fixture(vocab);
      await service.start();

      // `isMergeBackedTerminalTask` is the other half of the guard; mergeConfirmed satisfies it.
      const merged = task({ column: vocab.complete, mergeDetails: { mergeConfirmed: true } } as never);
      store.emitMoved({ task: merged, from: vocab.review, to: vocab.complete });
      await flushAsyncHandlers();

      expect(sendNotification).toHaveBeenCalledWith(
        "merged",
        expect.objectContaining({ taskId: "FN-9001", event: "merged" }),
      );
      await service.stop();
    });
  }

  it("classifies a manual merge hold from emitter-carried renamed review lanes synchronously", async () => {
    const { store, service, sendNotification, task } = fixture(RENAMED_VOCAB);
    await service.start();

    store.emitUpdated(
      task({ column: RENAMED_VOCAB.review, paused: true, pausedReason: "manual-hold", status: "in-review" }),
      { lanes: { review: RENAMED_VOCAB.review } },
    );

    // No promise turn: the synchronous listener must classify before its queued wedge work runs.
    expect(sendNotification).toHaveBeenCalledWith(
      "workflow-notify",
      expect.objectContaining({
        taskId: "FN-9001",
        metadata: expect.objectContaining({
          notificationKind: "manual_merge_hold",
          notificationDedupeKey: "workflow-transition:FN-9001:manual-merge-hold",
        }),
      }),
    );
    await service.stop();
  });

  it("keeps absent or blank review lanes on the existing in-review fallback", async () => {
    const { store, service, sendNotification, task } = fixture(RENAMED_VOCAB);
    await service.start();

    const held = (column: string) => task({ column, paused: true, pausedReason: "manual-hold", status: "in-review" });
    store.emitUpdated(held(RENAMED_VOCAB.review));
    store.emitUpdated(held(RENAMED_VOCAB.review), { lanes: { review: "" } });
    store.emitUpdated(held("in-review"));
    store.emitUpdated(held("in-review"), { lanes: { review: "" } });
    await flushAsyncHandlers();

    // Only the default-lane holds notify; absent and blank metadata are unknown rather than renamed.
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith("workflow-notify", expect.anything());
    await service.stop();
  });

  it("preserves marker, failed, and dedupe behavior independently of lane metadata", async () => {
    const { store, service, sendNotification, task } = fixture(RENAMED_VOCAB);
    await service.start();

    const marker = {
      kind: "manual-merge-hold" as const,
      transitionId: "marker-hold",
      column: RENAMED_VOCAB.review,
      createdAt: "2026-08-01T07:44:00.000Z",
    };
    store.emitUpdated(task({ id: "FN-marker", column: RENAMED_VOCAB.review, status: "in-review", workflowTransitionNotification: marker }));
    store.emitUpdated(task({ id: "FN-failed", column: RENAMED_VOCAB.review, status: "failed", paused: true, pausedReason: "manual-hold" }), { lanes: { review: RENAMED_VOCAB.review } });
    const duplicate = task({ id: "FN-duplicate", column: RENAMED_VOCAB.review, status: "in-review", paused: true, pausedReason: "manual-hold" });
    store.emitUpdated(duplicate, { lanes: { review: RENAMED_VOCAB.review } });
    store.emitUpdated(duplicate, { lanes: { review: RENAMED_VOCAB.review } });
    await flushAsyncHandlers();

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification).toHaveBeenCalledWith(
      "workflow-notify",
      expect.objectContaining({ taskId: "FN-marker", metadata: expect.objectContaining({ notificationDedupeKey: "workflow-transition:FN-marker:marker-hold" }) }),
    );
    expect(sendNotification).toHaveBeenCalledWith(
      "workflow-notify",
      expect.objectContaining({ taskId: "FN-duplicate", metadata: expect.objectContaining({ notificationDedupeKey: "workflow-transition:FN-duplicate:manual-merge-hold" }) }),
    );
    await service.stop();
  });

  it("does not dispatch for a move into a lane that plays no notable role", async () => {
    /*
    Non-vacuous check on both conversions at once: without it, a service that notified on EVERY move
    would satisfy all four cases above. `building` is the renamed WIP lane — a real column, just not
    one either guard is about.
    */
    const { store, service, sendNotification, task } = fixture(RENAMED_VOCAB);
    await service.start();

    store.emitMoved({ task: task({ column: RENAMED_VOCAB.wip }), from: RENAMED_VOCAB.hold, to: RENAMED_VOCAB.wip });
    await flushAsyncHandlers();

    expect(sendNotification).not.toHaveBeenCalled();
    await service.stop();
  });
});
