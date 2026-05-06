import { describe, expect, it } from "vitest";
import { buildPromptContributions } from "../prompts.js";

describe("prompt contributions", () => {
  it("covers all five prompt surfaces", () => {
    const prompts = buildPromptContributions({
      promptExecutorSystem: "a",
      promptExecutorTask: "b",
      promptTriage: "c",
      promptReviewer: "d",
      promptHeartbeat: "e",
    });
    expect(prompts.contributions.map((p) => p.surface)).toEqual([
      "executor-system",
      "executor-task",
      "triage",
      "reviewer",
      "heartbeat",
    ]);
  });
});
