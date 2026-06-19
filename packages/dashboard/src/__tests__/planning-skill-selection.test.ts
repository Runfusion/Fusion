// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@fusion/core";
import { __resetPlanningState, __setCreateFnAgent, createSession, createSessionWithAgent, planningStreamManager } from "../planning.js";

function createQuestionJson(): string {
  return JSON.stringify({
    type: "question",
    data: { id: "q-1", type: "text", question: "What is the scope?" },
  });
}

function createMockAgent(response = createQuestionJson()) {
  const messages: Array<{ role: string; content: string }> = [];
  return {
    session: {
      state: { messages },
      prompt: vi.fn(async () => {
        messages.push({ role: "assistant", content: response });
      }),
      dispose: vi.fn(),
    },
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

function pluginRunner() {
  return {
    getPluginSkills: vi.fn(() => [
      { pluginId: "fusion-plugin-compound-engineering", skill: { name: "ce-debug" } },
      { pluginId: "disabled-plugin", skill: { name: "disabled-skill", enabled: false } },
    ]),
  };
}

describe("planning skill selection", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "planning-skills-root-"));
    globalDir = mkdtempSync(join(tmpdir(), "planning-skills-global-"));
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
    __resetPlanningState();
  });

  afterEach(() => {
    __resetPlanningState();
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("passes executor fallback and enabled plugin skills to non-streaming planning sessions", async () => {
    const runner = pluginRunner();
    let capturedOptions: any;
    __setCreateFnAgent(async (options: any) => {
      capturedOptions = options;
      return createMockAgent();
    });

    await createSession("127.0.0.201", "Plan skill coverage", store, rootDir, undefined, undefined, undefined, runner as any);

    expect(runner.getPluginSkills).toHaveBeenCalledTimes(1);
    expect(capturedOptions.skillSelection).toMatchObject({
      projectRootDir: rootDir,
      sessionPurpose: "executor",
    });
    expect(capturedOptions.skillSelection.requestedSkillNames).toEqual(["fusion", "ce-debug"]);
  });

  it("passes enabled plugin skills to streaming planning sessions", async () => {
    const runner = pluginRunner();
    let capturedOptions: any;
    __setCreateFnAgent(async (options: any) => {
      capturedOptions = options;
      return createMockAgent();
    });

    const sessionId = await createSessionWithAgent(
      "127.0.0.203",
      "Plan streaming skill coverage",
      rootDir,
      store,
      undefined,
      undefined,
      undefined,
      { pluginRunner: runner as any },
    );
    const unsubscribe = planningStreamManager.subscribe(sessionId, () => undefined);
    try {
      planningStreamManager.consumeInitialTurn(sessionId)?.();
      await waitFor(() => Boolean(capturedOptions));
    } finally {
      unsubscribe();
    }

    expect(runner.getPluginSkills).toHaveBeenCalledTimes(1);
    expect(capturedOptions.skillSelection).toMatchObject({
      projectRootDir: rootDir,
      sessionPurpose: "executor",
    });
    expect(capturedOptions.skillSelection.requestedSkillNames).toEqual(["fusion", "ce-debug"]);
  });

  it("uses executor fallback without throwing when no plugin runner is available", async () => {
    let capturedOptions: any;
    __setCreateFnAgent(async (options: any) => {
      capturedOptions = options;
      return createMockAgent();
    });

    await createSession("127.0.0.202", "Plan degraded coverage", store, rootDir);

    expect(capturedOptions.skillSelection.requestedSkillNames).toEqual(["fusion"]);
  });
});
