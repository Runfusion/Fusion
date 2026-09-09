import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, Task, TaskStore } from "@fusion/core";

const { recordRunAuditEventMock } = vi.hoisted(() => ({
  recordRunAuditEventMock: vi.fn(async () => undefined),
}));
vi.mock("../util/run-audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/run-audit.js")>();
  return {
    ...actual,
    createRunAuditor: vi.fn(() => ({ database: recordRunAuditEventMock, git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() })),
  };
});

import { SelfHealingManager } from "../self-healing.js";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function stranded(id: string, canonicalId: string, overrides: Partial<Task> = {}): Task {
  return task(id, {
    paused: true,
    pausedReason: "duplicate-decision-required",
    sourceMetadata: { duplicateSource: "triage-marker", nearDuplicateOf: canonicalId },
    ...overrides,
  });
}

/*
FNXC:WorkflowResolvedColumns 2026-07-30-04:30:
An optional renamed workflow, so the same sweep can be driven under a board whose terminal lane is
`shipped` instead of `done`. Supplied, `resolveWorkflowIrForTask` resolves it and the canonical's
real flags reach `isNearDuplicateCanonicalInactive`; omitted, the store behaves exactly as before and
the existing cases are untouched.
*/
const RENAMED_IR = {
  version: "v2",
  id: "custom:renamed-terminal",
  nodes: [],
  edges: [],
  columns: [
    { id: "drafting", label: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
  ],
};

function storeFor(tasks: Task[], workflow?: unknown): TaskStore & EventEmitter {
  const tasksById = new Map(tasks.map((entry) => [entry.id, entry]));
  return Object.assign(new EventEmitter(), {
    ...(workflow
      ? {
          getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "custom:renamed-terminal", stepIds: [] })),
          getWorkflowDefinition: vi.fn(async () => ({ ir: workflow })),
        }
      : {}),
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false } as Settings)),
    listTasks: vi.fn(async () => [...tasksById.values()]),
    getTask: vi.fn(async (id: string) => tasksById.get(id)),
    updateTask: vi.fn(async (id: string, patch: Partial<Task> & { sourceMetadataPatch?: Record<string, unknown> }) => {
      const current = tasksById.get(id)!;
      const next = {
        ...current,
        ...patch,
        sourceMetadata: patch.sourceMetadataPatch ? { ...current.sourceMetadata, ...patch.sourceMetadataPatch } : current.sourceMetadata,
      } as Task;
      tasksById.set(id, next);
      return next;
    }),
  }) as unknown as TaskStore & EventEmitter;
}

describe("FN-8356: reconcile stale duplicate-decision pauses", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clears the FN-8353-shaped hidden decision for every inactive canonical state and audits each recovery", async () => {
    const done = task("FN-DONE", { column: "done" });
    const deleted = task("FN-DELETED", { deletedAt: new Date().toISOString() });
    const tasks = [
      stranded("FN-1", done.id), done,
      stranded("FN-2", deleted.id), deleted,
      stranded("FN-3", "FN-MISSING"),
    ];
    const store = storeFor(tasks);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileStaleDuplicateDecisionPause()).toBe(3);
    for (const id of ["FN-1", "FN-2", "FN-3"]) {
      const recovered = await store.getTask(id);
      expect(recovered?.paused).toBe(false);
      expect(recovered?.pausedReason).toBeNull();
      // needs-replan (not null) so the card cannot look planning-finished without a real PROMPT
      expect(recovered?.status).toBe("needs-replan");
      expect(recovered?.sourceMetadata?.nearDuplicateDismissed).toBe(true);
      // TaskCard and NotificationService both key their decision affordance on this predicate.
      expect(recovered?.pausedReason === "duplicate-decision-required").toBe(false);
    }
    expect(recordRunAuditEventMock).toHaveBeenCalledTimes(3);
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:reconcile-stale-duplicate-decision",
      metadata: expect.objectContaining({ priorPausedReason: "duplicate-decision-required" }),
    }));
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-04:30 (the sweep was inert on a renamed board):

  `isNearDuplicateCanonicalInactive` was called without the canonical's resolved flags, so it fell
  back to the legacy `done`/`archived` ids. A canonical resting in `shipped` read as still ACTIVE,
  this sweep skipped it, and the stranded card kept its "Needs your decision" badge pointing at work
  that had finished — the precise stranding FN-8356 exists to clear.

  Differential: `shipped` collides with no legacy literal, so a surviving `"done"` cannot pass here
  by luck, and the control above proves the default vocabulary still works.
  */
  it("preserves an executable prompt while clearing an inactive title-only redirect", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-stale-title-redirect-"));
    const card = stranded("KB-1", "KB-404", { title: "DUPLICATE: KB-404" });
    const promptPath = join(root, ".fusion", "tasks", card.id, "PROMPT.md");
    await mkdir(join(root, ".fusion", "tasks", card.id), { recursive: true });
    await writeFile(promptPath, "# Operator-authored plan\n", "utf8");
    const store = storeFor([card]);
    const manager = new SelfHealingManager(store, { rootDir: root });

    try {
      expect(await manager.reconcileStaleDuplicateDecisionPause()).toBe(1);
      await expect(readFile(promptPath, "utf8")).resolves.toBe("# Operator-authored plan\n");
      expect(await store.getTask(card.id)).toMatchObject({ title: "Duplicate redirect cleared: KB-404" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when stale metadata conflicts with prompt and title redirects", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-stale-duplicate-conflict-"));
    const card = stranded("KB-1", "KB-404", { title: "DUPLICATE: KB-404" });
    const promptPath = join(root, ".fusion", "tasks", card.id, "PROMPT.md");
    await mkdir(join(root, ".fusion", "tasks", card.id), { recursive: true });
    await writeFile(promptPath, "DUPLICATE: KB-405\n", "utf8");
    const store = storeFor([card]);
    const manager = new SelfHealingManager(store, { rootDir: root });

    try {
      expect(await manager.reconcileStaleDuplicateDecisionPause()).toBe(0);
      await expect(readFile(promptPath, "utf8")).resolves.toBe("DUPLICATE: KB-405\n");
      expect(await store.getTask(card.id)).toMatchObject({
        title: "DUPLICATE: KB-404",
        paused: true,
        pausedReason: "duplicate-decision-required",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("self-healing resolves a title-only custom-prefix redirect without discarding its plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-title-marker-sweep-"));
    const card = task("KB-1", { title: "DUPLICATE: KB-123" });
    const canonical = task("KB-123", { column: "todo" });
    const promptPath = join(root, ".fusion", "tasks", card.id, "PROMPT.md");
    await mkdir(join(root, ".fusion", "tasks", card.id), { recursive: true });
    await writeFile(promptPath, "# Operator-authored plan\n", "utf8");
    const store = storeFor([card, canonical]);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ triageDuplicateResolution: "keep" } as Settings);
    const manager = new SelfHealingManager(store, { rootDir: root });
    vi.spyOn(manager as any, "filterByPreWipRole").mockResolvedValue([card]);

    try {
      expect(await manager.resolveExplicitDuplicateMarkerTasks()).toBe(1);
      await expect(readFile(promptPath, "utf8")).resolves.toBe("# Operator-authored plan\n");
      expect(await store.getTask(card.id)).toMatchObject({
        title: "Duplicate redirect cleared: KB-123",
        status: "needs-replan",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renamed vocabulary: clears the decision for a canonical resting in a RENAMED complete column", async () => {
    const shipped = task("FN-SHIPPED", { column: "shipped" });
    const strandedCard = stranded("FN-1", shipped.id, { column: "drafting" });
    const store = storeFor([strandedCard, shipped], RENAMED_IR);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileStaleDuplicateDecisionPause()).toBe(1);
    const recovered = await store.getTask("FN-1");
    expect(recovered?.paused).toBe(false);
    expect(recovered?.pausedReason).toBeNull();
    expect(recovered?.status).toBe("needs-replan");
  });

  /*
  The paired negative on the same vocabulary: resolving real flags must not degrade into "every
  column is terminal", which would clear a decision whose canonical is still being worked on.
  */
  it("renamed vocabulary: leaves the decision alone while the canonical is still in the WIP lane", async () => {
    const building = task("FN-BUILDING", { column: "building" });
    const strandedCard = stranded("FN-1", building.id, { column: "drafting" });
    const store = storeFor([strandedCard, building], RENAMED_IR);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileStaleDuplicateDecisionPause()).toBe(0);
    expect(await store.getTask("FN-1")).toMatchObject({ paused: true, pausedReason: "duplicate-decision-required" });
  });

  it("leaves active canonical decisions, user pauses, unrelated reasons, and non-marker sources untouched", async () => {
    const active = task("FN-ACTIVE", { column: "todo" });
    const activeDecision = stranded("FN-1", active.id);
    const userPaused = stranded("FN-2", "FN-MISSING", { userPaused: true });
    const unrelatedPause = stranded("FN-3", "FN-MISSING", { pausedReason: "awaiting-approval" });
    const nonMarker = stranded("FN-4", "FN-MISSING", { sourceMetadata: { duplicateSource: "other", nearDuplicateOf: "FN-MISSING" } });
    const store = storeFor([active, activeDecision, userPaused, unrelatedPause, nonMarker]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileStaleDuplicateDecisionPause()).toBe(0);
    for (const entry of [activeDecision, userPaused, unrelatedPause, nonMarker]) {
      expect(await store.getTask(entry.id)).toMatchObject({ paused: true, pausedReason: entry.pausedReason });
    }
    expect(recordRunAuditEventMock).not.toHaveBeenCalled();
  });
});
