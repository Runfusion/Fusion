import { afterEach, beforeEach, expect, it } from "vitest";
import type { InteractiveAiSession, InteractiveAiSessionEvent, PlanningQuestion } from "@fusion/core";
import { vi } from "vitest";
import { CeOrchestrator, CE_EVENTS } from "../session/orchestrator.js";
import { CeSessionStore, getCeSessionStore } from "../session/session-store.js";
import { makeHarness, makeScriptedSession, pgDescribe, scriptedFactory, type TestHarness } from "./_harness.js";

/**
 * CHARACTERIZATION TEST — written first (U5 execution note: cover the
 * no-silent-loss invariant before the happy path). Asserts that an interrupted
 * mid-question session auto-saves progress, lands in `interrupted`, emits an
 * observable event, and resumes to the SAME question with full history.
 */

const QUESTION: PlanningQuestion = {
  id: "q1",
  type: "single_select",
  question: "Which direction?",
  options: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
};

let h: TestHarness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(() => {
  h.close();
});

/**
 * Session that yields a question on turn 1, then HANGS on the next turn
 * (the answer turn never produces an event) — forcing a turn timeout.
 */
function questionThenHangSession(): InteractiveAiSession {
  let cursor = -1;
  return {
    prompt: vi.fn(async () => {
      cursor++;
    }),
    answer: vi.fn(async () => {
      cursor++;
    }),
    nextEvent: vi.fn(async (): Promise<InteractiveAiSessionEvent> => {
      if (cursor === 0) return { type: "question", data: QUESTION };
      // turn 2+ hangs forever
      return new Promise<InteractiveAiSessionEvent>(() => undefined);
    }),
    dispose: vi.fn(),
  };
}

pgDescribe("interrupt + resume (no silent loss)", () => {
  it("auto-saves progress on a turn timeout, marks interrupted, emits an event", async () => {
    const session = questionThenHangSession();
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: vi.fn(async () => ({ session })),
      projectRoot: h.projectRoot,
      turnTimeoutMs: 20,
    });

    const started = await orch.start("brainstorm", { openingMessage: "kick off" });
    expect(started.event?.type).toBe("question");
    expect(started.session.status).toBe("awaiting_input");
    expect(started.session.currentQuestion?.id).toBe("q1");

    // Answering triggers the next turn, which hangs → timeout → interrupted.
    const interrupted = await orch.answer(started.session.id, "q1", "a");
    expect(interrupted.session.status).toBe("interrupted");
    // Progress preserved: full history including the question and the answer.
    const history = interrupted.session.conversationHistory;
    expect(history.some((t) => t.text.includes("kick off"))).toBe(true);
    expect(history.some((t) => t.text.includes("question"))).toBe(true);
    expect(history.some((t) => t.text.includes("\"answer\""))).toBe(true);

    // Observable event emitted — never silent loss.
    expect(h.emitted.map((e) => e.event)).toContain(CE_EVENTS.interrupted);
  });

  it("leaves an awaiting_input session (waiting on a human) untouched even far past the stale band, and resume returns the same question with full history", async () => {
    // A session legitimately paused on a human question: status awaiting_input
    // with currentQuestion set, lastActivity well past the interval stale band.
    // Human response time is unbounded, so this is NOT a crashed turn — the
    // interval rubric must not misclassify it as stale.
    const store = new CeSessionStore(null, h.layer);
    const created = await store.createAsync({
      stage: "brainstorm",
      artifactPath: "docs/plans/2026-06-27-001-topic-plan.md",
      turnIntervalMs: 1000,
    });
    await store.appendHistoryAsync(created.id, { role: "user", text: "kick off", at: new Date().toISOString() });
    await store.appendHistoryAsync(created.id, { role: "agent", text: JSON.stringify({ question: QUESTION }), at: new Date().toISOString() });
    await store.updateAsync(created.id, {
      status: "awaiting_input",
      currentQuestion: QUESTION,
      // 10× interval old → far past the band, yet legitimately awaiting a human.
      lastActivityAt: Date.now() - 10_000,
    });

    const recovered = await store.recoverStaleSessionsAsync();
    // Not flagged stale / not recovered — a human wait is not a crashed turn.
    expect(recovered).not.toContain(created.id);

    const after = (await store.getAsync(created.id))!;
    // Awaiting-input session with a question stays resumable, unchanged.
    expect(after.status).toBe("awaiting_input");
    expect(after.currentQuestion?.id).toBe("q1");
    expect(after.artifactPath).toBe("docs/plans/2026-06-27-001-topic-plan.md");

    // Resume via the orchestrator returns to the same question + full history.
    // Rehydration re-creates a live session and replays the opening message,
    // draining the agent's response (the question) during replay.
    const replaySession = makeScriptedSession([{ type: "question", data: QUESTION }]);
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: vi.fn(async () => ({ session: replaySession })),
      projectRoot: h.projectRoot,
    });
    const resumed = await orch.resume(created.id);
    expect(resumed.session.status).toBe("awaiting_input");
    expect(resumed.session.currentQuestion?.id).toBe("q1");
    expect(resumed.session.artifactPath).toBe("docs/plans/2026-06-27-001-topic-plan.md");
    expect(resumed.session.conversationHistory).toHaveLength(2);
  });

  it("answer() rehydrates an old awaiting_input session with no live handle and drives the answer to completion", async () => {
    const store = getCeSessionStore(h.ctx);
    const created = await store.createAsync({ stage: "brainstorm", turnIntervalMs: 5000 });
    await store.appendHistoryAsync(created.id, { role: "user", text: "kick off", at: new Date().toISOString() });
    await store.appendHistoryAsync(created.id, {
      role: "agent",
      text: JSON.stringify({ question: QUESTION }),
      at: new Date().toISOString(),
    });
    await store.updateAsync(created.id, { status: "awaiting_input", currentQuestion: QUESTION });

    const rehydrated = makeScriptedSession([
      { type: "question", data: QUESTION },
      { type: "complete", data: { artifact: "# Done\n" } },
    ]);
    const factory = scriptedFactory(rehydrated);
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: factory,
      projectRoot: h.projectRoot,
      turnTimeoutMs: 5000,
    });

    const done = await orch.answer(created.id, "q1", "a");
    expect(done.event?.type).toBe("complete");
    expect(done.session.status).toBe("completed");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ allowAnswerQuestionIdDrift: true }));
    expect(rehydrated.prompt).toHaveBeenCalledTimes(1);
    expect(rehydrated.answer).toHaveBeenCalledTimes(1);
    const hasAnswerTurn = done.session.conversationHistory.some(
      (t) => t.text === JSON.stringify({ answer: "a", questionId: "q1" }),
    );
    expect(hasAnswerTurn).toBe(true);
  });

  it("answer() uses an existing live handle directly without rehydrating", async () => {
    const live = makeScriptedSession([
      { type: "question", data: QUESTION },
      { type: "complete", data: { artifact: "# Done\n" } },
    ]);
    const factory = scriptedFactory(live);
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: factory,
      projectRoot: h.projectRoot,
      turnTimeoutMs: 5000,
    });

    const started = await orch.start("brainstorm", { openingMessage: "kick off" });
    expect(started.session.status).toBe("awaiting_input");
    expect(factory).toHaveBeenCalledTimes(1);

    const done = await orch.answer(started.session.id, "q1", "a");
    expect(done.session.status).toBe("completed");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(expect.not.objectContaining({ allowAnswerQuestionIdDrift: true }));
    expect(live.prompt).toHaveBeenCalledTimes(1);
    expect(live.answer).toHaveBeenCalledTimes(1);
  });

  it("answer() without a live handle and without a factory reports an honest error without corrupting the question", async () => {
    const store = getCeSessionStore(h.ctx);
    const created = await store.createAsync({ stage: "brainstorm", turnIntervalMs: 5000 });
    await store.appendHistoryAsync(created.id, { role: "user", text: "kick off", at: new Date().toISOString() });
    await store.appendHistoryAsync(created.id, {
      role: "agent",
      text: JSON.stringify({ question: QUESTION }),
      at: new Date().toISOString(),
    });
    await store.updateAsync(created.id, { status: "awaiting_input", currentQuestion: QUESTION });
    const orch = new CeOrchestrator({ ctx: h.ctx, projectRoot: h.projectRoot, turnTimeoutMs: 5000 });

    await expect(orch.answer(created.id, "q1", "a")).rejects.toThrow(/cannot be continued in this process/i);
    const after = (await store.getAsync(created.id))!;
    expect(after.status).toBe("awaiting_input");
    expect(after.currentQuestion?.id).toBe("q1");
    expect(after.conversationHistory.some((t) => t.text.includes('"answer"'))).toBe(false);
  });

  it("answer() rejects a stale questionId before rehydration and leaves state untouched", async () => {
    const store = getCeSessionStore(h.ctx);
    const created = await store.createAsync({ stage: "brainstorm", turnIntervalMs: 5000 });
    await store.appendHistoryAsync(created.id, { role: "user", text: "kick off", at: new Date().toISOString() });
    await store.appendHistoryAsync(created.id, {
      role: "agent",
      text: JSON.stringify({ question: QUESTION }),
      at: new Date().toISOString(),
    });
    await store.updateAsync(created.id, { status: "awaiting_input", currentQuestion: QUESTION });
    const factory = scriptedFactory(makeScriptedSession([{ type: "question", data: QUESTION }]));
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: factory,
      projectRoot: h.projectRoot,
      turnTimeoutMs: 5000,
    });

    await expect(orch.answer(created.id, "stale-q", "a")).rejects.toThrow(/q1|stale-q/);
    expect(factory).not.toHaveBeenCalled();
    const after = (await store.getAsync(created.id))!;
    expect(after.status).toBe("awaiting_input");
    expect(after.currentQuestion?.id).toBe("q1");
    expect(after.conversationHistory.some((t) => t.text.includes("stale-q"))).toBe(false);
  });

  it("answer() preserves the existing not-awaiting guard before rehydration", async () => {
    const store = getCeSessionStore(h.ctx);
    const created = await store.createAsync({ stage: "brainstorm", turnIntervalMs: 5000 });
    await store.updateAsync(created.id, { status: "active", currentQuestion: QUESTION });
    const factory = scriptedFactory(makeScriptedSession([{ type: "question", data: QUESTION }]));
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: factory,
      projectRoot: h.projectRoot,
      turnTimeoutMs: 5000,
    });

    await expect(orch.answer(created.id, "q1", "a")).rejects.toThrow(/not awaiting input/);
    expect(factory).not.toHaveBeenCalled();
    expect((await store.getAsync(created.id))!.status).toBe("active");
  });

  it("detached answer() rehydrates an old awaiting_input session in the background", async () => {
    const store = getCeSessionStore(h.ctx);
    const created = await store.createAsync({ stage: "brainstorm", turnIntervalMs: 5000 });
    await store.appendHistoryAsync(created.id, { role: "user", text: "kick off", at: new Date().toISOString() });
    await store.appendHistoryAsync(created.id, {
      role: "agent",
      text: JSON.stringify({ question: QUESTION }),
      at: new Date().toISOString(),
    });
    await store.updateAsync(created.id, { status: "awaiting_input", currentQuestion: QUESTION });
    const rehydrated = makeScriptedSession([
      { type: "question", data: QUESTION },
      { type: "complete", data: { artifact: "# Done\n" } },
    ]);
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: scriptedFactory(rehydrated),
      projectRoot: h.projectRoot,
      turnTimeoutMs: 5000,
    });

    const returned = await orch.answer(created.id, "q1", "a", { detach: true });
    expect(returned.session.status).toBe("active");

    await vi.waitFor(async () => expect((await store.getAsync(created.id))?.status).toBe("completed"));
    const after = (await store.getAsync(created.id))!;
    expect(rehydrated.answer).toHaveBeenCalledTimes(1);
    const hasAnswerTurn = after.conversationHistory.some(
      (t) => t.text === JSON.stringify({ answer: "a", questionId: "q1" }),
    );
    expect(hasAnswerTurn).toBe(true);
  });

  it("Bug 5: an interrupted/awaiting session with a currentQuestion + history can be resumed (rehydrated) and then ANSWERED to continue to completion", async () => {
    // Simulate the post-interrupt / post-restart state: a session persisted
    // mid-question (awaiting_input, currentQuestion set, full history) whose live
    // handle was disposed and removed from this.live. This is exactly the state
    // resume() must be able to back with a real live handle.
    const store = getCeSessionStore(h.ctx);
    const created = await store.createAsync({ stage: "brainstorm", turnIntervalMs: 5000 });
    await store.appendHistoryAsync(created.id, { role: "user", text: "kick off", at: new Date().toISOString() });
    await store.appendHistoryAsync(created.id, {
      role: "agent",
      text: JSON.stringify({ question: QUESTION }),
      at: new Date().toISOString(),
    });
    await store.updateAsync(created.id, { status: "awaiting_input", currentQuestion: QUESTION });
    const sessionId = created.id;

    // The rehydration factory: replays the opening prompt (yields the question,
    // which replay discards), then on the real answer turn completes the stage.
    const rehydrated = makeScriptedSession([
      { type: "question", data: QUESTION },
      { type: "complete", data: { artifact: "# Done\n" } },
    ]);
    const factory = vi.fn(async () => ({ session: rehydrated }));

    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: factory,
      projectRoot: h.projectRoot,
      turnTimeoutMs: 5000,
    });

    // Pre-fix: resume() flips status to awaiting_input but never re-establishes a
    // live handle, so the subsequent answer() throws "no live handle; call
    // resume() first" — a dead-end loop. Post-fix: resume rehydrates a live one.
    const resumed = await orch.resume(sessionId);
    expect(resumed.session.status).toBe("awaiting_input");
    expect(resumed.session.currentQuestion?.id).toBe("q1");
    expect(factory).toHaveBeenCalledTimes(1); // rehydration created a live session.

    // The resumed session is genuinely answerable now — drive it to completion.
    const done = await orch.answer(sessionId, "q1", "a");
    expect(done.event?.type).toBe("complete");
    expect(done.session.status).toBe("completed");
  });

  it("Bug 4: answering with a wrong questionId throws and leaves the session awaiting_input with its currentQuestion preserved", async () => {
    const session = questionThenHangSession();
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: vi.fn(async () => ({ session })),
      projectRoot: h.projectRoot,
      turnTimeoutMs: 20,
    });

    const started = await orch.start("brainstorm", { openingMessage: "kick off" });
    expect(started.session.status).toBe("awaiting_input");
    expect(started.session.currentQuestion?.id).toBe("q1");

    // Answer with the WRONG questionId → must reject without mutating state.
    await expect(orch.answer(started.session.id, "WRONG-ID", "a")).rejects.toThrow(/q1|WRONG-ID/);

    // The recovery anchor is intact: still awaiting_input with currentQuestion.
    const after = (await orch.getState(started.session.id))!;
    expect(after.status).toBe("awaiting_input");
    expect(after.currentQuestion?.id).toBe("q1");
    // No spurious answer turn was appended to history.
    expect(after.conversationHistory.some((t) => t.text.includes("WRONG-ID"))).toBe(false);

    // The correct questionId is still accepted (the live handle wasn't disturbed).
    // The session hangs on the answer turn → it interrupts, but it DID accept the
    // answer, proving the rejection above didn't break the seam.
    const accepted = await orch.answer(started.session.id, "q1", "a");
    expect(accepted.session.status).toBe("interrupted");
  });

  it("a crash with no pending question is marked interrupted (progress preserved), not silently dropped", async () => {
    const store = getCeSessionStore(h.ctx);
    const created = await store.createAsync({ stage: "brainstorm", turnIntervalMs: 1000 });
    await store.appendHistoryAsync(created.id, { role: "user", text: "kick off", at: new Date().toISOString() });
    await store.updateAsync(created.id, { status: "active", lastActivityAt: Date.now() - 10_000 });

    await store.recoverStaleSessionsAsync();
    const after = (await store.getAsync(created.id))!;
    expect(after.status).toBe("interrupted");
    expect(after.error).toMatch(/progress preserved/i);
    expect(after.conversationHistory).toHaveLength(1);
  });
});
