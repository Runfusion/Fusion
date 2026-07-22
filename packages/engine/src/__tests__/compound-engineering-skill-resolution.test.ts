/**
 * U2 — Empirical proof of how Compound Engineering bundled skills become
 * resolvable in an agent session.
 *
 * This drives the REAL engine skill pipeline:
 *   pi-coding-agent `loadSkills` (disk discovery)  →
 *   `resolveSessionSkills` + `createSkillsOverrideFromSelection` (the same
 *   path `createFnAgent` uses in pi.ts via DefaultResourceLoader.skillsOverride).
 *
 * THE QUESTION: does declaring `skills: PluginSkillContribution[]` (whose
 * contribution surfaces only as a *name* in `requestedSkillNames`) make a
 * bundled SKILL.md resolvable, OR is a physical install into a discoverable
 * directory also required?
 *
 * ANSWER (asserted below): the contribution alone is NOT enough. The engine
 * never ingests `PluginSkillContribution.skillFiles` into the discovered set;
 * the requested name has nothing on disk to match. A physical, plugin-local
 * install (so the SKILL.md lives on a path `loadSkills` scans) is REQUIRED.
 *
 * The test is self-contained on the engine side: it models "a physical install"
 * by materializing a `ce-plan/SKILL.md` on disk and pointing disk discovery at
 * its parent dir — exactly what the plugin's `installBundledCeSkills` does into
 * a plugin-local directory wired through `additionalSkillPaths`. (The plugin's
 * own cpSync + isolation behavior is verified in the plugin package's
 * skill-installation.test.ts; the engine package cannot import plugin source
 * without violating its tsc rootDir.)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, loadSkills, type Skill } from "@earendil-works/pi-coding-agent";
import {
  createSkillsOverrideFromSelection,
  resolveSessionSkills,
} from "../cli-runtime/skill-resolver.js";

vi.mock("../logger.js", () => ({
  piLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const CE_STAGES = [
  "ce-strategy",
  "ce-ideate",
  "ce-brainstorm",
  "ce-plan",
  "ce-work",
  "ce-code-review",
  "ce-compound",
] as const;

/** Model the plugin-local physical install: write each stage's SKILL.md to disk. */
function materializeInstalledSkills(root: string, stages: readonly string[]): void {
  for (const id of stages) {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${id}\ndescription: ${id} pipeline stage\n---\n\n# ${id}\n`,
    );
  }
}

/**
 * Run the exact engine resolution path for a session that requests CE skill
 * names (as if a plugin contributed them via getPluginSkills ->
 * requestedSkillNames), over whatever skills `loadSkills` discovers from
 * `discoveredSkillPaths`. Returns the resolved skill names visible to the
 * session.
 */
function resolveSessionFor(opts: {
  projectRootDir: string;
  agentDir: string;
  discoveredSkillPaths: string[];
  requestedSkillNames: string[];
}): string[] {
  // 1. Disk discovery — exactly what DefaultResourceLoader feeds to its override.
  const discovered = loadSkills({
    cwd: opts.projectRootDir,
    agentDir: opts.agentDir,
    skillPaths: opts.discoveredSkillPaths,
    includeDefaults: false,
  });

  // 2. Engine resolver (project settings + requested names).
  const selection = resolveSessionSkills({
    projectRootDir: opts.projectRootDir,
    requestedSkillNames: opts.requestedSkillNames,
    sessionPurpose: "executor",
  });
  const override = createSkillsOverrideFromSelection(selection, {
    requestedSkillNames: opts.requestedSkillNames,
    sessionPurpose: "executor",
  });

  const result = override({ skills: discovered.skills, diagnostics: discovered.diagnostics });
  return result.skills.map((s) => s.name);
}

describe("U2: CE bundled skill session-resolution (empirical)", () => {
  let tmp: string;
  let projectRootDir: string;
  let agentDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ce-resolve-"));
    // An empty project + empty agent dir: NOTHING ce-* is discoverable yet.
    projectRootDir = join(tmp, "project");
    agentDir = join(tmp, "agent");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("FAILING-FIRST: contribution name alone (no physical install) does NOT resolve ce-plan", () => {
    // Simulate: plugin declared skills -> requestedSkillNames includes ce-plan,
    // but no SKILL.md was installed anywhere discoverable.
    const resolved = resolveSessionFor({
      projectRootDir,
      agentDir,
      discoveredSkillPaths: [], // nothing on disk
      requestedSkillNames: ["ce-plan"],
    });
    // Proves the contribution alone is insufficient: ce-plan is NOT resolvable.
    expect(resolved).not.toContain("ce-plan");
    expect(resolved).toEqual([]);
  });

  it("PASSING: after a plugin-local physical install, ce-plan IS resolvable for the session", () => {
    const installRoot = join(tmp, "plugin-local", ".fusion-ce-skills");
    materializeInstalledSkills(installRoot, ["ce-plan"]);

    const resolved = resolveSessionFor({
      projectRootDir,
      agentDir,
      discoveredSkillPaths: [installRoot], // installed dir is now discoverable
      requestedSkillNames: ["ce-plan"],
    });

    expect(resolved).toContain("ce-plan");
  });

  it("PASSING: all seven CE stages resolve when requested after install", () => {
    const installRoot = join(tmp, ".fusion-ce-skills");
    materializeInstalledSkills(installRoot, CE_STAGES);

    const resolved = resolveSessionFor({
      projectRootDir,
      agentDir,
      discoveredSkillPaths: [installRoot],
      requestedSkillNames: [...CE_STAGES],
    });
    for (const s of CE_STAGES) {
      expect(resolved).toContain(s);
    }
  });

  it("PASSING (real loader): DefaultResourceLoader with additionalSkillPaths + skillsOverride discovers ce-plan — the exact path createFnAgent now feeds", async () => {
    const installRoot = join(tmp, ".fusion-ce-skills");
    materializeInstalledSkills(installRoot, ["ce-plan", "ce-work"]);
    mkdirSync(projectRootDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });

    // Build the same skillsOverride createFnAgent builds from `skills: ["ce-plan"]`.
    const selection = resolveSessionSkills({
      projectRootDir,
      requestedSkillNames: ["ce-plan"],
      sessionPurpose: "executor",
    });
    const skillsOverride = createSkillsOverrideFromSelection(selection, {
      requestedSkillNames: ["ce-plan"],
      sessionPurpose: "executor",
    });

    // Construct the loader exactly as pi.ts createFnAgent now does: cwd on the
    // project root, the install dir passed via additionalSkillPaths, and the
    // requested-name filter as skillsOverride.
    const loader = new DefaultResourceLoader({
      cwd: projectRootDir,
      agentDir,
      additionalSkillPaths: [installRoot],
      skillsOverride,
    });
    await loader.reload();

    const names = loader.getSkills().skills.map((s: Skill) => s.name);
    // ce-plan is discoverable (via additionalSkillPaths) AND survives the filter;
    // ce-work is discovered but filtered out by the requested-name override.
    expect(names).toContain("ce-plan");
    expect(names).not.toContain("ce-work");
  });
});
