import { describe, expect, it, vi } from "vitest";
import { deliverMailboxMessageOnce } from "../mailbox-delivery.js";

const message = {
  fromId: "system", fromType: "system" as const, toId: "dashboard-user", toType: "user" as const,
  type: "system" as const, content: "Safe blocker report", metadata: { taskId: "FN-9346", kind: "task-wedge" },
};

describe("mailbox delivery", () => {
  it("delivers once when the mailbox is available", async () => {
    const sendMessageOnce = vi.fn(async () => ({ message: {} as any, inserted: true }));
    await expect(deliverMailboxMessageOnce({ sendMessageOnce }, message, "task-wedge:episode", 50)).resolves.toBe("delivered");
    expect(sendMessageOnce).toHaveBeenCalledWith(message, "task-wedge:episode");
  });

  it("absorbs unavailable, throwing, rejecting, and hanging stores", async () => {
    vi.useFakeTimers();
    await expect(deliverMailboxMessageOnce(undefined, message, "missing", 50)).resolves.toBe("unavailable");
    await expect(deliverMailboxMessageOnce({ sendMessageOnce: () => { throw new Error("unavailable"); } }, message, "throws", 50)).resolves.toBe("unavailable");
    await expect(deliverMailboxMessageOnce({ sendMessageOnce: async () => { throw new Error("rejected"); } }, message, "rejects", 50)).resolves.toBe("unavailable");
    const hanging = deliverMailboxMessageOnce({ sendMessageOnce: () => new Promise(() => undefined) }, message, "hangs", 50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(hanging).resolves.toBe("unavailable");
    vi.useRealTimers();
  });
});
