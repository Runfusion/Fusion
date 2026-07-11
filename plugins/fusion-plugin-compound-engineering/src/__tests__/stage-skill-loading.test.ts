import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateInteractiveAiSessionFactory } from "@fusion/core";
import { CeOrchestrator, warnIfStageSkillMissing } from "../session/orchestrator.js";
import { getCeSessionStore } from "../session/session-store.js";
import { listStages } from "../session/stage-registry.js";
import { makeHarness, makeScriptedSession, type TestHarness } from "./_harness.js";

let h: TestHarness;

beforeEach(() => {
  h = makeHarness();
});

afterEach(() => {
  h.close();
  vi.restoreAllMocks();
});

describe("CE stage skill loading session options", () => {
  it.each(listStages())("starts $stageId with its registered skill selected and discoverable", async (stage) => {
    const capturedOptions: Parameters<CreateInteractiveAiSessionFactory>[0][] = [];
    const session = makeScriptedSession([{ type: "complete", data: { artifact: `# ${stage.stageId}` } }]);
    const factory: CreateInteractiveAiSessionFactory = vi.fn(async (options) => {
      capturedOptions.push(options);
      return { session, sessionFile: join(h.projectRoot, `${stage.stageId}.json`) };
    });

    const orch = new CeOrchestrator({ ctx: h.ctx, createInteractiveAiSession: factory, projectRoot: h.projectRoot });
    const result = await orch.start(stage.stageId, { openingMessage: `Run ${stage.stageId}` });

    expect(result.session.status).toBe("completed");
    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].requestedSkillNames).toEqual([stage.skillId]);
    expect(capturedOptions[0].additionalSkillPaths).toHaveLength(1);
    expect(capturedOptions[0].additionalSkillPaths?.[0]).toMatch(/\.fusion-ce-skills$/);
    expect(capturedOptions[0].additionalSkillPaths?.[0]).not.toMatch(/\.(claude|codex|gemini)[/\\]skills/);
    expect(capturedOptions[0].systemPrompt).toContain(stage.skillId);
  });

  it("warns loudly when a stage skill is missing from the install root", () => {
    const stage = listStages()[0];
    const missingRoot = mkdtempSync(join(tmpdir(), "ce-missing-skill-root-"));
    try {
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

      const guard = warnIfStageSkillMissing(logger, stage, [missingRoot]);

      expect(guard).toMatchObject({
        skillId: stage.skillId,
        found: false,
        expectedSkillMdPaths: [join(missingRoot, stage.skillId, "SKILL.md")],
      });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(stage.skillId),
        expect.objectContaining({
          stageId: stage.stageId,
          skillId: stage.skillId,
          expectedSkillMdPaths: [join(missingRoot, stage.skillId, "SKILL.md")],
          additionalSkillPaths: [missingRoot],
        }),
      );
    } finally {
      rmSync(missingRoot, { recursive: true, force: true });
    }
  });

  it("enriches a completed brainstorm artifact in place when plan starts for the same project", async () => {
    const capturedOptions: Parameters<CreateInteractiveAiSessionFactory>[0][] = [];
    const factory: CreateInteractiveAiSessionFactory = vi.fn(async (options) => {
      capturedOptions.push(options);
      const artifact = options.requestedSkillNames?.includes("ce-brainstorm")
        ? "---\nartifact_contract: ce-unified-plan/v1\nartifact_readiness: requirements-only\n---\n# Requirements\n"
        : "---\nartifact_contract: ce-unified-plan/v1\nartifact_readiness: implementation-ready\nexecution: code\n---\n# Plan\n";
      return { session: makeScriptedSession([{ type: "complete", data: { artifact } }]) };
    });
    const orch = new CeOrchestrator({ ctx: h.ctx, createInteractiveAiSession: factory, projectRoot: h.projectRoot });

    const brainstorm = await orch.start("brainstorm", { openingMessage: "Frame it", projectId: "project-a" });
    const plan = await orch.start("plan", { openingMessage: "Plan it", projectId: "project-a" });

    expect(plan.session.artifactPath).toBe(brainstorm.session.artifactPath);
    expect(readFileSync(plan.session.artifactPath!, "utf8")).toContain("artifact_readiness: implementation-ready");
    expect(capturedOptions[1].systemPrompt).toContain(brainstorm.session.artifactPath!);
    expect(capturedOptions[1].systemPrompt).toContain("enrich that exact artifact in place");
  });

  it("uses the explicitly selected brainstorm predecessor when several are complete", async () => {
    const factory: CreateInteractiveAiSessionFactory = vi.fn(async (options) => {
      const artifact = options.requestedSkillNames?.includes("ce-brainstorm")
        ? "---\nartifact_contract: ce-unified-plan/v1\nartifact_readiness: requirements-only\n---\n# Requirements\n"
        : "---\nartifact_contract: ce-unified-plan/v1\nartifact_readiness: implementation-ready\n---\n# Plan\n";
      return { session: makeScriptedSession([{ type: "complete", data: { artifact } }]) };
    });
    const orch = new CeOrchestrator({ ctx: h.ctx, createInteractiveAiSession: factory, projectRoot: h.projectRoot });
    const older = await orch.start("brainstorm", { openingMessage: "Older", projectId: "project-a" });
    const newer = await orch.start("brainstorm", { openingMessage: "Newer", projectId: "project-a" });

    const plan = await orch.start("plan", {
      openingMessage: "Plan the selected requirements",
      projectId: "project-a",
      sourceSessionId: older.session.id,
    });

    expect(plan.session.artifactPath).toBe(older.session.artifactPath);
    expect(readFileSync(older.session.artifactPath!, "utf8")).toContain("implementation-ready");
    expect(readFileSync(newer.session.artifactPath!, "utf8")).toContain("requirements-only");
  });

  it("does not reuse an already implementation-ready brainstorm artifact", async () => {
    const factory: CreateInteractiveAiSessionFactory = vi.fn(async (options) => {
      const artifact = options.requestedSkillNames?.includes("ce-brainstorm")
        ? "---\nartifact_contract: ce-unified-plan/v1\nartifact_readiness: requirements-only\n---\n# Requirements\n"
        : "---\nartifact_contract: ce-unified-plan/v1\nartifact_readiness: implementation-ready\n---\n# Plan\n";
      return { session: makeScriptedSession([{ type: "complete", data: { artifact } }]) };
    });
    const orch = new CeOrchestrator({ ctx: h.ctx, createInteractiveAiSession: factory, projectRoot: h.projectRoot });
    const brainstorm = await orch.start("brainstorm", { openingMessage: "Frame it", projectId: "project-a" });
    const firstPlan = await orch.start("plan", { openingMessage: "Plan it", projectId: "project-a" });
    const finalized = readFileSync(firstPlan.session.artifactPath!, "utf8");

    const secondPlan = await orch.start("plan", { openingMessage: "Plan again", projectId: "project-a" });

    expect(secondPlan.session.artifactPath).not.toBe(brainstorm.session.artifactPath);
    expect(readFileSync(brainstorm.session.artifactPath!, "utf8")).toBe(finalized);
  });

  it("preserves requirements when Plan completion is not implementation-ready", async () => {
    const factory: CreateInteractiveAiSessionFactory = vi.fn(async (options) => {
      const artifact = options.requestedSkillNames?.includes("ce-brainstorm")
        ? "---\nartifact_contract: ce-unified-plan/v1\nartifact_readiness: requirements-only\n---\n# Requirements\n"
        : "# malformed plan";
      return { session: makeScriptedSession([{ type: "complete", data: { artifact } }]) };
    });
    const orch = new CeOrchestrator({ ctx: h.ctx, createInteractiveAiSession: factory, projectRoot: h.projectRoot });
    const brainstorm = await orch.start("brainstorm", { openingMessage: "Frame it", projectId: "project-a" });
    const original = readFileSync(brainstorm.session.artifactPath!, "utf8");

    const plan = await orch.start("plan", { openingMessage: "Plan it", projectId: "project-a" });

    expect(plan.session.status).toBe("error");
    expect(readFileSync(brainstorm.session.artifactPath!, "utf8")).toBe(original);
  });

  it("does not reuse a brainstorm artifact from another project", async () => {
    const factory: CreateInteractiveAiSessionFactory = vi.fn(async (options) => ({
      session: makeScriptedSession([{
        type: "complete",
        data: { artifact: `# ${options.requestedSkillNames?.[0]}` },
      }]),
    }));
    const orch = new CeOrchestrator({ ctx: h.ctx, createInteractiveAiSession: factory, projectRoot: h.projectRoot });

    const brainstorm = await orch.start("brainstorm", { openingMessage: "Frame it", projectId: "project-a" });
    const plan = await orch.start("plan", { openingMessage: "Plan it", projectId: "project-b" });

    expect(plan.session.artifactPath).not.toBe(brainstorm.session.artifactPath);
  });

  it("rejects persisted brainstorm handoffs outside docs/plans", async () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), "ce-outside-plan-"));
    const outsideArtifact = join(outsideRoot, "requirements.md");
    writeFileSync(outsideArtifact, "do not overwrite", "utf8");
    const store = getCeSessionStore(h.ctx);
    const seeded = store.create({ stage: "brainstorm", projectId: "project-a", artifactPath: outsideArtifact });
    store.update(seeded.id, { status: "completed" });
    const factory: CreateInteractiveAiSessionFactory = vi.fn(async () => ({
      session: makeScriptedSession([{ type: "complete", data: { artifact: "# Safe plan" } }]),
    }));
    const orch = new CeOrchestrator({ ctx: h.ctx, createInteractiveAiSession: factory, projectRoot: h.projectRoot });

    try {
      const plan = await orch.start("plan", { openingMessage: "Plan it", projectId: "project-a" });

      expect(plan.session.artifactPath).not.toBe(outsideArtifact);
      expect(readFileSync(outsideArtifact, "utf8")).toBe("do not overwrite");
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});
