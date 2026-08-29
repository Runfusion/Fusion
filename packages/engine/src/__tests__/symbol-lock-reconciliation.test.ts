import { describe, expect, it, vi } from "vitest";
import { SelfHealingManager } from "../self-healing.js";
import type { TaskStore } from "@fusion/core";

describe("SelfHealingManager symbol-lock reconciliation", () => {
  it("audits stale lock reclamation and dedupes an idle no-action sweep", async () => {
    const reconcileStaleSymbolLocks = vi.fn()
      .mockResolvedValueOnce({ reconciled: ["pkg/a.ts#a"], skipped: ["pkg/live.ts#a"] })
      .mockResolvedValue({ reconciled: [], skipped: ["pkg/live.ts#a"] });
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const manager = new SelfHealingManager({ reconcileStaleSymbolLocks, recordRunAuditEvent } as unknown as TaskStore, { rootDir: "/tmp/symbol-lock-test" });
    await expect(manager.reconcileStaleSymbolLocks()).resolves.toBe(1);
    await expect(manager.reconcileStaleSymbolLocks()).resolves.toBe(0);
    await expect(manager.reconcileStaleSymbolLocks()).resolves.toBe(0);
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(2);
    expect(recordRunAuditEvent.mock.calls[0]?.[0]).toMatchObject({ mutationType: "symbol-lock:reconcile-stale", metadata: { count: 1, outcome: "reconciled" } });
    expect(recordRunAuditEvent.mock.calls[1]?.[0]).toMatchObject({ mutationType: "symbol-lock:reconcile-stale-no-action", metadata: { count: 0, outcome: "no-action" } });
  });
});
