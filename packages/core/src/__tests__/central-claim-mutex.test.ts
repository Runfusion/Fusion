import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCentralDatabase, type CentralDatabase } from "../central-db.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fn-central-claim-test-"));
}

describe("central claim mutex", () => {
  let globalDir: string;
  let db: CentralDatabase;

  beforeEach(() => {
    globalDir = makeTmpDir();
    db = createCentralDatabase(globalDir);
    db.init();
  });

  afterEach(async () => {
    db.close();
    await rm(globalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("first claim creates epoch 1 row", () => {
    const result = db.tryClaimTask({
      projectId: "P-1",
      taskId: "FN-1",
      nodeId: "node-a",
      agentId: "agent-a",
      runId: "run-1",
      renewedAt: "2026-05-16T00:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claim.leaseEpoch).toBe(1);
    expect(result.claim.ownerAgentId).toBe("agent-a");
    expect(result.claim.ownerNodeId).toBe("node-a");
  });

  it("different owner without expectedEpoch conflicts and does not mutate", () => {
    db.tryClaimTask({ projectId: "P-1", taskId: "FN-1", nodeId: "node-a", agentId: "agent-a", runId: "run-1", renewedAt: "2026-05-16T00:00:00.000Z" });
    const conflict = db.tryClaimTask({ projectId: "P-1", taskId: "FN-1", nodeId: "node-b", agentId: "agent-b", runId: "run-2", renewedAt: "2026-05-16T00:01:00.000Z" });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.reason).toBe("conflict");
    expect(conflict.current.ownerAgentId).toBe("agent-a");
    const row = db.getTaskClaim("P-1", "FN-1");
    expect(row?.ownerAgentId).toBe("agent-a");
    expect(row?.leaseEpoch).toBe(1);
  });

  it("owner-change with matching expectedEpoch increments exactly by one", () => {
    db.tryClaimTask({ projectId: "P-1", taskId: "FN-1", nodeId: "node-a", agentId: "agent-a", runId: "run-1", renewedAt: "2026-05-16T00:00:00.000Z" });
    const changed = db.tryClaimTask({ projectId: "P-1", taskId: "FN-1", nodeId: "node-b", agentId: "agent-b", runId: "run-2", renewedAt: "2026-05-16T00:01:00.000Z", expectedEpoch: 1 });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.claim.leaseEpoch).toBe(2);
    expect(changed.claim.ownerAgentId).toBe("agent-b");
  });

  it("renew with matching expectedEpoch preserves epoch and updates renewedAt", () => {
    db.tryClaimTask({ projectId: "P-1", taskId: "FN-1", nodeId: "node-a", agentId: "agent-a", runId: "run-1", renewedAt: "2026-05-16T00:00:00.000Z" });
    const renewed = db.renewTaskClaim({ projectId: "P-1", taskId: "FN-1", nodeId: "node-a", agentId: "agent-a", runId: "run-2", renewedAt: "2026-05-16T00:02:00.000Z", expectedEpoch: 1 });
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    expect(renewed.claim.leaseEpoch).toBe(1);
    expect(renewed.claim.ownerRunId).toBe("run-2");
    expect(renewed.claim.leaseRenewedAt).toBe("2026-05-16T00:02:00.000Z");
  });

  it("renew with stale expectedEpoch conflicts", () => {
    db.tryClaimTask({ projectId: "P-1", taskId: "FN-1", nodeId: "node-a", agentId: "agent-a", runId: "run-1", renewedAt: "2026-05-16T00:00:00.000Z" });
    const renewed = db.renewTaskClaim({ projectId: "P-1", taskId: "FN-1", nodeId: "node-a", agentId: "agent-a", runId: "run-2", renewedAt: "2026-05-16T00:02:00.000Z", expectedEpoch: 0 });
    expect(renewed.ok).toBe(false);
    if (renewed.ok) return;
    expect(renewed.reason).toBe("conflict");
  });

  it("release succeeds for owner and not_owner for other agent", () => {
    db.tryClaimTask({ projectId: "P-1", taskId: "FN-1", nodeId: "node-a", agentId: "agent-a", runId: "run-1", renewedAt: "2026-05-16T00:00:00.000Z" });
    const notOwner = db.releaseTaskClaim({ projectId: "P-1", taskId: "FN-1", nodeId: "node-b", agentId: "agent-b" });
    expect(notOwner.ok).toBe(false);
    if (!notOwner.ok) {
      expect(notOwner.reason).toBe("not_owner");
      expect(notOwner.current?.ownerAgentId).toBe("agent-a");
    }
    const released = db.releaseTaskClaim({ projectId: "P-1", taskId: "FN-1", nodeId: "node-a", agentId: "agent-a" });
    expect(released).toEqual({ ok: true });
  });

  it("getTaskClaim returns full row before release and null after", () => {
    db.tryClaimTask({ projectId: "P-1", taskId: "FN-1", nodeId: "node-a", agentId: "agent-a", runId: "run-1", renewedAt: "2026-05-16T00:00:00.000Z" });
    const before = db.getTaskClaim("P-1", "FN-1");
    expect(before).toMatchObject({ projectId: "P-1", taskId: "FN-1", ownerAgentId: "agent-a", ownerNodeId: "node-a", leaseEpoch: 1 });
    db.releaseTaskClaim({ projectId: "P-1", taskId: "FN-1", nodeId: "node-a", agentId: "agent-a" });
    expect(db.getTaskClaim("P-1", "FN-1")).toBeNull();
  });
});
