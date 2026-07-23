import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InteractiveAiSession, InteractiveAiSessionEvent, PlanningQuestion } from "@fusion/core";
import { CeOrchestrator, CeTurnInProgressError } from "../session/orchestrator.js";
import { makeHarness, pgDescribe, type TestHarness } from "./_harness.js";

/*
FNXC:CompoundEngineeringConcurrency 2026-07-23-11:10:
Port of the planning turn-admission invariant (FNXC:PlanningTurnAdmission, packages/dashboard/src/planning.ts 2026-07-22).
Field incident: a mobile CE Strategy session died with "Failed to parse agent response: AI returned no valid JSON" — the planning analogue was a re-entered view re-submitting a turn, displacing the in-flight turn's live agent, which then read an empty assistant message.
Invariant under test: at most one turn is admitted per CE session at a time; a concurrent answer/resume is rejected with CeTurnInProgressError and the in-flight turn settles unharmed; the reservation is released when the turn settles (including detached turns) and by explicit cancel().
*/

const QUESTION: PlanningQuestion = {
  id: "q1",
  type: "text",
  question: "Direction?",
};

let h: TestHarness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(() => {
  h.close();
});

/**
 * Scripted session whose ANSWER turn blocks until the test releases it: turn 1
 * (prompt) yields the question; the answer turn parks on a gate, then yields
 * complete. Lets the test hold a turn in flight deterministically.
 */
function gatedAnswerSession(): { session: InteractiveAiSession; releaseAnswer: () => void; answerCalls: () => number } {
  let cursor = -1;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let answers = 0;
  const session: InteractiveAiSession = {
    prompt: vi.fn(async () => {
      cursor++;
    }),
    answer: vi.fn(async () => {
      answers++;
      await gate;
      cursor++;
    }),
    nextEvent: vi.fn(async (): Promise<InteractiveAiSessionEvent> => {
      return cursor === 0
        ? { type: "question", data: QUESTION }
        : { type: "complete", data: { artifact: "# Done\n" } };
    }),
    dispose: vi.fn(),
  };
  return { session, releaseAnswer: () => release?.(), answerCalls: () => answers };
}

pgDescribe("turn admission (single in-flight turn per session)", () => {
  it("rejects a concurrent answer with CeTurnInProgressError and the in-flight turn settles unharmed", async () => {
    const gated = gatedAnswerSession();
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: vi.fn(async () => ({ session: gated.session })),
      projectRoot: h.projectRoot,
    });

    const started = await orch.start("brainstorm", { openingMessage: "kick off" });
    expect(started.session.status).toBe("awaiting_input");
    const id = started.session.id;

    // First answer holds the turn slot (its agent turn is gated open).
    const first = orch.answer(id, "q1", "north");
    // Give the first entry its synchronous reservation before racing it.
    await Promise.resolve();

    // A re-submitted answer (remounted view) is rejected, NOT admitted.
    await expect(orch.answer(id, "q1", "north")).rejects.toThrow(CeTurnInProgressError);
    // A racing resume is rejected the same way.
    await expect(orch.resume(id)).rejects.toThrow(CeTurnInProgressError);

    // The surviving turn was never displaced: it settles cleanly.
    gated.releaseAnswer();
    const settled = await first;
    expect(settled.event?.type).toBe("complete");
    expect(settled.session.status).toBe("completed");
    // Exactly ONE answer reached the live agent.
    expect(gated.answerCalls()).toBe(1);
  });

  it("releases the reservation when the turn settles (terminal session accepts resume again)", async () => {
    const gated = gatedAnswerSession();
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: vi.fn(async () => ({ session: gated.session })),
      projectRoot: h.projectRoot,
    });

    const started = await orch.start("brainstorm", { openingMessage: "kick off" });
    const id = started.session.id;
    const first = orch.answer(id, "q1", "north");
    await Promise.resolve();
    gated.releaseAnswer();
    await first;

    // Reservation released → resume is admitted (completed → no-op, no conflict throw).
    const resumed = await orch.resume(id);
    expect(resumed.session.status).toBe("completed");
  });

  it("holds the reservation across a DETACHED answer turn and releases on settle", async () => {
    const gated = gatedAnswerSession();
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: vi.fn(async () => ({ session: gated.session })),
      projectRoot: h.projectRoot,
    });

    const started = await orch.start("brainstorm", { openingMessage: "kick off" });
    const id = started.session.id;

    // Detached answer returns immediately with the turn running in background…
    const accepted = await orch.answer(id, "q1", "north", { detach: true });
    expect(accepted.session.status).toBe("active");

    // …but the turn slot stays reserved for the whole background turn.
    await expect(orch.answer(id, "q1", "north", { detach: true })).rejects.toThrow(CeTurnInProgressError);
    await expect(orch.resume(id, { detach: true })).rejects.toThrow(CeTurnInProgressError);

    gated.releaseAnswer();
    await vi.waitFor(async () => {
      const state = await orch.getState(id);
      expect(state?.status).toBe("completed");
    });
    // Background settle released the slot.
    const resumed = await orch.resume(id);
    expect(resumed.session.status).toBe("completed");
    expect(gated.answerCalls()).toBe(1);
  });

  it("a rejected concurrent answer does not clear the awaiting question (recovery anchor intact)", async () => {
    const gated = gatedAnswerSession();
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: vi.fn(async () => ({ session: gated.session })),
      projectRoot: h.projectRoot,
    });

    const started = await orch.start("brainstorm", { openingMessage: "kick off" });
    const id = started.session.id;
    const first = orch.answer(id, "q1", "north", { detach: true });
    await first;

    // The rejected duplicate must not have mutated persisted state mid-turn.
    await expect(orch.answer(id, "q1", "dupe", { detach: true })).rejects.toThrow(CeTurnInProgressError);
    const state = await orch.getState(id);
    expect(state?.status).toBe("active"); // still the first turn's accepted state

    gated.releaseAnswer();
    await vi.waitFor(async () => {
      expect((await orch.getState(id))?.status).toBe("completed");
    });
  });

  it("cancel() clears the reservation so a fresh turn is admitted after explicit teardown", async () => {
    const gated = gatedAnswerSession();
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: vi.fn(async () => ({ session: gated.session })),
      projectRoot: h.projectRoot,
    });

    const started = await orch.start("brainstorm", { openingMessage: "kick off" });
    const id = started.session.id;
    const inFlight = orch.answer(id, "q1", "north", { detach: true });
    await inFlight;
    await expect(orch.resume(id)).rejects.toThrow(CeTurnInProgressError);

    // Explicit teardown: cancel interrupts the session AND frees the slot.
    const cancelled = await orch.cancel(id);
    expect(cancelled?.status).toBe("interrupted");
    // Resume is admitted again (no CeTurnInProgressError): the interrupted
    // session (answer already cleared currentQuestion) resumes to the "active"
    // retry posture.
    const resumed = await orch.resume(id);
    expect(resumed.session.status).toBe("active");

    // Unblock the zombie turn so the test run doesn't leak a pending promise.
    gated.releaseAnswer();
  });
});
