/*
FNXC:WorkflowLifecycleColumns 2026-07-31-23:05:
THE SYNC IR PATH HAS TWO INDEPENDENT BLOCKERS, AND EVERY NOTE IN THIS REPO NAMES ONLY ONE.

The existing record — this file's sibling `sync-workflow-ir-callsite-allowlist.test.ts`, the
`postgres/sync-workflow-ir-is-always-default.pg.test.ts` proof, and a dozen FNXC notes across engine
and core, several of which I wrote — all say the same thing: `resolveTaskWorkflowIrSync` is inert
because `getTaskWorkflowSelectionImpl` returns `undefined` unconditionally, and the fix is "a
sync-capable workflow-selection reader".

That understates the work by half. Fixing the selection reader alone would NOT un-inert the sync
path for the boards this program cares about.

BLOCKER 2, proved below: `resolveTaskWorkflowIrSyncImpl` loads a CUSTOM workflow's IR with

    store.db.prepare("SELECT ir FROM workflows WHERE id = ?")

and `TaskStore.db` is not "SQLite-only" — its implementation (`dbImpl`, task-id-integrity.ts) is an
UNCONDITIONAL throw with no mode branch at all. So that read always throws, is always swallowed by
the surrounding `catch`, and always returns the default IR.

Consequence, and it is the one that matters here: a task bound to a BUILT-IN workflow could resolve
through the sync path today (that branch never touches `store.db`), but a task bound to a CUSTOM
workflow can never resolve, whatever the selection reader returns. Renamed lanes are by definition a
custom workflow. So the sync path cannot serve the renamed-board case at all until this read is
replaced too.

BLOCKER 3 is a design constraint rather than a bug, recorded here because it bounds the shape of any
fix: Fusion supports multiple nodes running their own engines against ONE shared PostgreSQL
(`docs/multi-project.md` → "Shared Postgres multi-node runbook"). A node-local synchronous cache of
`task_workflow_selection` therefore goes stale whenever ANOTHER node rewrites a selection, and it
would answer with full confidence. That is strictly worse than today's honest default, which is at
least uniformly wrong rather than intermittently wrong. Any sync reader needs an invalidation story
that survives a writer on a different host.

This file exists so the next person to attempt the unblock reads all three before starting, instead
of shipping a selection cache and discovering the second read at integration time.
*/

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../../..");

function source(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

describe("the sync workflow-IR path is blocked twice, not once", () => {
  /*
  Asserted against `dbImpl`'s SOURCE rather than by calling it, because calling it proves only that
  one construction path throws. The claim is stronger and is what the fix depends on: there is no
  mode in which this accessor returns a database, so no selection reader can rescue the read that
  uses it.
  */
  it("TaskStore.db is an unconditional throw — no SQLite branch survives", () => {
    const body = source("packages/core/src/task-store/task-id-integrity.ts");
    const start = body.indexOf("export function dbImpl(");
    expect(start).toBeGreaterThan(-1);
    const fn = body.slice(start, body.indexOf("\n}", start));

    expect(fn).toContain("throw new Error");
    /* If a mode branch is ever reintroduced, this file's premise changes and it must be re-read. */
    expect(fn).not.toMatch(/\bif\s*\(/);
    expect(fn).not.toMatch(/\breturn\b/);
  });

  it("the sync IR resolver still loads custom workflows through that dead accessor", () => {
    const body = source("packages/core/src/task-store/workflow-definitions.ts");
    const start = body.indexOf("export function resolveTaskWorkflowIrSyncImpl(");
    expect(start).toBeGreaterThan(-1);
    const fn = body.slice(start, body.indexOf("\n}", start));

    /* The custom-workflow branch. Reaching it guarantees the catch, hence the default IR. */
    expect(fn).toContain("store.db");
    expect(fn).toContain("SELECT ir FROM workflows");
    expect(fn).toContain("catch");
  });

  /*
  ANTI-VACUITY. The two assertions above are about source text, so they would keep passing if the
  sync resolver were deleted or renamed and the whole concern became moot. This pins that the
  resolver is still exported and still the thing the allow-list guards.
  */
  it("the resolver this file is about is still live", () => {
    expect(source("packages/core/src/store.ts")).toContain("resolveTaskWorkflowIrSync");
    expect(source("packages/core/src/__tests__/sync-workflow-ir-callsite-allowlist.test.ts"))
      .toContain("resolveTaskWorkflowIrSync");
  });

  /*
  The multi-node constraint is a documented product fact, not an inference. If that runbook ever goes
  away, blocker 3 goes with it and a node-local cache becomes viable — so the fix's shape depends on
  this line still being true.
  */
  it("multiple nodes still share one PostgreSQL, which is what makes a node-local cache unsafe", () => {
    expect(source("docs/multi-project.md")).toContain("Shared Postgres multi-node runbook");
  });
});
