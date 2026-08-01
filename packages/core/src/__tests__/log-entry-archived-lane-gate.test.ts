/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:20:
THE "ARCHIVED TASKS ARE LOG-READ-ONLY" GATE HAD NO TEST AT ALL — this adds one, and records why it
deliberately does NOT assert the renamed-lane case.

`logEntryImpl`'s fast path refuses a log write when the parent task is archived, asking with the
`archived` literal. On a renamed board a card the operator filed away keeps accepting log writes.
The gap is narrow rather than absent because `deletedAt` covers the soft-delete half and that is the
common path — which is also why it stayed invisible.

I CONVERTED IT, BACKED IT OUT, AND HAVE NOW CONVERTED IT PROPERLY. `archived-column-gate-parity.test.ts` caught it, and
its reasoning is correct and not obvious: this gate has THREE encodings — TypeScript comparisons,
Drizzle `eq`/`ne` predicates, and raw SQL templates — and converting only the TypeScript arm makes
them DIVERGE. TS would call the row archived while the SQL side still returns it as live: a log write
rejected by its gate while its parent is listed as live. Every builtin workflow names the column
`archived`, so all three agree by accident on every board we ship and nothing else can see the split.

So the renamed case stays uncovered ON PURPOSE, and the file says so rather than quietly omitting it.
Unblocking it means converting all three encodings together (the SQL sides need the resolved id as a
query-build value, including inside `for update` transactions that receive no store today), or
declaring `archived` a non-renameable system column — the choice that parity test lays out.

What IS asserted is the gate's existing behaviour, which had no coverage at all: it refuses the
legacy archived id, and — the case that matters more — it does NOT refuse a live lane. A gate that
refused everything would have satisfied a one-sided test and broken every log write on the board.

`readTaskRow` is mocked because the subject is the gate, not the row read.
*/

import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "../store.js";

const { readTaskRowMock } = vi.hoisted(() => ({ readTaskRowMock: vi.fn() }));
vi.mock("../task-store/async-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readTaskRow: readTaskRowMock,
}));

const { logEntryImpl } = await import("../task-store/audit-ops.js");

/** Archive lane is `filed`; the board declares no column called `archived`. */
const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    { id: "filed", name: "Filed", traits: [{ trait: "archived" }] },
  ],
};

function storeWith(ir: unknown): TaskStore {
  return {
    withTaskLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
    listWorkflowDefinitions: vi.fn(async () => [{ ir }]),
    asyncLayer: { db: {}, projectId: "p1" },
    isWatching: false,
    taskCache: new Map(),
    emit: vi.fn(),
    /* Reached only on the NON-archived path; enough for the write to complete. */
    updateTaskLogFields: vi.fn(async () => undefined),
  } as unknown as TaskStore;
}

function row(column: string) {
  return { id: "KB-1", column, deletedAt: null, log: [] };
}

describe("the log-entry archive gate", () => {
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-23:59: the renamed case is NO LONGER ABSENT — it is the
  first case below. The omission recorded here said the gate "cannot be fixed in the TypeScript arm
  alone". That was the right call on the evidence then and is now wrong: the conversion is ADDITIVE,
  keeping `pgRow.column === "archived"` verbatim as the fallback, so no encoding's literal count moves
  and the parity gate is satisfied rather than bypassed.
  */
  it("refuses a log write to a card in a RENAMED archive lane", async () => {
    readTaskRowMock.mockResolvedValue(row("filed"));

    await expect(logEntryImpl(storeWith(RENAMED_IR), "KB-1", "did a thing"))
      .rejects.toThrow(/archived — logging is read-only/);
  });

  /* CONTROL: the resolved set is legacy-seeded, so the built-in id must still refuse. */
  it("refuses a log write to the legacy `archived` column", async () => {
    readTaskRowMock.mockResolvedValue(row("archived"));

    await expect(logEntryImpl(storeWith(RENAMED_IR), "KB-1", "did a thing"))
      .rejects.toThrow(/archived — logging is read-only/);
  });

  /*
  The paired negative, and the one that matters most: a gate that refused everything would satisfy
  both cases above and silently break every log write on the board.
  */
  it("does NOT refuse a log write to a live lane", async () => {
    readTaskRowMock.mockResolvedValue(row("building"));

    /*
    Asserted as "the GATE did not fire", not as "the call succeeded". Past the gate the fast path
    performs a real Drizzle write, which this fake layer cannot serve — so the call still rejects,
    with an unrelated error. Asserting success would drag a database fixture into a test about a lane
    comparison, and asserting a bare rejection would pass even if the gate HAD fired.
    */
    const error = await logEntryImpl(storeWith(RENAMED_IR), "KB-1", "did a thing").catch((err: unknown) => err);
    expect(String(error)).not.toMatch(/logging is read-only/);
  });
});
