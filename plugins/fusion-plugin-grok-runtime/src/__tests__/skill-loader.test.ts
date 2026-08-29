import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildGrokSkillRules,
  extractRequestedSkillNames,
  getFusionSkillSourceCandidates,
  resolveBundledComputerUseSkillSource,
  resolveBundledFusionSkillSource,
  stageGrokSessionSkills,
} from "../skill-loader.js";

const disposers: Array<() => void> = [];
const envKeysTouched = new Set<string>();

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  for (const key of envKeysTouched) {
    delete process.env[key];
  }
  envKeysTouched.clear();
});

function setEnv(key: string, value: string): void {
  process.env[key] = value;
  envKeysTouched.add(key);
}

describe("skill-loader", () => {
  it("resolves the bundled Fusion skill from the monorepo", () => {
    const source = resolveBundledFusionSkillSource();
    expect(source).toBeTruthy();
    expect(existsSync(join(source!, "SKILL.md"))).toBe(true);
  });

  it("includes monorepo packages/cli/skill/fusion among candidates", () => {
    const candidates = getFusionSkillSourceCandidates();
    expect(
      candidates.some((c) => c.endsWith(join("packages", "cli", "skill", "fusion")) || c.includes(`${join("packages", "cli", "skill", "fusion")}`)),
    ).toBe(true);
  });

  /*
  FNXC:GrokAcp 2026-07-12-06:15:
  Packaged @runfusion/fusion ships skill/** at package root next to dist/plugins/.
  Candidate generation from a synthetic bundled.js URL must reach skill/fusion
  without a monorepo tree.
  */
  it("generates packaged-install candidates for bundled plugin layout", () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "fusion-pkg-"));
    const pluginDist = join(packageRoot, "dist", "plugins", "fusion-plugin-grok-runtime");
    mkdirSync(pluginDist, { recursive: true });
    const bundledJs = join(pluginDist, "bundled.js");
    writeFileSync(bundledJs, "// stub\n");

    const skillDir = join(packageRoot, "skill", "fusion");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: fusion\n---\n# fusion\n");

    const moduleUrl = pathToFileURL(bundledJs).href;
    const candidates = getFusionSkillSourceCandidates(moduleUrl);
    const resolvedSkill = resolve(skillDir);

    expect(candidates).toContain(resolvedSkill);
    expect(resolveBundledFusionSkillSource(moduleUrl)).toBe(resolvedSkill);
  });

  it("walks ancestors for packages/cli/skill/fusion layout", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "fusion-repo-"));
    const pluginSrc = join(repoRoot, "plugins", "fusion-plugin-grok-runtime", "src");
    mkdirSync(pluginSrc, { recursive: true });
    const moduleFile = join(pluginSrc, "skill-loader.js");
    writeFileSync(moduleFile, "// stub\n");

    const skillDir = join(repoRoot, "packages", "cli", "skill", "fusion");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: fusion\n---\n# fusion\n");

    const moduleUrl = pathToFileURL(moduleFile).href;
    const candidates = getFusionSkillSourceCandidates(moduleUrl);
    expect(candidates).toContain(resolve(skillDir));
    expect(resolveBundledFusionSkillSource(moduleUrl)).toBe(resolve(skillDir));
  });

  it("prefers FUSION_SKILL_SOURCE when set and valid", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-env-skill-"));
    const skillDir = join(root, "custom-fusion");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: fusion\n---\n# env\n");
    setEnv("FUSION_SKILL_SOURCE", skillDir);

    const candidates = getFusionSkillSourceCandidates(pathToFileURL(join(root, "missing", "mod.js")).href);
    expect(candidates[0]).toBe(resolve(skillDir));
    expect(resolveBundledFusionSkillSource(pathToFileURL(join(root, "missing", "mod.js")).href)).toBe(
      resolve(skillDir),
    );
  });

  it("stages fusion skill plus additional skill roots into a plugin dir", () => {
    const extraRoot = mkdtempSync(join(tmpdir(), "extra-skills-"));
    const skillDir = join(extraRoot, "ce-plan");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: ce-plan\n---\n# plan\n");

    const staged = stageGrokSessionSkills({
      requestedSkillNames: ["fusion", "ce-plan"],
      additionalSkillPaths: [extraRoot],
    });
    disposers.push(staged.dispose);

    expect(existsSync(join(staged.pluginDir, "skills", "fusion", "SKILL.md"))).toBe(true);
    expect(existsSync(join(staged.pluginDir, "skills", "ce-plan", "SKILL.md"))).toBe(true);
    expect(staged.skillNames).toEqual(expect.arrayContaining(["fusion", "ce-plan"]));
  });

  it("still lists requested fusion skill in rules when staging cannot copy files", () => {
    const staged = stageGrokSessionSkills({
      requestedSkillNames: ["fusion"],
      includeFusionSkill: false,
    });
    disposers.push(staged.dispose);
    expect(staged.skillNames).toContain("fusion");
    const rules = buildGrokSkillRules({ skillNames: staged.skillNames, fusionToolCount: 0 });
    expect(rules).toContain("fusion");
    expect(rules).toContain("Use the Fusion skill workflows");
  });

  it("extracts requested skill names from skills or skillSelection", () => {
    expect(extractRequestedSkillNames({ skills: ["a", "b"] })).toEqual(["a", "b"]);
    expect(
      extractRequestedSkillNames({ skillSelection: { requestedSkillNames: ["fusion", "ce-plan"] } }),
    ).toEqual(["fusion", "ce-plan"]);
  });

  it("builds rules mentioning skills and tool counts", () => {
    const rules = buildGrokSkillRules({
      skillNames: ["fusion"],
      toolMode: "coding",
      fusionToolCount: 3,
      operatorMcpCount: 1,
    });
    expect(rules).toContain("fusion");
    expect(rules).toContain("fusion-custom-tools");
    expect(rules).toContain("Operator MCP servers");
  });

  it("stages bundled computer-use only on Darwin", () => {
    const staged = stageGrokSessionSkills({ platform: "darwin" });
    disposers.push(staged.dispose);
    expect(existsSync(join(staged.pluginDir, "skills", "fusion", "SKILL.md"))).toBe(true);
    expect(existsSync(join(staged.pluginDir, "skills", "computer-use", "SKILL.md"))).toBe(true);
    expect(staged.skillNames).toEqual(expect.arrayContaining(["fusion", "computer-use"]));
  });

  it("keeps bundled computer-use absent on non-Darwin through every option path", () => {
    const source = resolveBundledComputerUseSkillSource(import.meta.url, "darwin")!;
    const cases = [
      { includeComputerUseSkill: true },
      { requestedSkillNames: ["computer-use"] },
      { additionalSkillPaths: [source] },
      { includeComputerUseSkill: true, requestedSkillNames: ["computer-use"], additionalSkillPaths: [source] },
    ];
    for (const options of cases) {
      const staged = stageGrokSessionSkills({ ...options, platform: "linux" });
      disposers.push(staged.dispose);
      expect(existsSync(join(staged.pluginDir, "skills", "computer-use"))).toBe(false);
      expect(staged.skillNames).not.toContain("computer-use");
    }
  });

  it("keeps user-owned computer-use roots on non-Darwin and honors suppression", () => {
    const root = mkdtempSync(join(tmpdir(), "user-computer-use-"));
    const userSkill = join(root, "computer-use");
    mkdirSync(userSkill, { recursive: true });
    writeFileSync(join(userSkill, "SKILL.md"), "# user skill\n");
    const staged = stageGrokSessionSkills({ platform: "linux", additionalSkillPaths: [root] });
    disposers.push(staged.dispose);
    expect(existsSync(join(staged.pluginDir, "skills", "computer-use", "SKILL.md"))).toBe(true);
    const overridden = stageGrokSessionSkills({ platform: "darwin", additionalSkillPaths: [root] });
    disposers.push(overridden.dispose);
    expect(readFileSync(join(overridden.pluginDir, "skills", "computer-use", "SKILL.md"), "utf8")).toContain("# user skill");
    const suppressed = stageGrokSessionSkills({ platform: "darwin", includeComputerUseSkill: false });
    disposers.push(suppressed.dispose);
    expect(suppressed.skillNames).not.toContain("computer-use");
  });

  it("gates computer-use at source resolution and keeps rules as discovery-only", () => {
    expect(resolveBundledComputerUseSkillSource(import.meta.url, "linux")).toBeNull();
    expect(resolveBundledComputerUseSkillSource(import.meta.url, "darwin")).toBeTruthy();
    const rules = buildGrokSkillRules({ skillNames: ["fusion", "computer-use"] });
    expect(rules).toContain("computer-use");
    expect(rules).not.toMatch(/fn computer|--/i);
  });
});
