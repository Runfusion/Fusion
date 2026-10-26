import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import {
  AutoClaimSnapshotManager,
  resolveFreshAutoClaimCandidates,
  toAutoClaimCandidate,
} from "../scheduling/auto-claim-snapshot.js";

/*
FNXC:AutoClaimRetention 2026-10-26-01:32 (RUFU-627 Step 5):
The contract these tests hold is a SHAPE contract, not a count. `AutoClaimSnapshotManager` keeps a
30-second board snapshot, and both of its consumers (`agent-heartbeat.ts:3498`,
`heartbeat-wake-signals.ts:269`) hand the whole retained array to `resolveFreshAutoClaimCandidates`,
which reads `id` off each retained record and rebuilds everything else from a canonical row — because
FN-6850 forbids rendering a cached card's identity text without that re-resolution. Before this change
the cache nevertheless retained up to 50 full card bodies it could never legitimately hand to anyone.

The assertions below are deliberately made on the RUNTIME shape and on the option bags the two reads
actually passed, never on source text:
1. a retained record owns no text key,
2. the rebuild read declares zero wide fields while the resolve read still declares `description`,
3. the resolved candidate a consumer actually renders still carries its body and first line.
Whether `fields: []` really removes the columns from the executed SELECT is proven one layer down, in
`packages/core/src/__tests__/postgres/list-tasks-field-declaration.pg.test.ts`, which reads the
rendered SQL — asserting "the option was passed" here and "the SQL changed" there is what makes the
pair non-vacuous in both directions.

Two rules are pinned as UNCHANGED on purpose, because Step 5 must not disturb them: the TTL window
(one read per window, no read for a cached hit) and the resolved candidate's identity fields, which
are the FN-6812/FN-6850 assertions in `auto-claim-snapshot.test.ts`.
*/

const SPEC_BODY = [
  "## What This Delivers",
  "A description body long enough to be the thing worth not copying: a planner-written spec with",
  "several paragraphs, a Before/After section, and a File Scope list — the shape of a real card.",
  ...Array.from({ length: 40 }, (_, i) => `  line ${i}: ${"filler ".repeat(12)}`),
].join("\n");

function makeTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? "Title",
    description: overrides.description ?? SPEC_BODY,
    status: overrides.status ?? "open",
    column: overrides.column ?? "todo",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    dependencies: overrides.dependencies ?? [],
    comments: overrides.comments ?? [],
    steps: overrides.steps ?? [],
    currentStep: overrides.currentStep ?? 0,
    log: overrides.log ?? [],
    // A populated `workflowStepResults` on a list-loaded row is part of the populated-board case:
    // this read must not start transferring it either, and nothing here reads it.
    workflowStepResults: overrides.workflowStepResults
      ?? { "code-review": [{ status: "APPROVED", timestamp: "2026-01-01T00:00:00.000Z" }] },
    assignedAgentId: overrides.assignedAgentId,
    checkedOutBy: overrides.checkedOutBy,
    paused: overrides.paused,
    userPaused: overrides.userPaused,
    deletedAt: overrides.deletedAt,
    columnMovedAt: overrides.columnMovedAt,
    sourceMetadata: overrides.sourceMetadata,
  } as unknown as Task;
}

/** Records every option bag a path passed to `listTasks`, so declarations are asserted, not assumed. */
function recordingStore(tasks: readonly Task[]) {
  const calls: Array<Record<string, unknown>> = [];
  const listTasks = vi.fn(async (options?: Record<string, unknown>) => {
    calls.push(options ?? {});
    return tasks.map((task) => ({ ...task }));
  });
  return { listTasks, calls };
}

const NOW = () => Date.parse("2026-01-12T00:00:00.000Z");

describe("AutoClaimSnapshotManager retained shape", () => {
  it("retains no card text on a populated board — the body a consumer cannot render is not stored", async () => {
    const store = recordingStore([
      makeTask({ id: "FN-pop-1" }),
      makeTask({ id: "FN-pop-2", columnMovedAt: "2026-01-05T00:00:00.000Z", title: null }),
    ]);
    const manager = new AutoClaimSnapshotManager({ taskStore: store, now: NOW });

    const snapshot = await manager.getSnapshot();

    expect(snapshot.tasks).toHaveLength(2);
    for (const retained of snapshot.tasks) {
      // Asserted on the record's OWN keys: a field dropped-but-present-as-empty would both keep the
      // retained slot and read downstream as a legitimate empty title/body. `columnMovedAt` is always
      // an own key (possibly `undefined`) because `toRetainedAutoClaimCandidate` writes it explicitly.
      expect(Object.keys(retained).sort()).toEqual(["baseScore", "column", "columnMovedAt", "createdAt", "id"]);
      expect(retained).not.toHaveProperty("description");
      expect(retained).not.toHaveProperty("title");
      expect(retained).not.toHaveProperty("descriptionFirstLine");
    }
    // The scalars the snapshot exists to compute survived, and they are the queue semantics they were.
    expect(snapshot.tasks.map((task) => task.id)).toEqual(["FN-pop-1", "FN-pop-2"]);
    expect(snapshot.tasks[1]!.columnMovedAt).toBe("2026-01-05T00:00:00.000Z");
    expect(snapshot.tasks.every((task) => task.baseScore >= 0 && task.baseScore <= 5)).toBe(true);
  });

  it("asks the rebuild read for zero wide fields and the resolve read still for description", async () => {
    const store = recordingStore([makeTask({ id: "FN-decl" })]);
    const manager = new AutoClaimSnapshotManager({ taskStore: store, now: NOW });

    const snapshot = await manager.getSnapshot();
    expect(store.calls[0]!.fields).toEqual([]);
    // The narrowing that must NOT have happened: the row shape stays log-free and derivation-free, and
    // the read stays slim, so the only thing this change moved is the wide-field declaration.
    expect(store.calls[0]).toMatchObject({ slim: true, derive: false, excludeLog: true });

    await resolveFreshAutoClaimCandidates(store as never, snapshot.tasks, NOW);
    expect(store.calls[1]!.fields).toEqual(["description"]);
  });

  it("still hands the consumer a resolved candidate carrying the body it scores and renders", async () => {
    const store = recordingStore([makeTask({ id: "FN-body", description: `first line\n${SPEC_BODY}` })]);
    const manager = new AutoClaimSnapshotManager({ taskStore: store, now: NOW });
    const snapshot = await manager.getSnapshot();

    const [resolved] = await resolveFreshAutoClaimCandidates(store as never, snapshot.tasks, NOW);

    // `taskRelevanceScore` scores agent role + soul words against title AND the full description, and
    // the heartbeat prompt renders `title ?? descriptionFirstLine`. Both consume the RESOLVED record.
    expect(resolved!.description).toBe(`first line\n${SPEC_BODY}`);
    expect(resolved!.descriptionFirstLine).toBe("first line");
    expect(resolved!.title).toBe("Title");
    expect(resolved!.id).toBe("FN-body");
    // Control for the assertion above: the retained record could not have supplied that text even if a
    // consumer tried, which is the compile-time half of this change.
    expect(snapshot.tasks[0]).not.toHaveProperty("description");
    expect(toAutoClaimCandidate(makeTask({ id: "FN-x", description: "sole line" }), NOW()).descriptionFirstLine)
      .toBe("sole line");
  });

  it("keeps the TTL window and the empty-read rule byte-identical: one read per window, none for an empty candidate set", async () => {
    let clock = Date.parse("2026-01-12T00:00:00.000Z");
    const store = recordingStore([makeTask({ id: "FN-ttl" })]);
    const manager = new AutoClaimSnapshotManager({ taskStore: store, ttlMs: 30_000, now: () => clock });

    await manager.getSnapshot();
    await manager.getSnapshot();
    expect(store.listTasks).toHaveBeenCalledTimes(1);

    clock += 30_001;
    await manager.getSnapshot();
    expect(store.listTasks).toHaveBeenCalledTimes(2);

    // An empty retained set must not trigger a board read at all — the empty-board case, asserted as
    // the absence of a call rather than the presence of an empty array.
    const emptyStore = recordingStore([]);
    const emptyManager = new AutoClaimSnapshotManager({ taskStore: emptyStore, now: NOW });
    const empty = await emptyManager.getSnapshot();
    expect(empty.tasks).toEqual([]);
    await resolveFreshAutoClaimCandidates(emptyStore as never, empty.tasks, NOW);
    expect(emptyStore.listTasks).toHaveBeenCalledTimes(1);
  });

  it("treats a duplicate-id board and an undefined-optional board exactly as before", async () => {
    // Two rows, one id: `tasksById` collapses them and the retained set keeps one entry per candidate.
    const dupes = recordingStore([
      makeTask({ id: "FN-dupe", description: "first copy" }),
      makeTask({ id: "FN-dupe", description: "second copy", createdAt: "2026-01-02T00:00:00.000Z" }),
    ]);
    const dupesManager = new AutoClaimSnapshotManager({ taskStore: dupes, now: NOW });
    const duped = await dupesManager.getSnapshot();
    expect(duped.tasks.map((task) => task.id)).toEqual(["FN-dupe", "FN-dupe"]);

    const resolved = await resolveFreshAutoClaimCandidates(dupes as never, duped.tasks, NOW);
    expect(resolved.map((candidate) => candidate.id)).toEqual(["FN-dupe", "FN-dupe"]);
    // Both retained entries re-resolve through ONE canonical row, and `tasksById` is last-write-wins,
    // so the second row is the canonical body for both. That is the pre-existing behaviour — Step 5
    // must not have changed which row wins, only whether the cache got to keep a copy of it.
    expect(resolved.map((candidate) => candidate.description)).toEqual(["second copy", "second copy"]);
    expect(resolved.map((candidate) => candidate.baseScore)).toEqual([5, 5]);

    // `columnMovedAt` undefined is the ordinary never-moved row: the queue reference falls back to
    // `createdAt`, and the optional must not materialise as a text key or a thrown read.
    const missing = recordingStore([makeTask({ id: "FN-nomove", columnMovedAt: undefined })]);
    const missingManager = new AutoClaimSnapshotManager({ taskStore: missing, now: NOW });
    const moved = await missingManager.getSnapshot();
    expect(moved.tasks[0]!.columnMovedAt).toBeUndefined();
    expect(Object.hasOwn(moved.tasks[0]!, "columnMovedAt")).toBe(true);
    const [resolvedMissing] = await resolveFreshAutoClaimCandidates(missing as never, moved.tasks, NOW);
    expect(resolvedMissing!.description).toBe(SPEC_BODY);
    expect(resolvedMissing!.descriptionFirstLine).toBe("## What This Delivers");
  });
});
