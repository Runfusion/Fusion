/*
FNXC:WorkflowLifecycleColumns 2026-07-31-19:30:

THE INVARIANT: a QUERY resolves the PROJECT's lane vocabulary, not a task's.

WHY THIS IS A DIFFERENT SHAPE FROM EVERY OTHER RESOLVER HERE. `resolveTaskLifecycleColumns` answers
"what does THIS card's workflow call its review lane" — the right question for a guard, and an
impossible one for a read:

    await store.listTasks({ column: "in-review" })   // there is no task to resolve from yet

#2800 measured the consequence: `self-healing.ts` alone issued 49 such reads, and on a renamed board
every one returns an EMPTY array, so the sweep never executes. The census scores the comparison
INSIDE the loop, not the query above it — so converting those comparisons drops a count while the
loop body stays unreachable. In that file the census total is not a floor; it is misleading.

The 49 is dated, not fixed: 37 as of this writing, and falling as the fleet converts them. Regenerate
with `node scripts/lifecycle-column-census.mjs --json` (`queryByFile`, `queryRoles`) rather than
trusting the figure — an un-reproducible count is how a comment starts lying about another file.

WHAT THIS MODULE IS FOR. It gives the query class one shared answer instead of each site inventing
its own. I wrote this logic once inline for the legacy auto-merge stamp backfill; a second copy is
how two readers of the same fact begin to disagree.

THE ASYMMETRY IS THE DESIGN. The legacy ids are always unioned in, never replaced: a board mid-rename
still has rows under the old id, and a query that skips them silently does nothing — the exact
failure being fixed. Over-inclusion costs one extra query whose rows the caller's own predicate then
filters; under-inclusion is invisible. The set is therefore never empty, so a caller cannot
accidentally query nothing.
*/
import { describe, expect, it, vi } from "vitest";
import {
  LEGACY_COLUMN_IDS_BY_ROLE,
  REVIEW_ROLES,
  TERMINAL_ROLES,
  resolveProjectColumnsForRoles,
} from "../project-lane-vocabulary.js";

const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
    { id: "waiting", name: "Waiting", traits: [{ trait: "human-review" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
};

/** A SECOND workflow, so the union across definitions is exercised rather than assumed. */
const OTHER_IR = {
  version: "v2", id: "wf-other", name: "other", nodes: [], edges: [],
  columns: [
    { id: "checking", name: "Checking", traits: [{ trait: "merge" }] },
    { id: "released", name: "Released", traits: [{ trait: "complete" }] },
  ],
};

const store = (definitions: unknown[]) => ({
  listWorkflowDefinitions: vi.fn(async () => definitions as Array<{ ir?: unknown }>),
});

describe("resolveProjectColumnsForRoles", () => {
  it("returns every review lane the project's workflows declare", async () => {
    const columns = await resolveProjectColumnsForRoles(store([{ ir: RENAMED_IR }, { ir: OTHER_IR }]), REVIEW_ROLES);

    expect(columns.has("signoff")).toBe(true);
    expect(columns.has("waiting")).toBe(true);
    expect(columns.has("checking")).toBe(true);
  });

  it("ALWAYS unions the legacy id, for a board mid-rename", async () => {
    // Rows stored under the old id must not be skipped while a rename is in flight — a query that
    // skips them silently does nothing, which is the failure this module exists to fix.
    const columns = await resolveProjectColumnsForRoles(store([{ ir: RENAMED_IR }]), REVIEW_ROLES);

    expect(columns.has("in-review")).toBe(true);
  });

  it("is never empty, so a caller cannot accidentally query nothing", async () => {
    const columns = await resolveProjectColumnsForRoles(store([]), REVIEW_ROLES);

    expect([...columns]).toEqual(["in-review"]);
  });

  it("keeps roles separate — terminal does not leak review lanes", async () => {
    const terminal = await resolveProjectColumnsForRoles(store([{ ir: RENAMED_IR }]), TERMINAL_ROLES);

    expect(terminal.has("shipped")).toBe(true);
    expect(terminal.has("archived")).toBe(false);
    expect(terminal.has("signoff")).toBe(false);
  });

  it("degrades to the legacy ids when definitions cannot be read", async () => {
    // A throwing workflow read must not turn a degraded definition into a failed sweep.
    const throwing = { listWorkflowDefinitions: vi.fn(async () => { throw new Error("unreadable"); }) };

    expect([...(await resolveProjectColumnsForRoles(throwing, TERMINAL_ROLES))]).toEqual(["done"]);
  });

  it("parses a string-serialised IR, the shape some backends actually return", async () => {
    /*
    `parseWorkflowIr` VALIDATES — it throws unless the graph has exactly one start and one end — so
    the string form needs a well-formed graph, unlike the object form which is passed through. The
    fixture carries the nodes for that reason, not decoration.
    */
    const serialisable = {
      ...RENAMED_IR,
      nodes: [{ id: "s", kind: "start" }, { id: "e", kind: "end" }],
      edges: [{ from: "s", to: "e" }],
    };

    const columns = await resolveProjectColumnsForRoles(store([{ ir: JSON.stringify(serialisable) }]), TERMINAL_ROLES);

    expect(columns.has("shipped")).toBe(true);
  });

  it("one malformed definition does not erase the vocabulary of the others", async () => {
    /*
    The bug my first draft had, found by the string-IR case above. `parseWorkflowIr` throws on an
    invalid graph, and a single `try` around the whole loop meant one half-migrated row handed back
    legacy-only lanes for EVERY workflow — a failure indistinguishable from the renamed-board bug
    this helper exists to fix.
    */
    const columns = await resolveProjectColumnsForRoles(
      store([{ ir: "{not json" }, { ir: RENAMED_IR }]),
      TERMINAL_ROLES,
    );

    expect(columns.has("shipped")).toBe(true);
    expect(columns.has("archived")).toBe(false);
  });

  it("degrades when the store does not declare listWorkflowDefinitions at all", async () => {
    /*
    Several call sites hold a deliberately narrow store interface that omits the method even though
    the real TaskStore behind it has one (`EvalBatchTaskStore` was the first). Requiring it would
    force every such interface — and its fakes — to widen, to satisfy a helper whose contract is
    already "degrade to the legacy ids when the workflows cannot be read". Absent and throwing are
    the same case.
    */
    expect([...(await resolveProjectColumnsForRoles({} as never, TERMINAL_ROLES))]).toEqual(["done"]);
  });

  it("declares a legacy id for every role it can be asked about", () => {
    // A role with no legacy entry would produce a set missing the pre-rename column — the exact
    // silent skip this module exists to prevent.
    for (const role of [...REVIEW_ROLES, ...TERMINAL_ROLES]) {
      expect(LEGACY_COLUMN_IDS_BY_ROLE[role]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-20:45:

THE UNTRAITED-PROJECT OPT-IN — the three-state rule at PROJECT scope.

A board that renames its lanes but declares NO lifecycle trait contributes nothing to the union, so its
cards are invisible to every role-keyed query — not misclassified downstream, absent from the result
entirely, which is why a correct per-card fallback cannot rescue them (#2869, #2876).

THE THREE CASES ARE THE WHOLE POINT, and the middle one is what keeps this from being a blunt widening:
  - project expresses NO trait anywhere -> it has no vocabulary, so its declared ids are the honest
    candidate set;
  - project expresses traits but this ROLE is absent -> it has ANSWERED, and inventing lanes would
    contradict it;
  - opt-in absent -> byte-identical to before, which is what makes this safe to land with no caller
    changes at all.
*/
describe("resolveProjectColumnsForRoles: untratedProject opt-in", () => {
  const storeWith = (...irs: unknown[]) => ({
    listWorkflowDefinitions: async () => irs.map((ir) => ({ ir })),
  } as never);

  const untraited = {
    version: "v2", name: "untraited",
    columns: [{ id: "drafting", name: "D", traits: [] }, { id: "checking", name: "C", traits: [] }],
    nodes: [], edges: [],
  };
  const traited = {
    version: "v2", name: "traited",
    columns: [{ id: "building", name: "B", traits: [{ trait: "wip" }] }],
    nodes: [], edges: [],
  };

  it("widens to every declared column when the project expresses no lifecycle trait at all", async () => {
    const lanes = await resolveProjectColumnsForRoles(storeWith(untraited), ["mergeOrchestration"], {
      untraitedProject: "declared-columns",
    });

    /* `checking` is the renamed review lane; without the opt-in it is absent and its cards are unseen. */
    expect(lanes.has("checking")).toBe(true);
    expect(lanes.has("drafting")).toBe(true);
    /* The legacy floor stays, so a board mid-rename is not dropped. */
    expect(lanes.has("in-review")).toBe(true);
  });

  it("does NOT widen when some workflow expresses a trait, even if none declares this role", async () => {
    /*
    The case that keeps this honest. The project HAS a vocabulary — one board declares `wip` — so a
    board with no review lane has answered "no review lane", and admitting its columns would contradict
    a statement the project actually made.
    */
    const lanes = await resolveProjectColumnsForRoles(storeWith(untraited, traited), ["mergeOrchestration"], {
      untraitedProject: "declared-columns",
    });

    expect(lanes.has("checking")).toBe(false);
    expect(lanes.has("drafting")).toBe(false);
    expect(lanes.has("in-review")).toBe(true);
  });

  it("is byte-identical to today's answer without the option", async () => {
    /* No caller changes behaviour until it asks — the property that makes this landable on its own. */
    const withOpt = await resolveProjectColumnsForRoles(storeWith(untraited), ["mergeOrchestration"]);

    expect([...withOpt].sort()).toEqual(["in-review"]);
  });
});
