import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listStages } from "../session/stage-registry.js";
import { COMPOUND_ENGINEERING_SKILLS } from "../skills.js";
import { CE_UPSTREAM_PROVENANCE } from "../upstream-provenance.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");
const skillsRoot = join(srcRoot, "skills");
const agentsRoot = join(srcRoot, "agents");

function frontmatterValue(content: string, key: string): string | undefined {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return undefined;
  const line = match[1].split("\n").find((entry) => entry.startsWith(`${key}:`));
  return line?.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, "");
}

describe("Compound Engineering upstream provenance", () => {
  it("pins a release tag and source tarball digest", () => {
    expect(CE_UPSTREAM_PROVENANCE.repo).toBe("EveryInc/compound-engineering-plugin");
    expect(CE_UPSTREAM_PROVENANCE.releaseTag).toMatch(/^compound-engineering-v\d+\.\d+\.\d+$/);
    expect(CE_UPSTREAM_PROVENANCE.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(CE_UPSTREAM_PROVENANCE.tarballSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps every bundled skill directory aligned with its SKILL.md frontmatter name", () => {
    const dirs = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("ce-"))
      .map((entry) => entry.name)
      .sort();

    expect(dirs).toEqual(COMPOUND_ENGINEERING_SKILLS.map((skill) => skill.skillId).sort());

    for (const dir of dirs) {
      const skillFile = join(skillsRoot, dir, "SKILL.md");
      expect(existsSync(skillFile), `${dir} should include SKILL.md`).toBe(true);
      expect(frontmatterValue(readFileSync(skillFile, "utf-8"), "name")).toBe(dir);
    }
  });

  it("keeps every bundled ce-* agent definition named in frontmatter", () => {
    const agentFiles = readdirSync(agentsRoot)
      .filter((file) => file.startsWith("ce-") && file.endsWith(".md"))
      .sort();

    expect(agentFiles.length).toBeGreaterThan(0);
    for (const file of agentFiles) {
      const name = frontmatterValue(readFileSync(join(agentsRoot, file), "utf-8"), "name");
      expect(name, `${file} should have a non-empty frontmatter name`).toMatch(/^ce-.+/);
    }
  });

  it("covers every stage skill id with a bundled skill contribution", () => {
    const bundledSkillIds = new Set(COMPOUND_ENGINEERING_SKILLS.map((skill) => skill.skillId));
    for (const stage of listStages()) {
      expect(bundledSkillIds.has(stage.skillId), `${stage.stageId} uses missing skill ${stage.skillId}`).toBe(true);
    }
  });
});
