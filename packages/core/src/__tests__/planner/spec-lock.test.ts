import { describe, expect, it } from "vitest";
import { evaluateSpecDrift, hasPriorLockDivergence, isCurrentSpecDriftReport } from "../../planner/drift-report.js";
import { canonicalizePlan, createCurrentPlanEvidence, diffSpecLocks, isSpecLockActive } from "../../planner/spec-lock.js";

const prompt = `# Task\n\n## Mission\n\nBuild a safe widget.\n\n## File Scope\n\n- src/widget.ts\n\n## Steps\n\n1. Build widget\n\n## Completion Criteria\n\n- [ ] Widget works\n\n## Do NOT\n\n- Change API\n\n## Dependencies\n\n- FN-1\n`;
const evidence = (text = prompt, version = 1) => createCurrentPlanEvidence({ version, sourceRevision: version, capturedAt: "2026-08-09T07:06:00.000Z", prompt: text });
const lock = (current = evidence()) => ({ version: 1, acceptedAt: "2026-08-09T07:06:00.000Z", approvalFingerprint: "approved", currentPlanVersion: current.version, currentPlanHash: current.plan.contentHash!, plan: current.plan });

describe("spec lock canonicalization", () => {
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
