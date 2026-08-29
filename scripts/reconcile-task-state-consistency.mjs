#!/usr/bin/env node
import process from "node:process";
import { openBackend, importCore } from "./lib/backend-db.mjs";

const DEFAULT_NOTE = "FN-4000 reconciliation: cleared stale transient failure state using TaskStore done-normalization so database and task JSON remain synchronized.";

/*
FNXC:OperatorScriptLaneAssumptions 2026-07-31-02:10:
Both checks ask this task's OWN lanes, because keyed on the literals they fail in BOTH directions.

  `hasDoneTransient` gated on `column === "done"`. On a board whose complete lane is named anything
  else it NEVER fires, so a finished card still carrying `status:"failed"`, a worktree, a blockedBy or
  live recovery counters is never reported and never normalized — the exact stale state FN-4000 exists
  to clear.

  `failed-status-outside-in-review` gated on `column !== "in-review"`, and fails the OPPOSITE way: on a
  renamed board no column equals the literal, so EVERY failed task is flagged. A reconciliation report
  listing the whole board is as useless as one listing nothing, and it is the more dangerous of the
  two because it looks like the tool is working.

Lanes arrive resolved from the caller rather than being resolved here, so this stays pure and testable
without a database or a built dist.
*/
export function findTaskStateInconsistencies(task, lanes = {}) {
  /* DELIBERATE-LITERAL — the degraded default when the caller resolved no lanes. */
  const completeColumn = lanes.complete ?? "done";
  /* DELIBERATE-LITERAL — as above. */
  const reviewColumn = lanes.review ?? "in-review";
  const findings = [];
  const hasDoneTransient = task.column === completeColumn && (
    task.status === "failed"
    || Boolean(task.error)
    || Boolean(task.worktree)
    || Boolean(task.blockedBy)
    || typeof task.recoveryRetryCount === "number"
    || Boolean(task.nextRecoveryAt)
  );

  if (hasDoneTransient) {
    findings.push("done-task-has-transient-failure-state");
  }

  if (task.status === "failed" && task.column !== reviewColumn) {
    findings.push("failed-status-outside-in-review");
  }

  return findings;
}

/*
FNXC:OperatorScriptLaneAssumptions 2026-07-31-02:10:
`resolveLanes` is INJECTED, not built here, and `main` below supplies the real one.

Resolving inside this function would drag `importCore()` — and therefore a built `packages/core/dist`
— into every unit test of a pure reconciliation loop. Injection keeps the tests database-free and
build-free while the production entry point still wires a real resolver, which is the wiring that
matters: an optional lane parameter no caller fills is the inert shape this migration keeps finding.
*/
export async function runReconciliation({ store, dryRun = true, noteByTaskId = {}, resolveLanes = null }) {
  const tasks = await store.listTasks({ includeArchived: false });
  const findings = [];
  const actions = [];

  for (const task of tasks) {
    const lanes = resolveLanes ? ((await resolveLanes(task.id)) ?? {}) : {};
    const issues = findTaskStateInconsistencies(task, lanes);
    if (issues.length === 0) continue;

    findings.push({ taskId: task.id, column: task.column, status: task.status ?? null, issues });

    if (dryRun) {
      actions.push({ taskId: task.id, action: "would-reconcile", issues });
      continue;
    }

    if (task.column === (lanes.complete ?? "done")) {
      /* Its OWN column: this move exists to trigger the store's done-normalization, so naming the
         destination by literal was only ever a way of spelling "where it already is". */
      await store.moveTask(task.id, task.column);
      const note = noteByTaskId[task.id] ?? DEFAULT_NOTE;
      await store.logEntry(task.id, "FN-4000 reconciliation", note);
      actions.push({ taskId: task.id, action: "reconciled", issues });
      continue;
    }

    actions.push({ taskId: task.id, action: "flagged-no-safe-auto-fix", issues });
  }

  return { findings, actions };
}

function readFlagValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  return argv[index + 1];
}

async function buildLaneResolver(store) {
  const { resolveTaskLifecycleColumns } = await importCore();
  /* One resolution per WORKFLOW, not per task — the cache is what keeps this loop cheap on a big board. */
  const irCache = new Map();
  return (taskId) => resolveTaskLifecycleColumns(store, taskId, irCache);
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const dryRun = !argv.includes("--apply");
  const projectDir = readFlagValue(argv, "--project-dir") ?? process.cwd();
  const backend = deps.store ? undefined : await openBackend(projectDir);
  const store = deps.store ?? backend.store;

  const noteByTaskId = {
    "FN-3990": "FN-4000 reconciliation: cleared stale failed-state metadata after shipped lineage work landed in b89471aa5 and dashboard/doc follow-through completed in FN-3998.",
  };

  try {
    /* FNXC:PostgresOperationalScripts 2026-07-14-18:18: Consistency reconciliation must inspect and repair the authoritative PostgreSQL rows. */
    /* Wired only when we opened a real backend: a caller injecting its own store (tests) has no
       staged dist to import, and falls back to the documented legacy literals. */
    const resolveLanes = deps.resolveLanes ?? (backend ? await buildLaneResolver(store) : null);
    const result = await runReconciliation({ store, dryRun, noteByTaskId, resolveLanes });
    console.log(JSON.stringify({ dryRun, ...result }, null, 2));
    return 0;
  } finally {
    await backend?.shutdown();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
