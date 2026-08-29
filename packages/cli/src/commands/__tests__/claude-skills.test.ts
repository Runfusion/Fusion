import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempWorkspace } from "@fusion/test-utils";
import {
  ensureShippedSkillsForProjects,
  installShippedSkillIntoProject,
  isPiClaudeCliConfigured,
  SHIPPED_SKILL_NAMES,
  type ShippedSkillName,
} from "../claude-skills.js";

function makeSourceSkill(root: string, skillName: ShippedSkillName): string {
  const dir = join(root, "src-skill", skillName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${skillName}\n---\n# hi\n`);
  return dir;
}

function makeSources(root: string): Record<ShippedSkillName, string> {
  return Object.fromEntries(SHIPPED_SKILL_NAMES.map((skillName) => [skillName, makeSourceSkill(root, skillName)])) as Record<ShippedSkillName, string>;
}

describe("isPiClaudeCliConfigured", () => {
  it("returns false for null or empty settings", () => {
    expect(isPiClaudeCliConfigured(null)).toBe(false);
    expect(isPiClaudeCliConfigured(undefined)).toBe(false);
    expect(isPiClaudeCliConfigured({})).toBe(false);
  });

  it("respects explicit useClaudeCli=true", () => {
    expect(isPiClaudeCliConfigured({ useClaudeCli: true })).toBe(true);
  });

  it("respects explicit useClaudeCli=false even when package is present", () => {
    expect(isPiClaudeCliConfigured({ useClaudeCli: false, packages: ["npm:pi-claude-cli"] })).toBe(false);
  });

  it("detects pi-claude-cli in packages array", () => {
    expect(isPiClaudeCliConfigured({ packages: ["npm:pi-claude-cli"] })).toBe(true);
    expect(isPiClaudeCliConfigured({ packages: ["npm:pi-claude-cli@0.3.1"] })).toBe(true);
    expect(isPiClaudeCliConfigured({ packages: ["github:owner/pi-claude-cli"] })).toBe(true);
  });
});

describe("installShippedSkillIntoProject", () => {
  /* FNXC:ComputerUseSkill 2026-08-11-14:30: Reconciliation outcomes must be
   * verified for every shipped skill. Adding a skill must not inherit coverage
   * only from fusion, because either target can independently be stale or foreign. */
  for (const skillName of SHIPPED_SKILL_NAMES) {
    describe(skillName, () => {
      it("skips without creating a Claude directory when disabled", () => {
        const root = tempWorkspace("fusion-claude-skills-");
        const projectPath = join(root, "project");
        mkdirSync(projectPath, { recursive: true });
        const result = installShippedSkillIntoProject(projectPath, skillName, { source: makeSourceSkill(root, skillName), enabled: false });
        expect(result.outcome).toBe("skipped");
        expect(existsSync(join(projectPath, ".claude"))).toBe(false);
      });

      it("installs then recognizes its current symlink", () => {
        const root = tempWorkspace("fusion-claude-skills-");
        const projectPath = join(root, "project");
        const source = makeSourceSkill(root, skillName);
        const first = installShippedSkillIntoProject(projectPath, skillName, { source, enabled: true });
        const second = installShippedSkillIntoProject(projectPath, skillName, { source, enabled: true });
        const target = join(projectPath, ".claude", "skills", skillName);
        expect(first.outcome).toBe("installed");
        expect(second.outcome).toBe("already-installed");
        expect(lstatSync(target).isSymbolicLink()).toBe(true);
        expect(readlinkSync(target)).toBe(source);
      });

      it("replaces stale links and prior copies", () => {
        const root = tempWorkspace("fusion-claude-skills-");
        const projectPath = join(root, "project");
        const source = makeSourceSkill(root, skillName);
        const target = join(projectPath, ".claude", "skills", skillName);
        const stale = join(root, "stale", skillName);
        mkdirSync(stale, { recursive: true });
        writeFileSync(join(stale, "SKILL.md"), "# stale");
        mkdirSync(join(projectPath, ".claude", "skills"), { recursive: true });
        symlinkSync(stale, target, "dir");
        expect(installShippedSkillIntoProject(projectPath, skillName, { source, enabled: true }).outcome).toBe("replaced");
        rmSync(target);
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, "SKILL.md"), "# prior copy");
        expect(installShippedSkillIntoProject(projectPath, skillName, { source, enabled: true }).outcome).toBe("replaced");
        expect(readlinkSync(target)).toBe(source);
      });

      it("refuses a foreign target without removing its contents", () => {
        const root = tempWorkspace("fusion-claude-skills-");
        const projectPath = join(root, "project");
        const target = join(projectPath, ".claude", "skills", skillName);
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, "user-data.txt"), "keep me");
        const result = installShippedSkillIntoProject(projectPath, skillName, { source: makeSourceSkill(root, skillName), enabled: true });
        expect(result.outcome).toBe("failed");
        expect(readFileSync(join(target, "user-data.txt"), "utf8")).toBe("keep me");
      });
    });
  }

  it("isolates one skill failure while reconciling the other skill", () => {
    const root = tempWorkspace("fusion-claude-skills-");
    const project = { id: "project", name: "project", path: join(root, "project") };
    mkdirSync(join(project.path, ".claude", "skills", "computer-use"), { recursive: true });
    writeFileSync(join(project.path, ".claude", "skills", "computer-use", "user-data.txt"), "foreign");
    const results = ensureShippedSkillsForProjects([project], { enabled: true, sources: makeSources(root) });
    expect(results.map((result) => result.outcome)).toEqual(["installed", "failed"]);
    expect(existsSync(join(project.path, ".claude", "skills", "fusion", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(project.path, ".claude", "skills", "computer-use", "user-data.txt"), "utf8")).toBe("foreign");
  });
});
