import { describe, expect, it, vi } from "vitest";
import { analyzeOverlapResume, deliveryEvidenceFromTask, parsePlanFileTargets, type OverlapDeliveryEvidence } from "../execution/overlap-resume-analysis.js";
import { buildOverlapResumeContext } from "../execution/overlap-resume-context.js";

const task = (prompt: string, modifiedFiles: string[] = []) => ({ prompt, modifiedFiles, lineageId: "lineage-b", declaredSymbols: ["sharedApi"] });
const plan = (scope = "src/shared.ts") => `# Task\n\n## Mission\nUpdate \`sharedApi\` without losing progress.\n\n## File Scope\n- \`${scope}\`\n\n## Steps\n### Step 1\nUse \`sharedApi\`.\n`;
const delivery = (overrides: Partial<OverlapDeliveryEvidence> = {}): OverlapDeliveryEvidence => ({
  blockerTaskId: "FN-A", repository: ".", landedSha: "c1", evidence: "git-recapture",
  paths: [{ repository: ".", path: "src/shared.ts", status: "modified", diff: "+// detail only" }],
  ...overrides,
});

describe("overlap resume analysis", () => {
  it("uses actual landed files rather than matching declared scopes", () => {
    const result = analyzeOverlapResume({ task: task(plan()), deliveries: [delivery({ paths: [{ repository: ".", path: "src/other.ts", status: "modified", diff: "+detail" }] })] });
    expect(result).toMatchObject({ decision: "resume", reason: "no-common-files", commonFiles: [] });
  });

  it("includes a delivered file targeted by the plan even before B has commits", () => {
    const result = analyzeOverlapResume({ task: task(plan(), []), deliveries: [delivery()] });
    expect(result).toMatchObject({ decision: "briefing", commonFiles: ["src/shared.ts"] });
    expect(buildOverlapResumeContext(result)).toContain("FN-A");
  });

  it("distinguishes a non-structural detail from an explicit signature change", () => {
    const detail = analyzeOverlapResume({ task: task(plan()), deliveries: [delivery()] });
    const signature = analyzeOverlapResume({ task: task(plan()), deliveries: [delivery({ paths: [{ repository: ".", path: "src/shared.ts", status: "modified", diff: "-export function sharedApi(a: string)\n+export function sharedApi(a: number)" }] })] });
    expect(detail.decision).toBe("briefing");
    expect(signature).toMatchObject({ decision: "revalidate", reason: "structural-contract-change" });
  });

  it.each([
    ["deleted", { repository: ".", path: "src/shared.ts", status: "deleted" as const, diff: "-export function sharedApi() {}" }],
    ["renamed", { repository: ".", path: "src/new.ts", previousPath: "src/shared.ts", status: "renamed" as const, diff: "" }],
  ])("revalidates a structurally %s plan target", (_label, change) => {
    expect(analyzeOverlapResume({ task: task(plan()), deliveries: [delivery({ paths: [change] })] }).decision).toBe("revalidate");
  });

  it("keeps identical relative paths in separate workspace repositories", () => {
    const result = analyzeOverlapResume({
      task: task(plan("repo-b:src/shared.ts")),
      deliveries: [delivery({ repository: "repo-a", paths: [{ repository: "repo-a", path: "src/shared.ts", status: "modified", diff: "+detail" }] })],
    });
    expect(result.decision).toBe("resume");
  });

  it("does not confuse a proven no-op with unavailable delivery evidence", () => {
    expect(analyzeOverlapResume({ task: task(plan()), deliveries: [delivery({ paths: [], noOp: true })] }).decision).toBe("resume");
    expect(analyzeOverlapResume({ task: task(plan()), deliveries: [delivery({ paths: undefined, evidence: "unavailable" })] })).toMatchObject({ decision: "freshness-pending", reason: "delivery-evidence-unavailable" });
  });

  it("aggregates A and C and renews identity when the plan changes", () => {
    const a = delivery();
    const c = delivery({ blockerTaskId: "FN-C", landedSha: "c2", paths: [{ repository: ".", path: "src/other.ts", status: "modified", diff: "+detail" }] });
    const first = analyzeOverlapResume({ task: task(plan()), deliveries: [a, c] });
    const second = analyzeOverlapResume({ task: task(plan("src/other.ts")), deliveries: [a, c] });
    expect(first.decisionFingerprint).not.toBe(second.decisionFingerprint);
  });

  it("extracts authoritative merge metadata but treats attribution fallback as unavailable", () => {
    expect(deliveryEvidenceFromTask({ id: "FN-A", mergeDetails: { commitSha: "c1", landedFiles: [], noOpVerifiedShortCircuit: true } })[0]).toMatchObject({ noOp: true, paths: [] });
    expect(deliveryEvidenceFromTask({ id: "FN-A", mergeDetails: { commitSha: "c1", landedFiles: ["x"], landedFilesCaptureFallback: "attribution-failed" } })[0]?.evidence).toBe("unavailable");
  });

  it("parses concrete and glob targets without any model call", () => {
    const model = vi.fn();
    expect(parsePlanFileTargets(plan("src/**/*.ts"))).toEqual(["src/**/*.ts"]);
    analyzeOverlapResume({ task: task(plan()), deliveries: [delivery()] });
    expect(model).not.toHaveBeenCalled();
  });
});
