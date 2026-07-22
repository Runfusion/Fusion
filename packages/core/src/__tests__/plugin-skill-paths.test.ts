import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { resolvePluginSkillBodyPath } from "../plugins/plugin-skill-paths.js";
import type { PluginSkillContribution } from "../plugins/plugin-types.js";

function skill(overrides: Partial<PluginSkillContribution> = {}): PluginSkillContribution {
  return {
    skillId: "entity-framework-core",
    name: "entity-framework-core",
    description: "EF Core guidance",
    skillFiles: [],
    ...overrides,
  };
}

describe("resolvePluginSkillBodyPath", () => {
  const pluginRoot = resolve("/tmp/fusion-plugin");

  it("honors category-subdir skillFiles as the skill body path", () => {
    const result = resolvePluginSkillBodyPath(
      skill({ skillFiles: ["skills/data/entity-framework-core/SKILL.md"] }),
      pluginRoot,
    );

    expect(result).toEqual({
      relativePath: "skills/data/entity-framework-core/SKILL.md",
      absolutePath: join(pluginRoot, "skills/data/entity-framework-core/SKILL.md"),
    });
  });

  it("honors flat skillFiles without changing existing relative paths", () => {
    const result = resolvePluginSkillBodyPath(
      skill({ skillFiles: ["skills/entity-framework-core/SKILL.md"] }),
      pluginRoot,
    );

    expect(result.relativePath).toBe("skills/entity-framework-core/SKILL.md");
    expect(result.absolutePath).toBe(join(pluginRoot, "skills/entity-framework-core/SKILL.md"));
  });

  it("falls back to the name-derived path when skillFiles is empty or absent", () => {
    expect(resolvePluginSkillBodyPath(skill({ skillFiles: [] }), pluginRoot)).toEqual({
      relativePath: "skills/entity-framework-core/SKILL.md",
      absolutePath: join(pluginRoot, "skills/entity-framework-core/SKILL.md"),
    });
    expect(resolvePluginSkillBodyPath(skill({ skillFiles: undefined as unknown as string[] }), pluginRoot)).toEqual({
      relativePath: "skills/entity-framework-core/SKILL.md",
      absolutePath: join(pluginRoot, "skills/entity-framework-core/SKILL.md"),
    });
  });

  it("guards traversal and falls back without resolving outside the plugin root", () => {
    const result = resolvePluginSkillBodyPath(
      skill({ skillFiles: ["../outside/SKILL.md"] }),
      pluginRoot,
    );

    expect(result.relativePath).toBe("skills/entity-framework-core/SKILL.md");
    expect(result.absolutePath.startsWith(`${pluginRoot}/`)).toBe(true);
  });

  it("uses only skillFiles[0] as the authoritative body path", () => {
    const result = resolvePluginSkillBodyPath(
      skill({
        skillFiles: [
          "skills/first/SKILL.md",
          "skills/second/SKILL.md",
        ],
      }),
      pluginRoot,
    );

    expect(result.relativePath).toBe("skills/first/SKILL.md");
  });
});
