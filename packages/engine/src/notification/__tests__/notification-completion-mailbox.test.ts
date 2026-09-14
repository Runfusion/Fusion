import { describe, expect, it, vi } from "vitest";
import type { Settings, Task } from "@fusion/core";
import { NotificationService } from "../notification-service.js";
import { DEFAULT_VOCAB, lifecycleIr } from "../../__tests__/_workflow-vocabulary-fixture.js";

vi.mock("../../logger.js", () => ({
  schedulerLog: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Listener = (...args: any[]) => void;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-mail",
    title: "Completion mail",
    description: "",
    column: "work",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-09-09T20:00:00.000Z",
    updatedAt: "2026-09-09T20:00:00.000Z",
    ...overrides,
  } as Task;
}

function fixture(options: { workflow?: unknown; artifacts?: unknown[]; artifactError?: Error } = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const inserted = new Map<string, any>();
  const sendMessageOnce = vi.fn(async (input: any, key: string) => {
    const wasInserted = !inserted.has(key);
    if (wasInserted) inserted.set(key, input);
    return { message: input, inserted: wasInserted };
  });
  const store = {
    getSettings: async () => ({ ntfyEnabled: false }) as Settings,
    getArtifacts: vi.fn(async () => {
      if (options.artifactError) throw options.artifactError;
      return options.artifacts ?? [];
    }),
    getTaskWorkflowSelection: options.workflow ? () => ({ workflowId: "completion", stepIds: [] }) : undefined,
    getWorkflowDefinition: options.workflow ? async () => ({ ir: options.workflow }) : undefined,
    on(event: string, listener: Listener) {
      const bucket = listeners.get(event) ?? new Set();
      bucket.add(listener);
      listeners.set(event, bucket);
    },
    off() {},
    emitMoved(payload: unknown) {
      for (const listener of listeners.get("task:moved") ?? []) listener(payload);
    },
  };
  const messageStore = { on: vi.fn(), off: vi.fn(), sendMessageOnce };
  const service = new NotificationService(store as any, { messageStore: messageStore as any });
  return { inserted, sendMessageOnce, service, store };
}

const lanes = (terminal: string[]) => ({ terminal, review: "review" });

/*
FNXC:TaskCompletionMailbox 2026-09-13-03:42:
The completion mailbox producer consumes the post-commit move snapshot as the sole recap for a
completion episode. Coverage spans all task-scoped terminal lanes, compact recommendation and image
identifiers, replay idempotency, optional-data degradation, and legacy lane fallback.
*/
describe("NotificationService completion mailbox producer", () => {
  it("accepts either task-scoped terminal lane and ignores terminal-to-terminal moves", async () => {
    const { service, store, sendMessageOnce } = fixture();
    await service.start();
    store.emitMoved({ task: makeTask({ column: "shipped", columnMovedAt: "2026-09-09T20:01:00.000Z" }), from: "work", to: "shipped", lanes: lanes(["shipped", "filed"]) });
    store.emitMoved({ task: makeTask({ column: "filed", columnMovedAt: "2026-09-09T20:02:00.000Z" }), from: "work", to: "filed", lanes: lanes(["shipped", "filed"]) });
    store.emitMoved({ task: makeTask({ column: "filed", columnMovedAt: "2026-09-09T20:03:00.000Z" }), from: "shipped", to: "filed", lanes: lanes(["shipped", "filed"]) });
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(2));
    await service.stop();
  });

  it("stores summary, image ids, and recommendation ids without non-image artifacts", async () => {
    const { service, store, sendMessageOnce } = fixture({ artifacts: [
      { id: "image-1", type: "image" },
      { id: "document-1", type: "document" },
      { id: "video-1", type: "video" },
      { id: "image-2", type: "image" },
    ] });
    await service.start();
    store.emitMoved({
      task: makeTask({ summary: "Delivered the workflow.", column: "done", columnMovedAt: "2026-09-09T20:04:00.000Z", recommendations: [{ id: "rec-1" }, { id: "rec-2" }, { id: "rec-1" }, { id: " " }] as any }),
      from: "review", to: "done", lanes: lanes(["done"]),
    });
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledOnce());
    const message = sendMessageOnce.mock.calls[0]![0];
    expect(message.content).toContain("Delivered the workflow.");
    expect(message.metadata).toEqual({ kind: "task-completion-notice", taskId: "FN-mail", imageArtifactIds: ["image-1", "image-2"], recommendationIds: ["rec-1", "rec-2"] });
    expect(JSON.stringify(message.metadata)).not.toMatch(/document-1|video-1|task-recommendation-notice/);
    await service.stop();
  });

  it("deduplicates replayed snapshots and creates a new episode after reopening", async () => {
    const { inserted, service, store, sendMessageOnce } = fixture();
    await service.start();
    const first = { task: makeTask({ column: "done", columnMovedAt: "2026-09-09T20:05:00.000Z" }), from: "review", to: "done", lanes: lanes(["done"]) };
    store.emitMoved(first);
    store.emitMoved(first);
    store.emitMoved({ task: makeTask({ column: "work", columnMovedAt: "2026-09-09T20:06:00.000Z" }), from: "done", to: "work", lanes: lanes(["done"]) });
    store.emitMoved({ task: makeTask({ column: "done", columnMovedAt: "2026-09-09T20:07:00.000Z" }), from: "work", to: "done", lanes: lanes(["done"]) });
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(3));
    expect(inserted).toHaveLength(2);
    await service.stop();
  });

  it("resolves every workflow complete lane when payload lanes are absent", async () => {
    const base = lifecycleIr(DEFAULT_VOCAB, "completion", { mergeOrchestration: true }) as any;
    const workflow = {
      ...base,
      columns: [...base.columns, { id: "filed", name: "Filed", traits: [{ trait: "complete" as const }] }],
    };
    const { service, store, sendMessageOnce } = fixture({ workflow });
    await service.start();
    store.emitMoved({ task: makeTask({ column: "filed", columnMovedAt: "2026-09-09T20:08:00.000Z" }), from: "work", to: "filed" });
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledOnce());
    await service.stop();
  });

  it("uses only legacy done when workflow resolution is unavailable", async () => {
    const { service, store, sendMessageOnce } = fixture();
    await service.start();
    store.emitMoved({ task: makeTask({ column: "shipped", columnMovedAt: "2026-09-09T20:09:00.000Z" }), from: "work", to: "shipped" });
    store.emitMoved({ task: makeTask({ column: "done", columnMovedAt: "2026-09-09T20:10:00.000Z" }), from: "work", to: "done" });
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledOnce());
    await service.stop();
  });

  it("keeps the recap useful when artifacts are unavailable and absorbs mailbox rejection", async () => {
    const artifactFailure = fixture({ artifactError: new Error("artifact unavailable") });
    await artifactFailure.service.start();
    artifactFailure.store.emitMoved({
      task: makeTask({ summary: "Delivered without optional images.", recommendations: [{ id: "rec-1" }] as any, column: "done", columnMovedAt: "2026-09-09T20:11:00.000Z" }),
      from: "work", to: "done", lanes: lanes(["done"]),
    });
    await vi.waitFor(() => expect(artifactFailure.sendMessageOnce).toHaveBeenCalledOnce());
    expect(artifactFailure.sendMessageOnce.mock.calls[0]![0]).toMatchObject({
      content: expect.stringContaining("Delivered without optional images."),
      metadata: { kind: "task-completion-notice", taskId: "FN-mail", imageArtifactIds: [], recommendationIds: ["rec-1"] },
    });
    await artifactFailure.service.stop();

    const mailboxFailure = fixture();
    mailboxFailure.sendMessageOnce.mockRejectedValueOnce(new Error("mailbox unavailable"));
    await mailboxFailure.service.start();
    mailboxFailure.store.emitMoved({ task: makeTask({ column: "done", columnMovedAt: "2026-09-09T20:12:00.000Z" }), from: "work", to: "done", lanes: lanes(["done"]) });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mailboxFailure.sendMessageOnce).toHaveBeenCalledOnce();
    await mailboxFailure.service.stop();

    const missing = new NotificationService({ getSettings: async () => ({ ntfyEnabled: false }), on() {}, off() {}, getArtifacts: async () => [] } as any);
    await expect(missing.start()).resolves.toBeUndefined();
    await missing.stop();
  });
});
