#!/usr/bin/env node
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openBackend } from "./lib/backend-db.mjs";

/*
FNXC:TaskArchiveReintegration 2026-09-06-08:00:
This operator repair is dry-run by default, requires an exact project root, and reports absent proof
instead of inventing zero metrics. Apply delegates every mutation to project-scoped TaskStore APIs.
*/
const execFileAsync = promisify(execFile);

const VISIBLE_HISTORY_FIELDS = [
  "firstExecutionAt",
  "cumulativeActiveMs",
  "cumulativePlanningMs",
  "columnDwellMs",
  "executionStartedAt",
  "executionCompletedAt",
  "tokenUsage",
  "mergeDetails",
  "modifiedFiles",
];

function hasProof(value) {
  return value !== undefined && value !== null;
}

async function listAllCompleted(store) {
  const tasks = [];
  let total = 0;
  for (let offset = 0; ; offset += 500) {
    const page = await store.listCompletedTasks({ limit: 500, offset, slim: false, sort: "task-id-desc" });
    total = page.total;
    tasks.push(...page.tasks);
    if (!page.hasMore) break;
  }
  return { tasks, total };
}

async function readForensicTask(store, id) {
  try {
    return await store.getTask(id, { includeDeleted: true });
  } catch {
    return undefined;
  }
}

async function resolveCommitFilesFromGit(store, task) {
  if (!task?.lineageId) return { files: undefined, available: 0, unavailable: 0 };
  const associations = await store.getTaskCommitAssociationsByLineageId?.(task.lineageId) ?? [];
  const files = new Set();
  let available = 0;
  let unavailable = 0;
  for (const association of associations) {
    const sha = association?.commitSha;
    if (typeof sha !== "string" || !/^[0-9a-f]{7,64}$/i.test(sha)) {
      unavailable += 1;
      continue;
    }
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-m", sha, "--"],
        { cwd: store.getRootDir(), maxBuffer: 10 * 1024 * 1024 },
      );
      for (const file of stdout.split("\n").map((value) => value.trim()).filter(Boolean)) files.add(file);
      available += 1;
    } catch {
      unavailable += 1;
    }
  }
  return { files: available > 0 ? [...files].sort() : undefined, available, unavailable };
}

function composeHistoricalEvidence(coldEntry, artifact, commitFiles) {
  const evidence = {};
  for (const field of VISIBLE_HISTORY_FIELDS) {
    if (hasProof(coldEntry?.[field])) evidence[field] = coldEntry[field];
    else if (hasProof(artifact?.[field])) evidence[field] = artifact[field];
  }
  if (!hasProof(evidence.modifiedFiles) && commitFiles !== undefined) evidence.modifiedFiles = commitFiles;
  return evidence;
}

function missingVisibleProof(tasks) {
  return tasks.flatMap((task) => VISIBLE_HISTORY_FIELDS
    .filter((field) => !hasProof(task[field]))
    .map((field) => ({ taskId: task.id, field })))
    .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.field.localeCompare(b.field));
}

export async function reconcileArchivedTaskHistory({
  store,
  apply = false,
  resolveCommitFiles = resolveCommitFilesFromGit,
}) {
  const projectId = store.getAsyncLayer?.()?.projectId?.trim();
  if (!projectId) throw new Error("Exact project identity is required; refusing an ambiguous archive reconciliation");

  const before = await listAllCompleted(store);
  const inspection = await store.inspectArchivedTaskHistory();
  const coldIds = new Set(inspection.coldEntries.map((entry) => entry.id));
  const candidateIds = [...new Set([
    ...before.tasks.map((task) => task.id),
    ...inspection.liveSentinels.map((task) => task.id),
    ...inspection.coldEntries.map((entry) => entry.id),
    ...(inspection.malformedColdEntryIds ?? []),
  ])].sort();
  const beforeById = new Map(before.tasks.map((task) => [task.id, task]));
  const forensicById = new Map(await Promise.all(candidateIds.map(async (id) => [id, await readForensicTask(store, id)])));
  const liveWon = inspection.coldEntries
    .filter((entry) => forensicById.get(entry.id) && !forensicById.get(entry.id).deletedAt)
    .map((entry) => entry.id)
    .sort();
  const malformedColdIds = new Set(inspection.malformedColdEntryIds ?? []);
  const retained = candidateIds.flatMap((id) => {
    const task = forensicById.get(id);
    if (task?.userPaused) return [{ taskId: id, reason: "user-paused" }];
    if (malformedColdIds.has(id)) return [{ taskId: id, reason: "malformed-snapshot" }];
    return [];
  });

  /*
  FNXC:TaskArchiveReintegration 2026-09-06-08:39:
  Repair follows durable proof precedence: PostgreSQL wins implicitly in the core supplement API,
  then cold snapshot, retained task artifact, and finally exact Git objects linked by durable commit
  associations. Missing Git objects stay unavailable and never become an empty-file assertion.
  */
  const coldById = new Map(inspection.coldEntries.map((entry) => [entry.id, entry]));
  const supplements = [];
  const gitEvidence = [];
  for (const taskId of candidateIds) {
    const live = forensicById.get(taskId) ?? beforeById.get(taskId);
    const artifact = await store.readTaskHistoryArtifact?.(taskId);
    const commitResolution = await resolveCommitFiles(store, live);
    gitEvidence.push({ taskId, available: commitResolution.available, unavailable: commitResolution.unavailable });
    const evidence = composeHistoricalEvidence(coldById.get(taskId), artifact, commitResolution.files);
    if (Object.keys(evidence).length === 0 || !live) continue;
    const result = await store.supplementTaskHistoryFromEvidence(taskId, evidence, { dryRun: !apply });
    supplements.push({ taskId, ...result });
  }

  let drain = { movedCount: 0, restoredCount: 0, outcomes: [] };
  const commitEvidence = await store.backfillCommitAssociationDiffStats?.({ dryRun: !apply });
  if (apply) drain = await store.reconcileArchivedTasksIntoDone();

  const after = await listAllCompleted(store);
  const afterById = new Map(after.tasks.map((task) => [task.id, task]));
  const recoveredFields = [...new Map([
    ...supplements.flatMap((item) => item.fields.map((field) => [`${item.taskId}:${field}`, { taskId: item.taskId, field }])),
    ...candidateIds.flatMap((taskId) => VISIBLE_HISTORY_FIELDS.flatMap((field) => {
      const beforeValue = beforeById.get(taskId)?.[field];
      const afterValue = afterById.get(taskId)?.[field];
      return !hasProof(beforeValue) && hasProof(afterValue) ? [[`${taskId}:${field}`, { taskId, field }]] : [];
    })),
  ]).values()].sort((a, b) => a.taskId.localeCompare(b.taskId) || a.field.localeCompare(b.field));
  const failures = drain.outcomes
    .filter((item) => item.outcome === "failed")
    .map((item) => ({ taskId: item.taskId, source: item.source }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
  const appliedRetained = drain.outcomes
    .filter((item) => item.outcome === "retained")
    .map((item) => ({ taskId: item.taskId, reason: item.reason }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));

  const provenRecoveries = new Set(recoveredFields.map(({ taskId, field }) => `${taskId}:${field}`));
  const fieldsWithoutProof = missingVisibleProof(after.tasks)
    .filter(({ taskId, field }) => apply || !provenRecoveries.has(`${taskId}:${field}`));

  return {
    mode: apply ? "apply" : "dry-run",
    projectId,
    sources: {
      liveSentinels: inspection.liveSentinels.length,
      coldSnapshots: inspection.coldEntries.length + malformedColdIds.size,
      malformedColdSnapshots: malformedColdIds.size,
      coldOnly: inspection.coldEntries.filter((entry) => !forensicById.get(entry.id)).length,
      softDeletedWithSnapshot: inspection.coldEntries.filter((entry) => forensicById.get(entry.id)?.deletedAt).length,
      collisions: liveWon.length,
    },
    candidates: candidateIds,
    wouldRestore: candidateIds.filter((id) => !retained.some((item) => item.taskId === id)),
    restored: drain.outcomes.filter((item) => item.outcome === "restored" || item.outcome === "moved").map((item) => item.taskId).sort(),
    liveWon,
    retained: apply ? appliedRetained : retained,
    failures,
    totalDoneBefore: before.total,
    totalDoneAfter: after.total,
    recoveredFields,
    fieldsWithoutProof,
    commitEvidence: commitEvidence ?? null,
    gitEvidence: gitEvidence.sort((a, b) => a.taskId.localeCompare(b.taskId)),
    coldSnapshotIds: [...coldIds].sort(),
  };
}

function parseArgs(argv) {
  let apply = false;
  let projectRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") apply = true;
    else if (arg === "--project-root") projectRoot = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!projectRoot) throw new Error("--project-root <exact-project-root> is required");
  return { apply, projectRoot: resolve(projectRoot) };
}

export async function main(argv = process.argv.slice(2), openBackendFn = openBackend) {
  const { apply, projectRoot } = parseArgs(argv);
  const backend = await openBackendFn(projectRoot, { skipArchiveReintegrationOnInit: true });
  try {
    const report = await reconcileArchivedTaskHistory({ store: backend.store, apply });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    await backend.shutdown();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
