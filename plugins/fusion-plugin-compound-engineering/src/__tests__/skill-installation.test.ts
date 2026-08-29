import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPluginLocalTarget,
  installBundledCeSkills,
  isPluginLocalPath,
  resolveBundledSkillsRoot,
} from "../skill-installation.js";
import { COMPOUND_ENGINEERING_SKILLS } from "../skills.js";

describe("compound engineering bundled skill install", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ce-skill-install-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("installs every bundled CE skill into the plugin-local target", () => {
    const targetRoot = join(tmp, "plugin-local", ".fusion-ce-skills");
    const { results } = installBundledCeSkills({ targetRoot });

    for (const skill of COMPOUND_ENGINEERING_SKILLS) {
      const r = results.find((x) => x.skillId === skill.skillId)!;
      expect(r.outcome).toBe("installed");
      const skillMd = join(targetRoot, skill.skillId, "SKILL.md");
      expect(existsSync(skillMd)).toBe(true);
    }
  });

  it("is idempotent when the plugin-local install provenance is current", () => {
    const targetRoot = join(tmp, ".fusion-ce-skills");
    const first = installBundledCeSkills({ targetRoot });
    expect(first.results.every((r) => r.outcome === "installed")).toBe(true);

    // Tamper with an installed file; a current provenance marker means this is
    // the operator's active plugin-local copy and should not be overwritten.
    const sentinelPath = join(targetRoot, "ce-plan", "SKILL.md");
    writeFileSync(sentinelPath, "SENTINEL");

    const second = installBundledCeSkills({ targetRoot });
    expect(second.results.every((r) => r.outcome === "skipped")).toBe(true);
    expect(readFileSync(sentinelPath, "utf-8")).toBe("SENTINEL");
  });

  it("refreshes stale plugin-local installs without a current provenance marker", () => {
    const targetRoot = join(tmp, ".fusion-ce-skills");
    const first = installBundledCeSkills({ targetRoot });
    expect(first.results.every((r) => r.outcome === "installed")).toBe(true);

    const sentinelPath = join(targetRoot, "ce-plan", "SKILL.md");
    writeFileSync(sentinelPath, "SENTINEL");
    rmSync(join(targetRoot, ".fusion-ce-upstream-provenance.json"), { force: true });

    const second = installBundledCeSkills({ targetRoot });
    expect(second.results.every((r) => r.outcome === "refreshed")).toBe(true);
    expect(readFileSync(sentinelPath, "utf-8")).not.toBe("SENTINEL");
  });

  // ── AE2: isolation — a global compound-engineering install is untouched ──
  it("AE2: never writes outside the plugin-local target when a global install exists", () => {
    // Seed a fake global compound-engineering install under a fake HOME.
    const fakeHome = join(tmp, "home");
    const globalSkillsDir = join(fakeHome, ".claude", "skills", "ce-plan");
    mkdirSync(globalSkillsDir, { recursive: true });
    const globalSkillMd = join(globalSkillsDir, "SKILL.md");
    writeFileSync(globalSkillMd, "GLOBAL-ORIGINAL");
    const beforeContent = readFileSync(globalSkillMd, "utf-8");
    const beforeMtime = statSync(globalSkillMd).mtimeMs;

    const targetRoot = join(tmp, "plugin-local", ".fusion-ce-skills");
    const { targetRoot: usedTarget, results } = installBundledCeSkills({ targetRoot });

    // The install target is provably plugin-local, never the global dir.
    expect(usedTarget.includes(join(".claude", "skills"))).toBe(false);
    expect(isPluginLocalPath(usedTarget)).toBe(true);
    for (const r of results) {
      expect(r.targetDir.includes(join(".claude", "skills"))).toBe(false);
    }

    // The global install is byte-for-byte and mtime untouched.
    expect(readFileSync(globalSkillMd, "utf-8")).toBe(beforeContent);
    expect(statSync(globalSkillMd).mtimeMs).toBe(beforeMtime);
  });

  it("AE2 guard: refuses to install into a global client skills directory", () => {
    const globalTarget = join(tmp, "home", ".claude", "skills");
    expect(() => assertPluginLocalTarget(globalTarget)).toThrow(/plugin-local/i);
    expect(() => installBundledCeSkills({ targetRoot: globalTarget })).toThrow(/plugin-local/i);
    expect(isPluginLocalPath(globalTarget)).toBe(false);
  });

  // ── Edge: malformed/missing SKILL.md surfaces a clear error ──
  it("edge: a missing/malformed bundled SKILL.md surfaces a clear load error, not a silent skip", () => {
    // Point at an empty source root so every skill's source dir is missing.
    const emptySource = join(tmp, "empty-source");
    mkdirSync(emptySource, { recursive: true });
    const targetRoot = join(tmp, ".fusion-ce-skills");

    const { results } = installBundledCeSkills({ targetRoot, sourceRoot: emptySource });
    for (const r of results) {
      expect(r.outcome).toBe("error");
      expect(r.reason).toMatch(/missing|SKILL\.md/i);
    }

    // Now a malformed SKILL.md (no frontmatter name) for one skill.
    const malformedSource = join(tmp, "malformed-source");
    const planDir = join(malformedSource, "ce-plan");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "SKILL.md"), "no frontmatter here\n");
    const res2 = installBundledCeSkills({ targetRoot: join(tmp, "t2"), sourceRoot: malformedSource });
    const plan = res2.results.find((r) => r.skillId === "ce-plan")!;
    expect(plan.outcome).toBe("error");
    expect(plan.reason).toMatch(/frontmatter 'name:'/i);
  });

  it("bundled source root resolves and contains all SKILL.md files", () => {
    const root = resolveBundledSkillsRoot();
    expect(existsSync(root)).toBe(true);
    for (const skill of COMPOUND_ENGINEERING_SKILLS) {
      expect(existsSync(join(root, skill.skillId, "SKILL.md"))).toBe(true);
    }
  });
});
