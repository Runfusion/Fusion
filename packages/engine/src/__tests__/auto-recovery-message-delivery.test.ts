import { describe, expect, it, vi } from "vitest";
import { MessageDeliveryAutoRecoveryHandler } from "../auto-recovery-handlers/message-delivery.js";

describe("MessageDeliveryAutoRecoveryHandler", () => {
  it("returns delivered on first attempt", async () => {
    const runAudit = { database: vi.fn(), git: vi.fn(), filesystem: vi.fn() } as any;
    const handler = new MessageDeliveryAutoRecoveryHandler({ runAudit, sleep: vi.fn() });
    const result = await handler.runWithBoundedRetry({ run: async () => ({ id: "m1" }), correlation: { kind: "direct", fromAgentId: "a1", toId: "a2" } }, { mode: "programmatic", maxRetries: 3 });
    expect(result.outcome).toBe("delivered");
  });

  it("retries transient failures then delivers", async () => {
    const runAudit = { database: vi.fn(), git: vi.fn(), filesystem: vi.fn() } as any;
    const sleep = vi.fn(async () => {});
    const handler = new MessageDeliveryAutoRecoveryHandler({ runAudit, sleep });
    const run = vi
      .fn<() => Promise<{ id: string }>>()
      .mockRejectedValueOnce(Object.assign(new Error("SQLITE_BUSY"), { code: "SQLITE_BUSY" }))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue({ id: "m2" });
    const result = await handler.runWithBoundedRetry({ run, correlation: { kind: "room", fromAgentId: "a1", roomId: "r1" } }, { mode: "programmatic", maxRetries: 3 });
    expect(result.outcome).toBe("delivered");
    expect(run).toHaveBeenCalledTimes(3);
    expect(runAudit.database).toHaveBeenCalledWith(expect.objectContaining({ type: "message-delivery:retry-issued" }));
  });

  it("parks permanent errors without retry", async () => {
    const runAudit = { database: vi.fn(), git: vi.fn(), filesystem: vi.fn() } as any;
    const run = vi.fn().mockRejectedValue(new Error("Room membership required"));
    const handler = new MessageDeliveryAutoRecoveryHandler({ runAudit, sleep: vi.fn(async () => {}) });
    const result = await handler.runWithBoundedRetry({ run, correlation: { kind: "room", fromAgentId: "a1", roomId: "r1" } }, { mode: "programmatic", maxRetries: 3 });
    expect(result.outcome).toBe("parked");
    expect(run).toHaveBeenCalledTimes(1);
    expect(runAudit.database).toHaveBeenCalledWith(expect.objectContaining({ type: "message-delivery:park" }));
  });
});
