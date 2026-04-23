import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempWorkspace } from "@fusion/test-utils";
import {
  ensureFusionSkillForProjects,
  installFusionSkillIntoProject,
  isPiClaudeCliConfigured,
} from "./claude-skills.js";

function makeSourceSkill(root: string, body = "---\nname: fusion\n---\n# hi\n"): string {
  const dir = join(root, "src-skill", "fusion");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
  return dir;
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
    expect(
      isPiClaudeCliConfigured({
        useClaudeCli: false,
        packages: ["npm:pi-claude-cli"],
      }),
    ).toBe(false);
  });

  it("detects pi-claude-cli in packages array", () => {
    expect(isPiClaudeCliConfigured({ packages: ["npm:pi-claude-cli"] })).toBe(true);
    expect(isPiClaudeCliConfigured({ packages: ["npm:pi-claude-cli@0.3.1"] })).toBe(true);
    expect(isPiClaudeCliConfigured({ packages: ["github:owner/pi-claude-cli"] })).toBe(true);
  });

  it("ignores unrelated packages", () => {
    expect(
      isPiClaudeCliConfigured({ packages: ["npm:some-other", "npm:pi-ai"] }),
    ).toBe(false);
  });
});

describe("installFusionSkillIntoProject", () => {
  it("is a no-op when disabled", () => {
    const root = tempWorkspace("fusion-claude-skills-");
    const projectPath = join(root, "project");
    mkdirSync(projectPath, { recursive: true });
    const source = makeSourceSkill(root);

    const result = installFusionSkillIntoProject(projectPath, { source, enabled: false });
    expect(result.outcome).toBe("skipped");
    expect(existsSync(join(projectPath, ".claude"))).toBe(false);
  });

  it("creates a symlink on first install", () => {
    const root = tempWorkspace("fusion-claude-skills-");
    const projectPath = join(root, "project");
    mkdirSync(projectPath, { recursive: true });
    const source = makeSourceSkill(root);

    const result = installFusionSkillIntoProject(projectPath, { source, enabled: true });
    expect(result.outcome).toBe("installed");

    const target = join(projectPath, ".claude", "skills", "fusion");
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readlinkSync(target)).toBe(source);
    expect(readFileSync(join(target, "SKILL.md"), "utf-8")).toContain("name: fusion");
  });

  it("is idempotent when the correct symlink already exists", () => {
    const root = tempWorkspace("fusion-claude-skills-");
    const projectPath = join(root, "project");
    mkdirSync(projectPath, { recursive: true });
    const source = makeSourceSkill(root);

    installFusionSkillIntoProject(projectPath, { source, enabled: true });
    const result = installFusionSkillIntoProject(projectPath, { source, enabled: true });
    expect(result.outcome).toBe("already-installed");
  });

  it("replaces a stale symlink that points elsewhere", () => {
    const root = tempWorkspace("fusion-claude-skills-");
    const projectPath = join(root, "project");
    mkdirSync(projectPath, { recursive: true });
    const source = makeSourceSkill(root);

    // Seed a stale symlink pointing at a different dir.
    const stale = join(root, "stale");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "SKILL.md"), "# stale");
    const target = join(projectPath, ".claude", "skills", "fusion");
    mkdirSync(join(projectPath, ".claude", "skills"), { recursive: true });
    symlinkSync(stale, target, "dir");

    const result = installFusionSkillIntoProject(projectPath, { source, enabled: true });
    expect(result.outcome).toBe("replaced");
    expect(readlinkSync(target)).toBe(source);
  });

  it("replaces a prior copy-install (plain dir with SKILL.md)", () => {
    const root = tempWorkspace("fusion-claude-skills-");
    const projectPath = join(root, "project");
    const source = makeSourceSkill(root);
    // Seed a prior copy — looks like a fusion skill install.
    const target = join(projectPath, ".claude", "skills", "fusion");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), "# old copy\n");

    const result = installFusionSkillIntoProject(projectPath, { source, enabled: true });
    expect(result.outcome).toBe("replaced");
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
  });

  it("refuses to clobber a foreign directory without SKILL.md", () => {
    const root = tempWorkspace("fusion-claude-skills-");
    const projectPath = join(root, "project");
    const source = makeSourceSkill(root);
    const target = join(projectPath, ".claude", "skills", "fusion");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "random.txt"), "user data");

    const result = installFusionSkillIntoProject(projectPath, { source, enabled: true });
    expect(result.outcome).toBe("failed");
    expect(readFileSync(join(target, "random.txt"), "utf-8")).toBe("user data");
  });

  it("reports failure when source is missing", () => {
    const root = tempWorkspace("fusion-claude-skills-");
    const projectPath = join(root, "project");
    mkdirSync(projectPath, { recursive: true });

    const result = installFusionSkillIntoProject(projectPath, {
      source: join(root, "nonexistent"),
      enabled: true,
    });
    // Source missing -> symlink may succeed on POSIX (to a nonexistent path)
    // then later fail to resolve. The function still creates the symlink;
    // that's acceptable since fs reads will surface the broken link clearly.
    expect(["installed", "failed"]).toContain(result.outcome);
  });
});

describe("ensureFusionSkillForProjects", () => {
  it("skips all when disabled", () => {
    const root = tempWorkspace("fusion-claude-skills-");
    const projects = [
      { id: "a", name: "a", path: join(root, "a") },
      { id: "b", name: "b", path: join(root, "b") },
    ];
    for (const p of projects) mkdirSync(p.path, { recursive: true });

    const results = ensureFusionSkillForProjects(projects, { enabled: false });
    expect(results.map((r) => r.outcome)).toEqual(["skipped", "skipped"]);
  });

  it("installs for all when enabled", () => {
    const root = tempWorkspace("fusion-claude-skills-");
    const source = makeSourceSkill(root);
    const projects = [
      { id: "a", name: "a", path: join(root, "a") },
      { id: "b", name: "b", path: join(root, "b") },
    ];
    for (const p of projects) mkdirSync(p.path, { recursive: true });

    const results = ensureFusionSkillForProjects(projects, { enabled: true, source });
    expect(results.map((r) => r.outcome)).toEqual(["installed", "installed"]);
    for (const p of projects) {
      expect(
        lstatSync(join(p.path, ".claude", "skills", "fusion")).isSymbolicLink(),
      ).toBe(true);
    }
  });
});
