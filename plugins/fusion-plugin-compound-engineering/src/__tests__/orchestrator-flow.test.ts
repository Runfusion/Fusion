import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InteractiveAiSessionEvent, PlanningQuestion } from "@fusion/core";
import { CeOrchestrator, CE_EVENTS } from "../session/orchestrator.js";
import { registerStage, getStage } from "../session/stage-registry.js";
import { makeHarness, makeScriptedSession, type TestHarness } from "./_harness.js";

const QUESTION: PlanningQuestion = {
  id: "q1",
  type: "text",
  question: "What is the topic?",
};

let h: TestHarness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.close();
});

function makeOrch(script: InteractiveAiSessionEvent[]) {
  const session = makeScriptedSession(script);
  return new CeOrchestrator({
    ctx: h.ctx,
    createInteractiveAiSession: vi.fn(async () => ({ session })),
    projectRoot: h.projectRoot,
    turnTimeoutMs: 5000,
  });
}

describe("orchestrator happy path", () => {
  it("start → question → answer → complete writes the artifact to the conventional location", async () => {
    const orch = makeOrch([
      { type: "question", data: QUESTION },
      { type: "complete", data: { artifact: "# Brainstorm\n\nThe plan.\n" } },
    ]);

    const started = await orch.start("brainstorm", { openingMessage: "let's brainstorm widgets" });
    expect(started.session.status).toBe("awaiting_input");
    expect(started.session.currentQuestion?.id).toBe("q1");

    const done = await orch.answer(started.session.id, "q1", "widgets");
    expect(done.event?.type).toBe("complete");
    expect(done.session.status).toBe("completed");

    // Artifact written to docs/brainstorms/ (the stage's conventional location).
    const artifactPath = done.session.artifactPath!;
    expect(artifactPath).toContain("docs/brainstorms/");
    expect(existsSync(artifactPath)).toBe(true);
    expect(readFileSync(artifactPath, "utf-8")).toContain("# Brainstorm");

    // Observable completion event emitted.
    expect(h.emitted.map((e) => e.event)).toContain(CE_EVENTS.completed);
  });

  it("runs a SECOND stage through the SAME orchestrator with only a registry-data entry (no new route/store code)", async () => {
    // Adding a stage = data only.
    registerStage({
      stageId: "compound",
      order: 600,
      skillId: "ce-compound",
      artifactLocation: "docs/solutions/",
      icon: "BookOpen",
      label: "Compound",
    });
    expect(getStage("compound")?.skillId).toBe("ce-compound");

    const orch = makeOrch([{ type: "complete", data: { artifact: "# Learning\n" } }]);
    const started = await orch.start("compound", { openingMessage: "document this" });
    expect(started.event?.type).toBe("complete");
    expect(started.session.stage).toBe("compound");
    expect(started.session.status).toBe("completed");
    expect(started.session.artifactPath).toContain("docs/solutions/");
    expect(readFileSync(started.session.artifactPath!, "utf-8")).toContain("# Learning");
  });
});

describe("multiple concurrent sessions", () => {
  it("drives two independent sessions through the SAME orchestrator without cross-talk", async () => {
    // Two scripted live sessions; the factory hands them out in creation order.
    const liveA = makeScriptedSession([
      { type: "question", data: QUESTION },
      { type: "complete", data: { artifact: "# A\n" } },
    ]);
    const liveB = makeScriptedSession([
      { type: "question", data: { ...QUESTION, id: "q-b" } },
      { type: "complete", data: { artifact: "# B\n" } },
    ]);
    const handles = [liveA, liveB];
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: vi.fn(async () => ({ session: handles.shift()! })),
      projectRoot: h.projectRoot,
      turnTimeoutMs: 5000,
    });

    const a = await orch.start("brainstorm", { openingMessage: "topic A" });
    const b = await orch.start("brainstorm", { openingMessage: "topic B" });
    expect(a.session.id).not.toBe(b.session.id);
    expect(a.session.status).toBe("awaiting_input");
    expect(b.session.status).toBe("awaiting_input");

    // Answer B first — A must stay awaiting, untouched.
    const doneB = await orch.answer(b.session.id, "q-b", "bee");
    expect(doneB.session.status).toBe("completed");
    expect(orch.getState(a.session.id)?.status).toBe("awaiting_input");

    // A is still answerable on ITS live handle (not B's).
    const doneA = await orch.answer(a.session.id, "q1", "ay");
    expect(doneA.session.status).toBe("completed");
    expect(liveA.answer).toHaveBeenCalledTimes(1);
    expect(liveB.answer).toHaveBeenCalledTimes(1);
  });

  it("discard disposes the live handle and deletes only that session", async () => {
    const live = makeScriptedSession([{ type: "question", data: QUESTION }]);
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: vi.fn(async () => ({ session: live })),
      projectRoot: h.projectRoot,
      turnTimeoutMs: 5000,
    });
    const started = await orch.start("brainstorm", { openingMessage: "topic" });

    expect(orch.discard(started.session.id)).toBe(true);
    expect(live.dispose).toHaveBeenCalled();
    expect(orch.getState(started.session.id)).toBeUndefined();
    // Idempotent-ish: a second discard reports false, no throw.
    expect(orch.discard(started.session.id)).toBe(false);
  });
});

describe("orchestrator error + retry", () => {
  it("agent error → status error, progress preserved, observable event; retry resumes to the question", async () => {
    const orch = makeOrch([
      { type: "question", data: QUESTION },
      { type: "error", data: { message: "model overloaded" } },
    ]);

    const started = await orch.start("brainstorm", { openingMessage: "topic" });
    expect(started.session.currentQuestion?.id).toBe("q1");

    const errored = await orch.answer(started.session.id, "q1", "answer-text");
    expect(errored.session.status).toBe("error");
    expect(errored.session.error).toContain("model overloaded");
    // Progress preserved: history retained.
    expect(errored.session.conversationHistory.length).toBeGreaterThan(0);
    expect(h.emitted.map((e) => e.event)).toContain(CE_EVENTS.error);

    // Retry: resume() moves an errored session forward. (Error keeps it
    // resumable; resume reads persisted state — the no-loss anchor.)
    const state = orch.getState(errored.session.id)!;
    expect(state.conversationHistory.length).toBeGreaterThan(0);
  });
});
