/**
 * Goal-citation proof (FN-5659)
 *
 * Deterministic Slice 2 proof path: verifies an executor-lane mock session can
 * observe injected `## Active Goals` context and cite a goal ID in output.
 * It runs entirely on `MockAgentRuntime` (`mock/scripted`) under `pnpm test`,
 * with no real model dependency. Citation evidence is the captured `onText`
 * emission asserted in the positive case, with a negative no-goal control.
 *
 * This test lives with mock-provider coverage so operators can discover it via:
 * `grep -R "Active Goals" packages/engine/src/__tests__/`
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Goal } from "@fusion/core";
import { buildGoalContextSection } from "../goals/goal-context-injector.js";
import { MockAgentRuntime, resetMockScripts, setMockScript } from "../providers/mock-provider.js";

const GOAL_ID_PATTERN = /^- (G-[A-Za-z0-9-]+):/gm;

const fixtureGoals: Goal[] = [
  {
    id: "G-0001",
    title: "Increase plugin ecosystem adoption",
    description: "",
    status: "active",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  },
  {
    id: "G-0002",
    title: "Improve task-board execution reliability",
    description: "",
    status: "active",
    createdAt: "2026-05-02T00:00:00.000Z",
    updatedAt: "2026-05-02T00:00:00.000Z",
  },
  {
    id: "G-0003",
    title: "Harden deterministic regression coverage",
    description: "",
    status: "active",
    createdAt: "2026-05-03T00:00:00.000Z",
    updatedAt: "2026-05-03T00:00:00.000Z",
  },
];

describe("goal-citation proof scaffolding", () => {
  beforeEach(() => {
    resetMockScripts();
  });

  afterEach(() => {
    resetMockScripts();
  });

  it("builds a deterministic Active Goals section with emitted IDs", () => {
    const result = buildGoalContextSection({ activeGoals: fixtureGoals });

    expect(result.text).toContain("## Active Goals");
    for (const goal of fixtureGoals) {
      expect(result.text).toContain(goal.id);
    }
    expect(result.emittedGoalIds).toEqual(["G-0001", "G-0002", "G-0003"]);
  });

  it("emits a goal citation only when the Active Goals block exists", async () => {
    const runtime = new MockAgentRuntime();
    const cwd = await mkdtemp(join(tmpdir(), "fn-goal-citation-proof-"));
    const result = buildGoalContextSection({ activeGoals: fixtureGoals });
    const onText = vi.fn();
    const proofTaskId = "FN-CITE-PROOF";

    setMockScript(
      { sessionPurpose: "executor", taskId: proofTaskId },
      {
        run: async (ctx) => {
          // Goal anchors live in options.systemPrompt (session-level), not per-turn ctx.prompt.
          const matches = Array.from((ctx.options.systemPrompt ?? "").matchAll(GOAL_ID_PATTERN));
          const ids = matches.map((match) => match[1]);
          const firstId = ids[0];
          if (firstId) {
            ctx.options.onText?.(`Citing goal ${firstId} when prioritizing plugin work.`);
            return;
          }
          ctx.options.onText?.("NO_GOAL_CITATION");
        },
      },
    );

    const systemPrompt = `Task context: prioritize plugin impact.\n\n${result.text}`;
    const { session } = await runtime.createSession({
      cwd,
      systemPrompt,
      runtimeContext: { sessionPurpose: "executor" },
      customTools: [],
      onText,
      taskId: proofTaskId,
      taskTitle: "Goal citation proof",
    });

    await runtime.promptWithFallback(session, "Pick the highest-leverage next step.");

    const emissions = onText.mock.calls.map(([text]) => String(text));
    expect(emissions.some((text) => text.includes(result.emittedGoalIds[0]))).toBe(true);
    expect(emissions.some((text) => /Citing goal G-\S+/.test(text))).toBe(true);
    expect(runtime.describeModel(session)).toBe("mock/scripted");

    const noGoalTaskId = "FN-NO-GOALS";
    const onTextNoGoals = vi.fn();
    setMockScript(
      { sessionPurpose: "executor", taskId: noGoalTaskId },
      {
        run: async (ctx) => {
          const matches = Array.from((ctx.options.systemPrompt ?? "").matchAll(GOAL_ID_PATTERN));
          const ids = matches.map((match) => match[1]);
          const firstId = ids[0];
          if (firstId) {
            ctx.options.onText?.(`Citing goal ${firstId} when prioritizing plugin work.`);
            return;
          }
          ctx.options.onText?.("NO_GOAL_CITATION");
        },
      },
    );

    const { session: noGoalSession } = await runtime.createSession({
      cwd,
      systemPrompt: "Task context: no injected goal context.",
      runtimeContext: { sessionPurpose: "executor" },
      customTools: [],
      onText: onTextNoGoals,
      taskId: noGoalTaskId,
      taskTitle: "Goal citation negative proof",
    });

    await runtime.promptWithFallback(noGoalSession, "Pick the highest-leverage next step.");
    expect(onTextNoGoals).toHaveBeenCalledWith("NO_GOAL_CITATION");
  });
});
