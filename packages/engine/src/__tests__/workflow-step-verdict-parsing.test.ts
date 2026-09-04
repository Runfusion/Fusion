import { describe, expect, it } from "vitest";
import {
  MAX_DERIVED_WORKFLOW_STEP_NOTES_CHARS,
  inferWorkflowStepVerdictFromProse,
  parseWorkflowStepOutput,
  parseWorkflowStepVerdict,
  workflowStepVerdictNoNotesNotice,
  type WorkflowStepVerdictNoNotesReason,
} from "../executor.js";
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

  it.each<WorkflowStepVerdictNoNotesReason>([
    "empty",
    "timed-out",
    "failed-soft",
    "unavailable",
    "reused-empty",
  ])("narrates a missing-note %s outcome without fabricating reviewer reasoning", (reason) => {
    const notice = workflowStepVerdictNoNotesNotice("APPROVE", reason);
    expect(notice.trim()).not.toBe("");
    expect(notice).toContain("APPROVE");
    expect(notice).toMatch(/without a rationale/);
    expect(notice).not.toMatch(/checked|correct|complete|passed|satisf(?:y|ied)/i);
  });

  it("mirrors structured verdict notes into human-readable output", () => {
    const parsed = parseWorkflowStepOutput('{"verdict":"APPROVE","notes":"The plan is internally consistent."}');
    expect(parsed.output).toBe("The plan is internally consistent.");
    expect(parsed.notes).toBe(parsed.output);
  });

  it("mirrors inferred REQUEST REVISION notes into output", () => {
    const parsed = parseWorkflowStepOutput("REQUEST REVISION\nPlease add the missing verification.");
    expect(parsed).toMatchObject({ verdict: "REVISE", notes: "Please add the missing verification." });
    expect(parsed.output).toBe(parsed.notes);
  });

  it("marks explicit approval prose malformed without a structured verdict", () => {
    const prose = "Verdict: APPROVE\n\nThe plan is ready.";
    const parsed = parseWorkflowStepOutput(prose);
    expect(parsed).toEqual({
      output: prose,
      malformed: true,
      malformedReason: "prose-approval-without-json",
    });
  });

  it("derives notes from prose surrounding an empty structured verdict", () => {
    const prose = "I read PROMPT.md and the cited files; scope and verification are adequate.";
    expect(parseWorkflowStepOutput(`${prose}\n{\"verdict\":\"APPROVE\",\"notes\":\"\"}`)).toEqual({
      output: prose,
      verdict: "APPROVE",
      notes: prose,
    });
  });

  it("strips fenced verdict payload markers while retaining surrounding prose", () => {
    const prose = "The implementation and targeted checks are complete.";
    expect(parseWorkflowStepOutput(`${prose}\n\`\`\`json\n{\"verdict\":\"APPROVE\",\"notes\":\"\"}\n\`\`\``)).toEqual({
      output: prose,
      verdict: "APPROVE",
      notes: prose,
    });
  });

  it("derives notes from finding titles when no prose is available", () => {
    expect(parseWorkflowStepOutput('{"verdict":"REVISE","notes":"","findings":[{"id":"a","title":"Fix auth","body":"detail"},{"id":"b","title":"Add coverage","body":"detail"}]}')).toMatchObject({
      output: "- Fix auth\n- Add coverage",
      verdict: "REVISE",
      notes: "- Fix auth\n- Add coverage",
    });
  });

  it.each([
    '{"verdict":"APPROVE","notes":"","findings":[]}',
    '{"verdict":"APPROVE_WITH_NOTES"}',
  ])("marks a structured verdict with no recoverable notes as transiently missing: %s", (payload) => {
    expect(parseWorkflowStepOutput(payload)).toEqual({
      output: "",
      verdict: payload.includes("APPROVE_WITH_NOTES") ? "APPROVE_WITH_NOTES" : "APPROVE",
      notes: "",
      notesMissing: true,
    });
  });

  it("does not derive or request notes for CLOSE_NO_OP", () => {
    expect(parseWorkflowStepOutput('{"verdict":"CLOSE_NO_OP","notes":""}', { optionalGroupId: "plan-review" })).toEqual({
      output: "",
      verdict: "CLOSE_NO_OP",
      notes: "",
    });
  });

  it("bounds derived notes on a whitespace boundary", () => {
    const longProse = `${"checked ".repeat(400)}finished`;
    const parsed = parseWorkflowStepOutput(`${longProse}\n{"verdict":"APPROVE","notes":""}`);
    expect(parsed.notes!.length).toBeLessThanOrEqual(MAX_DERIVED_WORKFLOW_STEP_NOTES_CHARS);
    expect(parsed.notes).toMatch(/…$/);
    expect(parsed.notes).not.toMatch(/check…$/);
  });

  it("does not mark non-verdict skill output as missing notes", () => {
    expect(parseWorkflowStepOutput("native skill output", { requireVerdict: false })).toEqual({ output: "native skill output" });
  });

  it("preserves normalized supersession claims with resolved finding receipts", () => {
    const parsed = parseWorkflowStepOutput('{"verdict":"REVISE","notes":"reviewed","findings":[{"id":"r1","title":"Receipt","body":"Fixed in this review","resolution":"resolved-in-review"},{"id":"o1","title":"Open","body":"Still needs work"}],"supersededFindingSourceWorkflowStepId":"cleanup-review","supersededFindingIds":[" c1 ",42,"c1","c2"]}');
    expect(parsed).toMatchObject({
      verdict: "REVISE",
      supersededFindingSourceWorkflowStepId: "cleanup-review",
      supersededFindingIds: ["c1", "c2"],
      findings: [
        { id: "r1", resolution: "resolved-in-review" },
        { id: "o1" },
      ],
    });
    expect(parsed.findings?.[1]).not.toHaveProperty("resolution");
  });

  it("recognizes CLOSE_NO_OP only for the Plan Review optional group", () => {
    const response = '{"verdict":"CLOSE_NO_OP","notes":"DUPLICATE: FN-1234 already covered"}';
    expect(parseWorkflowStepVerdict(response, { optionalGroupId: "plan-review" })).toMatchObject({
      verdict: "CLOSE_NO_OP",
      notes: "DUPLICATE: FN-1234 already covered",
    });
    expect(parseWorkflowStepVerdict(response, { optionalGroupId: "code-review" })).toBeNull();
    expect(parseWorkflowStepVerdict(response)).toBeNull();
  });

  it("prefers a trailing Plan Review close JSON payload", () => {
    const response = 'Example: {"verdict":"REVISE"}\n{"verdict":"CLOSE_NO_OP","notes":"PREMISE STALE: already shipped"}';
    expect(parseWorkflowStepVerdict(response, { optionalGroupId: "plan-review" })).toEqual({
      verdict: "CLOSE_NO_OP",
      notes: "PREMISE STALE: already shipped",
    });
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

  it("prefers the LAST JSON object when several appear despite an unpaired prose brace", () => {
    const out = 'Example format: {"verdict":"REVISE"}. IndexOfAny(\'{\',\'[\') actual verdict follows.\n' +
      '{"verdict":"APPROVE","notes":"ok"}';
    expect(parseWorkflowStepVerdict(out)).toEqual({ verdict: "APPROVE", notes: "ok" });
  });

  it("preserves the reported APPROVE_WITH_NOTES verdict, notes, and findings after unpaired prose", () => {
    const out = "prose with IndexOfAny('{','[') in it\n\n" +
      '{"verdict":"APPROVE_WITH_NOTES","notes":"n","findings":[{"id":"x","title":"t","body":"b","severity":"low"}]}';
    const expected = { verdict: "APPROVE_WITH_NOTES", notes: "n", findings: [{ id: "x", title: "t", body: "b", severity: "low" }] };
    expect(parseWorkflowStepVerdict(out)).toEqual(expected);
    expect(parseWorkflowStepOutput(out)).toEqual({ output: "n", ...expected });
  });

  it.each([
    ["a stray closing prose brace", 'stray } in prose\n{"verdict":"REVISE","notes":"n"}'],
    ["an odd prose quote with no primary candidate", 'odd quote "\n{"verdict":"REVISE","notes":"n"}'],
  ])("recovers a REVISE payload after %s", (_scenario, output) => {
    expect(parseWorkflowStepVerdict(output)).toEqual({ verdict: "REVISE", notes: "n" });
  });

  it("recovers a REVISE payload from quote desync, dense findings, and brace-bearing trailing prose", () => {
    const findings = Array.from({ length: 12 }, (_, index) => ({ id: `finding-${index}`, title: "t", body: "b" }));
    /* FNXC:ReviewLeniency 2026-08-11-18:57: Keep the payload multi-line so no
     * trailing-line fast path can rescue it; recovery must reach its outer opening after many inner objects. */
    const payload = JSON.stringify({
      verdict: "REVISE",
      notes: 'full { note } with "quotes"',
      findings,
    }, null, 2);
    const out = `{"example":true}\nodd quote "\n${payload}\nuse } to close\n} } } } } }\n{"example":1}`;
    expect(parseWorkflowStepVerdict(out)).toEqual({
      verdict: "REVISE",
      notes: 'full { note } with "quotes"',
      findings,
    });
  });

  it.each([
    ['{"verdict":"APPROVE"}', "APPROVE"],
    ['{"verdict":"APPROVE_WITH_NOTES","notes":"minor"}', "APPROVE_WITH_NOTES"],
    ['{"verdict":"REVISE"}', "REVISE"],
  ] as const)("accepts exact workflow verdict token %s", (input, expected) => {
    expect(parseWorkflowStepVerdict(input)?.verdict).toBe(expected);
  });

  it.each([
    '{"verdict":"APPROVE_ANYTHING"}',
    '{"verdict":"APPROVED"}',
    '{"verdict":"approve"}',
    '{"verdict":" APPROVE "}',
    '{"verdict":"approve_with_verdict"}',
    '{"verdict":"Approval"}',
    '{"verdict":"REQUEST_REVISION"}',
    '{"verdict":"REJECT"}',
    '{"verdict":"RETHINK"}',
  ])("rejects non-contract structured workflow verdict %s", (input) => {
    expect(parseWorkflowStepVerdict(input)).toBeNull();
    expect(parseWorkflowStepOutput(input)).toMatchObject({
      malformed: true,
      malformedReason: "unreadable-structured-verdict",
    });
  });
});

describe("inferWorkflowStepVerdictFromProse", () => {
  it("infers revise from REQUEST REVISION", () => {
    expect(inferWorkflowStepVerdictFromProse("REQUEST REVISION\nplease change")).toEqual({ verdict: "REVISE", notes: "please change" });
  });

  it("does not infer approval from positive prose", () => {
    expect(inferWorkflowStepVerdictFromProse("looks good")).toBeNull();
  });

  it("uses explicit markdown verdicts only for fail-safe revision", () => {
    expect(inferWorkflowStepVerdictFromProse("## Spec Review\n\n### Verdict: APPROVE\n\nThe plan is ready.")).toBeNull();
    expect(inferWorkflowStepVerdictFromProse("Status: APPROVE_WITH_NOTES\n\nProceed with notes.")).toBeNull();
    expect(inferWorkflowStepVerdictFromProse("Verdict: REVISE\n\nFix the plan.")).toEqual({
      verdict: "REVISE",
      notes: "",
    });
  });

  it("returns null for unrelated prose", () => {
    expect(inferWorkflowStepVerdictFromProse("lorem ipsum")).toBeNull();
  });

  /*
  FNXC:ReviewVerdictAuthority 2026-09-02-19:25:
  Approval phrasing remains diagnostic input, but prose alone never authorizes a pass.
  */
  it.each([
    "Approving — nice work.",
    "LGTM",
    "ship it",
    "All good, no blocking issues.",
    "This is acceptable.",
    "Good to merge.",
    "Passes review.",
  ])("does not infer approval from broadened approval phrasing: %s", (text) => {
    expect(inferWorkflowStepVerdictFromProse(text)).toBeNull();
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
  it("returns balanced objects in document order", () => {
    expect(extractJsonObjectCandidates('a {"x":1} b {"y":2} c')).toEqual(['{"x":1}', '{"y":2}']);
  });

  it("ignores braces inside string values", () => {
    expect(extractJsonObjectCandidates('{"notes":"has } and { braces"}')).toEqual([
      '{"notes":"has } and { braces"}',
    ]);
  });

  /* FNXC:ReviewLeniency 2026-08-11-18:44: Nested candidates are intentional so a
   * poisoned outer prose span cannot hide a later valid payload; the parent closes last. */
  it("emits nested objects followed by their parent", () => {
    expect(extractJsonObjectCandidates('prose {"a":{"b":2}} tail')).toEqual(['{"b":2}', '{"a":{"b":2}}']);
  });

  it("keeps a trailing payload after unpaired prose braces of either direction", () => {
    const payload = '{"verdict":"APPROVE","notes":"n"}';
    expect(extractJsonObjectCandidates(`IndexOfAny('{','[')\n${payload}`).at(-1)).toBe(payload);
    expect(extractJsonObjectCandidates(`stray } in prose\n${payload}`).at(-1)).toBe(payload);
  });

  it("recovers a payload after quote desync with no primary candidate", () => {
    const payload = '{"verdict":"REVISE","notes":"full"}';
    const candidates = extractJsonObjectCandidates(`odd quote "\n${payload}`);
    expect(candidates.at(-1)).toBe(payload);
  });

  it("recovers a payload after quote desync even when a bogus primary candidate exists", () => {
    const payload = '{"verdict":"REVISE","notes":"full"}';
    const candidates = extractJsonObjectCandidates(`{"example":true}\nodd quote "\n${payload}`);
    expect(candidates).toContain('{"example":true}');
    expect(candidates.at(-1)).toBe(payload);
  });

  it("recovers a brace- and quote-bearing multi-finding payload beneath brace-dense trailing prose", () => {
    const payload = JSON.stringify({
      verdict: "APPROVE_WITH_NOTES",
      notes: 'has { and } plus "quoted" text',
      findings: Array.from({ length: 12 }, (_, index) => ({ id: `f-${index}`, title: "t", body: "{ body }" })),
    }, null, 2);
    const trailing = ["use } to close", "} } }", "example {\"x\":1}", "} } }"].join("\n");
    const candidates = extractJsonObjectCandidates(`{"example":true}\nodd quote "\n${payload}\n${trailing}`);
    expect(candidates).toContain(payload);
    expect(JSON.parse(candidates.find((candidate) => candidate === payload)!)).toEqual(JSON.parse(payload));
  });

  /* FNXC:ReviewLeniency 2026-08-11-21:39: Primary candidate retention is capped
   * so brace-dense reviewer prose cannot grow memory without bound; retain the tail
   * because callers prefer the final authoritative verdict. */
  it("bounds brace-dense primary candidates while retaining the trailing verdict", () => {
    const noise = Array.from({ length: 500 }, (_, index) => `{"example":${index}}`).join(" ");
    const payload = '{"verdict":"APPROVE_WITH_NOTES","notes":"tail"}';
    const candidates = extractJsonObjectCandidates(`${noise}\n${payload}`);
    expect(candidates).toHaveLength(200);
    expect(candidates.at(-1)).toBe(payload);
  });
});

describe("classifyReviewVerdictToken", () => {
  it.each([
    ["APPROVE", "APPROVE"],
    ["APPROVE_WITH_NOTES", "APPROVE"],
    ["REVISE", "REVISE"],
    ["RETHINK", "RETHINK"],
  ] as const)("classifies exact protocol token %s", (token, expected) => {
    expect(classifyReviewVerdictToken(token)).toBe(expected);
  });

  it.each([
    "APPROVE_ANYTHING",
    "APPROVED",
    "approve",
    " APPROVE ",
    "approve_with_verdict",
    "Approval",
    "REQUEST_REVISION",
    "REJECT",
    "PASS",
    "",
  ])("returns null for non-contract token %s", (token) => {
    expect(classifyReviewVerdictToken(token)).toBeNull();
  });
});
