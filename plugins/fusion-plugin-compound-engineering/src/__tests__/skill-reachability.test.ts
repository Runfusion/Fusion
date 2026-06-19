import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installBundledCeSkills } from "../skill-installation.js";
import { resolveStageSkillPaths, buildStageSystemPrompt } from "../session/orchestrator.js";
import { getStage } from "../session/stage-registry.js";

/**
 * Prove the launched stage's ce-* skill is REACHABLE for the session — now via
 * the real seam wiring (closes the U2 → U5 carry-forward).
 *
 * The U4 `CreateInteractiveAiSessionOptions` surface now carries
 * `requestedSkillNames` + `additionalSkillPaths`, which the engine adapter
 * forwards into `createFnAgent` (`skills` + the loader's `additionalSkillPaths`).
 * So the orchestrator hands the session BOTH the stage's skill id and the
 * install directory to discover it from. This test asserts:
 *   1. the install directory `resolveStageSkillPaths()` returns actually holds
 *      the stage's `<skillId>/SKILL.md` after install, and
 *   2. the system prompt names the stage's skill id.
 *
 * The engine package separately proves (compound-engineering-skill-resolution
 * .test.ts) that `loadSkills` + the resolver resolve a ce-* skill once that
 * directory is on the discovery path — together the chain is closed.
 */

describe("stage skill reachability (real seam wiring)", () => {
  let tmpTargets: string[] = [];
  afterEach(() => {
    for (const t of tmpTargets) rmSync(t, { recursive: true, force: true });
    tmpTargets = [];
    vi.restoreAllMocks();
  });

  it("resolveStageSkillPaths returns the plugin-local install root the session scans", () => {
    // The orchestrator passes this as additionalSkillPaths; never a global path.
    const skillPaths = resolveStageSkillPaths();
    expect(skillPaths).toHaveLength(1);
    expect(skillPaths[0]).toMatch(/\.fusion-ce-skills$/);
    expect(skillPaths[0]).not.toMatch(/\.(claude|codex|gemini)[/\\]skills/);
  });

  it.each(["brainstorm", "debug"])(
    "installing bundled skills onto a discovery root produces %s's SKILL.md",
    (stageId) => {
      const stage = getStage(stageId)!;
      // Install into a temp discovery root (isolated; mirrors what the real
      // plugin-local install produces, without writing into the repo dir).
      const target = mkdtempSync(join(tmpdir(), "ce-skill-reach-"));
      tmpTargets.push(target);

      const { results } = installBundledCeSkills({ targetRoot: target });
      expect(results.every((r) => r.outcome === "installed" || r.outcome === "skipped")).toBe(true);

      const installedSkillMd = join(target, stage.skillId, "SKILL.md");
      expect(existsSync(installedSkillMd)).toBe(true);
    },
  );

  it.each(["brainstorm", "debug"])("the %s stage system prompt names the stage's ce-* skill id", (stageId) => {
    const stage = getStage(stageId)!;
    const prompt = buildStageSystemPrompt(stage);
    expect(prompt).toContain(stage.skillId);
    expect(prompt).toContain("question");
    expect(prompt).toContain("complete");
  });
});
