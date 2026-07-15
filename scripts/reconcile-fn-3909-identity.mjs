#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { openBackend } from "./lib/backend-db.mjs";
import process from "node:process";

export const TASK_ID = "FN-3909";
export const SOURCE_TASK_ID = "FN-4194";
export const CANONICAL_TITLE = "Restore icons + width-aware labels on agent card buttons";
export const CANONICAL_DESCRIPTION = "Fix the AgentsView card action buttons so the Details button restores its icon and split-sidebar action labels only hide when the available width is too narrow to fit them.";
export const EXPECTED_STALE_TITLE = "Implement heartbeat scope discipline for default agent promp";
export const EXPECTED_STALE_DESCRIPTION_FRAGMENT = "Pick up FN-3884 (Heartbeat scope discipline for default agent prompts)";
export const EXPECTED_PROMPT_HEADING = `Task: ${TASK_ID} - ${CANONICAL_TITLE}`;
export const RECONCILIATION_ACTION = `${SOURCE_TASK_ID} reconciliation`;
export const RECONCILIATION_OUTCOME = `${SOURCE_TASK_ID}: reconciled ${TASK_ID} title/description to the canonical merged UI-fix identity documented in task postmortem and canonical-mapping notes.`;

function readFlagValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function normalizeTitle(text) {
  return String(text ?? "")
    .replace(/^#\s+/, "")
    .replace(/^Task:\s*/i, "")
    .replace(/^[A-Z]+-\d+\s*[:-]\s*/i, "")
    .replace(/\s*\[via:[^\]]+\]\s*$/i, "")
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function firstHeading(promptText) {
  const line = String(promptText ?? "").split(/\r?\n/).find((entry) => entry.trim().startsWith("#"));
  if (!line) return null;
  return line.replace(/^#+\s*/, "").trim();
}

function readPromptHeading(projectRoot) {
  const promptPath = path.join(projectRoot, ".fusion", "tasks", TASK_ID, "PROMPT.md");
  const prompt = readFileSync(promptPath, "utf8");
  const heading = firstHeading(prompt);
  if (!heading) {
    throw new Error(`Refusing to reconcile ${TASK_ID}: PROMPT.md is missing a first heading at ${promptPath}`);
  }
  if (normalizeTitle(heading) !== normalizeTitle(EXPECTED_PROMPT_HEADING)) {
    throw new Error(
      `Refusing to reconcile ${TASK_ID}: unexpected PROMPT heading "${heading}" (expected "${EXPECTED_PROMPT_HEADING}")`,
    );
  }
  return { promptPath, heading };
}

function summarizeDiff(task, heading) {
  return {
    id: task.id,
    promptHeading: heading,
    before: {
      title: task.title,
      description: task.description,
    },
    after: {
      title: CANONICAL_TITLE,
      description: CANONICAL_DESCRIPTION,
    },
  };
}

function hasReconciliationLog(task) {
  return Array.isArray(task?.log)
    && task.log.some((entry) => entry?.action === RECONCILIATION_ACTION);
}

export function assessTaskState(task, heading) {
  if (!task || task.id !== TASK_ID) {
    throw new Error(`Refusing to reconcile: expected task ${TASK_ID}`);
  }

  const normalizedCurrentTitle = normalizeTitle(task.title);
  const normalizedCanonicalTitle = normalizeTitle(CANONICAL_TITLE);
  const alreadyCanonical = normalizedCurrentTitle === normalizedCanonicalTitle;
  const alreadyLogged = hasReconciliationLog(task);

  if (alreadyCanonical && alreadyLogged) {
    return {
      status: "noop",
      reason: `${TASK_ID} already matches the canonical title and carries the ${SOURCE_TASK_ID} reconciliation log entry`,
      diff: summarizeDiff(task, heading),
    };
  }

  if (alreadyCanonical) {
    throw new Error(
      `Refusing to reconcile ${TASK_ID}: row title already matches PROMPT heading but no ${SOURCE_TASK_ID} reconciliation marker is present`,
    );
  }

  if (task.title !== EXPECTED_STALE_TITLE) {
    throw new Error(
      `Refusing to reconcile ${TASK_ID}: unexpected stale title "${task.title}" (expected "${EXPECTED_STALE_TITLE}")`,
    );
  }

  if (!String(task.description ?? "").includes(EXPECTED_STALE_DESCRIPTION_FRAGMENT)) {
    throw new Error(`Refusing to reconcile ${TASK_ID}: current description does not match the expected heartbeat-scope stale text`);
  }

  return {
    status: "needs-reconciliation",
    diff: summarizeDiff(task, heading),
  };
}

export async function runReconciliation({ store, projectRoot, dryRun = true } = {}) {
  if (!store) {
    throw new Error("runReconciliation requires a store instance");
  }
  const resolvedProjectRoot = path.resolve(projectRoot ?? process.cwd());
  const { heading, promptPath } = readPromptHeading(resolvedProjectRoot);
  const task = await store.getTask(TASK_ID);
  const assessment = assessTaskState(task, heading);

  if (assessment.status === "noop") {
    return {
      dryRun,
      status: "noop",
      promptPath,
      ...assessment,
    };
  }

  if (dryRun) {
    return {
      dryRun,
      status: "would-apply",
      promptPath,
      diff: assessment.diff,
    };
  }

  await store.updateTask(TASK_ID, {
    title: CANONICAL_TITLE,
    description: CANONICAL_DESCRIPTION,
  });
  await store.logEntry(TASK_ID, RECONCILIATION_ACTION, RECONCILIATION_OUTCOME);
  const updated = await store.getTask(TASK_ID);

  return {
    dryRun,
    status: "applied",
    promptPath,
    diff: summarizeDiff(task, heading),
    updated: {
      title: updated.title,
      description: updated.description,
      reconciliationLogPresent: hasReconciliationLog(updated),
    },
  };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const dryRun = !argv.includes("--apply");
  const projectRoot = path.resolve(readFlagValue(argv, "--project-root") ?? process.cwd());
  const backend = deps.store ? undefined : await openBackend(projectRoot);
  try {
    /* FNXC:PostgresOperationalScripts 2026-07-14-18:18: Historical reconciliation utilities must mutate the live PostgreSQL task store, never a stale local SQLite file. */
    const result = await runReconciliation({ store: deps.store ?? backend.store, projectRoot, dryRun });
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await backend?.shutdown();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
