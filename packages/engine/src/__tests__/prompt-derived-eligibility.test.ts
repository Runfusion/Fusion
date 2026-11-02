/*
 * Surface enumeration (docs/testing.md checklist): this is the ONE predicate that decides whether a card may
 * finish with zero commits from what its plan declared. Its consumers are covered in their own suites
 * (`workspace-zero-acquire.test.ts` for the workspace classifier, the executor completion tests for the
 * `no_commits` refusal), the desktop/mobile boards render no part of this decision, and no streaming/agent
 * provider path reads it — this file owns the eligibility rule itself.
 *
 * FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-23:00 (RUFU-451):
 * The rule used to recognise exactly one board-owned File Scope: `.fusion/tasks/`. A card whose deliverable is
 * durable memory or a dated evidence archive — SANE-509, whose scope named a `MEMORY.md` in two memory trees
 * plus an archive directory — therefore derived nothing, and in a workspace project a card that derives nothing
 * is refused at a land door it can only satisfy by breaking its own contract. The widening is to board-owned,
 * git-ignored prefixes ONLY, and these cases are the fence: a single tracked path in the scope, or a `.fusion/`
 * root Fusion does not own, keeps the old refusal.
 */
import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { evaluatePromptDerivedNoCommitEligibility } from "../executor/prompt-derived-eligibility.js";

function completedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-451",
    title: "Record the memory-hygiene gate findings",
    description: "Investigation card; writes durable memory only.",
    column: "in-review",
    dependencies: [],
    steps: [{ name: "Investigate", status: "done" }, { name: "Delivery", status: "done" }],
    currentStep: 2,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function promptWithScope(entries: string[], extra = ""): string {
  return [
    "# Task: RUFU-451",
    "",
    "## File Scope",
    ...entries.map((entry) => `- \`${entry}\``),
    "",
    extra,
  ].join("\n");
}

describe("prompt-derived source-free eligibility (RUFU-451)", () => {
  const memoryOnlyScope = [
    ".fusion/memory/MEMORY.md",
    ".fusion/agent-memory/agent-5173bbf9/MEMORY.md",
    ".fusion/memory-archive/RUFU-451-20260926T235749Z/gate-v2.py",
  ];

  it("derives the declaration from a File Scope of board-owned ignored paths alone", () => {
    // No declaration sentence at all: declaring only paths Fusion owns and git ignores is the declaration.
    const result = evaluatePromptDerivedNoCommitEligibility(completedTask(), promptWithScope(memoryOnlyScope));
    expect(result.eligible).toBe(true);
    expect(result.reason).toContain("source-free");
  });

  it("still derives it when the criteria disclaim commits in the plan's own language", () => {
    // SANE-509's completion criteria were Slovak and used `NO-APPLICABLE`; the English phrasing tests below
    // would never have matched them, which is the measured half of why that card could not close.
    const prompt = promptWithScope(memoryOnlyScope, [
      "## Completion Criteria",
      "Delivery je source-free: ziaden tracked subor sa nemeni, preto sa nevyzaduje commit ani changeset.",
    ].join("\n"));
    expect(evaluatePromptDerivedNoCommitEligibility(completedTask(), prompt).eligible).toBe(true);
  });

  it("keeps the original `.fusion/tasks/`-plus-declaration path eligible", () => {
    const prompt = promptWithScope(["<rootDir>/.fusion/tasks/RUFU-451/notes.md"], [
      "## Completion Criteria",
      "Deliverables are source-free gitignored task artifacts.",
      "Never create empty or fabricated zero-diff commits.",
    ].join("\n"));
    expect(evaluatePromptDerivedNoCommitEligibility(completedTask(), prompt).eligible).toBe(true);
  });

  it("refuses the moment the scope names a tracked source path", () => {
    for (const tracked of ["packages/engine/src/merge/merger-ai.ts", "docs/memory-hygiene.md", "scripts/gate.py"]) {
      const result = evaluatePromptDerivedNoCommitEligibility(
        completedTask(),
        promptWithScope([...memoryOnlyScope, tracked]),
      );
      expect(result.eligible, tracked).toBe(false);
    }
  });

  it("refuses a `.fusion/` root the board does not own", () => {
    // Widening this allowlist is widening who may finish with zero commits, so an unlisted root keeps the refusal.
    const result = evaluatePromptDerivedNoCommitEligibility(
      completedTask(),
      promptWithScope([".fusion/scratch/notes.md", ".fusion/memory/MEMORY.md"]),
    );
    expect(result.eligible).toBe(false);
  });

  it("refuses while any step is unfinished, whatever the scope says", () => {
    const result = evaluatePromptDerivedNoCommitEligibility(
      completedTask({ steps: [{ name: "Investigate", status: "done" }, { name: "Delivery", status: "pending" }] }),
      promptWithScope(memoryOnlyScope),
    );
    expect(result.eligible).toBe(false);
  });

  it("refuses a card with no declared File Scope at all", () => {
    // An empty scope is the absence of a claim, never a claim of source-freedom.
    expect(evaluatePromptDerivedNoCommitEligibility(completedTask(), "# Task\n\n## File Scope\n\n## Notes\n")).toEqual({ eligible: false });
  });
});
