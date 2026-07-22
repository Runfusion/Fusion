import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DefaultResourceLoader, type Skill } from "@earendil-works/pi-coding-agent";
import type { AgentStore } from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSessionSkillContext } from "../cli-runtime/session-skill-context.js";
import { createSkillsOverrideFromSelection, resolveSessionSkills } from "../cli-runtime/skill-resolver.js";
import type { PluginRunner } from "../plugins/plugin-runner.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("plugin skill body delivery", () => {
  it("discovers an enabled plugin skill through additionalSkillPaths and keeps it through requested-name filtering", async () => {
    const projectRootDir = await mkdtemp(join(tmpdir(), "plugin-skill-project-"));
    const agentDir = await mkdtemp(join(tmpdir(), "plugin-skill-agent-"));
    const pluginRoot = await mkdtemp(join(tmpdir(), "plugin-skill-package-"));
    tempDirs.push(projectRootDir, agentDir, pluginRoot);
    await mkdir(join(projectRootDir, ".fusion"), { recursive: true });
    const skillDir = join(pluginRoot, "skills", "plugin-plan");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: plugin-plan\ndescription: Plugin planning guidance\n---\n\n# Plugin Plan\n\nDistinctive body delivered by plugin additionalSkillPaths.",
      "utf-8",
    );

    const pluginRunner = {
      getPluginSkills: vi.fn().mockReturnValue([
        { pluginId: "plugin-a", pluginRoot, skill: { name: "plugin-plan" } },
      ]),
    } as unknown as PluginRunner;
    const agentStore = { getAgent: vi.fn().mockResolvedValue(null) } as unknown as AgentStore;

    const context = await buildSessionSkillContext({
      agentStore,
      task: {},
      sessionPurpose: "executor",
      projectRootDir,
      pluginRunner,
    });

    expect(context.resolvedSkillNames).toContain("plugin-plan");
    expect(context.additionalSkillPaths).toEqual([skillDir, dirname(skillDir)]);

    const selection = resolveSessionSkills({
      projectRootDir,
      requestedSkillNames: context.skillSelectionContext?.requestedSkillNames,
      sessionPurpose: "executor",
    });
    const skillsOverride = createSkillsOverrideFromSelection(selection, {
      requestedSkillNames: context.skillSelectionContext?.requestedSkillNames,
      sessionPurpose: "executor",
    });

    const loader = new DefaultResourceLoader({
      cwd: projectRootDir,
      agentDir,
      additionalSkillPaths: context.additionalSkillPaths,
      skillsOverride,
    });
    await loader.reload();

    const skills = loader.getSkills().skills as Skill[];
    const names = skills.map((skill) => skill.name);
    expect(names).toContain("plugin-plan");
    const pluginSkill = skills.find((skill) => skill.name === "plugin-plan");
    expect(pluginSkill?.filePath).toBe(join(skillDir, "SKILL.md"));
    await expect(readFile(pluginSkill!.filePath, "utf-8")).resolves.toContain("Distinctive body delivered by plugin additionalSkillPaths.");
  });
});
