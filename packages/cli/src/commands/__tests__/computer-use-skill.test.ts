import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { COMPUTER_COMMAND_SURFACE } from "../computer/contract.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(testDir, "../../..");
const repoRoot = join(cliRoot, "../..");
const computerUseSkillPath = join(cliRoot, "skill/computer-use/SKILL.md");
const skillRoots = [join(cliRoot, "skill"), join(repoRoot, "plugins")];

function findShippedSkillMarkdown(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return findShippedSkillMarkdown(path);
    return entry.name === "SKILL.md" ? [path] : [];
  });
}

/**
 * FNXC:ComputerUseSkill 2026-08-13-23:35:
 * The original stub-only ratchet let sibling shipped skills reintroduce static computer commands and
 * flags that drift from the installed binary. Discover every bundled SKILL.md so the binary remains
 * the only version-matched command guide, while preserving the three read-only fallback probes.
 */
function readShippedSkills(): Array<{ path: string; content: string }> {
  return skillRoots
    .flatMap(findShippedSkillMarkdown)
    .filter((path) => path.includes("/skill/") || /\/plugins\/[^/]+\/src\/skills\//.test(path))
    .sort()
    .map((path) => ({ path, content: readFileSync(path, "utf8") }));
}

describe("computer-use shipped skill", () => {
  it("has parseable frontmatter and keeps its anti-drift stub thin", () => {
    const skill = readFileSync(computerUseSkillPath, "utf8");
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1];
    expect(parse(frontmatter ?? "")).toMatchObject({ name: "computer-use" });
    expect(skill).toContain("fn skills get computer-use");
    const commands = [...skill.matchAll(/fn computer ([a-z-]+)([^\n]*)/g)];
    expect(commands.map((x) => x[1])).toEqual(["capabilities", "permissions", "list-apps"]);
    for (const [, name, tail] of commands) {
      expect(COMPUTER_COMMAND_SURFACE[name as keyof typeof COMPUTER_COMMAND_SURFACE]).toBeDefined();
      expect(tail.replace(/`$/, "")).toBe(" --json");
    }
    expect([...skill.matchAll(/--[a-z][a-z-]*/g)].map(([flag]) => flag)).toEqual(["--json", "--json", "--json"]);
  });

  it("keeps computer commands out of every other shipped skill", () => {
    const skills = readShippedSkills();
    const skillPaths = skills.map(({ path }) => relative(repoRoot, path));
    expect(skillPaths).not.toHaveLength(0);
    expect(skillPaths).toContain("packages/cli/skill/computer-use/SKILL.md");
    expect(skillPaths).toContain("packages/cli/skill/fusion/SKILL.md");

    for (const { path, content } of skills) {
      if (path === computerUseSkillPath) continue;
      expect(content, relative(repoRoot, path)).not.toMatch(/fn computer [a-z-]+/);
    }
  });
});
