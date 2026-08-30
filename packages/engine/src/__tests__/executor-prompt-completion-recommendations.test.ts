/*
FNXC:TaskRecommendations 2026-08-10-01:15 (the producer must stay wired to the validator — regression):

FN-8850 added BOTH a `fn_task_done` validator for completion recommendations AND the engine-appended prompt
section that asks the executor to produce them. The U4 executor peel (#3317) rewrote `executor.ts` from a
pre-FN-8850 base and dropped the prompt half while keeping the validator. Nothing failed: `fn_task_done` kept
accepting `recommendations`, no test covered the prompt wiring, and recommendation capture simply stopped.

A refactor rebased off a stale base does not conflict — it deletes. These assertions pin the wiring so the
producer cannot be removed while the validator that consumes it stays in place.
*/
import { describe, expect, it } from "vitest";
import { getExecutorSystemPrompt } from "../executor/system-prompt.js";

const prompt = (settings: Record<string, unknown> = {}) => getExecutorSystemPrompt(settings as never);

describe("executor prompt: completion recommendations", () => {
  it("asks the executor to produce recommendations at the accepted completion checkpoint", () => {
    const text = prompt();
    expect(text).toContain("## Completion recommendations");
    expect(text).toContain("recommendations: []");
  });

  it.each([
    ["disabled", { maxRecommendationsPerTask: 0 }],
    ["required", { maxRecommendationsPerTask: 3, requireTaskRecommendations: true }],
    ["optional", { maxRecommendationsPerTask: 3, requireTaskRecommendations: false }],
  ])("qualifies blocked exits and deferred verification in the %s branch", (_name, settings) => {
    const text = prompt(settings);

    expect(text).toContain("host-resource, network, model-provider, and credential failures");
    expect(text).toContain("Missing tooling, optional services, and unrunnable commands");
    if (settings.maxRecommendationsPerTask === 0) {
      expect(text).toContain("completion summary and task log");
    } else {
      expect(text).toContain("plain prose without backticked command names");
      expect(text).toContain("substitute a runnable check");
    }
  });

  it("states the cap from settings so the prompt matches what the validator accepts", () => {
    // A prompt promising a different maximum than the validator enforces produces rejected completions.
    expect(prompt({ maxRecommendationsPerTask: 5 })).toContain("at most 5");
    // Default cap when unset.
    expect(prompt()).toContain("at most 3");
  });

  it("requires explicit quality-first evaluation when enabled", () => {
    const text = prompt({ maxRecommendationsPerTask: 3, requireTaskRecommendations: true });
    expect(text).toContain("MUST explicitly evaluate");
    expect(text).toContain("Aim toward 3 distinct");
    expect(text).toContain("shorter list or `recommendations: []` is correct");
    expect(text).toContain("scope drift");
    expect(text).not.toContain("optionally evaluate");
  });

  it("keeps cap zero authoritative over required mode", () => {
    const text = prompt({ maxRecommendationsPerTask: 0, requireTaskRecommendations: true });
    expect(text).toContain("Recommendation capture is disabled for this project");
    expect(text).not.toContain("MUST explicitly evaluate");
  });

  it("appends required guidance consistently to custom and withheld-tool prompts", () => {
    const text = getExecutorSystemPrompt({
      maxRecommendationsPerTask: 2,
      requireTaskRecommendations: true,
      agentPrompts: {
        templates: [{ id: "custom-executor", name: "Custom", role: "executor", prompt: "Custom executor instructions.", builtIn: false }],
        roleAssignments: { executor: "custom-executor" },
      },
    } as never, { taskCreateWithheld: true, delegateWithheld: true });

    expect(text).toContain("Custom executor instructions.");
    expect(text).toContain("MUST explicitly evaluate");
    expect(text).toContain("required completion evaluation");
    expect(text).not.toContain("Recommendation capture is disabled");
  });

  it("tells the executor to send nothing when capture is disabled", () => {
    const text = prompt({ maxRecommendationsPerTask: 0 });
    expect(text).toContain("Recommendation capture is disabled for this project");
    // A zero cap must not invite writes the store would reject.
    expect(text).not.toContain("at most 0");
  });

});
