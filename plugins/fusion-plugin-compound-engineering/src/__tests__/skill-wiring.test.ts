import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateInteractiveAiSessionOptions,
  InteractiveAiSessionEvent,
} from "@fusion/core";
import { CeOrchestrator } from "../session/orchestrator.js";
import { getStage } from "../session/stage-registry.js";
import { resolveDefaultInstallTargetRoot } from "../skill-installation.js";
import { makeHarness, makeScriptedSession, type TestHarness } from "./_harness.js";

/**
 * Proves the orchestrator hands a launched session the wiring a LIVE agent needs
 * to actually load the stage's bundled ce-* skill (closes the U2/U5 carry-forward):
 *   - cwd is the real project root (where the agent reads context + writes the
 *     artifact), NOT the skills directory;
 *   - requestedSkillNames names the stage's ce-* skill;
 *   - additionalSkillPaths includes the plugin-local install root so the engine
 *     loader can discover that skill.
 * The engine adapter forwards these to createFnAgent (skills + additionalSkillPaths);
 * compound-engineering-skill-resolution.test.ts proves the loader then resolves it.
 */
describe("session skill wiring", () => {
  let h: TestHarness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.close();
  });

  it.each(["brainstorm", "debug"])(
    "start() passes the %s stage skill id, install path, and project-root cwd to the factory",
    async (stageId) => {
      const captured: CreateInteractiveAiSessionOptions[] = [];
      const script: InteractiveAiSessionEvent[] = [
        { type: "complete", data: { artifact: "# done" } },
      ];
      const session = makeScriptedSession(script);
      const factory = vi.fn(async (opts: CreateInteractiveAiSessionOptions) => {
        captured.push(opts);
        return { session };
      });
      const orch = new CeOrchestrator({
        ctx: h.ctx,
        createInteractiveAiSession: factory,
        projectRoot: h.projectRoot,
        turnTimeoutMs: 5000,
      });

      await orch.start(stageId, { openingMessage: "let's go" });

      expect(captured).toHaveLength(1);
      const opts = captured[0];
      const stage = getStage(stageId)!;
      // cwd is the project root, not the skills dir.
      expect(opts.cwd).toBe(h.projectRoot);
      // the stage's ce-* skill is requested...
      expect(opts.requestedSkillNames).toEqual([stage.skillId]);
      // ...and the plugin-local install root is on the discovery path.
      expect(opts.additionalSkillPaths).toEqual([resolveDefaultInstallTargetRoot()]);
      expect(opts.additionalSkillPaths?.[0]).toMatch(/\.fusion-ce-skills$/);
    },
  );

  it("ignores stale enabledStages snapshots so registered stages remain launchable", async () => {
    h.ctx.settings = { enabledStages: ["strategy", "ideate", "brainstorm", "plan", "work"] };
    const factory = vi.fn(async () => ({
      session: makeScriptedSession([{ type: "complete", data: { artifact: "# done" } }]),
    }));
    const orch = new CeOrchestrator({
      ctx: h.ctx,
      createInteractiveAiSession: factory,
      projectRoot: h.projectRoot,
      turnTimeoutMs: 5000,
    });

    for (const stageId of ["strategy", "work", "debug"]) {
      await orch.start(stageId, { openingMessage: `launch ${stageId}` });
    }

    expect(factory).toHaveBeenCalledTimes(3);
  });

  it("rejects debug launch cleanly when the stage is disabled", async () => {
    h.ctx.settings = { disabledStages: ["debug"] };
    const factory = vi.fn(async () => ({
      session: makeScriptedSession([{ type: "complete", data: { artifact: "# done" } }]),
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
