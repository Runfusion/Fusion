import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedStepSessionExecutor,
  resetExecutorMocks,
} from "./executor-test-helpers.js";
import type { WorkflowIrNode } from "@fusion/core";
import {
  createPrimitivePromptLikeHandler,
  createPromptLikeHandler,
  FOREACH_ACTIVE_CONTEXT_KEY,
  SEAM_SKILL_NAME_CONTEXT_KEY,
  type WorkflowLegacySeams,
} from "../workflow-node-handlers.js";

const task = { id: "FN-8490", title: "Skill seam", steps: [] } as any;
const active = { foreachNodeId: "foreach", stepIndex: 0, instanceId: "foreach#0" };

function skillNode(config: Record<string, unknown>): WorkflowIrNode {
  return { id: "step-execute", kind: "prompt", config: { seam: "step-execute", ...config } };
}

function legacySeams(stepExecute: WorkflowLegacySeams["stepExecute"]): WorkflowLegacySeams {
  const ok = async () => ({ outcome: "success" as const });
  return { planning: ok, execute: ok, review: ok, merge: ok, schedule: ok, stepExecute };
}

/**
 * FNXC:WorkflowStepSkills 2026-07-22-00:00:
 * FN-8490 regression coverage uses production's config-bag executor fields. A
 * root-level executor must never create a resource pin because it is not IR.
 */
describe("foreach step-execute skill loading context", () => {
  it("stamps a trimmed config skill request for the legacy prompt-like seam", async () => {
    const stepExecute = vi.fn(async () => ({ outcome: "success" as const }));
    const handler = createPromptLikeHandler(legacySeams(stepExecute));
    const context = { [FOREACH_ACTIVE_CONTEXT_KEY]: active };

    await handler(skillNode({ executor: "skill", skillName: "  verify  " }), { task, context } as any);

    expect(context[SEAM_SKILL_NAME_CONTEXT_KEY]).toBe("verify");
    expect(stepExecute).toHaveBeenCalledWith(task, expect.objectContaining({
      [SEAM_SKILL_NAME_CONTEXT_KEY]: "verify",
    }));
  });

  it.each([
    [{ executor: "model", skillName: "verify" }],
    [{ executor: "skill", skillName: "   " }],
    [{ skillName: "verify" }],
  ])("does not invent a skill request for %o", async (config) => {
    const handler = createPromptLikeHandler(legacySeams(async () => ({ outcome: "success" })));
    const context: Record<string, unknown> = {
      [FOREACH_ACTIVE_CONTEXT_KEY]: active,
      [SEAM_SKILL_NAME_CONTEXT_KEY]: "stale-skill",
    };

    await handler(skillNode(config), { task, context } as any);

    expect(context).not.toHaveProperty(SEAM_SKILL_NAME_CONTEXT_KEY);
  });

  it("stamps the same config-bag skill request for the primitive step-execute path", async () => {
    const runTaskStep = vi.fn(async () => ({ outcome: "success" as const }));
    const handler = createPrimitivePromptLikeHandler({ runTaskStep } as any);
    const context: Record<string, unknown> = { [FOREACH_ACTIVE_CONTEXT_KEY]: active };

    await handler(skillNode({ executor: "skill", skillName: "security-scan" }), { task, context } as any);

    expect(context[SEAM_SKILL_NAME_CONTEXT_KEY]).toBe("security-scan");
    expect(runTaskStep).toHaveBeenCalledWith(expect.anything(), task, 0);
  });
});

function stepSessionTask() {
  return {
    id: "FN-8490", title: "Skill seam", description: "Skill seam", column: "in-progress",
    dependencies: [], steps: [{ name: "Implement", status: "pending" }], currentStep: 0,
    prompt: "# test\n## Steps\n### Step 0: Implement\n- [ ] implement",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

describe("foreach step-execute skill session selection", () => {
  beforeEach(() => resetExecutorMocks());

  it("merges namespaced and bare requested names plus the CE discovery root", async () => {
    const store = createMockStore();
    const taskDetail = stepSessionTask();
    store.getTask.mockResolvedValue(taskDetail as any);
    const executor = new TaskExecutor(store as any, "/tmp/test", { agentStore: { getAgent: vi.fn() } } as any);
    (executor as any).graphStepSessionPinned.add(taskDetail.id);
    (executor as any).graphSeamSkillName.set(taskDetail.id, "compound-engineering:verify");

    const previousCeSkillsDir = process.env.FUSION_CE_SKILLS_DIR;
    process.env.FUSION_CE_SKILLS_DIR = "/opt/ce/.fusion-ce-skills";
    try {
      await (executor as any).runImplementationPhase(taskDetail);
    } finally {
      if (previousCeSkillsDir === undefined) delete process.env.FUSION_CE_SKILLS_DIR;
      else process.env.FUSION_CE_SKILLS_DIR = previousCeSkillsDir;
    }

    const options = mockedStepSessionExecutor.mock.calls.at(-1)?.[0] as any;
    expect(options.skillSelection.requestedSkillNames).toEqual(expect.arrayContaining([
      "compound-engineering:verify", "verify",
    ]));
    expect(options.additionalSkillPaths).toContain("/opt/ce/.fusion-ce-skills");
    expect(store.logEntry).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("[skill-load]"));
  });

  it("warns but retains role-fallback selection when the pinned skill is missing", async () => {
    const store = createMockStore();
    const taskDetail = stepSessionTask();
    store.getTask.mockResolvedValue(taskDetail as any);
    const executor = new TaskExecutor(store as any, "/tmp/test", { agentStore: { getAgent: vi.fn() } } as any);
    (executor as any).graphStepSessionPinned.add(taskDetail.id);
    (executor as any).graphSeamSkillName.set(taskDetail.id, "missing-verify");

    await (executor as any).runImplementationPhase(taskDetail);

    const options = mockedStepSessionExecutor.mock.calls.at(-1)?.[0] as any;
    expect(options.skillSelection.requestedSkillNames).toContain("missing-verify");
    expect(store.logEntry).toHaveBeenCalledWith(taskDetail.id, expect.stringContaining("[skill-load] Foreach step-execute"));
  });
});
