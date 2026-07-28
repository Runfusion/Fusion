/*
FNXC:PostgresCutover 2026-07-12:
The three replicated-create tests (buildMeshReplicatedTaskCreatePayload,
toReplicatedCreateInput, taskMatchesReplicatedCreate) were deleted because
mesh task replication moved to the PostgreSQL level (nodes share the
database) and those functions were removed from mesh-task-replication.ts.
Only buildBootstrapPrompt survives (task/comment PROMPT.md stub builder).
*/
import { describe, expect, it } from "vitest";
import {
  buildBootstrapPrompt,
  buildRefinementSeedPrompt,
  isTaskAwaitingPlanning,
  isUnplannedSeedPrompt,
} from "../mesh-task-replication.js";
import { applyOriginalDescription } from "../original-description-policy.js";

describe("mesh-task-replication", () => {
  it("buildBootstrapPrompt matches task bootstrap format", () => {
    expect(buildBootstrapPrompt("FN-1", undefined, "desc")).toBe("# FN-1\n\ndesc\n");
    expect(buildBootstrapPrompt("FN-1", "Title", "desc")).toBe("# FN-1: Title\n\ndesc\n");
  });

  /*
  FNXC:OriginalDescriptionInPrompt 2026-07-14-23:35:
  Planned-spec Original Description injection must not change bootstrap equality
  used by isUnplannedSeedPrompt / hold-release unplanned detection.
  */
  it("keeps bootstrap seed equality after original-description policy exists", () => {
    const bootstrap = buildBootstrapPrompt("FN-1", "Title", "desc");
    expect(isUnplannedSeedPrompt(bootstrap, "FN-1", "Title", "desc")).toBe(true);
    // Applying original description to a *real* spec does not affect bootstrap detection.
    const planned = applyOriginalDescription(
      "# FN-1: Title\n\n**Created:** 2026-07-14\n\n## Mission\n\nPlanned work.\n",
      "desc",
    );
    expect(isUnplannedSeedPrompt(planned, "FN-1", "Title", "desc")).toBe(false);
    expect(planned).toContain("## Original Description");
  });

  /*
  FNXC:WorkflowScheduling 2026-07-25-11:20:
  Regression for the "started card never plans" symptom. Seed detection was raw byte-equality, so
  any benign whitespace/line-ending drift in PROMPT.md reclassified an unplanned card as "already
  planned" and triage's todo-discovery silently skipped it forever.

  Surface enumeration (invariant: a seed is recognized as unplanned regardless of line-ending or
  trailing-whitespace drift, for BOTH seed shapes, while a real spec is never mistaken for one):
   - Both seed builders (bootstrap stub and refinement seed).
   - Both drift sources (CRLF round-trip, added/stripped trailing newline, trailing spaces).
   - Both titled and untitled bootstrap shapes.
   - Negative: a real spec, and a seed whose heading/body text genuinely differs, stay "planned".
  */
  describe("isUnplannedSeedPrompt tolerates benign PROMPT.md drift", () => {
    const drift = (s: string) => [
      s.replace(/\n/g, "\r\n"),      // CRLF checkout / Windows editor
      s.trimEnd(),                    // editor stripped the trailing newline
      `${s}\n\n`,                     // editor added trailing newlines
      s.replace(/\n/g, "  \n"),      // trailing spaces on each line
    ];

    it("recognizes a drifted bootstrap stub (titled and untitled)", () => {
      for (const title of ["Title", undefined]) {
        const seed = buildBootstrapPrompt("FN-1", title, "desc");
        expect(isUnplannedSeedPrompt(seed, "FN-1", title, "desc")).toBe(true);
        for (const variant of drift(seed)) {
          expect(isUnplannedSeedPrompt(variant, "FN-1", title, "desc")).toBe(true);
        }
      }
    });

    it("recognizes a drifted refinement seed", () => {
      const seed = buildRefinementSeedPrompt("Title", "desc");
      expect(isUnplannedSeedPrompt(seed, "FN-1", "Title", "desc")).toBe(true);
      for (const variant of drift(seed)) {
        expect(isUnplannedSeedPrompt(variant, "FN-1", "Title", "desc")).toBe(true);
      }
    });

    it("still rejects a real spec and genuinely different text", () => {
      expect(
        isUnplannedSeedPrompt("# FN-1: Title\n\n## Mission\n\nReal spec.\n", "FN-1", "Title", "desc"),
      ).toBe(false);
      // Body text differs by more than whitespace — not this task's seed.
      expect(isUnplannedSeedPrompt("# FN-1: Title\n\nother\n", "FN-1", "Title", "desc")).toBe(false);
      // Heading belongs to a different task.
      expect(
        isUnplannedSeedPrompt(buildBootstrapPrompt("FN-2", "Title", "desc"), "FN-1", "Title", "desc"),
      ).toBe(false);
    });
  });
});

/*
FNXC:CodingIdeasWorkflow 2026-07-26-15:30:
`isTaskAwaitingPlanning` is the single answer to "is this plan-in-place card waiting for a PLANNING
slot?", shared by triage's todo-discovery and the `GET /api/tasks` board enrichment that drives the
"Queued to plan" / "Ready" badge pair. Before it, the board inferred the answer from `steps.length`
and disagreed with the engine in both directions.

The three clauses are exactly triage's three todo-discovery branches, so each is pinned here:
status park, missing spec, and seed-vs-real content. The step count is deliberately NOT an input —
that is the whole point — so the content cases assert both step shapes.
*/
describe("isTaskAwaitingPlanning", () => {
  const task = (overrides: Partial<{ id: string; title?: string; description: string; status?: string | null }> = {}) => ({
    id: "FN-1",
    title: "Title",
    description: "desc",
    ...overrides,
  });

  it("is true for a parked replan regardless of a real spec on disk", () => {
    expect(isTaskAwaitingPlanning(task({ status: "needs-replan" }), "# FN-1: Title\n\n## Mission\n\nReal spec.\n")).toBe(true);
  });

  it("is true when PROMPT.md is missing", () => {
    expect(isTaskAwaitingPlanning(task(), null)).toBe(true);
  });

  it("is true for either seed shape and false for a real spec", () => {
    expect(isTaskAwaitingPlanning(task(), buildBootstrapPrompt("FN-1", "Title", "desc"))).toBe(true);
    expect(isTaskAwaitingPlanning(task(), buildRefinementSeedPrompt("Title", "desc"))).toBe(true);
    expect(isTaskAwaitingPlanning(task(), "# FN-1: Title\n\n## Steps\n\n1. Do it\n")).toBe(false);
  });

  it("ignores statuses that are not planning parks", () => {
    for (const status of [undefined, null, "planning", "executing", "failed"]) {
      expect(
        isTaskAwaitingPlanning(task({ status }), "# FN-1: Title\n\n## Steps\n\n1. Do it\n"),
        String(status),
      ).toBe(false);
    }
  });
});
