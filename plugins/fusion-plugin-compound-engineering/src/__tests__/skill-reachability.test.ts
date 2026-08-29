import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installBundledCeSkills, resolveBundledSkillsRoot } from "../skill-installation.js";
import {
  buildStageSystemPrompt,
  checkStageSkillResolution,
  resolveStageSkillPaths,
} from "../session/orchestrator.js";
import { listStages } from "../session/stage-registry.js";

/**
 * Prove every registered stage's ce-* skill is REACHABLE for the session — via
 * the real seam wiring (closes the U2 → U5 carry-forward).
 *
 * FNXC:CompoundEngineering 2026-06-27-15:44:
 * CE stage skill coverage must iterate `listStages()` rather than sample stages so newly registered stages automatically prove the source → install → discovery-path → prompt contract before they can silently launch without their bundled skill.
 *
 * The U4 `CreateInteractiveAiSessionOptions` surface carries
 * `requestedSkillNames` + `additionalSkillPaths`, which the engine adapter
 * forwards into `createFnAgent` (`skills` + the loader's `additionalSkillPaths`).
 * So the orchestrator hands the session BOTH the stage's skill id and the
 * install directory to discover it from.
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

  it.each(listStages())(
    "the $stageId stage has a bundled source SKILL.md with matching frontmatter name",
    (stage) => {
      const skillMd = join(resolveBundledSkillsRoot(), stage.skillId, "SKILL.md");
      expect(existsSync(skillMd)).toBe(true);
      const content = readFileSync(skillMd, "utf-8");
      expect(content).toMatch(new RegExp(`^name:\\s*${stage.skillId}$`, "m"));
    },
  );

  it.each(listStages())("installing bundled skills onto a discovery root produces $stageId's SKILL.md", (stage) => {
    // Install into a temp discovery root (isolated; mirrors what the real
    // plugin-local install produces, without writing into the repo dir).
    const target = mkdtempSync(join(tmpdir(), "ce-skill-reach-"));
    tmpTargets.push(target);

    const { results } = installBundledCeSkills({ targetRoot: target });
    const stageResult = results.find((r) => r.skillId === stage.skillId);
    expect(stageResult?.outcome).toBe("installed");

    const installedSkillMd = join(target, stage.skillId, "SKILL.md");
    expect(existsSync(installedSkillMd)).toBe(true);
    expect(checkStageSkillResolution(stage, [target])).toMatchObject({
      skillId: stage.skillId,
      found: true,
      expectedSkillMdPaths: [installedSkillMd],
    });
  });

  it.each(listStages())("the $stageId stage system prompt names the stage's ce-* skill id", (stage) => {
    const prompt = buildStageSystemPrompt(stage);
    expect(prompt).toContain(stage.skillId);
    expect(prompt).toContain("question");
    expect(prompt).toContain("complete");
  });
});
