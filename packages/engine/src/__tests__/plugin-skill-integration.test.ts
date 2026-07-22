import { describe, it, expect, vi } from "vitest";
import type { AgentStore } from "@fusion/core";
import type { PluginRunner } from "../plugins/plugin-runner.js";
import { buildSessionSkillContext } from "../cli-runtime/session-skill-context.js";
import { createSkillsOverrideFromSelection, resolveSessionSkills } from "../cli-runtime/skill-resolver.js";
import type { Skill } from "@earendil-works/pi-coding-agent";

describe("plugin skill integration", () => {
  const projectRootDir = "/test/project";

  it("merges enabled plugin skills, excludes disabled, and dedupes with agent skills", async () => {
    const agentStore = {
      getAgent: vi.fn().mockResolvedValue({
        id: "agent-1",
        metadata: { skills: ["fusion", "agent-only"] },
      }),
    } as unknown as AgentStore;

    const pluginRunner = {
      getPluginSkills: vi.fn().mockReturnValue([
        { pluginId: "plugin-a", skill: { name: "fusion", enabled: true } },
        { pluginId: "plugin-a", skill: { name: "plugin-enabled", enabled: true } },
        { pluginId: "plugin-b", skill: { name: "plugin-disabled", enabled: false } },
      ]),
    } as unknown as PluginRunner;

    const contextResult = await buildSessionSkillContext({
      agentStore,
      task: { assignedAgentId: "agent-1" },
      sessionPurpose: "executor",
      projectRootDir,
      pluginRunner,
    });

    expect(contextResult.skillSelectionContext?.requestedSkillNames).toEqual([
      "fusion",
      "agent-only",
      "plugin-enabled",
    ]);
  });

  it("coexists with role fallback and flows through resolver pipeline", async () => {
    const agentStore = {
      getAgent: vi.fn().mockResolvedValue(null),
    } as unknown as AgentStore;
    const pluginRunner = {
      getPluginSkills: vi.fn().mockReturnValue([
        { pluginId: "plugin-a", skill: { name: "plugin-skill", enabled: true } },
      ]),
    } as unknown as PluginRunner;

    const contextResult = await buildSessionSkillContext({
      agentStore,
      task: {},
      sessionPurpose: "triage",
      projectRootDir,
      pluginRunner,
    });

    expect(contextResult.skillSelectionContext?.requestedSkillNames).toEqual(["fusion", "plugin-skill"]);

    const resolved = resolveSessionSkills(contextResult.skillSelectionContext!);
    const skillsOverride = createSkillsOverrideFromSelection(resolved, {
      requestedSkillNames: contextResult.skillSelectionContext?.requestedSkillNames,
      sessionPurpose: contextResult.skillSelectionContext?.sessionPurpose,
    });
    const makeSkill = (name: string, filePath: string): Skill => ({
      name,
      description: `${name} description`,
      filePath,
      baseDir: "/skills",
      sourceInfo: {} as Skill["sourceInfo"],
      disableModelInvocation: false,
    });

    const filtered = skillsOverride({
      skills: [
        makeSkill("fusion", "/skills/fusion/SKILL.md"),
        makeSkill("plugin-skill", "/skills/plugin/SKILL.md"),
        makeSkill("other", "/skills/other/SKILL.md"),
      ],
      diagnostics: [],
    });

    expect(contextResult.skillSelectionContext?.requestedSkillNames).toEqual(["fusion", "plugin-skill"]);
    expect(filtered.skills.map((skill) => skill.name)).toEqual(["fusion", "plugin-skill"]);
  });
});
