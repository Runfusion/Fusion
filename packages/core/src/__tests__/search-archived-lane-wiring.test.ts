/*
FNXC:WorkflowResolvedColumns 2026-07-31-18:58 (found by BLINDING — the WIRING was unheld):

`liveSearchPredicate` HONOURS A RESOLVED SET. NOTHING PROVED `reads.ts` PASSES ONE.

`search-excludes-renamed-archive-lane.test.ts` (#3160, mine) asserts the predicate directly: give it
`Set(["archived","filed"])` and `filed` appears in the bound params. That is a real contract and it
is still correct — but it is a UNIT test of the predicate, so blinding the resolver in `reads.ts`
cannot affect it. I measured this with #3214's procedure and it is the sharpest false-green I have
hit in this program:

    reads.ts:396  archived (cold-storage list)  -> Set(["archived"])   1 failed   covered
    reads.ts:615  archived (incremental sync)   -> Set(["archived"])   0 failed   UNCOVERED
    reads.ts:793  archived (search)             -> Set(["archived"])   0 failed   UNCOVERED

Against `search-excludes-renamed-archive-lane.test.ts` all three read as uncovered, which is an
artefact of asking the wrong instrument — that file never runs `reads.ts` at all. Against
`cold-storage-renamed-archive-lane.test.ts`, which drives `listTasksImpl` for real, 396 is covered
and the other two are genuinely not. The lesson is rule 2 restated one level up: the test must reach
the site, and a unit test of the collaborator never does.

WHAT 793 COSTS ON A RENAMED BOARD. `searchTasks` backs the CREATE-time near-duplicate check. If the
resolved lanes stop being threaded, search stops excluding the board's archive lane, and creating a
task can be REFUSED as a duplicate of one the operator archived long ago — with no way to see why,
because the matching card is not on the board. That is the exact symptom #3160 set out to fix; this
pins the wiring that delivers it.

THE SEAM. `searchTasksTsvector` is spied and the assertion is on the `archivedColumns` it RECEIVES.
Asserting on returned rows would need a real database and would test Drizzle's rendering; asserting
on the predicate is what the sibling file already does. What was missing is the hand-off between
them, so that is what this asserts — and it is the only thing it asserts.

613/615's incremental-sync scan is deliberately NOT covered here: it composes Drizzle conditions and
runs them against `layer.db` with no injectable seam, so pinning it means a real database and belongs
with the `.pg` suites. Left flagged rather than papered over with a test that would assert the query
built rather than the rows excluded.
*/

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TaskStore } from "../store.js";

const { searchTsvectorMock, searchLikeMock } = vi.hoisted(() => ({
  searchTsvectorMock: vi.fn(async () => [] as unknown[]),
  searchLikeMock: vi.fn(async () => [] as unknown[]),
}));

/*
Both search paths are replaced. The tsvector path is primary and the LIKE path is its cold-index
fallback; leaving the fallback real would let a miss on the first fall through into a real query
against the fake `layer.db` and throw, which reads as an unrelated failure.
*/
vi.mock("../task-store/async-search.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  searchTasksTsvector: searchTsvectorMock,
  searchTasksLike: searchLikeMock,
}));

const { searchTasksImpl } = await import("../task-store/reads.js");

/** Archive lane is `filed`; the board declares no column called `archived`. */
const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "drafting", name: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    { id: "filed", name: "Filed", traits: [{ trait: "archived" }] },
  ],
};

/**
 * `getSettingsFast` and `getMergeQueuedTaskIdsAsync` are reached AFTER the search call this file is
 * about — the hydration pass that turns rows into tasks. They are stubbed because omitting them
 * throws past the assertion, not because the seam cares about them.
 */
function storeWith(definitions: unknown[]): TaskStore {
  return {
    listWorkflowDefinitions: vi.fn(async () => definitions),
    asyncLayer: { db: {}, projectId: "p1" },
    getAsyncLayer: () => ({ db: {}, projectId: "p1" }),
    listTasks: vi.fn(async () => []),
    archiveEntryToTask: vi.fn(() => ({})),
    getSettingsFast: vi.fn(async () => ({})),
    getMergeQueuedTaskIdsAsync: vi.fn(async () => new Set<string>()),
  } as unknown as TaskStore;
}

/** The `archivedColumns` handed to the primary search path on the most recent call. */
function archivedColumnsPassed(): ReadonlySet<string> | undefined {
  const calls = searchTsvectorMock.mock.calls as unknown[][];
  const call = calls.length > 0 ? calls[calls.length - 1] : undefined;
  return (call?.[2] as { archivedColumns?: ReadonlySet<string> } | undefined)?.archivedColumns;
}

describe("search threads the board's own archive lanes into the query", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("passes a RENAMED archive lane through to the search path", async () => {
    await searchTasksImpl(storeWith([{ ir: RENAMED_IR }]), "widget", { includeArchived: false });

    /* Blinding the resolver at reads.ts:793 leaves this as Set(["archived"]) and drops `filed`. */
    expect(archivedColumnsPassed()).toBeDefined();
    expect([...(archivedColumnsPassed() ?? [])]).toContain("filed");
  });

  /*
  CONTROL. The resolved set is legacy-seeded, so the built-in id must still be threaded — a wiring
  that resolved the renamed lane and dropped the legacy one would break every default board while
  passing the case above.
  */
  it("still threads the legacy `archived` id alongside it", async () => {
    await searchTasksImpl(storeWith([{ ir: RENAMED_IR }]), "widget", { includeArchived: false });

    expect([...(archivedColumnsPassed() ?? [])]).toContain("archived");
  });

  /*
  DEGRADED BOARD, and I asserted the wrong mechanism first — worth recording, because the correction
  is the more useful fact.

  I expected an unreadable workflow list to leave `archivedColumns` undefined via the
  `.catch(() => undefined)` at the call site, so `liveSearchPredicate` would fall back to its
  literal. It does not: `resolveProjectColumnsForRoles` catches internally and returns its
  LEGACY-SEEDED set, so the value threaded through is `Set(["archived"])` and the `.catch` never
  fires on this path. Two layers both fail soft, and the inner one wins.

  What matters is the guarantee, which holds either way and is what this now asserts: a board whose
  workflows cannot be read still excludes the legacy archive id. The failure to guard against is an
  EMPTY set — that would exclude nothing and quietly return archived rows in every search, including
  the CREATE-time duplicate check.
  */
  it("still excludes the legacy id when the workflow list cannot be read", async () => {
    const store = storeWith([]);
    (store as unknown as { listWorkflowDefinitions: unknown }).listWorkflowDefinitions =
      vi.fn(async () => { throw new Error("unreadable"); });

    await searchTasksImpl(store, "widget", { includeArchived: false });

    const passed = archivedColumnsPassed();
    /* Never an empty set: excluding nothing is worse than excluding only the legacy id. */
    expect(passed === undefined || passed.size > 0).toBe(true);
    if (passed) expect([...passed]).toContain("archived");
  });

  /*
  ANTI-VACUITY. Every case above reads a mock's arguments, so all three would pass trivially if the
  search were never reached — an early return on a blank query, a zero limit, a changed entry point.
  This pins that the primary search path actually ran.
  */
  it("actually reaches the search path", async () => {
    await searchTasksImpl(storeWith([{ ir: RENAMED_IR }]), "widget", { includeArchived: false });

    expect(searchTsvectorMock).toHaveBeenCalledTimes(1);
  });
});
