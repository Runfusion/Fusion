import { afterEach, expect, it, vi } from "vitest";
import type { InteractiveAiSession } from "@fusion/core";
import { CE_EVENTS, CeOrchestrator } from "../session/orchestrator.js";
import { getCeSessionStore, type CeActivityTurn, type CeSessionStatus } from "../session/session-store.js";
import { makeHarness, pgDescribe, type TestHarness } from "./_harness.js";

interface OrchestratorInternals {
  live: Map<string, InteractiveAiSession>;
  activity: Map<string, CeActivityTurn[]>;
}

function internals(orch: CeOrchestrator): OrchestratorInternals {
  return orch as unknown as OrchestratorInternals;
}

function liveHandle(): InteractiveAiSession {
  return {
    prompt: vi.fn(),
    answer: vi.fn(),
    nextEvent: vi.fn(),
    dispose: vi.fn(),
  };
}

pgDescribe("CeOrchestrator.cancel", () => {
  let h: TestHarness;

  afterEach(() => {
    h?.close();
  });

  it("interrupts an in-flight session with a live handle, flushes progress, disposes, and emits", async () => {
    h = await makeHarness();
    const store = getCeSessionStore(h.ctx);
    const orch = new CeOrchestrator({ ctx: h.ctx });
    const session = (await store.updateAsync((await store.createAsync({ stage: "brainstorm" })).id, { status: "active" }))!;
    const handle = liveHandle();
    internals(orch).live.set(session.id, handle);
    internals(orch).activity.set(session.id, [
      { kind: "thinking", text: "drafting cancellable progress", at: new Date().toISOString() },
    ]);

    const cancelled = (await orch.cancel(session.id))!;

    expect(cancelled.status).toBe("interrupted");
    expect(cancelled.error).toBe("Cancelled by user");
    expect(handle.dispose).toHaveBeenCalledTimes(1);
    expect(orch.getLiveActivity(session.id)).toEqual([]);
    expect(cancelled.conversationHistory.some((t) => t.text.includes("drafting cancellable progress"))).toBe(true);
    expect(h.emitted).toContainEqual({
      event: CE_EVENTS.interrupted,
      data: { sessionId: session.id, message: "Cancelled by user" },
    });
  });

  it.each<CeSessionStatus>(["launching", "active", "awaiting_input"])(
    "interrupts %s without requiring a live handle",
    async (status) => {
      h = await makeHarness();
      const store = getCeSessionStore(h.ctx);
      const orch = new CeOrchestrator({ ctx: h.ctx });
      const session = (await store.updateAsync((await store.createAsync({ stage: "brainstorm" })).id, { status }))!;

      const cancelled = (await orch.cancel(session.id))!;

      expect(cancelled.status).toBe("interrupted");
      expect(cancelled.error).toBe("Cancelled by user");
      expect(h.emitted.map((e) => e.event)).toEqual([CE_EVENTS.interrupted]);
    },
  );

  it.each<CeSessionStatus>(["completed", "error", "interrupted"])(
    "is idempotent for terminal status %s",
    async (status) => {
      h = await makeHarness();
      const store = getCeSessionStore(h.ctx);
      const orch = new CeOrchestrator({ ctx: h.ctx });
      const session = (await store.updateAsync((await store.createAsync({ stage: "brainstorm" })).id, {
        status,
        error: status === "completed" ? null : "already settled",
      }))!;
      const handle = liveHandle();
      internals(orch).live.set(session.id, handle);

      const cancelled = (await orch.cancel(session.id))!;

      expect(cancelled).toEqual(session);
      expect(handle.dispose).not.toHaveBeenCalled();
      expect(h.emitted).toEqual([]);
      expect((await store.getAsync(session.id))!.status).toBe(status);
    },
  );

  it("returns undefined for an unknown session", async () => {
    h = await makeHarness();
    const orch = new CeOrchestrator({ ctx: h.ctx });

    expect(await orch.cancel("missing")).toBeUndefined();
    expect(h.emitted).toEqual([]);
  });
});
