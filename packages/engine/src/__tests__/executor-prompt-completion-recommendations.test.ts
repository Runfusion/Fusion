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

  it("states the cap from settings so the prompt matches what the validator accepts", () => {
    // A prompt promising a different maximum than the validator enforces produces rejected completions.
    expect(prompt({ maxRecommendationsPerTask: 5 })).toContain("at most 5");
    // Default cap when unset.
    expect(prompt()).toContain("at most 3");
  });

  it("tells the executor to send nothing when capture is disabled", () => {
    const text = prompt({ maxRecommendationsPerTask: 0 });
    expect(text).toContain("Recommendation capture is disabled for this project");
    // A zero cap must not invite writes the store would reject.
    expect(text).not.toContain("at most 0");
  });

});
