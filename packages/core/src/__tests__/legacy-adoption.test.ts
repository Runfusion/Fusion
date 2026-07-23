/*
FNXC:LegacyAdoption 2026-07-19-12:20 (U9 / R10 / KTD-8):
The KTD-8 adoption contract + its build-failing WRITE-SITE CENSUS. The completeness
test greps every task.status write literal in core/engine/dashboard and fails the build if any
lacks an adoption-table row — so a status added during the cutover window is caught
at build time instead of mass-parking rows `paused` at upgrade. Plus adoption-action
+ reviewLevel-backfill unit coverage (fixture rows resume owned; never both fields).
*/
import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  LEGACY_STATUS_ADOPTION,
  resolveLegacyStatusAdoption,
  resolveReviewLevelBackfill,
  planLegacyAdoption,
  resolveOrphanedPendingStepResults,
} from "../legacy-adoption.js";
import { CODE_REVIEW_GROUP_ID } from "../builtin-code-review-group.js";
import { PLAN_REVIEW_GROUP_ID } from "../builtin-plan-review-group.js";
import { adoptLegacyTaskRowsOnOpen } from "../task-store/lifecycle-ops.js";
import type { TaskStore } from "../store.js";
import type { Task } from "../types.js";

const coreSrc = dirname(dirname(fileURLToPath(import.meta.url)));
const engineSrc = join(coreSrc, "..", "..", "engine", "src");
const dashboardSrc = join(coreSrc, "..", "..", "dashboard", "src");

/*
FNXC:LegacyAdoption 2026-07-19-13:40 (PR #2341 review; same finding on PR #2335):
The census originally scanned a curated 6-file list while claiming "all of core +
engine" — any task.status write elsewhere (scheduler.ts, comments-ops.ts, dashboard
routes, or a NEW file in either package) silently bypassed the build gate. It now
recursively enumerates every non-test .ts source under core/engine/dashboard src in a
single pass, so the completeness claim matches what is actually scanned.
*/
function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const parent = entry.parentPath ?? root;
    if (/(^|\/)(__tests__|dist|node_modules)(\/|$)/.test(parent)) continue;
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts") || /\.test\.ts$/.test(entry.name)) continue;
    out.push(join(parent, entry.name));
  }
  return out;
}

/**
 * Census: extract every literal WRITTEN to a task's status field across a source
 * tree. Task-status writes are matched via the concrete patterns the code uses —
 * `updateTask(... status: "X" ...)`, `<taskExpr>.status = "X"`, and
 * `{ status: "X" ... } as ...Partial<Task>` — deliberately NOT the broad
 * `status: "X"` (which would catch agent/session/merge-request statuses that are
 * not task rows). Reads (`=== "X"`) are excluded.
 */
function censusTaskStatusWrites(sources: string[]): Set<string> {
  const found = new Set<string>();
  /*
  FNXC:LegacyAdoption 2026-07-19-13:50 (PR #2341 review):
  Precision hardening required by the recursive scan. With the old curated 6-file list
  the loose forms were safe; over the whole tree they false-positived on non-task
  objects — `step.status = "pending"`, devserver/subtask `session.status`, dashboard
  `usage.status = "ok"/"no-auth"` — and the updateTask lookahead crossed a `;` into a
  neighboring `moveTask(...)` statement. Pattern 1 now stops at statement boundaries;
  pattern 2 requires a task-named receiver (no direct `<nonTask>.status = "X"` write
  can be a task row, and every real task write today goes through
  updateTask/createTask/`as Partial<Task>` anyway).
  */
  const patterns: RegExp[] = [
    // updateTask(id, { ... status: "X" ... }) / createTask({ ... status: "X" ... })
    // — `[^;]` so the lookahead cannot cross into the next statement.
    /(?:updateTask|createTask)\([^;]{0,600}?status:\s*"([a-z][a-z-]*)"/g,
    // <taskExpr>.status = "X" (assignment, not === / == / >= / <=) — receiver must be
    // task-named so step/session/usage/etc. object statuses are not censused.
    /\b\w*[tT]ask\w*\.status\s*=\s*"([a-z][a-z-]*)"/g,
    // { status: "X", ... } as (unknown as)? Partial<Task
    /\{\s*status:\s*"([a-z][a-z-]*)"[\s\S]{0,200}?\}\s*as\s*(?:unknown\s*as\s*)?Partial<Task/g,
  ];
  for (const src of sources) {
    for (const re of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) found.add(m[1]);
    }
  }
  return found;
}

describe("KTD-8 adoption table — write-site census completeness (build-failing)", () => {
  it("every task.status write literal in core + engine + dashboard has an adoption row", () => {
    const paths = [coreSrc, engineSrc, dashboardSrc].flatMap(listSourceFiles);
    // Sanity: the recursive walk found a real tree, not an empty/renamed root.
    expect(paths.length).toBeGreaterThan(100);
    const files = paths.map((f) => readFileSync(f, "utf-8"));
    const written = censusTaskStatusWrites(files);
    // `null` clears are not literals; the adoption table covers named statuses.
    const uncovered = [...written].filter((s) => LEGACY_STATUS_ADOPTION[s] === undefined);
    // A NEW written status with no adoption row fails the build here (KTD-8).
    expect(uncovered).toEqual([]);
  });

  it("the census actually finds task-status writes (guards against a broken/vacuous regex)", () => {
    const files = [readFileSync(join(engineSrc, "executor.ts"), "utf-8")];
    const written = censusTaskStatusWrites(files);
    // executor writes at least these — proves the census pattern is live, not vacuous.
    expect(written.has("failed")).toBe(true);
    expect(written.has("needs-replan")).toBe(true);
    expect(written.size).toBeGreaterThan(3);
  });

  it("the adoption table explicitly covers the critical cutover statuses (census-independent guard)", () => {
    // Some writes reach task.status via moveTask/computed values the regex census
    // cannot see; assert the cutover-critical vocabulary is covered regardless.
    for (const s of ["planning", "needs-replan", "plan-review-unavailable", "merging", "queued", "failed", "done", "awaiting-approval"]) {
      expect(LEGACY_STATUS_ADOPTION[s], `missing adoption row for '${s}'`).toBeDefined();
    }
  });
});

describe("resolveLegacyStatusAdoption — every legacy (status) resumes owned", () => {
  it("statuses whose writers U3 deleted resume the graph", () => {
    for (const s of ["plan-review-unavailable", "triaged"]) {
      expect(resolveLegacyStatusAdoption(s)?.kind).toBe("resume-graph");
    }
  });

  /*
  FNXC:LegacyAdoption 2026-07-22-18:20 (FN-8504 incident — generalizes FN-8498):
  Statuses with LIVE post-cutover writers are not legacy. The sweep runs on every store
  open (active tasks withhold the drained marker), so a clearing action races live lanes:
  FN-8504's replan planner wrote status:"planning" and a store-open adoption cleared it
  ~100ms later, leaving a live planner rendered as an idle "Ready" card. Each of these has
  its own crash-recovery owner; adoption must never touch them.
  */
  it("live-writer statuses are preserved — planning/queued/merge pipeline/stuck-killed (FN-8504)", () => {
    for (const s of ["planning", "queued", "merging", "merging-pr", "merging-fix", "stuck-killed", "needs-replan"]) {
      expect(resolveLegacyStatusAdoption(s)?.kind, s).toBe("preserve");
    }
  });

  /*
  FNXC:LegacyAdoption 2026-07-22-15:55 (FN-8498 incident):
  needs-replan is written LIVE by the graph's plan-replan seam and is the exact key
  triage's todo-rediscovery uses to re-admit a planned todo task. Adoption must never
  clear it — the resume-graph mapping stranded FN-8498 in `todo` across a restart.
  */
  it("needs-replan is preserved — it is the graph's live replan signal, not legacy", () => {
    expect(resolveLegacyStatusAdoption("needs-replan")?.kind).toBe("preserve");
  });

  it("live human/terminal gates are preserved (never disturbed)", () => {
    for (const s of ["awaiting-approval", "failed", "error", "blocked", "done", "cancelled"]) {
      expect(resolveLegacyStatusAdoption(s)?.kind).toBe("preserve");
    }
  });

  it("no status (null/empty) needs no adoption", () => {
    expect(resolveLegacyStatusAdoption(null)).toBeUndefined();
    expect(resolveLegacyStatusAdoption(undefined)).toBeUndefined();
    expect(resolveLegacyStatusAdoption("")).toBeUndefined();
  });

  it("an UNMAPPABLE (unknown) status parks paused for a human — never silently frozen", () => {
    const action = resolveLegacyStatusAdoption("some-future-status-xyz");
    expect(action?.kind).toBe("park-paused");
    expect(action?.note).toContain("some-future-status-xyz");
  });
});

describe("resolveReviewLevelBackfill — never both fields", () => {
  it("backfills a reviewLevel-only task with the U8 preset step set", () => {
    expect(resolveReviewLevelBackfill({ reviewLevel: 2 })).toEqual({
      kind: "backfill",
      enabledWorkflowSteps: [PLAN_REVIEW_GROUP_ID, CODE_REVIEW_GROUP_ID],
    });
    expect(resolveReviewLevelBackfill({ reviewLevel: 1 })).toEqual({
      kind: "backfill",
      enabledWorkflowSteps: [CODE_REVIEW_GROUP_ID],
    });
  });

  it("leaves a task with BOTH fields untouched and warned (explicit steps win)", () => {
    expect(resolveReviewLevelBackfill({ reviewLevel: 3, enabledWorkflowSteps: [CODE_REVIEW_GROUP_ID] })).toEqual({
      kind: "both-set-warn",
    });
    // explicit empty opt-out also counts as "set"
    expect(resolveReviewLevelBackfill({ reviewLevel: 3, enabledWorkflowSteps: [] })).toEqual({
      kind: "both-set-warn",
    });
  });

  it("no-ops a task with no reviewLevel", () => {
    expect(resolveReviewLevelBackfill({})).toEqual({ kind: "no-op" });
    expect(resolveReviewLevelBackfill({ enabledWorkflowSteps: [CODE_REVIEW_GROUP_ID] })).toEqual({ kind: "no-op" });
  });
});

/*
FNXC:LegacyAdoption 2026-07-19-04:40 (U9b / R10 / KTD-8):
The adoption PLAN — the shared brain both consumers (store-open reconcile and the
self-healing startup sweep) run. U9 shipped the table with NO consumer, so these assert the
end-to-end decision each legacy row gets, plus the two properties the whole mechanism rests
on: zero frozen rows, and idempotency across restarts.
*/
describe("planLegacyAdoption (U9b consumers)", () => {
  const NOW = "2026-07-19T04:40:00.000Z";

  it("clears every resume-graph status so the graph re-enters at its owning node", () => {
    for (const status of ["plan-review-unavailable", "triaged"]) {
      const plan = planLegacyAdoption({ status }, NOW);
      expect(plan.action, status).toBe("resume-graph");
      // Clearing the legacy status IS the re-entry: the graph owns the node again.
      expect(plan.patch?.status, status).toBeNull();
      expect(plan.patch?.legacyAdoptedAt, status).toBe(NOW);
      expect(plan.auditType, status).toBe("task:reconcile-legacy-adoption");
    }
  });

  it("parks an UNMAPPABLE status paused, leaving the status visible for the operator", () => {
    const plan = planLegacyAdoption({ status: "some-status-from-the-future" }, NOW);
    expect(plan.action).toBe("park-paused");
    expect(plan.patch?.paused).toBe(true);
    expect(plan.patch?.pausedReason).toContain("some-status-from-the-future");
    // The status is deliberately NOT cleared — a human needs to see what the row carried.
    expect(plan.patch?.status).toBeUndefined();
    expect(plan.auditType).toBe("task:reconcile-legacy-adoption-unmappable");
  });

  it("never disturbs a preserve gate", () => {
    for (const status of ["awaiting-approval", "failed", "done", "blocked", "cancelled"]) {
      expect(planLegacyAdoption({ status }, NOW).action, status).toBe("skip");
    }
  });

  /*
  FNXC:LegacyAdoption 2026-07-22-18:20 (FN-8504 incident):
  The end-to-end plan for a live-writer status must be a full skip — no clear, no stamp —
  because the sweep can fire from any store open while the status is genuinely live.
  */
  it("skips live-writer statuses entirely — a live planner/merge/queue marker is never cleared (FN-8504)", () => {
    for (const status of ["planning", "queued", "merging", "merging-pr", "merging-fix", "stuck-killed"]) {
      const plan = planLegacyAdoption({ status }, NOW);
      expect(plan.action, status).toBe("skip");
      expect(plan.patch, status).toBeUndefined();
    }
  });

  /*
  FNXC:LegacyAdoption 2026-07-22-15:55 (FN-8498 incident):
  A post-cutover todo row in the plan-replan loop carries status "needs-replan" and no
  legacyAdoptedAt stamp. The startup sweep used to clear it (resume-graph), stranding the
  task: triage's todo-rediscovery only re-admits a planned todo task on that exact status.
  The plan must skip it entirely — no status clear, no patch, no stamp — so the replan
  signal survives any number of engine restarts.
  */
  it("survives a restart mid-replan-loop: needs-replan is skipped, never cleared (FN-8498)", () => {
    const plan = planLegacyAdoption({ status: "needs-replan" }, NOW);
    expect(plan.action).toBe("skip");
    expect(plan.patch).toBeUndefined();
  });

  it("backfills reviewLevel-only rows and never writes both fields", () => {
    const plan = planLegacyAdoption({ reviewLevel: 1 }, NOW);
    expect(plan.patch?.enabledWorkflowSteps).toEqual([CODE_REVIEW_GROUP_ID]);
    expect(plan.patch?.legacyAdoptedAt).toBe(NOW);

    // Explicit steps win: no backfill, nothing to adopt.
    expect(planLegacyAdoption({ reviewLevel: 3, enabledWorkflowSteps: [CODE_REVIEW_GROUP_ID] }, NOW).action)
      .toBe("skip");
  });

  it("lands a reviewLevel backfill even on a preserve gate (orthogonal metadata)", () => {
    const plan = planLegacyAdoption({ status: "awaiting-approval", reviewLevel: 2 }, NOW);
    expect(plan.action).not.toBe("skip");
    expect(plan.patch?.enabledWorkflowSteps).toEqual([PLAN_REVIEW_GROUP_ID, CODE_REVIEW_GROUP_ID]);
    // ...but the gate's status is still untouched.
    expect(plan.patch?.status).toBeUndefined();
  });

  /*
  Idempotency is what makes the sweep safe to run on EVERY startup: without the stamp a
  restart loop would re-clear a status a human re-set and re-park a row an operator
  un-parked.
  */
  it("is idempotent — an already-adopted row is never re-adopted", () => {
    const plan = planLegacyAdoption({ status: "plan-review-unavailable", legacyAdoptedAt: NOW }, NOW);
    expect(plan.action).toBe("skip");
    expect(plan.patch).toBeUndefined();
  });

  it("only stamps rows it actually mutates (no mass-write of every done row on upgrade)", () => {
    expect(planLegacyAdoption({ status: "done" }, NOW).patch).toBeUndefined();
    expect(planLegacyAdoption({}, NOW).patch).toBeUndefined();
  });

  /*
  ZERO FROZEN ROWS — the headline U9/R10 property. Every status the adoption table knows
  about, plus an unknown one, must resolve to a decision. A row that resolved to neither a
  mutation nor a deliberate preserve/no-op would be exactly the silent freeze this exists to
  prevent.
  */
  it("leaves zero frozen rows across every known status and an unknown one", () => {
    const statuses = [...Object.keys(LEGACY_STATUS_ADOPTION), "totally-unknown-status"];
    for (const status of statuses) {
      const plan = planLegacyAdoption({ status }, NOW);
      const owned = plan.patch !== undefined
        || resolveLegacyStatusAdoption(status)?.kind === "preserve";
      expect(owned, `status '${status}' resolved to no adoption and no preserve gate`).toBe(true);
    }
  });
});

/*
FNXC:LegacyAdoption 2026-07-19-04:40 (U9b / KTD-8):
Orphaned pending step results. A pre-cutover crash leaves a `pending` result with no live
session and the graph waits on it forever; a LEASED one is real work in flight.
*/
describe("resolveOrphanedPendingStepResults (U9b, FN-8492 rewrite-to-failed)", () => {
  it("marks dead-session pending results failed and preserves live/completed ones", () => {
    const input = [
      { stepIndex: 0, status: "done" },
      { stepIndex: 1, status: "pending" },   // orphaned
      { stepIndex: 2, status: "pending" },   // live — leased
      { stepIndex: 3, status: "failed" },
    ];
    const { results, orphanedCount } = resolveOrphanedPendingStepResults(
      input,
      (r) => r.stepIndex === 2,
      { output: "orphan-note", completedAt: "2026-07-22T23:00:00.000Z" },
    );
    expect(orphanedCount).toBe(1);
    expect(results.map((r) => r.status)).toEqual(["done", "failed", "pending", "failed"]);
    expect(results[1]).toMatchObject({ output: "orphan-note", completedAt: "2026-07-22T23:00:00.000Z" });
  });

  /*
  FNXC:OrphanedPendingSteps 2026-07-22-16:35 (FN-8492 review follow-up):
  Deletion is a severity inversion: the merge gate blocks on pending/failed results, not
  on an enabled step with NO result, so deleting a dead review's pending entry silently
  satisfied the gate and the task merged with its review skipped. Rewrite, never delete.
  */
  it("NEVER deletes an orphaned entry — deletion silently satisfied the merge gate", () => {
    const input = [{ stepIndex: 0, status: "pending" }];
    const { results } = resolveOrphanedPendingStepResults(input, () => false);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("failed");
  });

  it("is a no-op on empty/absent results", () => {
    expect(resolveOrphanedPendingStepResults([], () => false).orphanedCount).toBe(0);
    expect(resolveOrphanedPendingStepResults(null, () => false).orphanedCount).toBe(0);
  });
});

/*
FNXC:LegacyAdoption 2026-07-19-09:00 (PR #2335 review):
Pagination drain. `listTasks` returns newest-first pages, so a capped single fetch would
re-scan the same newest 500 rows on every open/restart and strand every older legacy row —
the frozen-row failure R10 forbids. These prove the sweep pages past the cap until the
active census is drained, and that the `legacyAdoptedAt` stamp keeps a drained sweep
idempotent on the next open.
*/
/*
FNXC:LegacyAdoption 2026-07-19-14:30 (PR #2341 review):
The fake store optionally carries a fake PG asyncLayer so the drained-marker
short-circuit is testable: `db.execute` answers the marker SELECT from
`markerPresent`, records marker INSERTs, and can be forced to throw to prove the
fail-open-toward-sweeping path. Omitting `backend` models SQLite mode (no
bookkeeping table → no marker, sweep always runs).
*/
function makeFakeStore(
  rows: Array<Partial<Task> & { id: string }>,
  opts?: { backend?: boolean; markerPresent?: boolean; markerReadThrows?: boolean; markerWriteThrows?: boolean; markerError?: Error },
) {
  const listCalls: Array<{ limit?: number; offset?: number }> = [];
  const markerWrites: string[] = [];
  let markerPresent = opts?.markerPresent ?? false;
  // Flatten a drizzle SQL object's chunks into inspectable text.
  const sqlText = (q: unknown): string => {
    const chunks = (q as { queryChunks?: unknown[] }).queryChunks ?? [];
    return chunks
      .map((c) => {
        const v = (c as { value?: unknown }).value;
        return Array.isArray(v) ? v.join("") : String(v ?? "");
      })
      .join(" ");
  };
  const asyncLayer = opts?.backend
    ? {
        db: {
          execute: async (q: unknown) => {
            const text = sqlText(q);
            // FNXC:LegacyAdoption 2026-07-21-17:30: write path calls the SECURITY DEFINER
            // helper (SELECT public.fusion_mark_legacy_adoption_drained()); the read path is
            // SELECT version FROM … WHERE version = ….
            if (text.includes("fusion_mark_legacy_adoption_drained")) {
              if (opts?.markerWriteThrows) throw opts.markerError ?? new Error("marker write boom");
              markerWrites.push(text);
              markerPresent = true;
              return [];
            }
            if (text.includes("SELECT") && text.includes("version")) {
              if (opts?.markerReadThrows) throw opts.markerError ?? new Error("marker read boom");
              return markerPresent ? [{ version: "legacy-adoption-drained" }] : [];
            }
            return [];
          },
        },
      }
    : undefined;
  const store = {
    asyncLayer,
    listTasks: async (options?: { limit?: number; offset?: number }) => {
      listCalls.push({ limit: options?.limit, offset: options?.offset });
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? rows.length;
      return rows.slice(offset, offset + limit) as Task[];
    },
    updateTask: async (id: string, patch: Partial<Task>) => {
      const row = rows.find((r) => r.id === id)!;
      Object.assign(row, patch);
      return row as Task;
    },
  } as unknown as TaskStore;
  return { store, listCalls, rows, markerWrites };
}

describe("adoptLegacyTaskRowsOnOpen — paginates past the 500-row page cap", () => {
  it("adopts every legacy row beyond the first page, not just the newest 500", async () => {
    // 1101 legacy rows → 3 pages (500 + 500 + 101); a capped scan would strand 601.
    const rows: Array<Partial<Task> & { id: string }> = Array.from({ length: 1101 }, (_, i) => ({
      id: `task-${i + 1}`,
      status: "plan-review-unavailable",
    }));
    const { store, listCalls } = makeFakeStore(rows);

    const adopted = await adoptLegacyTaskRowsOnOpen(store);

    expect(adopted).toBe(1101);
    expect(rows.every((r) => r.status === null && typeof r.legacyAdoptedAt === "string")).toBe(true);
    expect(listCalls.map((c) => c.offset)).toEqual([0, 500, 1000]);
    expect(listCalls.every((c) => c.limit === 500)).toBe(true);
  });

  it("stops after one page when the census fits under the cap, and stays idempotent", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `task-${i + 1}`, status: "triaged" }));
    const { store, listCalls } = makeFakeStore(rows);

    expect(await adoptLegacyTaskRowsOnOpen(store)).toBe(3);
    expect(listCalls.length).toBe(1);

    // Second open: every row is stamped `legacyAdoptedAt` — nothing is re-adopted.
    expect(await adoptLegacyTaskRowsOnOpen(store)).toBe(0);
  });
});

/*
FNXC:LegacyAdoption 2026-07-19-14:30 (PR #2341 review):
Drained-marker short-circuit contract: the sweep must skip when the marker is present,
sweep when it is absent or unreadable, write the marker only after a fully-clean drain,
and withhold it on any cycle that produced a mutating plan.
*/
describe("adoptLegacyTaskRowsOnOpen — drained-marker completion short-circuit", () => {
  it("writes the non-numeric marker after a clean drain (no mutating plan)", async () => {
    const rows = [
      { id: "task-1", status: "done" },                                    // preserve gate → skip
      { id: "task-2", status: "plan-review-unavailable", legacyAdoptedAt: "2026-07-19" }, // already adopted → skip
      { id: "task-3" },                                                    // nothing legacy → skip
    ];
    const { store, listCalls, markerWrites } = makeFakeStore(rows, { backend: true });

    expect(await adoptLegacyTaskRowsOnOpen(store)).toBe(0);
    // The sweep still ran (marker was absent) …
    expect(listCalls.length).toBe(1);
    // … and a clean drain recorded the durable marker exactly once via the SECURITY DEFINER helper.
    expect(markerWrites.length).toBe(1);
    expect(markerWrites[0]).toContain("fusion_mark_legacy_adoption_drained");
  });

  it("skips the sweep entirely when the marker is present", async () => {
    const rows = [{ id: "task-1", status: "plan-review-unavailable" }];
    const { store, listCalls } = makeFakeStore(rows, { backend: true, markerPresent: true });

    expect(await adoptLegacyTaskRowsOnOpen(store)).toBe(0);
    expect(listCalls.length).toBe(0);
    // The (hypothetical) legacy row is untouched — marker presence means it cannot exist.
    expect(rows[0].status).toBe("plan-review-unavailable");
  });

  it("a mutating drain adopts but does NOT write the marker that cycle", async () => {
    const rows = [{ id: "task-1", status: "plan-review-unavailable" }];
    const { store, markerWrites } = makeFakeStore(rows, { backend: true });

    expect(await adoptLegacyTaskRowsOnOpen(store)).toBe(1);
    expect(rows[0].status).toBeNull();
    expect(markerWrites.length).toBe(0);

    // Next open: the census is now clean → the marker lands, then later opens skip.
    expect(await adoptLegacyTaskRowsOnOpen(store)).toBe(0);
    expect(markerWrites.length).toBe(1);
  });

  it("a userPaused legacy row withholds the marker without being mutated", async () => {
    const rows = [{ id: "task-1", status: "plan-review-unavailable", userPaused: true }];
    const { store, markerWrites } = makeFakeStore(rows, { backend: true });

    expect(await adoptLegacyTaskRowsOnOpen(store)).toBe(0);
    // Operator-paused rows are never adopted …
    expect(rows[0].status).toBe("plan-review-unavailable");
    // … but they keep the census "not drained" so they stay adoptable after unpause.
    expect(markerWrites.length).toBe(0);
  });

  it("falls back to sweeping when the marker read fails (fail-open toward correctness)", async () => {
    const rows = [{ id: "task-1", status: "plan-review-unavailable" }];
    const { store } = makeFakeStore(rows, { backend: true, markerReadThrows: true });

    expect(await adoptLegacyTaskRowsOnOpen(store)).toBe(1);
    expect(rows[0].status).toBeNull();
  });

  it("reports a permanent marker privilege failure once per SQLSTATE class", async () => {
    const cause = Object.assign(new Error("permission denied for table fusion_schema_migrations"), {code: "42501"});
    const markerError = new Error("Failed query: SELECT version FROM public.fusion_schema_migrations", {cause});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const {store} = makeFakeStore([{id: "task-1", status: "done"}], {
        backend: true,
        markerReadThrows: true,
        markerWriteThrows: true,
        markerError,
      });

      await adoptLegacyTaskRowsOnOpen(store);
      await adoptLegacyTaskRowsOnOpen(store);

      const diagnostics = stderr.mock.calls.filter(([message]) =>
        String(message).includes("Legacy-adoption drained-marker infrastructure is unavailable"),
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.[1]).toMatchObject({
        operation: "read",
        sqlstate: "42501",
        sqlstateClass: "42",
        hint: expect.stringContaining("schema baseline 0032+"),
      });
    } finally {
      stderr.mockRestore();
    }
  });
});
