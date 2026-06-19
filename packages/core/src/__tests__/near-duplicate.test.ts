import { describe, expect, it } from "vitest";

import { extractIntentSignature, findNearDuplicates, isActiveNearDuplicateColumn, isNearDuplicateCanonicalInactive } from "../near-duplicate.js";

const fn5144Title = "Create PR dialog missing /pr/options /pr/preflight /pr/generate-metadata routes";
const fn5144Description =
  "The Create PR dialog calls POST /api/tasks/:id/pr/generate-metadata, GET /api/tasks/:id/pr/preflight, and GET /api/tasks/:id/pr/options but handlers are missing in packages/dashboard/src/routes/register-git-github.ts.";

const fn5149Title = "Create PR modal routes: add /pr/options, /pr/preflight, /pr/generate-metadata endpoints";
const fn5149Description =
  "PrCreateModal currently 404s for GET /api/tasks/:id/pr/options, GET /api/tasks/:id/pr/preflight, and POST /api/tasks/:id/pr/generate-metadata. Wire routes in `register-git-github.ts` and reuse `PrPreflightResponse` contracts.";

const fn5145Title = "Review tab Create PR button no-op when PrCreateModal mount is gated";
const fn5145Description =
  "TaskReviewTab create button toggles state but PrCreateModal mount is hidden by tab switch. Move `PrCreateModal` in `TaskDetailModal.tsx` and keep `task-review-create-pr` wiring.";

const fn5150Title = "TaskReviewTab Create PR button no-op; lift PrCreateModal mount";
const fn5150Description =
  "Lift `PrCreateModal` to tab-agnostic mount in `TaskDetailModal.tsx`; `task-review-create-pr` in TaskReviewTab currently no-op.";

describe("extractIntentSignature", () => {
  it("extracts PR route paths from FN-5144 content", () => {
    const sig = extractIntentSignature({
      title: fn5144Title,
      description: fn5144Description,
    });

    expect(sig.routePaths).toEqual(
      expect.arrayContaining([
        "/pr/options",
        "/pr/preflight",
        "/pr/generate-metadata",
      ]),
    );
  });

  it("extracts identifier and file tokens from FN-5149 content", () => {
    const sig = extractIntentSignature({
      title: fn5149Title,
      description: `${fn5149Description} \`PrCreateModal\` \`PrPreflightResponse\` packages/dashboard/src/routes/register-git-github.ts`,
    });

    expect(sig.identifiers).toEqual(
      expect.arrayContaining([
        "prcreatemodal",
        "prpreflightresponse",
        "register-git-github.ts",
      ]),
    );
  });
});

describe("near-duplicate canonical activity predicates", () => {
  it("treats non-terminal live columns as active", () => {
    expect(isActiveNearDuplicateColumn("triage")).toBe(true);
    expect(isActiveNearDuplicateColumn("todo")).toBe(true);
    expect(isActiveNearDuplicateColumn("in-progress")).toBe(true);
    expect(isActiveNearDuplicateColumn("in-review")).toBe(true);
  });

  it("treats archived, done, soft-deleted, and missing canonicals as inactive", () => {
    expect(isNearDuplicateCanonicalInactive(undefined)).toBe(true);
    expect(isNearDuplicateCanonicalInactive({ column: "archived" })).toBe(true);
    expect(isNearDuplicateCanonicalInactive({ column: "done" })).toBe(true);
    expect(isNearDuplicateCanonicalInactive({ column: "todo", deletedAt: "2026-06-14T00:00:00.000Z" })).toBe(true);
    expect(isNearDuplicateCanonicalInactive({ column: "todo", deletedAt: null })).toBe(false);
  });
});

describe("findNearDuplicates", () => {
  it("flags FN-5144 and FN-5149 pair via shared PR route tokens", () => {
    const matches = findNearDuplicates(
      { title: fn5144Title, description: fn5144Description },
      [
        {
          id: "FN-5149",
          title: fn5149Title,
          description: fn5149Description,
          column: "todo",
          createdAt: Date.now(),
        },
      ],
      { nowMs: Date.now() },
    );

    expect(matches[0]?.id).toBe("FN-5149");
    expect(matches[0]?.sharedTokens).toEqual(
      expect.arrayContaining(["/pr/options", "/pr/preflight", "/pr/generate-metadata"]),
    );
  });

  it("flags FN-5145 and FN-5150 pair", () => {
    const matches = findNearDuplicates(
      { title: fn5145Title, description: fn5145Description },
      [
        {
          id: "FN-5150",
          title: fn5150Title,
          description: fn5150Description,
          column: "todo",
          createdAt: Date.now(),
        },
      ],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe("FN-5150");
  });

  it("does not match on generic-large-file overlap only", () => {
    const matches = findNearDuplicates(
      {
        title: "Add PR merge auto-rebase",
        description: "Touch packages/dashboard/src/routes/register-git-github.ts only",
      },
      [
        {
          id: "FN-X",
          title: "Fix PR comments pagination",
          description: "Also touches packages/dashboard/src/routes/register-git-github.ts",
          column: "todo",
          createdAt: Date.now(),
        },
      ],
    );
    expect(matches).toEqual([]);
  });

  it("does not match different domains", () => {
    const matches = findNearDuplicates(
      { title: "Fix dashboard board scrolling", description: "Board snap bug" },
      [
        {
          id: "FN-Y",
          title: "Fix PR create dialog",
          description: "pr modal bug",
          column: "todo",
          createdAt: Date.now(),
        },
      ],
    );
    expect(matches).toEqual([]);
  });

  it("respects 7-day window", () => {
    const now = Date.now();
    const matches = findNearDuplicates(
      { title: fn5144Title, description: fn5144Description },
      [
        {
          id: "FN-OLD",
          title: fn5149Title,
          description: fn5149Description,
          column: "todo",
          createdAt: now - 8 * 24 * 60 * 60 * 1000,
        },
      ],
      { nowMs: now },
    );
    expect(matches).toEqual([]);
  });

  it("does not match title-only overlap with no shared high-signal tokens", () => {
    const matches = findNearDuplicates(
      { title: "Fix review task create bug", description: "plain words only" },
      [
        {
          id: "FN-Z",
          title: "Fix review task create issue",
          description: "still plain words no routes or files",
          column: "todo",
          createdAt: Date.now(),
        },
      ],
    );
    expect(matches).toEqual([]);
  });

  it("returns [] for empty signal input", () => {
    const matches = findNearDuplicates(
      { title: "", description: "just english sentence no path tokens" },
      [],
    );
    expect(matches).toEqual([]);
  });
});
