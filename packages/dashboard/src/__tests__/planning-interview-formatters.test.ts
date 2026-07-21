import { describe, expect, it } from "vitest";
import type { PlanningQuestion } from "@fusion/core";
import {
  formatInterviewQA,
  formatResponseForAgent,
  normalizePlanningSummaryPayload,
} from "../planning";

/*
FNXC:PlanningMode 2026-07-19-01:45:
FN-8341 removed deepen-checkpoint helpers (buildDeepeningCheckpoint*). Keep
formatter coverage for Other answers and core summary normalization only.
*/

const singleSelectQuestion: PlanningQuestion = {
  id: "scope",
  type: "single_select",
  question: "What scope should we plan?",
  options: [
    { id: "mvp", label: "MVP" },
    { id: "full", label: "Full launch" },
  ],
};

const multiSelectQuestion: PlanningQuestion = {
  id: "priorities",
  type: "multi_select",
  question: "Which priorities matter?",
  options: [
    { id: "speed", label: "Speed" },
    { id: "quality", label: "Quality" },
  ],
};

const confirmQuestion: PlanningQuestion = {
  id: "proceed",
  type: "confirm",
  question: "Proceed with this plan?",
};

describe("normalizePlanningSummaryPayload", () => {
  it("normalizes core summary fields without deepen themes", () => {
    const summary = normalizePlanningSummaryPayload({
      title: "A plan",
      description: "A description",
      suggestedSize: "M",
      suggestedDependencies: ["FN-1", "FN-1", ""],
      keyDeliverables: ["Ship"],
    }, { title: "Fallback", description: "Fallback desc" });
    expect(summary.title).toBe("A plan");
    expect(summary.description).toBe("A description");
    expect(summary.suggestedDependencies).toEqual(["FN-1"]);
    expect(summary.keyDeliverables).toEqual(["Ship"]);
    expect(summary).not.toHaveProperty("deepeningThemes");
  });
});

describe("planning interview formatter Other answers", () => {
  it("formats Other-only single-select answers for the planning agent and Q&A history", () => {
    const response = { scope: "other", _other: "Run discovery first" };
    const agent = formatResponseForAgent(singleSelectQuestion, response);
    const qa = formatInterviewQA([{ question: singleSelectQuestion, response }]);
    expect(agent).toContain("Run discovery first");
    expect(qa).toContain("Run discovery first");
  });

  it("appends Other text to multi-select option labels for the planning agent and Q&A history", () => {
    const response = { priorities: ["speed"], _other: "Keep humans in review" };
    const agent = formatResponseForAgent(multiSelectQuestion, response);
    const qa = formatInterviewQA([{ question: multiSelectQuestion, response }]);
    expect(agent).toMatch(/Speed/);
    expect(agent).toContain("Keep humans in review");
    expect(qa).toContain("Keep humans in review");
  });

  it("formats confirm Yes and No answers without changing boolean semantics", () => {
    expect(formatResponseForAgent(confirmQuestion, { proceed: true })).toMatch(/Yes/i);
    expect(formatInterviewQA([{ question: confirmQuestion, response: { proceed: false } }])).toMatch(/No/i);
  });

  it("formats confirm Other answers and comments as first-class custom answers", () => {
    const response = { _other: "Ask a different scoping question", _comment: "Need more context" };
    const agent = formatResponseForAgent(confirmQuestion, response);
    const qa = formatInterviewQA([{ question: confirmQuestion, response }]);
    expect(agent).toContain("Ask a different scoping question");
    expect(qa).toContain("Ask a different scoping question");
  });

  it("reasserts the infinite, high-impact next-question contract with every answer", () => {
    const prompt = formatResponseForAgent(singleSelectQuestion, { strategy: "discovery" });

    expect(prompt).toContain("exactly one new, high-impact question");
    expect(prompt).toContain("does not repeat a prior question");
    expect(prompt).toContain("only the user can validate it");
  });
});
