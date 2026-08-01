/*
FNXC:WorkflowResolvedColumns 2026-07-31-20:30:

THE INVARIANT: cold storage is consulted for the BOARD'S OWN archive lane.

COVERAGE FOR A LANDED, UNTESTED CONVERSION. #3057 converted this decision — `columnFilterIsArchive`
replaced `columnFilter === "archived"` — and shipped no test. I had converted it independently and
arrived after; rather than duplicate the change, this keeps the part main does not have.

Why it is worth a test rather than a shrug. Archived rows do not live in `tasks`: `archiveTask`
copies them into the archive store and removes them, so `listTasksImpl` decides whether to read that
second store. Against the literal, a caller naming a RENAMED archive lane —
`listTasks({ column: "filed", includeArchived: true })`, which is exactly what an archive view does —
skipped cold storage and got an empty page.

Note the shape: the UNFILTERED read (`!columnFilter`) was always correct, so this fails only for the
caller that names the lane. It survives any board-level smoke test, and the symptom presents as "the
archive is empty" rather than as a bug — which is precisely the class that regresses quietly once the
conversion that fixed it has no test holding it.

Driven through `listTasksImpl`, so the assertion is about the DECISION to consult cold storage.
Whether the archive store returns the right rows is its own contract with its own tests; conflating
them would make this pass for the wrong reason.
*/

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TaskStore } from "../store.js";

/*
The cold-storage read is a module function, not a store method, so the spy goes on the module. Only
the two list entry points are replaced; everything else keeps its real export, because a bare factory
would silently drop the other archive readers `reads.ts` imports from here.
*/
const { listArchivedTasksMock, listArchivedByCreatedOrderMock } = vi.hoisted(() => ({
  listArchivedTasksMock: vi.fn(async () => []),
  listArchivedByCreatedOrderMock: vi.fn(async () => []),
}));
vi.mock("../async-archive-db.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listArchivedTasks: listArchivedTasksMock,
  listArchivedTasksByCreatedOrder: listArchivedByCreatedOrderMock,
}));

/*
The LIVE read has to succeed for control flow to reach the cold-storage decision at all. My first
version left it real against a fake `layer.db`, it threw, the `.catch` swallowed it, and ALL THREE
cases "passed the negative" — including the legacy control, which is what exposed it. A test whose
subject is never reached looks identical to a test whose subject answered no.
*/
vi.mock("../task-store/async-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readLiveTaskRows: vi.fn(async () => []),
}));

const { listTasksImpl } = await import("../task-store/reads.js");

/** Either entry point counts — which one runs depends on pagination, not on the lane decision. */
function coldStorageConsulted(): boolean {
  return listArchivedTasksMock.mock.calls.length > 0 || listArchivedByCreatedOrderMock.mock.calls.length > 0;
}

/** Hold `drafting`, complete `shipped`, archive `filed` — no legacy id anywhere. */
const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "drafting", name: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    { id: "filed", name: "Filed", traits: [{ trait: "archived" }] },
  ],
};

/**
 * The seam under test is "was cold storage consulted", so the archive reader is a spy over a fixed
 * row set. `liveRows` stands in for the `tasks` table, which by construction holds no archived rows.
 */
function storeWith(definitions: unknown[]) {
  return {
    listWorkflowDefinitions: vi.fn(async () => definitions),
    isWatching: true,
    startupSlimListMemo: new Map(),
    asyncLayer: { db: {}, projectId: "p1" },
    getAsyncLayer: () => ({ db: {}, projectId: "p1" }),
    getSettingsFast: vi.fn(async () => ({})),
    getMergeQueuedTaskIdsAsync: vi.fn(async () => new Set<string>()),
    archiveEntryToTask: vi.fn(() => ({})),
  } as unknown as TaskStore;
}

describe("cold storage is consulted for the board's own archive lane", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("consults cold storage for a RENAMED archive lane", async () => {
    const impl = storeWith([{ ir: RENAMED_IR }]);

    await listTasksImpl(impl, { column: "filed" as never, includeArchived: true, slim: true })
      .catch(() => undefined);

    /* Keyed on the `archived` literal this was never called and the archive view rendered empty. */
    expect(coldStorageConsulted()).toBe(true);
  });

  /*
  CONTROL. The legacy id must keep opting in — `resolveProjectColumnsForRoles` seeds it, so an
  unconverted board behaves exactly as before. Without this case a conversion that resolved the
  renamed lane and DROPPED the legacy one would pass the case above while breaking every default
  board, which is the seeding hazard in its other direction.
  */
  it("still consults cold storage for the legacy `archived` id", async () => {
    const impl = storeWith([{ ir: RENAMED_IR }]);

    await listTasksImpl(impl, { column: "archived" as never, includeArchived: true, slim: true })
      .catch(() => undefined);

    expect(coldStorageConsulted()).toBe(true);
  });

  /*
  The paired negative. The conversion widens an inclusion, so it must not make EVERY filtered read
  pay a cold-storage query — a board read for the wip lane has no archived rows to find, and turning
  that into a second store round-trip on every board poll is a real cost.
  */
  it("does NOT consult cold storage for a lane that is not the archive lane", async () => {
    const impl = storeWith([{ ir: RENAMED_IR }]);

    await listTasksImpl(impl, { column: "drafting" as never, includeArchived: true, slim: true })
      .catch(() => undefined);

    expect(coldStorageConsulted()).toBe(false);
  });
});
