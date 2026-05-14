import { describe, expect, it } from "vitest";
import { inferWorkflowStepVerdictFromProse, parseWorkflowStepVerdict } from "../executor.js";

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
});

describe("inferWorkflowStepVerdictFromProse", () => {
  it("infers revise from REQUEST REVISION", () => {
    expect(inferWorkflowStepVerdictFromProse("REQUEST REVISION\nplease change")).toEqual({ verdict: "REVISE", notes: "please change" });
  });

  it("infers approve from positive prose", () => {
    expect(inferWorkflowStepVerdictFromProse("looks good")).toEqual({ verdict: "APPROVE", notes: "" });
  });

  it("returns null for unrelated prose", () => {
    expect(inferWorkflowStepVerdictFromProse("lorem ipsum")).toBeNull();
  });
});
