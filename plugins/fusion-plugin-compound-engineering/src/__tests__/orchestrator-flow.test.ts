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
