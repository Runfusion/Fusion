/**
 * Compound-Engineering workflow-step skill-loading — focused unit coverage for
 * the plan units U8/U1/U2/U3/U9 engine surface that does NOT require a full
 * executor e2e:
 *
 *   1. The exported `FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE` constant carries
 *      the await-input sentinel grammar, the FUSION_HEADLESS degrade
 *      instruction, and the persona-fan-out / systemPromptOverride /
 *      path-confinement instruction (always feasible — pure constant assertion).
 *
 *   2. Skill resolution: requested CE skill names resolve the named CE skill
 *      once the install dir is fed as a discovery path, whether the request uses
 *      the bare, namespaced, path/SKILL.md-suffixed, mixed-case, or dual form
 *      that executeWorkflowStep merges into requestedSkillNames. This mirrors
 *      and extends compound-engineering-skill-resolution.test.ts, asserting the
 *      normalized U1 request forms resolve once without duplicates.
 *
 * The full runGraphCustomNode -> executeWorkflowStep session path (skillName on
 * the synthesized step, spawn gating, FUSION_HEADLESS, verdict conditional) is
 * covered separately in ce-workflow-step-executor.test.ts (driving the real
 * executor with a mocked agent session).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE } from "../executor.js";
import {
  createSkillsOverrideFromSelection,
  resolveSessionSkills,
} from "../cli-runtime/skill-resolver.js";

vi.mock("../logger.js", () => {
  const mk = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });
  return {
    createLogger: vi.fn(() => mk()),
    piLog: mk(),
    schedulerLog: mk(),
    executorLog: mk(),
    planLog: mk(),
    mergerLog: mk(),
    worktreePoolLog: mk(),
    reviewerLog: mk(),
    prMonitorLog: mk(),
    runtimeLog: mk(),
    ipcLog: mk(),
    projectManagerLog: mk(),
    hybridExecutorLog: mk(),
    formatError: (err: unknown) =>
      err instanceof Error ? { message: err.message, detail: err.stack ?? err.message } : { message: String(err), detail: String(err) },
  };
});

describe("FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE (U2/U9 constant)", () => {
  it("documents the await-input sentinel grammar verbatim", () => {
    // These exact tokens are the cross-module contract with parseAwaitInputSentinel.
    expect(FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE).toContain("===FUSION_AWAIT_INPUT===");
    expect(FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE).toContain("===END_FUSION_AWAIT_INPUT===");
    // It must tell the skill to emit exactly one block and STOP.
    expect(FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE).toMatch(/emit EXACTLY ONE block/);
  });

  it("carries the FUSION_HEADLESS degrade-to-assumption instruction (U3)", () => {
    expect(FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE).toContain("FUSION_HEADLESS=1");
    // In headless mode the skill must NOT ask and must record an assumption.
    expect(FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE).toMatch(/do NOT ask the user/i);
    expect(FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE).toMatch(/record a reasonable assumption/i);
    expect(FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE).toMatch(/never emit the await-input block in this mode/i);
  });

  it("carries the persona fan-out / systemPromptOverride / path-confinement instruction (U8/U9)", () => {
    // Persona def is read from the agents dir env var…
    expect(FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE).toContain("$FUSION_CE_AGENTS_DIR/<persona>.md");
    // …and passed to fn_spawn_agent as systemPromptOverride (the U8 fan-out contract).
    expect(FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE).toContain("systemPromptOverride");
    expect(FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE).toContain("fn_spawn_agent");
    // Path confinement (the U9 filesystem prompt-injection guard): reject ../ traversal.
    expect(FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE).toMatch(/reject any[\s\S]*path traversal/i);
    expect(FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE).toMatch(/Resolve the path strictly inside/i);
    expect(FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE).toContain("$FUSION_CE_AGENTS_DIR");
    // Readonly fallback: if spawn is unavailable, do the persona's work inline.
    expect(FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE).toMatch(/readonly step.*inline/i);
  });

  it("overrides contrary skill-body instructions (the conventions win)", () => {
    expect(FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE).toMatch(/override any contrary instruction in the skill body/i);
  });
});

/**
 * U1 normalized request-form resolution. executeWorkflowStep still merges BOTH
 * the namespaced `compound-engineering:ce-work` and the bare `ce-work` into
 * requestedSkillNames before resolution, and the resolver now compares those
 * requested names through requestedSkillMatchKey.
 *
 * FNXC:SkillResolution 2026-06-27-04:15:
 * requestedSkillMatchKey strips trailing `/SKILL.md`, keeps the final slash
 * segment, strips a `namespace:` prefix, and lowercases only the request-name
 * comparison key. A discovered bare CE skill should therefore load from each
 * supported request spelling exactly once, while still requiring the skill to be
 * present on the discovery path.
 */
describe("U1: normalized CE skill request-form resolution", () => {
  let tmp: string;
  let projectRootDir: string;
  let agentDir: string;
  let installRoot: string;

  function materialize(id: string): void {
    const dir = join(installRoot, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${id}\ndescription: ${id} pipeline stage\n---\n\n# ${id}\n`,
    );
  }

  function resolveFor(
    requestedSkillNames: string[],
    skillPaths = [installRoot],
  ): string[] {
    const discovered = loadSkills({
      cwd: projectRootDir,
      agentDir,
      skillPaths,
      includeDefaults: false,
    });
    const selection = resolveSessionSkills({
      projectRootDir,
      requestedSkillNames,
      sessionPurpose: "executor",
    });
    const override = createSkillsOverrideFromSelection(selection, {
      requestedSkillNames,
      sessionPurpose: "executor",
    });
    const result = override({ skills: discovered.skills, diagnostics: discovered.diagnostics });
    return result.skills.map((s) => s.name);
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ce-conv-"));
    projectRootDir = join(tmp, "project");
    agentDir = join(tmp, "agent");
    installRoot = join(tmp, ".fusion-ce-skills");
    mkdirSync(projectRootDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    materialize("ce-work");
    materialize("ce-doc-review");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("bare name `ce-work` resolves the installed skill", () => {
    expect(resolveFor(["ce-work"])).toContain("ce-work");
  });

  it("namespaced name `compound-engineering:ce-work` resolves the installed skill", () => {
    expect(resolveFor(["compound-engineering:ce-work"])).toContain("ce-work");
  });

  it("slash and SKILL.md-suffixed request forms resolve the installed skill", () => {
    expect(resolveFor(["compound-engineering/ce-work"])).toContain("ce-work");
    expect(resolveFor(["ce-work/SKILL.md"])).toContain("ce-work");
  });

  it("mixed-case request forms resolve the installed skill", () => {
    expect(resolveFor(["CE-Work"])).toContain("ce-work");
    expect(resolveFor(["Compound-Engineering:CE-WORK"])).toContain("ce-work");
  });

  it("the dual request (both forms together, as executeWorkflowStep merges them) resolves it once", () => {
    const resolved = resolveFor(["compound-engineering:ce-work", "ce-work"]);
    expect(resolved).toContain("ce-work");
    // No duplicate skill entries from the two request forms.
    expect(resolved.filter((n) => n === "ce-work")).toHaveLength(1);
  });

  it("optional ce-doc-review resolves from bare and namespaced workflow-step requests", () => {
    expect(resolveFor(["ce-doc-review"])).toContain("ce-doc-review");
    expect(resolveFor(["compound-engineering:ce-doc-review"])).toContain("ce-doc-review");
    const resolved = resolveFor(["compound-engineering:ce-doc-review", "ce-doc-review"]);
    expect(resolved.filter((n) => n === "ce-doc-review")).toHaveLength(1);
  });

  it("without the install dir on the discovery path, the request does NOT resolve", () => {
    // Repoint discovery away from the install root: name alone is insufficient
    // for every normalized request form.
    for (const requestedSkillNames of [
      ["ce-work"],
      ["compound-engineering:ce-work"],
      ["compound-engineering/ce-work"],
      ["ce-work/SKILL.md"],
      ["Compound-Engineering:CE-WORK"],
      ["compound-engineering:ce-work", "ce-work"],
    ]) {
      expect(resolveFor(requestedSkillNames, [])).not.toContain("ce-work");
    }
  });
});
