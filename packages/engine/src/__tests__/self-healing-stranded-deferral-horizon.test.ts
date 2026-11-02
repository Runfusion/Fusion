/*
FNXC:StrandedContinuationDeferralHorizon 2026-11-02-12:27 (RUFU-299):
Sweep-level proof that a deferred stranded continuation stays BOUNDED and OBSERVABLE.

The classifier tests already prove what `evaluateStrandedContinuationReclaim` returns. What only the sweep can
prove is what it then DOES with that verdict, and every one of those facts has a failure mode a mock that
echoes its inputs would hide:

- the episode anchor must be stamped at the FIRST deferral and PRESERVED by every later one. A sweep that
  re-stamped it each pass would make the horizon slide forward forever and never reveal — the exact RUFU-547
  hazard — while still looking green under a fake that returns whatever patch it was handed.
- the reveal must actually CLEAR both `retryAfter` and the anchor, and must clear them in the one guarded
  write, because a reveal that cleared only the ladder restarts the episode at the top rung.
- one reveal per episode, and no event row at all when the compare-and-set loses.
- the noise bounders hold: one `-defer-sustained` event row AND one `[recovery]` card line per episode across
  every saturated pass, one `[recovery]` line per reveal, and nothing at all from a lost compare-and-set. The
  line is per EPISODE, not per pass, because RUFU-263 removed this sweep's per-pass writes after one card
  carried 782 identical `[recovery]` lines while the card itself never moved.

The store fake is therefore STATEFUL: transitions apply their patch to the row, and a compare-and-set whose
`expectedState` no longer matches returns the row exactly as the other writer left it. Assertions read the
row back after each pass, never the call list.

Surface enumeration: first deferral, second deferral, saturated deferral, reveal, reveal-after-reveal, a lost
CAS on both the deferral and the reveal, and the ladder's own advance (asserted unchanged by the sibling
owner-routing file).
*/
import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore, WorkflowWorkItem } from "@fusion/core";

const { recordRunAuditEventMock, resolveTaskLifecycleColumnsMock } = vi.hoisted(() => ({
  recordRunAuditEventMock: vi.fn(async () => undefined),
  resolveTaskLifecycleColumnsMock: vi.fn(),
}));
vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  resolveTaskLifecycleColumns: resolveTaskLifecycleColumnsMock,
  resolveProjectColumnsForRoles: vi.fn(async () => new Set(["in-review"])),
  resolveWorkflowIrForTask: vi.fn(async () => ({ version: "v2", columns: [], nodes: [], edges: [] })),
  resolveColumnFlags: (column: { id: string }) => column.id === "todo" ? ({ countsTowardWip: true }) : ({ mergeBlocker: true }),
  resolveContainedBackwardTargetForTask: vi.fn(async () => "todo"),
}));
vi.mock("../util/run-audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../util/run-audit.js")>()),
  createRunAuditor: vi.fn(() => ({ database: recordRunAuditEventMock })),
}));

import { SelfHealingManager } from "../self-healing.js";
import {
  DEPENDENCY_HOLD_REASON_PREFIX,
  RECLAIM_DEFERRAL_HORIZON_MS,
  RECLAIM_DEFERRAL_LADDER_MS,
} from "../workflows/stranded-continuation-reclaim.js";

const DAY = 24 * 3_600_000;
const TOP_RUNG = RECLAIM_DEFERRAL_LADDER_MS[RECLAIM_DEFERRAL_LADDER_MS.length - 1]!;
const STALE = 20 * 60_000;

/** A `held` dependency wait whose blocker is still real, so every pass routes to the deferral ladder. */
function heldDependencyRow(overrides: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem {
  return {
    id: "wi-horizon", runId: "run-horizon", taskId: "RUFU-299", nodeId: "plan-review", kind: "task",
    state: "held", attempt: 0,
    retryAfter: null, leaseOwner: null, leaseExpiresAt: null, lastError: null,
    blockedReason: `${DEPENDENCY_HOLD_REASON_PREFIX}RUFU-196`,
    deferredSince: null,
    createdAt: new Date(Date.now() - STALE).toISOString(),
    updatedAt: new Date(Date.now() - STALE).toISOString(),
    ...overrides,
  } as unknown as WorkflowWorkItem;
}

/**
 * Stateful row store: a transition applies its patch, and a compare-and-set that no longer matches returns
 * the row untouched. Nothing here can confirm a patch the sweep forgot to send.
 */
function harness(rows: WorkflowWorkItem[], options: { casLoses?: boolean } = {}) {
  const live: WorkflowWorkItem[] = rows.map((row) => ({ ...row }));
  const logged: string[] = [];
  const task = {
    id: "RUFU-299", title: "horizon", description: "", column: "todo",
    dependencies: [], steps: [], currentStep: 0, log: [],
    blockedBy: "RUFU-196",
    createdAt: new Date(Date.now() - STALE).toISOString(),
    updatedAt: new Date(Date.now() - STALE).toISOString(),
  } as unknown as Task;
  const store = {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false } as Settings)),
    listDueWorkflowWorkItems: vi.fn(async () => live.map((row) => ({ ...row }))),
    getTask: vi.fn(async (id: string) => (id === task.id ? task : undefined)),
    transitionWorkflowWorkItem: vi.fn(async (id: string, _state: string, patch: Record<string, unknown>) => {
      const row = live.find((entry) => entry.id === id);
      if (!row) throw new Error(`unknown work item ${id}`);
      // A lost compare-and-set returns the row exactly as the competing writer left it.
      if (options.casLoses || patch.expectedState !== row.state) return { ...row };
      const { expectedState, expectedLeaseOwner, ...written } = patch;
      void expectedState; void expectedLeaseOwner;
      Object.assign(row, written);
      return { ...row };
    }),
    logEntry: vi.fn(async (_id: string, message: string) => { logged.push(message); }),
    recordRunAuditEvent: recordRunAuditEventMock,
    getRootDir: vi.fn(() => "/repo"),
    getTasksDir: vi.fn(() => ""),
  } as unknown as TaskStore;
  resolveTaskLifecycleColumnsMock.mockResolvedValue({ complete: "done" });
  return {
    store,
    logged,
    readRow: () => ({ ...live[0] }),
    manager: new SelfHealingManager(store, { rootDir: "/repo" }),
  };
}

/** Every stranded-reclaim audit row emitted so far, as `{ type, metadata }`. */
function emitted(type?: string): Array<{ type: string; metadata: Record<string, unknown> }> {
  return recordRunAuditEventMock.mock.calls
    .map(([row]) => row as unknown as { type?: string; metadata?: Record<string, unknown> })
    .filter((row) => typeof row.type === "string" && row.type.startsWith("workflowWorkItem:reconcile-stranded"))
    .map((row) => ({ type: row.type!, metadata: row.metadata ?? {} }))
    .filter((row) => type === undefined || row.type === type);
}

describe("reconcileStrandedWorkflowContinuations — deferral horizon (RUFU-299)", () => {
  it("stamps the episode anchor on the first deferral and preserves it on every later one", async () => {
    recordRunAuditEventMock.mockClear();
    const h = harness([heldDependencyRow()]);

    await h.manager.reconcileStrandedWorkflowContinuations();
    const first = h.readRow();
    expect(first.retryAfter, "the first deferral still sets the ladder").not.toBeNull();
    expect(first.deferredSince, "the first deferral anchors the episode").not.toBeNull();
    const anchoredAt = first.deferredSince!;
    expect(new Date(anchoredAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(anchoredAt).not.toBe(first.retryAfter, "the anchor is not a copy of the ladder");

    // A second pass, one rung up. The anchor must not move: a horizon that slides forward never elapses.
    const secondPass = harness([first]);
    await secondPass.manager.reconcileStrandedWorkflowContinuations();
    const second = secondPass.readRow();
    expect(second.deferredSince).toBe(anchoredAt);
    expect(Date.parse(second.retryAfter!)).toBeGreaterThan(Date.parse(first.retryAfter!));
  });

  it("records every saturated pass as an event row but announces the card only once per episode", async () => {
    /*
    The fake store returns the row on every pass regardless of its `retryAfter`, which production would honour —
    so these four back-to-back passes stand for four rung-widths of real time. That is the shape the assertion
    needs: the EVENT rows count the saturated passes (the symptom report's unanswered "how many times was the
    widest rung applied?"), while the CARD line stays at one, which is the channel RUFU-263 flooded.
    */
    recordRunAuditEventMock.mockClear();
    // Already at the ceiling with an anchor a day old: this pass re-applies the top rung.
    const saturated = heldDependencyRow({
      retryAfter: new Date(Date.now() - STALE + TOP_RUNG).toISOString(),
      deferredSince: new Date(Date.now() - DAY).toISOString(),
    });
    const h = harness([saturated]);

    await h.manager.reconcileStrandedWorkflowContinuations();
    expect(emitted("workflowWorkItem:reconcile-stranded-defer-sustained")).toHaveLength(1);
    const row = emitted("workflowWorkItem:reconcile-stranded-defer-sustained")[0]!.metadata;
    expect(row).toMatchObject({
      taskId: "RUFU-299",
      workItemId: "wi-horizon",
      nodeId: "plan-review",
      kind: "task",
      priorState: "held",
      reason: "dependency-hold",
      deferralAgeMs: expect.any(Number),
      rungMs: TOP_RUNG,
    });
    expect(Number(row.deferralAgeMs)).toBeGreaterThanOrEqual(DAY - 60_000);
    expect(row.deferralSince, "the row names the episode it is saturating").not.toBeNull();

    // The card's notice is per episode, not per pass.
    expect(h.logged, "one saturated pass writes one card-history line").toHaveLength(1);
    expect(h.logged[0]).toContain("[recovery] workflow continuation deferral saturated");

    // The SAME manager, three more saturated passes: each is counted, none of them re-announces the card.
    for (let pass = 0; pass < 3; pass += 1) {
      await h.manager.reconcileStrandedWorkflowContinuations();
    }
    expect(emitted("workflowWorkItem:reconcile-stranded-defer-sustained"), "every saturated pass is countable")
      .toHaveLength(4);
    expect(h.logged, "but the card heard about the episode once").toHaveLength(1);
  });

  it("reveals past the horizon: both the ladder and the anchor are cleared, once, with one event row", async () => {
    recordRunAuditEventMock.mockClear();
    const aged = heldDependencyRow({
      retryAfter: new Date(Date.now() - STALE + TOP_RUNG).toISOString(),
      deferredSince: new Date(Date.now() - RECLAIM_DEFERRAL_HORIZON_MS - DAY).toISOString(),
    });
    const h = harness([aged]);

    await h.manager.reconcileStrandedWorkflowContinuations();
    const row = h.readRow();
    expect(row.retryAfter, "the deferral is refused, so the due-gate opens").toBeNull();
    expect(row.deferredSince, "the anchor is cleared, which is what bounds reveal to one per episode").toBeNull();
    expect(row.leaseExpiresAt, "and no future-looking gate is left on the row at all").toBeNull();
    expect(row.state, "a reveal is not a reclaim — the wait keeps its state").toBe("held");
    expect(row.blockedReason, "and keeps its reason").toBe(`${DEPENDENCY_HOLD_REASON_PREFIX}RUFU-196`);

    const revealed = emitted("workflowWorkItem:reconcile-stranded-revealed");
    expect(revealed).toHaveLength(1);
    expect(revealed[0]!.metadata).toMatchObject({
      taskId: "RUFU-299",
      workItemId: "wi-horizon",
      nodeId: "plan-review",
      kind: "task",
      priorState: "held",
      reason: "dependency-hold",
    });
    expect(Number(revealed[0]!.metadata.deferralAgeMs))
      .toBeGreaterThanOrEqual(RECLAIM_DEFERRAL_HORIZON_MS - 60_000);

    // One reveal per episode: the next pass has no anchor, so it starts a FRESH episode at rung 0 instead of
    // clearing the same row again. The card is back in sight and the ladder is back to working.
    const after = harness([row]);
    await after.manager.reconcileStrandedWorkflowContinuations();
    const nextPass = after.readRow();
    expect(nextPass.deferredSince, "a new episode anchors now").not.toBeNull();
    expect(Date.parse(nextPass.retryAfter!) - Date.parse(nextPass.deferredSince!))
      .toBe(RECLAIM_DEFERRAL_LADDER_MS[0]);
    expect(emitted("workflowWorkItem:reconcile-stranded-revealed")).toHaveLength(1);
    expect(h.logged, "the reveal writes exactly one card-history line").toHaveLength(1);
    expect(h.logged[0]).toContain("[recovery] workflow continuation deferral revealed");
  });

  it("claims nothing when the compare-and-set loses, on either the deferral or the reveal", async () => {
    // A competing writer owns the row: every guarded write returns the row as that writer left it, so the
    // sweep must neither move the row nor announce an outcome it did not produce.
    recordRunAuditEventMock.mockClear();
    const deferred = harness([heldDependencyRow()], { casLoses: true });
    await deferred.manager.reconcileStrandedWorkflowContinuations();
    const unwritten = deferred.readRow();
    expect(unwritten.deferredSince, "a lost deferral anchors nothing").toBeNull();
    expect(unwritten.retryAfter, "and stamps no ladder").toBeNull();
    expect(emitted("workflowWorkItem:reconcile-stranded-defer-sustained"), "and claims no saturated outcome")
      .toEqual([]);

    recordRunAuditEventMock.mockClear();
    const revealed = harness([{
      ...heldDependencyRow({
        retryAfter: new Date(Date.now() - STALE + TOP_RUNG).toISOString(),
        deferredSince: new Date(Date.now() - RECLAIM_DEFERRAL_HORIZON_MS - DAY).toISOString(),
      }),
    }], { casLoses: true });
    await revealed.manager.reconcileStrandedWorkflowContinuations();
    const stuck = revealed.readRow();
    expect(stuck.retryAfter).not.toBeNull();
    expect(stuck.deferredSince).not.toBeNull();
    expect(emitted("workflowWorkItem:reconcile-stranded-revealed"), "a lost reveal emits no event row")
      .toEqual([]);
    expect(revealed.logged, "and announces a reveal it did not perform to nobody").toEqual([]);
  });
});
