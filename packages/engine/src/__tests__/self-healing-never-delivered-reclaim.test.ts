/*
FNXC:AlreadyMergedFalsePositive 2026-10-11-13:10 (RUFU-396):
Sweep-level pin for the routing decision, measured on the shape the operator recorded for RUFU-391:
`main..fusion/rufu-391` holds ZERO commits, `main` carries two commits whose messages contain
`Fusion-Task-Id: RUFU-391` while their bodies and content belong to RUFU-388, and the card's declared
scope is absent from main. Before this change the base-history grep counted those stamps as delivery,
so `foreignTipRejection` refused, and every refusal burned a bounded recovery pass until the card sat
terminal in `branch-conflict-recovery-exhausted` with work still to do.

Both directions are pinned here, because the pair is the invariant:
  - proven never-delivered  → no refusal, no budget burn, announced on the card and in run-audit;
  - verified own landed commit (RUFU-378's shape) → the refusal still fires and still counts.
The proof internals themselves are unit-tested in self-healing-never-delivered-proof.test.ts; this file
spies `baseDeliveryEvidence` so it exercises only the sweep's use of its verdict.
*/
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { withBranchWriteProvenance } from "./branch-write-provenance-store-stub.js";

vi.mock("../worktree/worktree-pool.js", () => ({
  isUsableTaskWorktree: vi.fn().mockResolvedValue(true),
  classifyTaskWorktree: vi.fn().mockResolvedValue({ ok: false, classification: "missing", reason: "test" }),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  relocateReclaimableWorktreeIntoRoot: vi.fn(async ({ sourcePath }: { sourcePath: string }) => ({
    kind: "ready" as const,
    path: sourcePath,
    relocated: false,
  })),
  getRegisteredWorktreePaths: vi.fn().mockReturnValue([]),
  getRegisteredWorktreeBranchMap: vi.fn().mockReturnValue(new Map()),
  resolveWorktreeBackend: vi.fn().mockReturnValue({ kind: "native" }),
  scanIdleWorktrees: vi.fn().mockResolvedValue([]),
  scanOrphanedBranches: vi.fn().mockResolvedValue([]),
}));

const mocked = vi.hoisted(() => ({
  inspectBranchConflict: vi.fn(),
  resolveTrustedIntegrationRefs: vi.fn(),
  recoverForeignOnlyContamination: vi.fn(),
}));

vi.mock("../execution/branch-conflicts.js", async () => {
  const actual = await vi.importActual<typeof import("../execution/branch-conflicts.js")>(
    "../execution/branch-conflicts.js",
  );
  return {
    ...actual,
    inspectBranchConflict: mocked.inspectBranchConflict,
    resolveTrustedIntegrationRefs: mocked.resolveTrustedIntegrationRefs,
  };
});

vi.mock("../recovery/foreign-only-contamination.js", async () => {
  const actual = await vi.importActual<typeof import("../recovery/foreign-only-contamination.js")>(
    "../recovery/foreign-only-contamination.js",
  );
  return { ...actual, recoverForeignOnlyContamination: mocked.recoverForeignOnlyContamination };
});

import { SelfHealingManager } from "../self-healing.js";

const NOW = "2026-10-11T13:10:00.000Z";
/** The tip RUFU-391 inherited from the previously landed card. */
const FOREIGN_TIP = "df42f2b218dd00000000000000000000000000";

/** RUFU-391's declared scope, carried on `sourceMetadata` so no prompt file has to exist. */
const DECLARED_SCOPE = [
  "packages/cli/src/commands/settings.ts",
  "packages/engine/src/triage.ts",
  "docs/cli-reference.md",
];

function stuckCard(): Task {
  return {
    id: "RUFU-391",
    title: "RUFU-391",
    description: "zero-own-commit card whose id was reused by other work on main",
    column: "in-review",
    status: "failed",
    paused: true,
    pausedReason: "branch-conflict-unrecoverable",
    userPaused: false,
    branch: "fusion/rufu-391",
    branchWriteOrigin: "engine",
    worktree: "/tmp/fusion-rufu396/rufu-391",
    baseCommitSha: FOREIGN_TIP,
    sourceMetadata: { fileScope: DECLARED_SCOPE },
    dependencies: [],
    steps: [],
    log: [],
    createdAt: NOW,
    updatedAt: NOW,
  } as Task;
}

function createStore(initialTasks: Task[]) {
  const tasks = new Map(initialTasks.map((task) => [task.id, { ...task }]));
  const settings = {
    globalPause: false,
    enginePaused: false,
    autoMerge: true,
    maintenanceIntervalMs: 0,
    autoRecovery: { mode: "deterministic-only" as const, maxRetries: 3 },
  } as Settings;

  const updateTask = vi.fn(withBranchWriteProvenance(async (id: string, patch: Partial<Task>) => {
    const current = tasks.get(id);
    if (!current) throw new Error(`Task ${id} missing`);
    const next = { ...current, ...patch } as Task;
    tasks.set(id, next);
    return next;
  }));
  const logEntry = vi.fn(async () => undefined);
  const recordRunAuditEvent = vi.fn(async () => undefined);

  const store = Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => {
      const values = [...tasks.values()].filter((task) => !task.deletedAt);
      return column ? values.filter((task) => task.column === column) : values;
    }),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    updateTask,
    moveTask: vi.fn(async (id: string, column: Task["column"]) => {
      const current = tasks.get(id);
      if (!current) throw new Error(`Task ${id} missing`);
      const next = { ...current, column } as Task;
      tasks.set(id, next);
      return next;
    }),
    logEntry,
    recordRunAuditEvent,
    handoffToReview: vi.fn(async (id: string) => tasks.get(id)!),
    recordAgentActivity: vi.fn(async () => undefined),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
  }) as unknown as TaskStore & EventEmitter;

  return { store, tasks, updateTask, logEntry, recordRunAuditEvent };
}

function managerFor(store: TaskStore & EventEmitter) {
  const manager = new SelfHealingManager(store, {
    rootDir: "/tmp/fusion-rufu396",
    getExecutingTaskIds: () => new Set<string>(),
  });
  vi.spyOn(manager as any, "evaluateBackwardMoveTripleProof").mockResolvedValue({
    ok: true,
    stalenessMs: 0,
    reason: "test",
    metadata: {},
  });
  // The tip is an ancestor of main with nothing unique (zero own commits), and the base does
  // mention the card's id — the exact condition that used to be read as delivery.
  vi.spyOn(manager as any, "branchHasNoUniqueDiff").mockResolvedValue(true);
  vi.spyOn(manager as any, "baseHasExplicitTaskOwnership").mockResolvedValue(true);
  vi.spyOn(manager as any, "readCommitTaskOwnership").mockResolvedValue({
    owned: false,
    ownerTaskId: "RUFU-388",
    rejectionReason: "foreign-task",
  });
  return manager;
}

function messagesFor(logEntry: ReturnType<typeof vi.fn>): string[] {
  return logEntry.mock.calls.map((call) => String(call[1] ?? ""));
}

function auditRows(recordRunAuditEvent: ReturnType<typeof vi.fn>, mutationType: string) {
  return recordRunAuditEvent.mock.calls
    .map((call) => (call[0] ?? call[1]) as { mutationType?: string; metadata?: Record<string, unknown> })
    .filter((event) => event?.mutationType === mutationType);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.recoverForeignOnlyContamination.mockResolvedValue({ recovered: false, reason: "ambiguous" });
  mocked.resolveTrustedIntegrationRefs.mockResolvedValue(["main"]);
  mocked.inspectBranchConflict.mockResolvedValue({
    kind: "tip-already-merged",
    tipSha: FOREIGN_TIP,
    integrationRef: "main",
    landedVia: "ancestor",
  });
});

describe("already-merged never-delivered routing (sweep)", () => {
  it("withholds the foreign-tip refusal for a card whose stamped base commits touch none of its scope", async () => {
    const task = stuckCard();
    const { store, tasks, logEntry, recordRunAuditEvent } = createStore([task]);
    const manager = managerFor(store);
    vi.spyOn(manager as any, "baseDeliveryEvidence").mockResolvedValue({
      hasVerifiedOwnLandedCommit: false,
      scopeNeverDelivered: true,
      stampedBaseCommitCount: 2,
      ownLandedCommitCount: 0,
      scopePathCount: DECLARED_SCOPE.length,
    });

    await manager.reclaimSelfOwnedBranchConflicts();

    const messages = messagesFor(logEntry);
    expect(messages.some((message) => message.includes("already-merged rejected"))).toBe(false);
    expect(messages.some((message) => message.includes("already-merged never-delivered"))).toBe(true);
    // No budget burn and no terminal park: the card stays re-dispatchable.
    expect(tasks.get(task.id)?.recoveryRetryCount).toBeUndefined();
    expect(tasks.get(task.id)?.pausedReason).not.toBe("branch-conflict-recovery-exhausted");
    const rows = auditRows(recordRunAuditEvent, "task:already-merged-never-delivered");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({
      baseBranch: "main",
      stampedBaseCommitCount: 2,
      ownLandedCommitCount: 0,
      declaredScopePathCount: DECLARED_SCOPE.length,
      outcome: "reclaimed",
    });
    // Ids/counts only — never scope prose or commit messages.
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain("packages/cli");
  });

  it("still refuses and still counts a card whose own landed commit is verified on the base", async () => {
    const task = stuckCard();
    const { store, tasks, logEntry } = createStore([task]);
    const manager = managerFor(store);
    vi.spyOn(manager as any, "baseDeliveryEvidence").mockResolvedValue({
      hasVerifiedOwnLandedCommit: true,
      scopeNeverDelivered: false,
      stampedBaseCommitCount: 1,
      ownLandedCommitCount: 1,
      scopePathCount: DECLARED_SCOPE.length,
    });

    await manager.reclaimSelfOwnedBranchConflicts();

    const messages = messagesFor(logEntry);
    expect(messages.some((message) => message.includes("already-merged rejected") && message.includes("reason=foreign-task-tip"))).toBe(true);
    expect(tasks.get(task.id)?.recoveryRetryCount).toBe(1);
  });

  it("keeps today's grep verdict when the proof cannot answer (unknown → no rescue, no new event)", async () => {
    const task = stuckCard();
    const { store, logEntry, recordRunAuditEvent } = createStore([task]);
    const manager = managerFor(store);
    // `null` is what `baseDeliveryEvidence` returns when a git read failed.
    vi.spyOn(manager as any, "baseDeliveryEvidence").mockResolvedValue(null);

    await manager.reclaimSelfOwnedBranchConflicts();

    const messages = messagesFor(logEntry);
    expect(messages.some((message) => message.includes("already-merged rejected"))).toBe(true);
    expect(auditRows(recordRunAuditEvent, "task:already-merged-never-delivered")).toHaveLength(0);
  });
});
