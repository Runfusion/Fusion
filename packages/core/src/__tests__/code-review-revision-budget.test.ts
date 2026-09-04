import { describe, expect, it } from "vitest";
import {
  codeReviewOptionalGroupNode,
  DEFAULT_CODE_REVIEW_MAX_REVISIONS,
} from "../workflows/builtin-code-review-group.js";
import { resolveOptionalReviewRevisionBudget } from "../workflows/workflow-settings-resolver.js";

describe("Code Review revision budget", () => {
  it("authors the bounded default on the built-in Code Review node", () => {
    expect(DEFAULT_CODE_REVIEW_MAX_REVISIONS).toBe(3);
    expect(codeReviewOptionalGroupNode("in-progress").config?.maxRevisions)
      .toBe(DEFAULT_CODE_REVIEW_MAX_REVISIONS);
  });

  it.each([
    ["unset workflow and node values", {}, undefined, DEFAULT_CODE_REVIEW_MAX_REVISIONS],
    ["stored zero", { codeReviewMaxRevisions: 0 }, undefined, 0],
    ["stored unbounded", { codeReviewMaxRevisions: "unbounded" }, undefined, "unbounded"],
    ["stored positive cap", { codeReviewMaxRevisions: 7 }, undefined, 7],
    ["authored node cap", {}, 2, 2],
  ] as const)("resolves %s with the documented precedence", (_label, workflowSettings, nodeMaxRevisions, expected) => {
    expect(resolveOptionalReviewRevisionBudget({
      optionalGroupId: "code-review",
      workflowSettings,
      nodeMaxRevisions,
    })).toBe(expected);
  });

  it("keeps an unset Plan Review budget unbounded", () => {
    expect(resolveOptionalReviewRevisionBudget({
      optionalGroupId: "plan-review",
      workflowSettings: {},
      nodeMaxRevisions: undefined,
    })).toBe("unbounded");
  });
});
