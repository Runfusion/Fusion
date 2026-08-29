import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dashboardSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard.ts"), "utf8");

describe("dashboard Claude skill wiring", () => {
  it("C5: both dashboard project-registration handlers use the generalized installer", () => {
    /* FNXC:ComputerUseSkill 2026-08-11-07:43: Dashboard boot pulls in process supervision and
     * cannot be safely started in this narrow suite; pin both callback bodies instead of a server. */
    expect([...dashboardSource.matchAll(/onProjectRegistered:\s*\(\{ path \}\)\s*=>\s*\{\s*maybeInstallClaudeSkillForNewProject\(path\);/g)]).toHaveLength(2);
  });

  it("C7b: all dashboard startup reconciliation hooks use the generalized runner", () => {
    expect([...dashboardSource.matchAll(/ensureClaudeSkillsForAllProjectsOnStartup\(/g)]).toHaveLength(3);
    expect(dashboardSource).not.toMatch(/(?:installFusionSkillIntoProject|ensureFusionSkillForProjects)\(/);
  });
});
