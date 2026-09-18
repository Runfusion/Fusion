import { describe, expect, it } from "vitest";
import {
  buildPatchnodeEntryId,
  buildPatchnodeEntryInput,
  buildPatchnodeSnapshotLabel,
  groupPatchnodeEntriesByDay,
  matchesPatchnodeQuery,
  PATCHNODE_DESCRIPTION_LABEL_LENGTH,
  toPatchnodeDay,
} from "../board/patchnode.js";
import { extractPatchnodeProductSummary, PATCHNODE_PRODUCT_SUMMARY_LENGTH } from "../board/patchnode-product-summary.js";
import { planPatchnodeLabelRepair, planPatchnodeProductSummaryRepair } from "../task-store/async/async-patchnode.js";
import type { PatchnodeEntry } from "../types/task/patchnode.js";

/*
FNXC:PatchnodeLedger 2026-09-18-02:48:
FN-526 fixtures are duplicated literally in `packages/dashboard/app/utils/__tests__/taskPlanSummary.test.ts`
so the core extractor and the dashboard's `extractTaskProductSummary` stay converged on section
selection. Editing one side requires editing the other.
*/
export const PLAN_WITH_BOTH_SECTIONS = [
  "# Task: FN-1 - Titre",
  "",
  "## What This Delivers",
  "",
  "- Les opérateurs relisent l'intention.",
  "- La description vient du plan.",
  "",
  "## Before → After Transformation",
  "",
  "- **Before:** ancien corps.",
  "",
  "## Mission",
  "",
  "Technique.",
  "",
].join("\n");

export const PLAN_BEFORE_AFTER_ONLY = [
  "# Task: FN-1 - Titre",
  "",
  "## Before -> After Transformation",
  "",
  "- **Before:** `body` venait du résumé.",
  "",
  "## Mission",
  "",
  "Technique.",
  "",
].join("\n");

export const PLAN_MISSION_ONLY = "# Task: FN-1 - Titre\n\n## Mission\n\nTechnique seulement.\n";

const entry = (overrides: Partial<PatchnodeEntry> = {}): PatchnodeEntry => ({
  entryId: "completed:FN-1:1",
  taskId: "FN-1",
  kind: "completed",
  occurrenceKey: "1",
  day: "2026-08-28",
  occurredAt: "2026-08-28T10:00:00.000Z",
  title: "Ship feature",
  body: "Feature shipped",
  ...overrides,
});

describe("Patchnode projection", () => {
  it("returns the UTC day for an instant on a different local day", () => {
    expect(toPatchnodeDay("2026-08-28T00:30:00+02:00")).toBe("2026-08-27");
  });

  it("groups days and entries newest first", () => {
    const days = groupPatchnodeEntriesByDay([
      entry({ entryId: "older", day: "2026-08-27", occurredAt: "2026-08-27T12:00:00Z" }),
      entry({ entryId: "newest", occurredAt: "2026-08-28T12:00:00Z" }),
      entry({ entryId: "middle", occurredAt: "2026-08-28T11:00:00Z", kind: "reverted" }),
    ]);
    expect(days.map((day) => day.day)).toEqual(["2026-08-28", "2026-08-27"]);
    expect(days[0]?.entries.map((item) => item.entryId)).toEqual(["newest", "middle"]);
    expect(days[0]).toMatchObject({ completedCount: 1, revertedCount: 1 });
  });

  /*
  FNXC:PatchnodeLedger 2026-09-18-02:48:
  FN-526 replaces the FN-444 expectations here (which asserted `body === task.summary`, literally the
  reported defect). The symptom reproduction: a task whose Completion Summary is "Shipped search"
  and whose plan declares `## What This Delivers` must persist the PRODUCT text, and the completion
  summary must never appear in the body — not even as a fallback when no product section exists.
  */
  it("captures the plan's product summary as the body and never the completion summary", () => {
    // A stored Completion Summary is present on the source task and must be ignored entirely.
    const withProductSection = { id: "FN-1", title: "Titre", description: "D", summary: "Shipped search", prompt: "## What This Delivers\n\n- Les opérateurs relisent l'intention.\n" };
    const captured = buildPatchnodeEntryInput(withProductSection, "completed", "2026-08-28T00:00:00Z");
    expect(captured.body).toBe("Les opérateurs relisent l'intention.");
    expect(captured.body).not.toContain("Shipped search");

    // No product section, a non-empty completion summary: the body stays EMPTY, no fallback.
    const missionOnly = { id: "FN-1", title: "Titre", description: "D", summary: "Shipped search", prompt: PLAN_MISSION_ONLY };
    expect(buildPatchnodeEntryInput(missionOnly, "completed", "2026-08-28T00:00:00Z").body).toBe("");

    // No plan at all (unreadable or absent PROMPT.md).
    expect(buildPatchnodeEntryInput({ id: "FN-1", title: "Titre", description: "D" }, "completed", "2026-08-28T00:00:00Z").body).toBe("");
  });

  it("captures the canonical task label instead of repeating the task id", () => {
    // Symptom reproduction from FN-444: a titleless task used to persist title === taskId.
    expect(buildPatchnodeEntryInput({ id: "FN-2", title: undefined, description: "Corriger le rendu" }, "completed", "2026-08-28T00:00:00Z").title).toBe("Corriger le rendu");
    expect(buildPatchnodeEntryInput({ id: "FN-2", title: "  ", description: "Corriger le rendu" }, "completed", "2026-08-28T00:00:00Z").title).toBe("Corriger le rendu");
  });

  it("mirrors the FN-391 label precedence: title, then exactly 220 description characters, then id", () => {
    expect(PATCHNODE_DESCRIPTION_LABEL_LENGTH).toBe(220);
    expect(buildPatchnodeSnapshotLabel({ id: "FN-1", title: "Stored title", description: "Ignored description" })).toBe("Stored title");
    const short = "x".repeat(PATCHNODE_DESCRIPTION_LABEL_LENGTH);
    expect(buildPatchnodeSnapshotLabel({ id: "FN-1", title: undefined, description: short })).toBe(short);
    const long = "y".repeat(PATCHNODE_DESCRIPTION_LABEL_LENGTH + 40);
    const label = buildPatchnodeSnapshotLabel({ id: "FN-1", title: null, description: long });
    expect(label).toBe(long.slice(0, PATCHNODE_DESCRIPTION_LABEL_LENGTH));
    expect(label).toHaveLength(PATCHNODE_DESCRIPTION_LABEL_LENGTH);
    expect(label.endsWith("…")).toBe(false);
    expect(label.endsWith("...")).toBe(false);
    expect(buildPatchnodeSnapshotLabel({ id: "FN-3", title: "  ", description: "   " })).toBe("FN-3");
    expect(buildPatchnodeSnapshotLabel({ id: "FN-3" })).toBe("FN-3");
  });

  it("still falls back to the task id when neither a title nor a description exists", () => {
    expect(buildPatchnodeEntryInput({ id: "FN-2", title: "  ", description: "" }, "completed", "2026-08-28T00:00:00Z")).toMatchObject({ title: "FN-2", body: "" });
  });

  it("matches task id, title, and body case-insensitively", () => {
    const value = entry();
    expect(matchesPatchnodeQuery(value, "fn-1")).toBe(true);
    expect(matchesPatchnodeQuery(value, "SHIP FEATURE")).toBe(true);
    expect(matchesPatchnodeQuery(value, "feature SHIPPED")).toBe(true);
    expect(matchesPatchnodeQuery(value, "missing")).toBe(false);
  });

  it("keeps an unpaired reverted entry intact", () => {
    const reverted = entry({
      entryId: buildPatchnodeEntryId("reverted", "FN-1", "none"),
      kind: "reverted",
      occurrenceKey: "none",
      revertsEntryId: null,
    });
    expect(groupPatchnodeEntriesByDay([reverted])[0]?.entries[0]).toEqual(reverted);
  });

  it("distinguishes deliveries while converging repeated capture of one delivery", () => {
    const first = buildPatchnodeEntryInput({ id: "FN-1", title: "Title", description: "D" }, "completed", "2026-08-27T10:00:00Z");
    const repeated = buildPatchnodeEntryInput({ id: "FN-1", title: "Title", description: "D" }, "completed", "2026-08-27T10:00:00Z");
    const second = buildPatchnodeEntryInput({ id: "FN-1", title: "Title", description: "D" }, "completed", "2026-08-28T10:00:00Z");
    expect(first.entryId).toBe(repeated.entryId);
    expect(second.entryId).not.toBe(first.entryId);
    expect([first.day, second.day]).toEqual(["2026-08-27", "2026-08-28"]);
  });

  it("uses one kind prefix to distinguish completed and reverted identities", () => {
    expect(buildPatchnodeEntryId("completed", "FN-1", "42")).toBe("completed:FN-1:42");
    expect(buildPatchnodeEntryId("reverted", "FN-1", "42")).toBe("reverted:FN-1:42");
  });

  describe("legacy label repair", () => {
    const degenerate = (overrides: Partial<PatchnodeEntry> = {}) => entry({ taskId: "FN-2", title: "FN-2", body: "FN-2", ...overrides });

    it("leaves a healthy entry alone", () => {
      expect(planPatchnodeLabelRepair(entry(), { id: "FN-1", title: "Ship feature" })).toBeNull();
      expect(planPatchnodeLabelRepair(entry({ title: "Ship feature" }), { id: "FN-1", title: undefined, description: "Other" })).toBeNull();
    });

    it("repairs a degenerate entry from the live task label", () => {
      expect(planPatchnodeLabelRepair(degenerate(), { id: "FN-2", title: undefined, description: "Corriger le rendu" })).toEqual({ title: "Corriger le rendu", body: "" });
      expect(planPatchnodeLabelRepair(degenerate(), { id: "FN-2", title: "Stored title", description: "Ignored" })).toEqual({ title: "Stored title", body: "" });
    });

    it("cannot repair when the task has no recoverable label", () => {
      expect(planPatchnodeLabelRepair(degenerate(), { id: "FN-2", title: "  ", description: "" })).toBeNull();
      expect(planPatchnodeLabelRepair(degenerate(), { id: "FN-2" })).toBeNull();
    });

    it("preserves a real point-in-time summary and clears only a copied identifier body", () => {
      expect(planPatchnodeLabelRepair(degenerate({ body: "Shipped search" }), { id: "FN-2", description: "Corriger le rendu" })).toEqual({ title: "Corriger le rendu", body: "Shipped search" });
      expect(planPatchnodeLabelRepair(degenerate({ body: "FN-2" }), { id: "FN-2", description: "Corriger le rendu" })?.body).toBe("");
    });

    it("is idempotent", () => {
      const task = { id: "FN-2", title: undefined, description: "Corriger le rendu" };
      const repaired = planPatchnodeLabelRepair(degenerate(), task)!;
      expect(planPatchnodeLabelRepair({ taskId: "FN-2", ...repaired }, task)).toBeNull();
    });
  });

  /*
  FNXC:PatchnodeLedger 2026-09-18-02:48:
  FN-526: the SQL provenance marker (`entries.body = tasks.summary`) is what admits a row into this
  planner; the planner itself only decides the replacement body.
  */
  describe("legacy product-summary repair", () => {
    it("replaces an old completion-summary body with the plan's product summary", () => {
      expect(planPatchnodeProductSummaryRepair({ body: "Shipped search" }, PLAN_WITH_BOTH_SECTIONS))
        .toEqual({ body: "Les opérateurs relisent l'intention. La description vient du plan." });
    });

    it("clears the body when the plan exposes no product section", () => {
      expect(planPatchnodeProductSummaryRepair({ body: "Shipped search" }, PLAN_MISSION_ONLY)).toEqual({ body: "" });
    });

    it("clears the body for an unreadable plan, but leaves an already-empty body alone", () => {
      expect(planPatchnodeProductSummaryRepair({ body: "Shipped search" }, null)).toEqual({ body: "" });
      expect(planPatchnodeProductSummaryRepair({ body: "" }, null)).toBeNull();
    });

    it("leaves a body that already carries the product summary alone", () => {
      expect(planPatchnodeProductSummaryRepair({ body: "Les opérateurs relisent l'intention. La description vient du plan." }, PLAN_WITH_BOTH_SECTIONS)).toBeNull();
    });

    it("is idempotent", () => {
      const first = planPatchnodeProductSummaryRepair({ body: "Shipped search" }, PLAN_WITH_BOTH_SECTIONS)!;
      expect(planPatchnodeProductSummaryRepair(first, PLAN_WITH_BOTH_SECTIONS)).toBeNull();
    });
  });

  it("captures title and body by value", () => {
    const source = { id: "FN-1", title: "Original", description: "D", prompt: PLAN_WITH_BOTH_SECTIONS };
    const captured = buildPatchnodeEntryInput(source, "completed", "2026-08-28T10:00:00Z");
    source.title = "Changed";
    source.prompt = PLAN_MISSION_ONLY;
    expect(captured).toMatchObject({ title: "Original", body: "Les opérateurs relisent l'intention. La description vient du plan." });
  });
});

describe("Patchnode product summary extraction", () => {
  it("prefers What This Delivers over Before → After Transformation", () => {
    expect(extractPatchnodeProductSummary(PLAN_WITH_BOTH_SECTIONS)).toBe("Les opérateurs relisent l'intention. La description vient du plan.");
  });

  it("falls back to Before → After Transformation, including the ASCII variant", () => {
    expect(extractPatchnodeProductSummary(PLAN_BEFORE_AFTER_ONLY)).toBe("Before: body venait du résumé.");
    expect(extractPatchnodeProductSummary(PLAN_BEFORE_AFTER_ONLY.replace("->", "→"))).toBe("Before: body venait du résumé.");
  });

  it("never falls back to Mission", () => {
    expect(extractPatchnodeProductSummary(PLAN_MISSION_ONLY)).toBe("");
  });

  it("returns an empty string for an absent, null, or contentless plan", () => {
    expect(extractPatchnodeProductSummary(null)).toBe("");
    expect(extractPatchnodeProductSummary(undefined)).toBe("");
    expect(extractPatchnodeProductSummary("")).toBe("");
    expect(extractPatchnodeProductSummary("# Task: FN-1 - Titre\n")).toBe("");
  });

  it("treats an empty product section as absent", () => {
    expect(extractPatchnodeProductSummary("## What This Delivers\n\n## Mission\n\nTechnique.\n")).toBe("");
    // An empty first section still yields the legitimate legacy fallback.
    expect(extractPatchnodeProductSummary("## What This Delivers\n\n## Before → After Transformation\n\n- Ancien corps.\n")).toBe("Ancien corps.");
  });

  it("ignores a heading inside a code fence", () => {
    const plan = [
      "## Mission",
      "",
      "```markdown",
      "## What This Delivers",
      "",
      "- Exemple de gabarit, pas une section.",
      "```",
      "",
    ].join("\n");
    expect(extractPatchnodeProductSummary(plan)).toBe("");
  });

  it("keeps only the first occurrence of a duplicated heading", () => {
    const plan = "## What This Delivers\n\n- Première.\n\n## Mission\n\nX\n\n## What This Delivers\n\n- Seconde.\n";
    expect(extractPatchnodeProductSummary(plan)).toBe("Première.");
  });

  it("flattens a markdown bullet list into one plain line", () => {
    const plan = "## What This Delivers\n\n- **Gras** retiré\n- `code` retiré\n1. Numéroté retiré\n\n### Sous-titre\n";
    expect(extractPatchnodeProductSummary(plan)).toBe("Gras retiré code retiré Numéroté retiré Sous-titre");
  });

  it("truncates at exactly 400 characters with no ellipsis", () => {
    expect(PATCHNODE_PRODUCT_SUMMARY_LENGTH).toBe(400);
    const long = "z".repeat(PATCHNODE_PRODUCT_SUMMARY_LENGTH + 80);
    const extracted = extractPatchnodeProductSummary(`## What This Delivers\n\n${long}\n`);
    expect(extracted).toHaveLength(PATCHNODE_PRODUCT_SUMMARY_LENGTH);
    expect(extracted.endsWith("…")).toBe(false);
    expect(extracted.endsWith("...")).toBe(false);
  });
});
