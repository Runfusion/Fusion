import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CeOrchestrator } from "../session/orchestrator.js";
import { makeHarness, makeScriptedSession, type TestHarness } from "./_harness.js";

/*
FNXC:CompoundEngineering 2026-06-17-13:22:
A stale persisted enabledStages snapshot must not block any registered CE stage, including newly added stages such as debug. Keep this runnable source regression outside the quarantined skill-wiring suite so opt-out launch gating remains covered by normal test runs.
*/
describe("CE stage launch guard", () => {
  let h: TestHarness;

  beforeEach(() => {
    h = makeHarness();
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
