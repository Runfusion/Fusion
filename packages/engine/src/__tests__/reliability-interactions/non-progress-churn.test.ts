import { describe, expect, it, vi } from "vitest";
import { StuckTaskDetector } from "../../healing/stuck-task-detector.js";
import { createMockStore } from "../executor-test-helpers.js";

function session() {
  return { dispose: vi.fn() };
}

describe("reliability interactions: repeated stuck-session recovery", () => {
  it("repeated silence remains automatically recoverable without terminal state", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const store = createMockStore();
      const onStuck = vi.fn();
      const detector = new StuckTaskDetector(store, { onStuck });

      for (let round = 0; round < 2; round += 1) {
        const current = session();
        detector.trackTask("FN-CHURN", current);
        vi.advanceTimersByTime(61_000);
        await detector.killAndRetry("FN-CHURN", 60_000);
        expect(current.dispose).toHaveBeenCalledOnce();
      }

      expect(onStuck).toHaveBeenCalledTimes(2);
      for (const [event] of onStuck.mock.calls) {
        expect(event).toMatchObject({ taskId: "FN-CHURN", reason: "inactivity" });
        expect(event).not.toHaveProperty("shouldRequeue");
      }
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(JSON.stringify(onStuck.mock.calls)).not.toMatch(/STUCK_(?:LOOP_EXHAUSTED|NO_PROGRESS_CHURN)|awaiting-approval|decompose/i);
    } finally {
      vi.useRealTimers();
    }
  });
});
