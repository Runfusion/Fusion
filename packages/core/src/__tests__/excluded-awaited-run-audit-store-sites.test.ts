import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStepResult } from "../types.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../workflows/builtin-coding-workflow-ir.js";
import type { WorkflowIrV2 } from "../workflows/workflow-ir-types.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

/*
 * FNXC:RunAudit 2026-08-20-06:40:
 * FN-9178 characterizes current awaited audit behavior through public store entry points; it is
 * not a remediation. These fixtures are PG-gated because TaskStore's durable methods require the
 * production async layer, while hostile doubles prove the operation's observable ordering.
 */
pgDescribe("FN-9178 awaited store run-audit characterization", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_awaited_audit" });
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const failed = (): WorkflowStepResult => ({
    workflowStepId: "review", workflowStepName: "Review", phase: "pre-merge", status: "failed",
    completedAt: "2026-08-20T00:00:00.000Z",
  });
  const pending = (): WorkflowStepResult => ({
    workflowStepId: "review", workflowStepName: "Review", phase: "pre-merge", status: "pending",
  });

  async function seed(id: string, results: WorkflowStepResult[]) {
    const store = h.store();
    await store.createTaskWithReservedId({ description: id, column: "in-review" }, { taskId: id, applyDefaultWorkflowSteps: false });
    await store.updateTask(id, { workflowStepResults: results });
    return store;
  }

  it("bypass treats an absent/non-function audit result as a completed write", async () => {
    const store = await seed("FN-BYP-ABSENT", [failed()]);
    vi.spyOn(store, "recordRunAuditEvent").mockImplementation(() => undefined as never);
    const write = vi.spyOn(store as never, "atomicWriteTaskJson");
    write.mockClear();
    await expect(store.bypassFailedPreMergeReviewStep("FN-BYP-ABSENT", { reason: "test", actor: "operator" })).resolves.toBeDefined();
    expect(write).toHaveBeenCalledOnce();
  });

  it.each([
    ["synchronous throw", () => { throw new Error("sync"); }],
    ["rejection", () => Promise.reject(new Error("rejected"))],
  ])("bypass rejects and does not persist after a %s audit sink", async (_kind, sink) => {
    const id = `FN-BYP-${_kind.replace(/\W/g, "")}`;
    const store = await seed(id, [failed()]);
    vi.spyOn(store, "recordRunAuditEvent").mockImplementation(sink as never);
    const write = vi.spyOn(store as never, "atomicWriteTaskJson");
    write.mockClear();
    await expect(store.bypassFailedPreMergeReviewStep(id, { reason: "test", actor: "operator" })).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });

  it("bypass remains pending for a never-settling audit sink", async () => {
    const store = await seed("FN-BYP-PENDING", [failed()]);
    vi.useFakeTimers();
    try {
      vi.spyOn(store, "recordRunAuditEvent").mockImplementation(() => new Promise<never>(() => undefined));
      const write = vi.spyOn(store as never, "atomicWriteTaskJson");
      write.mockClear();
      let settled = false;
      void store.bypassFailedPreMergeReviewStep("FN-BYP-PENDING", { reason: "test", actor: "operator" }).finally(() => { settled = true; }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(2_100);
      expect(settled).toBe(false);
      expect(write).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("bypass waits for a late-settling audit before writing task.json", async () => {
    let resolve!: () => void;
    const store = await seed("FN-BYP-LATE", [failed()]);
    const audit = vi.spyOn(store, "recordRunAuditEvent").mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    audit.mockClear();
    const write = vi.spyOn(store as never, "atomicWriteTaskJson");
    write.mockClear();
    const operation = store.bypassFailedPreMergeReviewStep("FN-BYP-LATE", { reason: "test", actor: "operator" });
    await vi.waitFor(() => expect(audit).toHaveBeenCalledOnce());
    expect(write).not.toHaveBeenCalled();
    resolve();
    await expect(operation).resolves.toMatchObject({ id: "FN-BYP-LATE" });
    expect(write).toHaveBeenCalledOnce();
  });

  it.each([
    ["absent", () => undefined, true],
    ["synchronous throw", () => { throw new Error("sync"); }, false],
    ["rejection", () => Promise.reject(new Error("rejected")), false],
  ])("resume-step's persistence follows a %s audit result", async (_state, sink, persists) => {
    const id = `FN-RESUME-${_state.replace(/\W/g, "")}`;
    const store = await seed(id, [pending()]);
    vi.spyOn(store, "recordRunAuditEvent").mockImplementation(sink as never);
    const write = vi.spyOn(store as never, "atomicWriteTaskJson");
    write.mockClear();
    const operation = store.resumeWorkflowStep(id, { stepId: "review", reason: "test", actor: "operator" });
    if (persists) await expect(operation).resolves.toBeDefined();
    else await expect(operation).rejects.toThrow();
    expect(write).toHaveBeenCalledTimes(persists ? 1 : 0);
  });

  it.each([
    ["never-settling", () => new Promise<never>(() => undefined)],
    ["late-settling", () => new Promise<void>((resolve) => setTimeout(resolve, 2_100))],
  ])("resume-step cannot reach persistence while its %s audit is unresolved", async (_state, sink) => {
    const id = `FN-RESUME-${_state}`;
    const store = await seed(id, [pending()]);
    vi.useFakeTimers();
    try {
      vi.spyOn(store, "recordRunAuditEvent").mockImplementation(sink as never);
      const write = vi.spyOn(store as never, "atomicWriteTaskJson");
      write.mockClear();
      let settled = false;
      void store.resumeWorkflowStep(id, { stepId: "review", reason: "test", actor: "operator" }).finally(() => { settled = true; }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(2_100);
      // The late sink would have settled after the prospective bounded-window; an unbounded await
      // either remains pending (never) or only proceeds once its real promise settles (late).
      expect(write).not.toHaveBeenCalled();
      expect(settled).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("preserves WorkflowSwitchRehomeFailedError after all hostile audit outcomes", async () => {
    const sourceIr = structuredClone(BUILTIN_CODING_WORKFLOW_IR) as WorkflowIrV2;
    sourceIr.columns.push({ id: "audit-source", name: "Audit source", traits: [] });
    for (const [state, sink] of [
      ["absent", () => undefined],
      ["sync", () => { throw new Error("sync"); }],
      ["reject", () => Promise.reject(new Error("reject"))],
    ] as const) {
      const store = h.store();
      const source = await store.createWorkflowDefinition({ name: `source ${state}`, ir: sourceIr, layout: {} });
      const target = await store.createWorkflowDefinition({ name: `target ${state}`, ir: structuredClone(BUILTIN_CODING_WORKFLOW_IR) as WorkflowIrV2, layout: {} });
      const task = await store.createTask({ description: `switch ${state}` });
      await store.selectTaskWorkflow(task.id, source.id);
      await store.moveTask(task.id, "audit-source", { moveSource: "engine", bypassGuards: true, recoveryRehome: true });
      vi.spyOn(store, "rehomeOccupant").mockResolvedValue({ moved: false, error: "race" } as never);
      vi.spyOn(store, "recordRunAuditEvent").mockImplementation(sink as never);
      await expect(store.selectTaskWorkflowAndReconcile(task.id, target.id)).rejects.toMatchObject({ name: "WorkflowSwitchRehomeFailedError", committed: true });
      vi.restoreAllMocks();
    }
  });

  it("keeps workflow-switch torn waiting on a never-settling audit promise", async () => {
    const store = h.store();
    const sourceIr = structuredClone(BUILTIN_CODING_WORKFLOW_IR) as WorkflowIrV2;
    sourceIr.columns.push({ id: "audit-never", name: "Audit", traits: [] });
    const source = await store.createWorkflowDefinition({ name: "source never", ir: sourceIr, layout: {} });
    const target = await store.createWorkflowDefinition({ name: "target never", ir: structuredClone(BUILTIN_CODING_WORKFLOW_IR) as WorkflowIrV2, layout: {} });
    const task = await store.createTask({ description: "switch never" });
    await store.selectTaskWorkflow(task.id, source.id);
    await store.moveTask(task.id, "audit-never", { moveSource: "engine", bypassGuards: true, recoveryRehome: true });
    vi.useFakeTimers();
    try {
      vi.spyOn(store, "rehomeOccupant").mockResolvedValue({ moved: false } as never);
      vi.spyOn(store, "recordRunAuditEvent").mockImplementation(() => new Promise<never>(() => undefined));
      let settled = false;
      void store.selectTaskWorkflowAndReconcile(task.id, target.id).finally(() => { settled = true; }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(2_100);
      expect(settled).toBe(false);
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });

  it("throws WorkflowSwitchRehomeFailedError after a late audit settles beyond the bounded window", async () => {
    const store = h.store();
    const sourceIr = structuredClone(BUILTIN_CODING_WORKFLOW_IR) as WorkflowIrV2;
    sourceIr.columns.push({ id: "audit-late", name: "Audit", traits: [] });
    const source = await store.createWorkflowDefinition({ name: "source late", ir: sourceIr, layout: {} });
    const target = await store.createWorkflowDefinition({ name: "target late", ir: structuredClone(BUILTIN_CODING_WORKFLOW_IR) as WorkflowIrV2, layout: {} });
    const task = await store.createTask({ description: "switch late" });
    await store.selectTaskWorkflow(task.id, source.id);
    await store.moveTask(task.id, "audit-late", { moveSource: "engine", bypassGuards: true, recoveryRehome: true });
    let resolveAudit!: () => void;
    let signalAudit!: () => void;
    const auditStarted = new Promise<void>((resolve) => { signalAudit = resolve; });
    try {
      vi.spyOn(store, "rehomeOccupant").mockResolvedValue({ moved: false } as never);
      vi.spyOn(store, "recordRunAuditEvent").mockImplementation(() => new Promise<void>((resolve) => {
        resolveAudit = resolve;
        signalAudit();
      }));
      const operation = store.selectTaskWorkflowAndReconcile(task.id, target.id);
      void operation.catch(() => undefined);
      await auditStarted;
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(2_100);
      resolveAudit();
      await expect(operation).rejects.toMatchObject({ name: "WorkflowSwitchRehomeFailedError", committed: true });
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });

  it.each([
    ["absent", () => undefined, "reconciled"],
    ["synchronous throw", () => { throw new Error("sync"); }, "audit-failed: sync"],
    ["rejection", () => Promise.reject(new Error("rejected")), "audit-failed: rejected"],
  ])("phantom reconciliation exposes %s audit outcome in its public result", async (_state, sink, expected) => {
    const store = h.store();
    const task = await store.createTask({ description: `phantom ${_state}` });
    const layer = h.layer();
    const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
    const { rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const schema = await import("../postgres/schema/index.js");
    const { and, eq } = await import("drizzle-orm");
    await rm(join(h.rootDir(), ".fusion", "tasks", task.id), { recursive: true, force: true });
    await layer.db.delete(schema.project.tasks).where(and(eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, task.id)));
    await layer.db.insert(schema.project.activityLog).values({ projectId, id: `audit-${task.id}`, timestamp: new Date().toISOString(), type: "task:created", taskId: task.id, details: "orphan" });
    vi.spyOn(store, "recordRunAuditEvent").mockImplementation(sink as never);
    const result = await store.reconcilePhantomCommittedReservations();
    if (expected === "reconciled") expect(result.reconciled).toContain(task.id);
    else expect(result.skipped).toContainEqual({ id: task.id, reason: expected });
  });

  it.each(["never", "late"])("phantom reconciliation remains pending when its %s audit does", async (state) => {
    const store = h.store();
    const task = await store.createTask({ description: `phantom ${state}` });
    const layer = h.layer(); const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
    const { rm } = await import("node:fs/promises"); const { join } = await import("node:path");
    const schema = await import("../postgres/schema/index.js"); const { and, eq } = await import("drizzle-orm");
    await rm(join(h.rootDir(), ".fusion", "tasks", task.id), { recursive: true, force: true });
    await layer.db.delete(schema.project.tasks).where(and(eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, task.id)));
    await layer.db.insert(schema.project.activityLog).values({ projectId, id: `audit-${task.id}`, timestamp: new Date().toISOString(), type: "task:created", taskId: task.id, details: "orphan" });
    vi.useFakeTimers();
    try {
      vi.spyOn(store, "recordRunAuditEvent").mockImplementation((state === "never" ? () => new Promise<never>(() => undefined) : () => new Promise<void>((resolve) => setTimeout(resolve, 2_100))) as never);
      let settled = false; void store.reconcilePhantomCommittedReservations().finally(() => { settled = true; }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(2_100);
      expect(settled).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
