import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CreateInteractiveAiSessionFactory, InteractiveAiSessionEvent, PlanningQuestion } from "@fusion/core";
import { CeOrchestrator } from "../session/orchestrator.js";
import { makeHarness, makeScriptedSession, pgDescribe, type TestHarness } from "./_harness.js";

/*
FNXC:CompoundEngineering 2026-06-17-13:22:
A stale persisted enabledStages snapshot must not block any registered CE stage, including newly added stages such as debug. Keep this runnable source regression outside the quarantined skill-wiring suite so opt-out launch gating remains covered by normal test runs.
*/
const DEBUG_OPENING_MESSAGE = "Start the Debug stage.";

const DEBUG_PROTOCOL_SENTINEL = "translate any loaded-skill instruction";

function debugProtocolSensitiveFactory(question: PlanningQuestion): CreateInteractiveAiSessionFactory {
  return vi.fn(async (options) => {
    const hasConflictOverride = options.systemPrompt.includes(DEBUG_PROTOCOL_SENTINEL);
    const event: InteractiveAiSessionEvent = hasConflictOverride
      ? { type: "question", data: question }
      : {
          type: "error",
          data: {
            message: "Failed to parse agent response: AI returned no valid JSON.",
          },
        };
    return { session: makeScriptedSession([event]) };
  });
}

pgDescribe("CE stage launch guard", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(() => {
    h.close();
  });

  it.each(["strategy", "work", "debug"])(
    "launches %s when settings only contain a stale enabledStages snapshot",
    async (stageId) => {
      h.ctx.settings = { enabledStages: ["strategy", "ideate", "brainstorm", "plan", "work"] };
      const factory = vi.fn(async () => ({
        session: makeScriptedSession([{ type: "complete", data: { artifact: `# ${stageId} done` } }]),
      }));
      const orch = new CeOrchestrator({
        ctx: h.ctx,
        createInteractiveAiSession: factory,
        projectRoot: h.projectRoot,
        turnTimeoutMs: 5000,
      });

      await orch.start(stageId, { openingMessage: `launch ${stageId}` });

      expect(factory).toHaveBeenCalledTimes(1);
    },
  );

  it("starts the built-in debug stage with the default launcher message as a protocol question", async () => {
    const question: PlanningQuestion = {
      id: "debug-scope",
      type: "text",
      question: "What bug or failing behavior should I investigate?",
    };
    const factory = debugProtocolSensitiveFactory(question);
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: factory,
      projectRoot: h.projectRoot,
      turnTimeoutMs: 5000,
    });

    const result = await orch.start("debug", { openingMessage: DEBUG_OPENING_MESSAGE });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(result.session).toMatchObject({
      stage: "debug",
      status: "awaiting_input",
      error: null,
      currentQuestion: question,
    });
    expect(result.session.conversationHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", text: DEBUG_OPENING_MESSAGE }),
        expect.objectContaining({ role: "agent", text: JSON.stringify({ question }) }),
      ]),
    );
    expect(result.session.error ?? "").not.toContain("AI returned no valid JSON");
  });

  it("keeps genuinely malformed debug output as an error instead of fabricating a question", async () => {
    const factory = vi.fn(async () => ({
      session: makeScriptedSession([
        {
          type: "error",
          data: { message: "Failed to parse agent response: AI returned no valid JSON." },
        },
      ]),
    }));
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: factory,
      projectRoot: h.projectRoot,
      turnTimeoutMs: 5000,
    });

    const result = await orch.start("debug", { openingMessage: DEBUG_OPENING_MESSAGE });

    expect(result.session).toMatchObject({
      stage: "debug",
      status: "error",
      currentQuestion: null,
      error: "Failed to parse agent response: AI returned no valid JSON.",
    });
  });

  it("rejects debug launch when debug is explicitly disabled", async () => {
    h.ctx.settings = { disabledStages: ["debug"] };
    const factory = vi.fn(async () => ({
      session: makeScriptedSession([{ type: "complete", data: { artifact: "# debug done" } }]),
    }));
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: factory,
      projectRoot: h.projectRoot,
      turnTimeoutMs: 5000,
    });

    await expect(orch.start("debug", { openingMessage: "investigate" })).rejects.toThrow(
      "CE stage is not enabled: debug",
    );
    expect(factory).not.toHaveBeenCalled();
  });
});
