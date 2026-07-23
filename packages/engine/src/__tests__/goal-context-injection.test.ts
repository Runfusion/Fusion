import { describe, expect, it } from "vitest";
import type { Goal } from "@fusion/core";
import { buildGoalContextSection } from "../goals/goal-context-injector.js";
import { buildPromptLayers, collapsePromptLayers } from "../execution/prompt-layers.js";

function goal(id: string, title: string, createdAt: string): Goal {
  return {
    id,
    title,
    description: undefined,
    status: "active",
    createdAt,
    updatedAt: createdAt,
  };
}

function buildExecutorPrompt(activeGoals: Goal[]): { goalContext: string; prompt: string } {
  const goalContext = buildGoalContextSection({ activeGoals }).text;
  const layers = buildPromptLayers({
    basePrompt: "EXECUTOR_BASE",
    goalContext,
  });
  return { goalContext, prompt: collapsePromptLayers(layers) };
}

function buildHeartbeatPrompt(activeGoals: Goal[]): { goalContext: string; prompt: string } {
  const goalContext = buildGoalContextSection({ activeGoals }).text;
  const layers = buildPromptLayers({
    basePrompt: "HEARTBEAT_BASE",
    goalContext,
  });
  return { goalContext, prompt: collapsePromptLayers(layers) };
}

function buildPlanningPrompt(activeGoals: Goal[]): { goalContext: string; prompt: string } {
  const goalContext = buildGoalContextSection({ activeGoals }).text;
  const layers = buildPromptLayers({
    basePrompt: "PLANNING_BASE",
    goalContext,
  });
  return { goalContext, prompt: collapsePromptLayers(layers) };
}

describe("goal context lane injection parity", () => {
  it("injects byte-identical goal block across heartbeat executor and planning lanes", () => {
    const activeGoals = [
      goal("G-001", "Ship CLI", "2026-01-01T00:00:00.000Z"),
      goal("G-002", "Harden engine", "2026-01-02T00:00:00.000Z"),
    ];

    const expectedGoalBlock = buildGoalContextSection({ activeGoals }).text;
    const executor = buildExecutorPrompt(activeGoals);
    const heartbeat = buildHeartbeatPrompt(activeGoals);
    const planning = buildPlanningPrompt(activeGoals);

    expect(executor.goalContext).toBe(expectedGoalBlock);
    expect(heartbeat.goalContext).toBe(expectedGoalBlock);
    expect(planning.goalContext).toBe(expectedGoalBlock);
  });

  it("emits no goal header or blank-line artifact when active goals are empty", () => {
    const executor = buildExecutorPrompt([]);
    const heartbeat = buildHeartbeatPrompt([]);
    const planning = buildPlanningPrompt([]);

    expect(executor.goalContext).toBe("");
    expect(heartbeat.goalContext).toBe("");
    expect(planning.goalContext).toBe("");
    expect(executor.prompt).toBe("EXECUTOR_BASE");
    expect(heartbeat.prompt).toBe("HEARTBEAT_BASE");
    expect(planning.prompt).toBe("PLANNING_BASE");
    expect(executor.prompt).not.toContain("## Active Goals");
    expect(heartbeat.prompt).not.toContain("## Active Goals");
    expect(planning.prompt).not.toContain("## Active Goals");
  });

  it("uses shared formatter output without lane-local reformatting", () => {
    const activeGoals = [goal("G-010", "Refine prompt caching", "2026-01-10T00:00:00.000Z")];

    const helperOutput = buildGoalContextSection({ activeGoals }).text;
    const executor = buildExecutorPrompt(activeGoals);
    const heartbeat = buildHeartbeatPrompt(activeGoals);
    const planning = buildPlanningPrompt(activeGoals);

    expect(executor.goalContext).toEqual(helperOutput);
    expect(heartbeat.goalContext).toEqual(helperOutput);
    expect(planning.goalContext).toEqual(helperOutput);
  });
});
