import { describe, expect, it } from "vitest";
import type { RunAuditEventInput, TaskStore } from "@fusion/core";
import { createRunAuditor } from "../util/run-audit.js";

class AuditStoreStub {
  events: RunAuditEventInput[] = [];
  recordRunAuditEvent(event: RunAuditEventInput): void {
    this.events.push(event);
  }
}

describe("createRunAuditor sandbox domain", () => {
  it("records sandbox events with metadata", async () => {
    const store = new AuditStoreStub();
    const auditor = createRunAuditor(store as unknown as TaskStore, {
      runId: "run-1",
      agentId: "agent-1",
      taskId: "FN-1",
      phase: "execute",
    });

    await auditor.sandbox({
      type: "sandbox:run",
      target: "native",
      metadata: { timeoutMs: 12000, exitCode: 0 },
    });

    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      runId: "run-1",
      agentId: "agent-1",
      taskId: "FN-1",
      domain: "sandbox",
      mutationType: "sandbox:run",
      target: "native",
    });
    expect(store.events[0].metadata).toMatchObject({
      phase: "execute",
      timeoutMs: 12000,
      exitCode: 0,
    });
  });

  it("no-ops when context is null", async () => {
    const store = new AuditStoreStub();
    const auditor = createRunAuditor(store as unknown as TaskStore, null);

    await auditor.sandbox({ type: "sandbox:prepare", target: "native" });

    expect(store.events).toHaveLength(0);
  });

  it("no-ops when store lacks recordRunAuditEvent", async () => {
    const storeWithoutAudit = {} as TaskStore;
    const auditor = createRunAuditor(storeWithoutAudit, {
      runId: "run-2",
      agentId: "agent-2",
      taskId: "FN-2",
    });

    await expect(
      auditor.sandbox({ type: "sandbox:failure", target: "native", metadata: { errorMessage: "boom" } }),
    ).resolves.toBeUndefined();
  });
});
