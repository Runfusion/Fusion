/*
FNXC:WorkflowLifecycleColumns 2026-07-31-08:50:

THE INVARIANT: the GitHub-tracking toggle stays editable until the card's OWN workflow calls it
finished.

CENSUS-INVISIBLE, and in a file that was already half converted: `GITHUB_TRACKING_EDITABLE_COLUMNS`
is a `Set` literal — a definition, not a comparison — sitting twenty lines below
`isTaskFieldEditableColumn`, which had ALREADY been moved onto the shared role helper. One converted
predicate and one unconverted one, in the same file, answering adjacent questions about the same card.

On a renamed board the set matched nothing, so the toggle was disabled on EVERY card, with nothing on
screen to explain why. That is the identical failure the note above `isTaskFieldEditableColumn`
records for inline editing — the same bug, one function over, found only by grepping for lane-shaped
list literals.

BEHAVIOURAL, NOT STRUCTURAL, DELIBERATELY. I have leaned on source ratchets three times in this
sweep where the seam was unreachable; this predicate is small and pure, so it is exported and driven
directly. A ratchet here would have been laziness rather than necessity.

REVERT PROOF, measured: restore `GITHUB_TRACKING_EDITABLE_COLUMNS.has(column) || workflowId === …`
and the two renamed-lane cases fail.
*/
import { describe, expect, it } from "vitest";
import { canTaskEditGithubTracking } from "../TaskDetailModal";
import type { ColumnId } from "@fusion/core";

const CODING_IDEAS = "builtin:coding-ideas";

describe("canTaskEditGithubTracking resolves the card's own lanes", () => {
  it("allows editing in a RENAMED wip lane", () => {
    // Pre-fix: `building` was in no literal set, so the toggle was disabled mid-implementation.
    expect(canTaskEditGithubTracking("building" as ColumnId, "wf-renamed", { countsTowardWip: true })).toBe(true);
  });

  it("allows editing in a RENAMED review lane", () => {
    expect(canTaskEditGithubTracking("signoff" as ColumnId, "wf-renamed", { mergeBlocker: true })).toBe(true);
  });

  it("blocks editing once the card reaches a RENAMED complete lane", () => {
    // The gate must still gate — a finished card should not be re-pointed at a different issue.
    expect(canTaskEditGithubTracking("shipped" as ColumnId, "wf-renamed", { complete: true })).toBe(false);
  });

  it("blocks editing in a RENAMED archived lane", () => {
    expect(canTaskEditGithubTracking("vault" as ColumnId, "wf-renamed", { archived: true })).toBe(false);
  });

  it("keeps the literal set when flags have not resolved yet", () => {
    // Flags are absent both before the board-workflows payload lands and for a column the workflow
    // does not declare — unknown, not known-false — so the legacy answer applies.
    expect(canTaskEditGithubTracking("todo" as ColumnId, "wf-renamed", undefined)).toBe(true);
    expect(canTaskEditGithubTracking("done" as ColumnId, "wf-renamed", undefined)).toBe(false);
  });

  it("still short-circuits for the Coding (Ideas) workflow regardless of lane", () => {
    // That escape hatch predates this change and must survive it.
    expect(canTaskEditGithubTracking("shipped" as ColumnId, CODING_IDEAS, { complete: true })).toBe(true);
  });
});
