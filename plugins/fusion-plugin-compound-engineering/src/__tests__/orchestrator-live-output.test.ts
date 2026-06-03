import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateInteractiveAiSessionFactory,
  InteractiveAiSessionEvent,
  InteractiveAiSessionProgressEvent,
  PlanningQuestion,
} from "@fusion/core";
import { buildStageSystemPrompt, CeOrchestrator, CE_EVENTS } from "../session/orchestrator.js";
import { getStage } from "../session/stage-registry.js";
import { makeHarness, makeScriptedSession, type TestHarness } from "./_harness.js";

/**
 * Live working-output + steering-protocol coverage:
 * - mid-turn progress (thinking/text deltas, tool markers) is visible via
 *   getLiveActivity while the turn runs, emitted as observable events, and
 *   persisted into history as a condensed trace when the turn settles;
 * - the turn timeout is INACTIVITY-based — an actively-working long turn is
 *   never killed, a quiet one is interrupted with its trace preserved;
 * - detached start/answer return immediately and converge via persisted state;
 * - the stage system prompt documents the steering response shapes.
 */

const QUESTION: PlanningQuestion = { id: "q1", type: "text", question: "Topic?" };

let h: TestHarness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.close();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A factory exposing the onProgress hook and a controllable nextEvent. */
function progressFactory(nextEvent: () => Promise<InteractiveAiSessionEvent>) {
  const captured: { progress?: (e: InteractiveAiSessionProgressEvent) => void; dispose: ReturnType<typeof vi.fn> } = {
    dispose: vi.fn(),
  };
  const factory: CreateInteractiveAiSessionFactory = vi.fn(async (opts) => {
    captured.progress = opts.onProgress;
    return {
      session: {
        prompt: vi.fn(async () => undefined),
        answer: vi.fn(async () => undefined),
        nextEvent,
        dispose: captured.dispose,
      },
    };
  });
  return { factory, captured };
}

describe("live working output", () => {
  it("buffers mid-turn progress, emits observable events, and persists the trace on settle (before the question)", async () => {
    const evt = deferred<InteractiveAiSessionEvent>();
    const { factory, captured } = progressFactory(() => evt.promise);
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: factory,
      projectRoot: h.projectRoot,
      turnTimeoutMs: 5000,
    });

    const started = await orch.start("brainstorm", { openingMessage: "go", detach: true });
    expect(["launching", "active"]).toContain(started.session.status);
    await vi.waitFor(() => expect(captured.progress).toBeDefined());

    // Stream: consecutive deltas of one kind merge; tool start/end are discrete.
    captured.progress!({ type: "thinking", delta: "Let me " });
    captured.progress!({ type: "thinking", delta: "look around." });
    captured.progress!({ type: "tool", name: "Read", phase: "start" });
    captured.progress!({ type: "tool", name: "Read", phase: "end", isError: false });
    captured.progress!({ type: "text", delta: "Drafting…" });

    const live = orch.getLiveActivity(started.session.id);
    expect(live.map((t) => t.kind)).toEqual(["thinking", "tool", "text"]);
    expect(live[0].text).toBe("Let me look around.");
    expect(live[1].done).toBe(true);
    expect(live[1].isError).toBeUndefined();

    // Observable progress event emitted (throttled; the first one is immediate).
    expect(
      h.emitted.some((e) => e.event === CE_EVENTS.turn && (e.data as { kind?: string }).kind === "progress"),
    ).toBe(true);

    // Settle the turn → buffer flushed into history BEFORE the question record.
    evt.resolve({ type: "question", data: QUESTION });
    await vi.waitFor(() => expect(orch.getState(started.session.id)?.status).toBe("awaiting_input"));
    expect(orch.getLiveActivity(started.session.id)).toHaveLength(0);

    const history = orch.getState(started.session.id)!.conversationHistory;
    const activityIdx = history.findIndex((t) => t.role === "agent" && t.text.startsWith('{"activity"'));
    const questionIdx = history.findIndex((t) => t.role === "agent" && t.text.startsWith('{"question"'));
    expect(activityIdx).toBeGreaterThanOrEqual(0);
    expect(questionIdx).toBeGreaterThan(activityIdx);
    const trace = JSON.parse(history[activityIdx].text) as {
      activity: { turns: Array<{ kind: string; text: string }> };
    };
    expect(trace.activity.turns.map((t) => t.kind)).toEqual(["thinking", "tool", "text"]);
  });

  it("inactivity watchdog: an actively-working long turn survives past the timeout; a quiet one is interrupted with its trace kept", async () => {
    const { factory, captured } = progressFactory(() => new Promise<InteractiveAiSessionEvent>(() => undefined));
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: factory,
      projectRoot: h.projectRoot,
      turnTimeoutMs: 120,
    });
    const started = await orch.start("brainstorm", { openingMessage: "go", detach: true });
    const id = started.session.id;
    await vi.waitFor(() => expect(captured.progress).toBeDefined());

    // Keep working for ~3× the timeout — must NOT be interrupted.
    for (let i = 0; i < 8; i++) {
      await sleep(45);
      captured.progress!({ type: "thinking", delta: "." });
    }
    expect(orch.getState(id)?.status).toBe("active");

    // Go quiet → interrupted after the inactivity window, trace preserved.
    await vi.waitFor(() => expect(orch.getState(id)?.status).toBe("interrupted"), { timeout: 2000 });
    expect(orch.getState(id)?.error).toMatch(/no agent activity/i);
    const history = orch.getState(id)!.conversationHistory;
    expect(history.some((t) => t.text.startsWith('{"activity"'))).toBe(true);
    expect(captured.dispose).toHaveBeenCalled();
  });
});

describe("detached turns (route posture)", () => {
  it("answer(detach) returns immediately with status active and converges to the next question", async () => {
    const NEXT: PlanningQuestion = { id: "q2", type: "text", question: "More?" };
    const scripted = makeScriptedSession([
      { type: "question", data: QUESTION },
      { type: "question", data: NEXT },
    ]);
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: vi.fn(async () => ({ session: scripted })),
      projectRoot: h.projectRoot,
      turnTimeoutMs: 5000,
    });
    const started = await orch.start("brainstorm", { openingMessage: "go" });
    expect(started.session.status).toBe("awaiting_input");

    const stepped = await orch.answer(started.session.id, "q1", "widgets", { detach: true });
    // Detached return reflects the just-accepted answer, not the settled turn…
    expect(stepped.session.status).toBe("active");
    expect(stepped.session.currentQuestion).toBeNull();
    // …and the background turn converges to the next question.
    await vi.waitFor(() => expect(orch.getState(started.session.id)?.currentQuestion?.id).toBe("q2"));
    expect(orch.getState(started.session.id)?.status).toBe("awaiting_input");
  });

  it("start(detach) without a working factory converges to an error state (never silent)", async () => {
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: vi.fn(async () => {
        throw new Error("factory exploded");
      }),
      projectRoot: h.projectRoot,
      turnTimeoutMs: 5000,
    });
    const started = await orch.start("brainstorm", { openingMessage: "go", detach: true });
    expect(started.session.id).toBeTruthy();
    await vi.waitFor(() => expect(orch.getState(started.session.id)?.status).toBe("error"));
    expect(orch.getState(started.session.id)?.error).toContain("factory exploded");
    expect(h.emitted.map((e) => e.event)).toContain(CE_EVENTS.error);
  });
});

describe("steering protocol", () => {
  it("the stage system prompt documents direct, value+comment, and feedback-only response shapes", () => {
    const prompt = buildStageSystemPrompt(getStage("brainstorm")!);
    expect(prompt).toContain('"value"');
    expect(prompt).toContain('"comment"');
    expect(prompt).toContain('"feedback"');
    expect(prompt).toMatch(/steering/i);
  });
});
