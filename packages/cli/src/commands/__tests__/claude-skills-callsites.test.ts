import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempWorkspace } from "@fusion/test-utils";
import { SHIPPED_SKILL_NAMES } from "../claude-skills.js";
import { ensureClaudeSkillsForAllProjectsOnStartup } from "../claude-skills-runner.js";
const commands = join(dirname(fileURLToPath(import.meta.url)), "..");
describe("Claude skill call sites", () => {
  it("C7d reconciles both skills for every project and skips all writes when disabled", () => {
    /* FNXC:ComputerUseSkill 2026-08-11-12:59: C7d must exercise the runner as well as pin host
     * text: static call-site counts cannot prove multi-project reconciliation or the disabled
     * pi-claude-cli no-write contract. Explicit sources keep this test independent of packaging. */
    const root = tempWorkspace("fusion-claude-skills-callsites-");
    const projects = ["first", "second"].map((name, index) => {
      const path = join(root, name);
      mkdirSync(path, { recursive: true });
      return { id: String(index), name, path };
    });
    const sources = Object.fromEntries(SHIPPED_SKILL_NAMES.map((skillName) => {
      const source = join(root, "sources", skillName);
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "SKILL.md"), `---\nname: ${skillName}\n---\n`);
      return [skillName, source];
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const installed = ensureClaudeSkillsForAllProjectsOnStartup(projects, { enabled: true, sources });
      expect(installed).toHaveLength(projects.length * SHIPPED_SKILL_NAMES.length);
      expect(installed.map((result) => result.outcome)).toEqual(["installed", "installed", "installed", "installed"]);
      for (const project of projects) {
        for (const skillName of SHIPPED_SKILL_NAMES) {
          expect(existsSync(join(project.path, ".claude", "skills", skillName, "SKILL.md"))).toBe(true);
        }
      }
      const disabledRoot = join(root, "disabled");
      mkdirSync(disabledRoot, { recursive: true });
      const disabled = ensureClaudeSkillsForAllProjectsOnStartup([{ id: "disabled", name: "disabled", path: disabledRoot }], { enabled: false, sources });
      expect(disabled.map((result) => result.outcome)).toEqual(["skipped", "skipped"]);
      expect(existsSync(join(disabledRoot, ".claude"))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it("pins every startup host to the generalized reconciliation runner", () => {
    /* FNXC:ComputerUseSkill 2026-08-11-07:19: These seven host calls are pinned separately from
     * runner behavior so a dropped startup reconciliation site cannot silently lose computer-use. */
    const expected = { "serve.ts": 2, "dashboard.ts": 3, "daemon.ts": 2 };
    expect(SHIPPED_SKILL_NAMES).toEqual(["fusion", "computer-use"]);
    for (const [file, count] of Object.entries(expected)) {
      const source = readFileSync(join(commands, file), "utf8");
      expect([...source.matchAll(/ensureClaudeSkillsForAllProjectsOnStartup\(/g)]).toHaveLength(count);
      expect(source).toContain('from "./claude-skills-runner.js"');
    }
  });

  it("keeps command entry points on multi-skill delegates", () => {
    const fusionOnly = /\b(?:installFusionSkillIntoProject|ensureFusionSkillForProjects|resolveFusionSkillSource|installBundledFusionSkill)\b/;
    for (const file of ["init.ts", "project.ts", "serve.ts", "dashboard.ts", "daemon.ts", "claude-skills-runner.ts"]) {
      expect(readFileSync(join(commands, file), "utf8"), file).not.toMatch(fusionOnly);
    }
  });
});
