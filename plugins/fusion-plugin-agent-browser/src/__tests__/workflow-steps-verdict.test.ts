import { describe, expect, it } from "vitest";
import { AGENT_BROWSER_WORKFLOW_STEPS } from "../workflow-steps.js";

// Engine verdict helpers are not exported/importable from this plugin package build graph,
// so this test uses deterministic output-shape checks for the same contract.
function parseStructuredVerdict(output: string): { verdict: string; notes: string } | null {
  const lastLine = output.trim().split(/\n/).at(-1);
  if (!lastLine) return null;
  try {
    const parsed = JSON.parse(lastLine) as { verdict?: unknown; notes?: unknown };
    if (parsed.verdict !== "APPROVE" && parsed.verdict !== "APPROVE_WITH_NOTES" && parsed.verdict !== "REVISE") {
      return null;
    }
    return {
      verdict: parsed.verdict,
      notes: typeof parsed.notes === "string" ? parsed.notes : "",
    };
  } catch {
    return null;
  }
}

describe("browser-evidence-review verdict parsing", () => {
  it("parses clean trailing JSON output", () => {
    const output = '{"verdict":"APPROVE","notes":""}';
    expect(parseStructuredVerdict(output)).toEqual({ verdict: "APPROVE", notes: "" });
  });

  it("parses fast-bail JSON output", () => {
    const output = '{"verdict":"APPROVE","notes":"out of scope: no browser-derived evidence in diff"}';
    expect(parseStructuredVerdict(output)).toEqual({
      verdict: "APPROVE",
      notes: "out of scope: no browser-derived evidence in diff",
    });
  });

  it("keeps prose fallback contract for revision requests", () => {
    const output = "REQUEST REVISION\nclaim about pricing page lacks a screenshot";
    expect(parseStructuredVerdict(output)).toBeNull();
    expect(output).toMatch(/^REQUEST REVISION\s*\n/i);
    expect(output).toContain("claim about pricing page lacks a screenshot");
  });

  it("template declares structured verdict envelope", () => {
    const step = AGENT_BROWSER_WORKFLOW_STEPS.find((entry) => entry.stepId === "browser-evidence-review");
    expect(step?.prompt).toContain('{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}');
  });
});
