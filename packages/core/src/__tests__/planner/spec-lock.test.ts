import { describe, expect, it } from "vitest";
import { evaluateSpecDrift, hasPriorLockDivergence, isCurrentSpecDriftReport } from "../../planner/drift-report.js";
import { canonicalizePlan, createCurrentPlanEvidence, diffSpecLocks, isSpecLockActive, isUnavailablePlanLockError, UnavailablePlanLockError } from "../../planner/spec-lock.js";
import type { SpecLockSection } from "../../planner/spec-lock.js";
import { applyOriginalDescription } from "../../tasks/original-description-policy.js";

const prompt = `# Task\n\n## Mission\n\nBuild a safe widget.\n\n## File Scope\n\n- src/widget.ts\n\n## Steps\n\n1. Build widget\n\n## Completion Criteria\n\n- [ ] Widget works\n\n## Do NOT\n\n- Change API\n\n## Dependencies\n\n- FN-1\n`;
const plannerPromptWithSummary = `# Task\n\n## What This Delivers\n\n- Deliver a safe widget.\n\n## Mission\n\nBuild a safe widget.\n\n## File Scope\n\n- src/widget.ts\n\n## Steps\n\n1. Build widget\n\n## Completion Criteria\n\n- [ ] Widget works\n\n## Do NOT\n\n- Change API\n\n## Dependencies\n\n- FN-1\n`;
const evidence = (text = prompt, version = 1) => createCurrentPlanEvidence({ version, sourceRevision: version, capturedAt: "2026-08-09T07:06:00.000Z", prompt: text });
const lock = (current = evidence()) => ({ version: 1, acceptedAt: "2026-08-09T07:06:00.000Z", approvalFingerprint: "approved", currentPlanVersion: current.version, currentPlanHash: current.plan.contentHash!, plan: current.plan });

describe("spec lock canonicalization", () => {
  it.each([
    "Mission", "File Scope", "Steps", "Completion Criteria", "Acceptance Criteria", "Do NOT", "Non-goals", "Dependencies", "Mission Lineage", "Parent-child Lineage",
  ])("ignores embedded operator heading %s without changing the planner hash", (heading) => {
    const control = applyOriginalDescription(prompt, "Operator context without structural collisions.");
    const embedded = applyOriginalDescription(prompt, `## ${heading}\n\nOperator-owned prose.`);
    expect(canonicalizePlan(embedded)).toMatchObject({ status: "available", contentHash: canonicalizePlan(control).contentHash });
  });

  it.each(["Mission", "File Scope", "Steps", "Completion Criteria", "Do NOT", "Dependencies"])("ignores tracked operator heading %s when What This Delivers follows the generated region", (heading) => {
    const control = applyOriginalDescription(plannerPromptWithSummary, "Operator context without structural collisions.");
    const embedded = applyOriginalDescription(plannerPromptWithSummary, `Operator context.\n\n## ${heading}\n\nOperator-owned prose.`);
    const canonical = canonicalizePlan(embedded);

    expect(canonical).toMatchObject({
      status: "available",
      contentHash: canonicalizePlan(control).contentHash,
      sections: { "non-goals": expect.objectContaining({ canonical: "Change API" }) },
    });
  });

  it("uses the bounded generated end marker when operator prose contains a literal marker", () => {
    const control = applyOriginalDescription(prompt, "Operator context.");
    const embedded = applyOriginalDescription(prompt, "Literal <!-- fusion-original-description:end --> remains operator prose.\n\n## Do NOT\n\nDo not alter compatibility.");
    expect(canonicalizePlan(embedded)).toMatchObject({ status: "available", contentHash: canonicalizePlan(control).contentHash });
  });

  it("keeps a quoted standalone marker inside the encoded region out of the planner structure", () => {
    const description = [
      "Quoted sample follows:",
      "<!-- fusion-original-description:end -->",
      "",
      "## Do NOT",
      "operator-owned constraint",
    ].join("\n");
    const control = applyOriginalDescription(plannerPromptWithSummary, "Operator context.");
    const encoded = applyOriginalDescription(plannerPromptWithSummary, description);

    expect(canonicalizePlan(encoded)).toMatchObject({
      status: "available",
      contentHash: canonicalizePlan(control).contentHash,
      sections: { "non-goals": expect.objectContaining({ canonical: "Change API" }) },
    });
  });

  it("keeps planner-authored duplicate sections unavailable", () => {
    expect(canonicalizePlan(`${prompt}\n## Do NOT\n\nDuplicate`)).toMatchObject({ status: "unavailable", reason: "section-duplicate" });
  });

  it("combines distinct aliases for the same planner-authored section", () => {
    const withAliases = `${prompt}\n## Non-Goals\n\n- Preserve compatibility`;
    expect(canonicalizePlan(withAliases)).toMatchObject({
      status: "available",
      sections: {
        "non-goals": expect.objectContaining({ canonical: "Change API\nPreserve compatibility" }),
      },
    });
  });

  it("keeps repeated exact aliases unavailable", () => {
    const withRepeatedAlias = `${prompt}\n## Non-Goals\n\n- Preserve compatibility\n\n## Non-Goals\n\n- Duplicate`;
    expect(canonicalizePlan(withRepeatedAlias)).toMatchObject({ status: "unavailable", reason: "section-duplicate" });
  });

  it("identifies unavailable locks without changing the established error message", () => {
    const error = new UnavailablePlanLockError("section-duplicate", ["mission", "non-goals"], "source-hash");
    expect(error.message).toBe("Cannot lock an unavailable plan: section-duplicate");
    expect(isUnavailablePlanLockError(error)).toBe(true);
    expect(isUnavailablePlanLockError(new Error(error.message))).toBe(false);
    expect(error.unavailableSections).toEqual(["mission", "non-goals"]);
  });

  it("normalizes Mission whitespace but preserves a structural Mission rewrite", () => {
    expect(canonicalizePlan(prompt).sections.mission.hash).toBe(canonicalizePlan(prompt.replace("Build a safe widget.", " Build   a safe widget. ")).sections.mission.hash);
    expect(canonicalizePlan(prompt).sections.mission.hash).toBe(canonicalizePlan(prompt.replace("Build a safe widget.", "Build a\n\n safe\twidget.")).sections.mission.hash);
    expect(canonicalizePlan(prompt).sections.mission.hash).not.toBe(canonicalizePlan(prompt.replace("safe", "different")).sections.mission.hash);
  });

  it.each(["", "\n## File Scope\n\n- a.ts", `${prompt}\n## Mission\n\nDuplicate`])("makes missing, empty, and duplicate Mission unavailable", (text) => {
    expect(canonicalizePlan(text).status).toBe("unavailable");
  });

  it("matches recursive glob boundaries without corrupting double-stars", () => {
    const recursive = evidence(prompt.replace("src/widget.ts", "src/**/*.ts"));
    expect(evaluateSpecDrift({ latestLock: lock(recursive), currentPlan: recursive, modifiedFiles: ["src/widget.ts", "src/deep/widget.ts"] }).findings).toEqual([]);
  });

  it("normalizes File Scope separators before comparing execution paths", () => {
    const windowsScope = evidence(prompt.replace("src/widget.ts", "src\\widget.ts"));
    expect(evaluateSpecDrift({ latestLock: lock(windowsScope), currentPlan: windowsScope, modifiedFiles: ["src/widget.ts"] }).findings).toEqual([]);
  });

  it("identifies deterministic Mission deviation and file scope creep", () => {
    const current = evidence(prompt.replace("safe widget", "different widget"), 2);
    const report = evaluateSpecDrift({ latestLock: lock(), currentPlan: current, modifiedFiles: ["src/other.ts"] });
    expect(report.alignment).toBe("diverged-needs-review");
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "plan-deviation", category: "mission-statement" }),
      expect.objectContaining({ kind: "scope-creep", path: "src/other.ts" }),
    ]));
  });

  it("flags additive boundaries as silent expansion and retains a stable diff", () => {
    const current = evidence(prompt.replace("- src/widget.ts", "- src/widget.ts\n- src/extra.ts"), 2);
    expect(evaluateSpecDrift({ latestLock: lock(), currentPlan: current }).findings).toContainEqual(expect.objectContaining({ kind: "silent-expansion", category: "file-scope" }));
    expect(diffSpecLocks(lock().plan, current.plan).changedSections).toEqual(["file-scope"]);
  });

  it("makes live dependency and lineage mutations comparable current-plan revisions", () => {
    const accepted = createCurrentPlanEvidence({
      version: 1,
      sourceRevision: 1,
      capturedAt: "2026-08-09T07:06:00.000Z",
      prompt,
      bindings: { dependencies: ["FN-1"], missionId: "M-1", sliceId: "S-1", sourceParentTaskId: "FN-PARENT" },
    });
    const changed = createCurrentPlanEvidence({
      version: 2,
      sourceRevision: 2,
      capturedAt: "2026-08-09T07:07:00.000Z",
      prompt,
      bindings: { dependencies: ["FN-1", "FN-2"], missionId: "M-2", sliceId: "S-1", sourceParentTaskId: "FN-PARENT" },
    });
    const permuted = createCurrentPlanEvidence({
      version: 3,
      sourceRevision: 3,
      capturedAt: "2026-08-09T07:08:00.000Z",
      prompt,
      bindings: { dependencies: ["FN-2", "FN-1", "FN-1"], missionId: "M-2", sliceId: "S-1", sourceParentTaskId: "FN-PARENT" },
    });
    const report = evaluateSpecDrift({ latestLock: lock(accepted), currentPlan: changed });
    expect(changed.sourceHash).not.toBe(accepted.sourceHash);
    expect(permuted.sourceHash).toBe(changed.sourceHash);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "silent-expansion", category: "dependencies" }),
      expect.objectContaining({ kind: "plan-deviation", category: "lineage" }),
    ]));
  });

  it.each([
    ["Steps", "1. Build widget\n2. Add another widget step", "steps"],
    ["Completion Criteria", "- [ ] Widget works\n- [ ] Another criterion", "acceptance-criteria"],
  ])("classifies added %s items as silent expansion", (heading, replacement, category) => {
    const current = evidence(prompt.replace(heading === "Steps" ? "1. Build widget" : "- [ ] Widget works", replacement), 2);
    expect(evaluateSpecDrift({ latestLock: lock(), currentPlan: current }).findings).toContainEqual(
      expect.objectContaining({ kind: "silent-expansion", category }),
    );
  });

  it("treats reordered durable steps as a plan deviation", () => {
    const expandedPrompt = prompt.replace("1. Build widget", "1. Build widget\n2. Add setup");
    const current = evidence(expandedPrompt, 2);
    const reordered = evidence(expandedPrompt.replace("1. Build widget\n2. Add setup", "1. Add setup\n2. Build widget"), 3);
    expect(evaluateSpecDrift({ latestLock: lock(current), currentPlan: reordered }).findings).toContainEqual(
      expect.objectContaining({ kind: "plan-deviation", category: "steps" }),
    );
  });

  it("reports malformed retained evidence as unavailable rather than clean", () => {
    const current = evidence();
    delete (current.plan.sections as Partial<typeof current.plan.sections>).steps;
    expect(evaluateSpecDrift({ latestLock: lock(), currentPlan: current, approvedPlanFingerprint: "approved" })).toMatchObject({
      status: "unavailable",
      reason: "malformed-plan-evidence",
      alignment: "unavailable",
    });
  });

  it("is on-plan only for matching active approval", () => {
    const current = evidence();
    const active = evaluateSpecDrift({ latestLock: lock(), currentPlan: current, approvedPlanFingerprint: "approved" });
    expect(active.alignment).toBe("on-plan");
    expect(active.approvedPlanFingerprint).toBe("approved");
    expect(isSpecLockActive(lock(), current, "approved")).toBe(true);
    expect(isSpecLockActive(lock(), current, undefined)).toBe(false);
    expect(evaluateSpecDrift({ latestLock: lock(), currentPlan: evidence() }).alignment).toBe("unavailable");
  });

  it("retains historical divergence after a clean newer lock is re-approved", () => {
    const relockedPlan = evidence(prompt.replace("safe widget", "re-scoped widget"), 2);
    const relock = {
      ...lock(relockedPlan),
      version: 2,
      approvalFingerprint: "re-approved",
      priorVersion: 1,
    };
    expect(evaluateSpecDrift({
      latestLock: relock,
      currentPlan: relockedPlan,
      approvedPlanFingerprint: "re-approved",
      priorDivergence: true,
    }).alignment).toBe("diverged-relocked-approved");
  });

  it("derives prior divergence from all retained lock versions", () => {
    const current = evidence();
    const currentLock = lock(current);
    const clean = evaluateSpecDrift({ latestLock: currentLock, currentPlan: current, approvedPlanFingerprint: "approved" });
    const unavailable = evaluateSpecDrift({});
    const divergence = evaluateSpecDrift({
      latestLock: currentLock,
      currentPlan: evidence(prompt.replace("safe widget", "different widget"), 2),
      approvedPlanFingerprint: "approved",
    });

    expect(hasPriorLockDivergence([], currentLock.version)).toBe(false);
    expect(hasPriorLockDivergence([unavailable], undefined)).toBe(false);
    expect(hasPriorLockDivergence([divergence], currentLock.version)).toBe(false);
    expect(hasPriorLockDivergence([{ ...divergence, lockVersion: 0 }, { ...divergence, lockVersion: 0 }], currentLock.version)).toBe(true);
    expect(hasPriorLockDivergence([unavailable, clean], currentLock.version)).toBe(false);
  });

  it("does not expose a report from an older current-plan revision as current", () => {
    const first = evidence(prompt, 1);
    const originalLock = lock(first);
    const report = evaluateSpecDrift({ latestLock: originalLock, currentPlan: first, approvedPlanFingerprint: "approved" });
    const rewritten = evidence(prompt.replace("safe widget", "changed widget"), 2);
    expect(isCurrentSpecDriftReport(report, originalLock, rewritten, "approved")).toBe(false);
    expect(isCurrentSpecDriftReport(report, originalLock, first, "approved")).toBe(true);
    expect(isCurrentSpecDriftReport(report, originalLock, first, undefined)).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------------------
 * FUSI-017 — equivalent spellings of one section combine, a heading inside a fenced example is
 * content, and a genuinely repeated heading outside fences is still refused.
 * ---------------------------------------------------------------------------------------------- */

const promptWith = (...blocks: Array<[heading: string, body: string]>): string => [
  "# Task",
  "",
  "## Mission",
  "",
  "Build a safe widget.",
  "",
  ...blocks.flatMap(([heading, body]) => [`## ${heading}`, "", body, ""]),
].join("\n");

/*
 * Test-local list semantics, written independently of the production normalizer (split/join instead of
 * a whitespace-collapse regex) so the assertions prove byte equality instead of restating the code.
 */
const listItems = (body: string): string[] => body
  .split(/\r?\n/)
  .map((line) => line.replace(/^[ \t]*(?:[*+-]|\d+[.)])[ \t]+/, "").split(/[ \t]+/).filter(Boolean).join(" "))
  .filter((line) => line.length > 0);
const expectedList = (...bodies: string[]): string => [...new Set(bodies.flatMap(listItems))].sort().join("\n");
const expectedOrderedList = (...bodies: string[]): string => bodies.flatMap(listItems).join("\n");
const expectedText = (body: string): string => body.split(/\s+/).filter(Boolean).join(" ");

const multiAliasSections: Array<{ key: SpecLockSection; first: string; second: string; firstBody: string; secondBody: string }> = [
  {
    key: "acceptance-criteria",
    first: "Completion Criteria",
    second: "Acceptance Criteria",
    firstBody: "- [ ] alpha works\n- [ ] beta works",
    secondBody: "- [ ] gamma works",
  },
  {
    key: "non-goals",
    first: "Do NOT",
    second: "Non-Goals",
    firstBody: "- Change API",
    secondBody: "- Change schema",
  },
  {
    key: "lineage",
    first: "Mission Lineage",
    second: "Parent-child Lineage",
    firstBody: "- mission:M-1",
    secondBody: "- slice:S-1",
  },
];

const singleAliasSections: Array<{ key: SpecLockSection; prompt: string; expected: string }> = [
  {
    key: "mission",
    prompt: "# Task\n\n## Mission\n\nBuild   a safe widget.\n",
    expected: expectedText("Build   a safe widget."),
  },
  {
    key: "file-scope",
    prompt: promptWith(["File Scope", "- src/widget.ts\n- src/util.ts"]),
    expected: expectedList("- src/widget.ts\n- src/util.ts"),
  },
  {
    key: "steps",
    prompt: promptWith(["Steps", "1. Build widget\n2. Ship widget"]),
    expected: expectedOrderedList("1. Build widget\n2. Ship widget"),
  },
  {
    key: "dependencies",
    prompt: promptWith(["Dependencies", "- FN-1"]),
    expected: expectedList("- FN-1"),
  },
];

describe("spec lock alias union", () => {
  it.each(multiAliasSections)("combines both accepted spellings of $key into the normalized union", ({ key, first, second, firstBody, secondBody }) => {
    const firstOnly = canonicalizePlan(promptWith([first, firstBody]));
    const secondOnly = canonicalizePlan(promptWith([second, secondBody]));
    const both = canonicalizePlan(promptWith([first, firstBody], [second, secondBody]));

    expect(firstOnly.sections[key].canonical).toBe(expectedList(firstBody));
    expect(secondOnly.sections[key].canonical).toBe(expectedList(secondBody));
    expect(both.status).toBe("available");
    expect(both.sections[key].canonical).toBe(expectedList(firstBody, secondBody));
  });

  it.each(multiAliasSections)("keeps the merged $key body materially comparable instead of dropping it", ({ key, first, second, firstBody, secondBody }) => {
    const single = canonicalizePlan(promptWith([first, firstBody]));
    const both = canonicalizePlan(promptWith([first, firstBody], [second, secondBody]));

    expect(diffSpecLocks(single, both).changedSections).toContain(key);
  });

  it.each(singleAliasSections)("canonicalizes a single spelling of $key under the documented semantics", ({ key, prompt: subject, expected }) => {
    const plan = canonicalizePlan(subject);

    expect(plan.status).toBe("available");
    expect(plan.sections[key].canonical).toBe(expected);
  });

  it("keeps an approved both-spellings plan active and on-plan for the pre-merge consumer path", () => {
    const both = promptWith(
      ["File Scope", "- src/widget.ts"],
      ["Steps", "1. Build widget"],
      ["Completion Criteria", "- [ ] Widget works"],
      ["Acceptance Criteria", "- [ ] Widget works\n- [ ] Widget is documented"],
    );
    const accepted = createCurrentPlanEvidence({ version: 1, sourceRevision: 1, capturedAt: "2026-09-18T00:00:00.000Z", prompt: both });
    const current = createCurrentPlanEvidence({ version: 2, sourceRevision: 2, capturedAt: "2026-09-18T00:01:00.000Z", prompt: both });
    const gateLock = {
      version: 1,
      acceptedAt: "2026-09-18T00:00:00.000Z",
      approvalFingerprint: "fingerprint-1",
      currentPlanVersion: accepted.version,
      currentPlanHash: accepted.plan.contentHash!,
      plan: accepted.plan,
    };

    expect(accepted.plan.status).toBe("available");
    expect(accepted.plan.sections["acceptance-criteria"].canonical).toBe(expectedList("- [ ] Widget works", "- [ ] Widget is documented"));
    expect(isSpecLockActive(gateLock, current, "fingerprint-1")).toBe(true);
    expect(evaluateSpecDrift({ latestLock: gateLock, currentPlan: current, approvedPlanFingerprint: "fingerprint-1" }).alignment).toBe("on-plan");
  });
});

describe("spec lock retained duplicate detection", () => {
  /*
   * Acceptance clause 3 — repeating one heading outside fences still makes the section ambiguous: two
   * identical level-2 headings cannot be merged deterministically, so the refusal is kept and is now
   * reserved for that case only (a fenced example can no longer reach it).
   */
  const duplicatedHeadings: Array<{ key: SpecLockSection; heading: string; reason: string }> = [
    { key: "mission", heading: "Mission", reason: "mission-duplicate" },
    { key: "file-scope", heading: "File Scope", reason: "section-duplicate" },
    { key: "steps", heading: "Steps", reason: "section-duplicate" },
    { key: "acceptance-criteria", heading: "Completion Criteria", reason: "section-duplicate" },
    { key: "acceptance-criteria", heading: "Acceptance Criteria", reason: "section-duplicate" },
    { key: "non-goals", heading: "Do NOT", reason: "section-duplicate" },
    { key: "non-goals", heading: "Non-Goals", reason: "section-duplicate" },
    { key: "dependencies", heading: "Dependencies", reason: "section-duplicate" },
    { key: "lineage", heading: "Mission Lineage", reason: "section-duplicate" },
    { key: "lineage", heading: "Parent-child Lineage", reason: "section-duplicate" },
  ];

  it.each(duplicatedHeadings)("refuses a repeated $heading heading as $reason", ({ key, heading, reason }) => {
    const plan = canonicalizePlan(promptWith([heading, "- first"], [heading, "- second"]));

    expect(plan.status).toBe("unavailable");
    expect(plan.reason).toBe(reason);
    expect(plan.sections[key]).toMatchObject({ status: "unavailable", reason });
  });

  it("refuses one spelling repeated twice without merging it", () => {
    const plan = canonicalizePlan(promptWith(["Non-Goals", "- Preserve compatibility"], ["Non-Goals", "- Duplicate"]));

    expect(plan).toMatchObject({ status: "unavailable", reason: "section-duplicate" });
  });
});

describe("spec lock fenced examples", () => {
  it("keeps a fenced example inside a section body as section content", () => {
    const body = "- FN-1\n\n```text\n## Dependencies\n\n- FN-2\n```";
    const plan = canonicalizePlan(promptWith(["Dependencies", body]));

    expect(plan.status).toBe("available");
    expect(plan.sections.dependencies.canonical).toBe(expectedList(body));
  });

  it("ignores a fenced heading that precedes the real declaration", () => {
    const plan = canonicalizePlan(`# Task\n\n## Mission\n\nBuild a safe widget.\n\n\`\`\`text\n## Dependencies\n\n- FN-9\n\`\`\`\n\n## Dependencies\n\n- FN-1\n`);

    expect(plan.status).toBe("available");
    expect(plan.sections.dependencies.canonical).toBe(expectedList("- FN-1"));
  });

  it("ignores a fenced heading for a section that also exists for real", () => {
    const plan = canonicalizePlan(promptWith(["File Scope", "- src/widget.ts\n\n```text\n## File Scope\n\n- src/other.ts\n```"]));

    expect(plan.status).toBe("available");
    expect(plan.sections["file-scope"].canonical).toBe(expectedList("- src/widget.ts\n\n```text\n## File Scope\n\n- src/other.ts\n```"));
    expect(plan.sections["file-scope"].canonical).toContain("src/other.ts");
  });

  it("keeps a fenced heading inside a section body from truncating that body", () => {
    const body = "1. Build widget\n\n```bash\n## Example run\nnpm test\n```\n\n2. Ship widget";
    const plan = canonicalizePlan(promptWith(["Steps", body]));

    expect(plan.status).toBe("available");
    expect(plan.sections.steps.canonical).toBe(expectedOrderedList(body));
    expect(plan.sections.steps.canonical.split("\n")).toEqual(expect.arrayContaining(["Build widget", "Ship widget"]));
  });

  it("ignores a heading inside a tilde fence", () => {
    const body = "- FN-1\n\n~~~text\n## Dependencies\n\n- FN-2\n~~~";
    const plan = canonicalizePlan(promptWith(["Dependencies", body]));

    expect(plan.status).toBe("available");
    expect(plan.sections.dependencies.canonical).toBe(expectedList(body));
  });

  it("lets a longer fence enclose a shorter fence and its heading as content", () => {
    const body = "- FN-1\n\n````markdown\n```\n## Dependencies\n```\n````";
    const plan = canonicalizePlan(promptWith(["Dependencies", body]));

    expect(plan.status).toBe("available");
    expect(plan.sections.dependencies.canonical).toBe(expectedList(body));
  });

  it("treats CRLF fences exactly like LF fences", () => {
    const body = "- FN-1\n\n```text\n## Dependencies\n\n- FN-2\n```";
    const lf = canonicalizePlan(promptWith(["Dependencies", body]));
    const crlf = canonicalizePlan(promptWith(["Dependencies", body.replace(/\n/g, "\r\n")]));

    expect(crlf.status).toBe("available");
    expect(crlf.sections.dependencies.canonical).toBe(lf.sections.dependencies.canonical);
    expect(crlf.sections.dependencies.canonical).toBe(expectedList(body));
  });

  it("keeps an indented example heading on its current safe behavior", () => {
    const plan = canonicalizePlan(promptWith(["Dependencies", "- FN-1\n\n    ## Dependencies\n    - FN-2"]));

    expect(plan.status).toBe("available");
    expect(plan.sections.dependencies.canonical).toBe(expectedList("- FN-1\n\n    ## Dependencies\n    - FN-2"));
  });

  it("falls back to the pre-change scan when a fence is left open at end of file", () => {
    const duplicate = canonicalizePlan(promptWith(["Dependencies", "- FN-1\n\n```text\n## Dependencies\n\n- FN-2"]));
    const truncated = canonicalizePlan(promptWith(["Steps", "1. Build widget\n\n```bash\n## Example run\nnpm test"]));

    expect(duplicate).toMatchObject({ status: "unavailable", reason: "section-duplicate" });
    expect(truncated.status).toBe("available");
    /* The pre-change scan ends the steps body at the fenced `## Example run` line, so the retained body is
       the real step plus the fence opener; the conservative fallback must reproduce exactly that. */
    expect(truncated.sections.steps.canonical).toBe(expectedOrderedList("1. Build widget\n\n```bash"));
  });

  it("does not treat a qualified heading spelling as a lock alias", () => {
    /*
     * Follow-up class recorded at completion: a canonical alias plus a trailing qualifier (for example
     * `## Completion Criteria (delivery)`) is not recognized, so that body stays outside the canonical.
     * Not fixed here on purpose — recognizing it would rewrite the canonical content of already approved
     * cards that use a qualified heading and invalidate their active locks.
     */
    const plan = canonicalizePlan(promptWith(["Steps", "1. Build widget"], ["Completion Criteria (delivery)", "- [ ] Widget works"]));

    expect(plan.status).toBe("available");
    expect(plan.sections["acceptance-criteria"]).toMatchObject({ status: "available", canonical: "" });
  });
});
