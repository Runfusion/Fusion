/*
FNXC:ReviewLaneRecommendations 2026-08-26-07:34:
The Documentation milestone runs `toolMode: "readonly"`: read/grep/find/ls, `fn_web_fetch`, and a few
read-only task reads. It holds NO writer, and `fn_task_create` is explicitly denied there. Before
this, its prompt asked for four tool calls it could not make — so it produced a well-formed report on
every card and persisted NOTHING, while also having replaced `completion-summary`, which worked.

These tests pin the replacement channel: the node's OUTPUT is projected. Prose becomes the card
summary; a trailing JSON payload becomes task recommendations, which an operator turns into tasks
from the Recommendations tab. An in-review agent proposes; it never creates board rows.
*/
import { describe, expect, it } from "vitest";
import { getBuiltinWorkflow, normalizeTaskRecommendations } from "@fusion/core";

import {
  parseWorkflowStepRecommendations,
  resolveMaxRecommendationsPerTask,
} from "../executor/workflow-step-recommendations.js";

const SUMMARY = "Removed the obsolete repository fixture and replaced its date-based assertions with an absence contract. Verified with the package-scoped suite.";

function output(payload: string): string {
  return `${SUMMARY}\n\n\`\`\`json\n${payload}\n\`\`\``;
}

describe("review-lane recommendation projection", () => {
  it("separates the card summary from the proposals it carries", () => {
    const parsed = parseWorkflowStepRecommendations(
      output('{"recommendations":[{"id":"export-csv","title":"Add task export","description":"Provide CSV export outside this task\'s scope.","category":"feature"}]}'),
      { max: 3 },
    );

    expect(parsed.recommendations).toEqual([{
      id: "export-csv",
      title: "Add task export",
      description: "Provide CSV export outside this task's scope.",
      category: "feature",
    }]);
    // The operator reads prose on the card, never the machine payload that produced it.
    expect(parsed.remainingText).toBe(SUMMARY);
    expect(parsed.remainingText).not.toContain("```");
  });

  it("leaves the output untouched when the node proposed nothing", () => {
    const parsed = parseWorkflowStepRecommendations(SUMMARY, { max: 3 });
    expect(parsed.recommendations).toEqual([]);
    expect(parsed.remainingText).toBe(SUMMARY);
  });

  /* A verdict or findings payload belongs to another contract and must not be consumed here. */
  it("does not claim a payload that carries no recommendations array", () => {
    const verdict = output('{"verdict":"APPROVE","notes":"looks fine"}');
    const parsed = parseWorkflowStepRecommendations(verdict, { max: 3 });
    expect(parsed.recommendations).toEqual([]);
    expect(parsed.remainingText).toBe(verdict);
  });

  /*
  One malformed proposal must never fail the node: the code is already approved, and a stray
  character in a suggestion cannot be allowed to wedge a card. Bad entries drop, good ones survive.
  */
  it("drops unusable proposals instead of failing the milestone", () => {
    const parsed = parseWorkflowStepRecommendations(
      output(JSON.stringify({
        recommendations: [
          { id: "ok", title: "Real proposal", description: "Something grounded and useful.", category: "improvement" },
          { id: "no-category", title: "Missing category", description: "x", category: "urgent" },
          { id: "", title: "No id", description: "x", category: "bug" },
          { id: "ok", title: "Duplicate id", description: "x", category: "bug" },
          "not-an-object",
        ],
      })),
      { max: 3 },
    );

    expect(parsed.recommendations.map((entry) => entry.id)).toEqual(["ok"]);
  });

  /* Proposals are operator-facing prose, never an execution channel. */
  it("refuses a proposal carrying a command or a credential", () => {
    expect(normalizeTaskRecommendations([
      { id: "cmd", title: "Run the migration", description: "pnpm migrate --force", category: "other" },
      { id: "secret", title: "Rotate", description: "api_key: sk-live-1234567890", category: "other" },
      { id: "fine", title: "Rotate credentials", description: "Plan a rotation of the deploy credentials.", category: "improvement" },
    ], { max: 5 }).map((entry) => entry.id)).toEqual(["fine"]);
  });

  it("honours the per-project cap, including zero", () => {
    const many = JSON.stringify({
      recommendations: Array.from({ length: 6 }, (_, index) => ({
        id: `r${index}`, title: `Proposal ${index}`, description: "Grounded follow-up work.", category: "improvement",
      })),
    });

    expect(parseWorkflowStepRecommendations(output(many), { max: 2 }).recommendations).toHaveLength(2);

    // Capture disabled: nothing is consumed, and the text is left exactly as written.
    const disabled = parseWorkflowStepRecommendations(output(many), { max: 0 });
    expect(disabled.recommendations).toEqual([]);
    expect(disabled.remainingText).toContain("```");

    expect(resolveMaxRecommendationsPerTask({ maxRecommendationsPerTask: 0 } as never)).toBe(0);
    expect(resolveMaxRecommendationsPerTask(undefined)).toBe(3);
  });

  /*
  The node must DECLARE both projections, or its output goes nowhere — which is exactly the defect
  this change repairs. Asserting the wiring here is what makes the parser above meaningful.
  */
  it("wires Documentation to both durable channels and to no tool at all", () => {
    const template = getBuiltinWorkflow("builtin:coding-ideas-v2")?.ir.nodes
      .find((node) => node.id === "documentation-delivery")?.config?.template as
      { nodes?: Array<{ id: string; config?: Record<string, unknown> }> } | undefined;
    const config = template?.nodes?.find((node) => node.id === "documentation-delivery-step")?.config ?? {};

    expect(config.summaryTarget).toBe("task");
    expect(config.recommendationsTarget).toBe("task");
    expect(config.toolMode).toBe("readonly");

    const prompt = String(config.prompt);
    // It must not be instructed to use a tool its policy denies it.
    for (const tool of ["fn_task_done", "fn_task_document_write", "fn_artifact_register", "fn_task_create"]) {
      expect(prompt, `${tool} is not available to a readonly workflow step`).not.toContain(tool);
    }
    expect(prompt).toContain("You have NO writer");
    expect(prompt).toContain("You cannot create tasks");
  });
});
