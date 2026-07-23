import { describe, expect, it } from "vitest";
import { inferWorkflowStepVerdictFromProse, parseWorkflowStepVerdict } from "../executor.js";
import { proseSignalsClearApproval, extractJsonObjectCandidates, classifyReviewVerdictToken } from "../execution/reviewer.js";

describe("parseWorkflowStepVerdict", () => {
  it("parses plain JSON", () => {
    expect(parseWorkflowStepVerdict('{"verdict":"APPROVE","notes":"ok"}')).toEqual({ verdict: "APPROVE", notes: "ok" });
  });

  it("parses fenced JSON", () => {
    expect(parseWorkflowStepVerdict('```json\n{"verdict":"REVISE","notes":"fix"}\n```')).toEqual({ verdict: "REVISE", notes: "fix" });
  });

  it("defaults missing notes to empty string", () => {
    expect(parseWorkflowStepVerdict('{"verdict":"APPROVE_WITH_NOTES"}')).toEqual({ verdict: "APPROVE_WITH_NOTES", notes: "" });
  });

  it("returns null for invalid verdict", () => {
    expect(parseWorkflowStepVerdict('{"verdict":"PASS"}')).toBeNull();
  });

  /*
  FNXC:ReviewLeniency 2026-07-01-23:30:
  Models often emit reasoning PROSE (sometimes containing braces) then a trailing
  JSON verdict payload. The trailing payload must be extracted and preferred.
  */
  it("extracts a trailing JSON payload after prose", () => {
    const out = "I reviewed the diff and it meets the criteria.\n\n" +
      '{"verdict":"APPROVE","notes":"clean"}';
    expect(parseWorkflowStepVerdict(out)).toEqual({ verdict: "APPROVE", notes: "clean" });
  });

  it("extracts trailing JSON even when the prose itself contains braces", () => {
    const out = "The change touches `render({ x: 1 })` and looks correct.\n" +
      '{"verdict":"REVISE","notes":"tighten the type"}';
    expect(parseWorkflowStepVerdict(out)).toEqual({ verdict: "REVISE", notes: "tighten the type" });
  });

  it("prefers the LAST JSON object when several appear", () => {
    const out = 'Example format: {"verdict":"REVISE"}. My actual verdict follows.\n' +
      '{"verdict":"APPROVE","notes":"ok"}';
    expect(parseWorkflowStepVerdict(out)).toEqual({ verdict: "APPROVE", notes: "ok" });
  });

  // "Any approved" — approval-family verdict tokens all map to an approve pass.
  it.each([
    ['{"verdict":"APPROVED"}', "APPROVE"],
    ['{"verdict":"approve_with_verdict"}', "APPROVE"],
    ['{"verdict":"APPROVE_WITH_NOTES","notes":"minor"}', "APPROVE_WITH_NOTES"],
    ['{"verdict":"Approval"}', "APPROVE"],
    ['{"verdict":"REJECT"}', "REVISE"],
  ] as const)("classifies approval/revise family token %s", (input, expected) => {
    expect(parseWorkflowStepVerdict(input)?.verdict).toBe(expected);
  });
});

describe("inferWorkflowStepVerdictFromProse", () => {
  it("infers revise from REQUEST REVISION", () => {
    expect(inferWorkflowStepVerdictFromProse("REQUEST REVISION\nplease change")).toEqual({ verdict: "REVISE", notes: "please change" });
  });

  it("infers approve from positive prose", () => {
    expect(inferWorkflowStepVerdictFromProse("looks good")).toEqual({ verdict: "APPROVE", notes: "" });
  });

  it("infers explicit markdown verdicts from reviewer-style output", () => {
    expect(inferWorkflowStepVerdictFromProse("## Spec Review\n\n### Verdict: APPROVE\n\nThe plan is ready.")).toEqual({
      verdict: "APPROVE",
      notes: "",
    });
    expect(inferWorkflowStepVerdictFromProse("Status: APPROVE_WITH_NOTES\n\nProceed with notes.")).toEqual({
      verdict: "APPROVE_WITH_NOTES",
      notes: "",
    });
    expect(inferWorkflowStepVerdictFromProse("Verdict: REVISE\n\nFix the plan.")).toEqual({
      verdict: "REVISE",
      notes: "",
    });
  });

  it("returns null for unrelated prose", () => {
    expect(inferWorkflowStepVerdictFromProse("lorem ipsum")).toBeNull();
  });

  /*
  FNXC:ReviewLeniency 2026-07-01-22:15:
  A review whose text clearly approves must pass even when not perfectly structured.
  These broadened phrasings previously fell through to malformed → blocking gate.
  */
  it.each([
    "Approving — nice work.",
    "LGTM",
    "ship it",
    "All good, no blocking issues.",
    "This is acceptable.",
    "Good to merge.",
    "Passes review.",
  ])("infers approve from broadened approval phrasing: %s", (text) => {
    expect(inferWorkflowStepVerdictFromProse(text)).toEqual({ verdict: "APPROVE", notes: "" });
  });

  // Negation guard: a prose rejection must NOT be promoted to APPROVE.
  it.each([
    "I do not approve this; please revise.",
    "We can't approve — needs changes.",
    "Rejecting this change.",
    "Not approved.",
    "Please revise the plan.",
  ])("does not infer approve from a prose rejection: %s", (text) => {
    expect(inferWorkflowStepVerdictFromProse(text)).toBeNull();
  });
});

describe("proseSignalsClearApproval", () => {
  it.each([
    "approve",
    "approved",
    "approving the work",
    "LGTM",
    "ship it",
    "no blocking issues",
    "no concerns",
    "all good",
    "acceptable",
    "good to go",
    "looks good",
  ])("returns true for a clear approval: %s", (text) => {
    expect(proseSignalsClearApproval(text)).toBe(true);
  });

  it.each([
    "",
    "lorem ipsum",
    "not approved",
    "cannot approve this",
    "do not approve",
    "please revise",
    "REVISE",
    "reject",
    "disapprove",
    "needs revision before approval",
    "The build passes.",
    "This passes the unit tests but I want changes to the API.",
    // Praise + change-request: an approval token is present but the review still
    // requests changes, so it must NOT be promoted to APPROVE.
    "The memory leak is out of scope for this PR, but we should still address the null check before merging.",
    "I have no objections to the direction, but the race condition must be fixed.",
    "The performance is acceptable. However, the API breaks compatibility and I want that changed.",
    "It passes review of the happy path. That said, please fix the error-handling gap.",
  ])("returns false for non-approval / rejection: %s", (text) => {
    expect(proseSignalsClearApproval(text)).toBe(false);
  });
});

describe("extractJsonObjectCandidates", () => {
  it("returns balanced top-level objects in document order", () => {
    expect(extractJsonObjectCandidates('a {"x":1} b {"y":2} c')).toEqual(['{"x":1}', '{"y":2}']);
  });

  it("ignores braces inside string values", () => {
    expect(extractJsonObjectCandidates('{"notes":"has } and { braces"}')).toEqual([
      '{"notes":"has } and { braces"}',
    ]);
  });

  it("captures a nested object as one top-level candidate", () => {
    expect(extractJsonObjectCandidates('prose {"a":{"b":2}} tail')).toEqual(['{"a":{"b":2}}']);
  });
});

describe("classifyReviewVerdictToken", () => {
  it.each([
    ["APPROVE", "APPROVE"],
    ["APPROVED", "APPROVE"],
    ["APPROVE_WITH_NOTES", "APPROVE"],
    ["approve_with_verdict", "APPROVE"],
    ["Approval", "APPROVE"],
    ["REVISE", "REVISE"],
    ["REQUEST_REVISION", "REVISE"],
    ["REJECT", "REVISE"],
    ["RETHINK", "RETHINK"],
  ] as const)("classifies %s", (token, expected) => {
    expect(classifyReviewVerdictToken(token)).toBe(expected);
  });

  it("returns null for unknown tokens", () => {
    expect(classifyReviewVerdictToken("PASS")).toBeNull();
    expect(classifyReviewVerdictToken("")).toBeNull();
  });
});
