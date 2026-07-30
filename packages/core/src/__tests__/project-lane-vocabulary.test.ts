/*
FNXC:WorkflowLifecycleColumns 2026-07-31-19:30:

THE INVARIANT: a QUERY resolves the PROJECT's lane vocabulary, not a task's.

WHY THIS IS A DIFFERENT SHAPE FROM EVERY OTHER RESOLVER HERE. `resolveTaskLifecycleColumns` answers
"what does THIS card's workflow call its review lane" — the right question for a guard, and an
impossible one for a read:

    await store.listTasks({ column: "in-review" })   // there is no task to resolve from yet

#2800 measured the consequence: `self-healing.ts` alone issues 49 such reads, and on a renamed board
every one returns an EMPTY array, so the sweep never executes. The census scores the comparison
INSIDE the loop, not the query above it — so converting those comparisons drops a count while the
loop body stays unreachable. In that file the census total is not a floor; it is misleading.

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
  resolveWorkflowColumnForRole,
} from "../project-lane-vocabulary.js";

const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
    { id: "waiting", name: "Waiting", traits: [{ trait: "human-review" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    { id: "vault", name: "Vault", traits: [{ trait: "archived" }] },
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
    expect(terminal.has("vault")).toBe(true);
    expect(terminal.has("signoff")).toBe(false);
  });

  it("degrades to the legacy ids when definitions cannot be read", async () => {
    // A throwing workflow read must not turn a degraded definition into a failed sweep.
    const throwing = { listWorkflowDefinitions: vi.fn(async () => { throw new Error("unreadable"); }) };

    expect([...(await resolveProjectColumnsForRoles(throwing, TERMINAL_ROLES))].sort()).toEqual(["archived", "done"]);
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
    expect(columns.has("vault")).toBe(true);
  });

  it("degrades when the store does not declare listWorkflowDefinitions at all", async () => {
    /*
    Several call sites hold a deliberately narrow store interface that omits the method even though
    the real TaskStore behind it has one (`EvalBatchTaskStore` was the first). Requiring it would
    force every such interface — and its fakes — to widen, to satisfy a helper whose contract is
    already "degrade to the legacy ids when the workflows cannot be read". Absent and throwing are
    the same case.
    */
    expect([...(await resolveProjectColumnsForRoles({} as never, TERMINAL_ROLES))].sort()).toEqual(["archived", "done"]);
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
FNXC:WorkflowLifecycleColumns 2026-07-30-22:20:

THE INVARIANT: a WRITE resolves ONE column from ONE workflow, and says so when it cannot.

This is the mirror of the suite above, and the contrast is the point. `resolveProjectColumnsForRoles`
answers a read and bakes the legacy ids in, because an extra id in a query set is inert.
`resolveWorkflowColumnForRole` answers a write, where the same trick is a silent wrong destination:
post-U12 an undeclared column is a `TransitionRejectionError` on move, and on create it is a phantom
lane — the row is written, the caller reports success, and the card is not on the board.

So it returns `undefined` and each caller keeps its own visible fallback rather than being handed a
plausible-looking legacy id it never asked for.
*/
describe("resolveWorkflowColumnForRole", () => {
  const definitionStore = (ir: unknown, defaultId = "wf-renamed") => ({
    getWorkflowDefinition: vi.fn(async () => (ir === undefined ? undefined : { ir: ir as never })),
    getDefaultWorkflowId: vi.fn(async () => defaultId),
  });

  it("returns the workflow's own column for the role", async () => {
    expect(await resolveWorkflowColumnForRole(definitionStore(RENAMED_IR) as never, "hold")).toBe("backlog");
    expect(await resolveWorkflowColumnForRole(definitionStore(RENAMED_IR) as never, "complete")).toBe("shipped");
  });

  it("honours an explicit workflow id over the project default", async () => {
    const store = definitionStore(OTHER_IR);

    expect(await resolveWorkflowColumnForRole(store as never, "complete", "wf-other")).toBe("released");
    expect(store.getWorkflowDefinition).toHaveBeenCalledWith("wf-other");
    // The default lookup must be skipped entirely — an explicit id is not a hint.
    expect(store.getDefaultWorkflowId).not.toHaveBeenCalled();
  });

  it("returns undefined — NOT a legacy id — when the workflow does not declare the role", async () => {
    // OTHER_IR has no hold column. Handing back "todo" here is precisely the phantom-lane write
    // this helper exists to avoid; the caller decides what its own degraded behaviour is.
    expect(await resolveWorkflowColumnForRole(definitionStore(OTHER_IR) as never, "hold")).toBeUndefined();
  });

  it("yields the BUILT-IN lane, not undefined, when the workflow cannot be read", async () => {
    /*
    This case documents a contract I got wrong twice before reading the resolver. `undefined` means
    "this workflow declares no such column" and NOTHING else: `resolveWorkflowIrById` never throws
    and never returns nothing — an unregistered builtin id, a missing definition row and a failing
    read all resolve to the default coding IR (branded by `markFellBack`). So an unreadable custom
    workflow lands on the built-in hold lane.

    Pinned rather than treated as an accident, because it is what makes the callers' own `?? "todo"`
    fallbacks unreachable in practice — and a future change that made this path return `undefined`
    would silently move every such create to the caller's literal instead.
    */
    const throwing = {
      getWorkflowDefinition: vi.fn(async () => { throw new Error("db down"); }),
      getDefaultWorkflowId: vi.fn(async () => "wf-custom"),
    };

    expect(await resolveWorkflowColumnForRole(throwing as never, "hold")).toBe("todo");
  });

  it("falls back to the built-in default workflow id when no default is persisted", async () => {
    /*
    A fresh project has no default row. Returning undefined here would send every create through its
    literal fallback on a board that does in fact declare lanes — the FN-7591 gap that dropped cards
    into the hard-coded `"triage"`.

    My first draft of this case handed the mock a RENAMED ir and expected `backlog`, and it failed:
    `resolveWorkflowIrById` resolves a `builtin:` id from the built-in registry and never consults
    `getWorkflowDefinition` at all. The premise was wrong, not the product — so what is asserted is
    the real contract: the BUILT-IN workflow's own hold lane, reached without a definition read.
    */
    const store = {
      getWorkflowDefinition: vi.fn(async () => undefined),
      getDefaultWorkflowId: vi.fn(async () => undefined),
    };

    expect(await resolveWorkflowColumnForRole(store as never, "hold")).toBe("todo");
    expect(store.getDefaultWorkflowId).toHaveBeenCalled();
  });
});
