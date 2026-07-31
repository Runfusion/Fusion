import type { Task, TaskCreateInput, TaskSourceIssue } from "@fusion/core";
import type { LinearIssue } from "./linear-client.js";

export interface LinearSourceMetadata extends Record<string, unknown> {
  provider: "linear";
  issueId: string;
  identifier: string;
  url: string;
  teamId?: string;
  teamKey?: string;
  teamName?: string;
  stateName?: string;
  stateType?: string;
  assigneeId?: string;
  assigneeName?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface LinearDuplicateKeySet {
  issueId: string;
  identifier: string;
  url: string;
}

export interface LinearImportPreview {
  title: string;
  description: string;
  sourceIssue: TaskSourceIssue;
  sourceMetadata: LinearSourceMetadata;
  duplicateKeys: LinearDuplicateKeySet;
}

function cleanText(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function linearRepository(issue: LinearIssue): string {
  return issue.team?.key ?? issue.team?.id ?? "linear";
}

export function getLinearDuplicateKeys(issue: Pick<LinearIssue, "id" | "identifier" | "url">): LinearDuplicateKeySet {
  return {
    issueId: issue.id,
    identifier: issue.identifier,
    url: issue.url,
  };
}

export function buildLinearSourceMetadata(issue: LinearIssue): LinearSourceMetadata {
  return {
    provider: "linear",
    issueId: issue.id,
    identifier: issue.identifier,
    url: issue.url,
    teamId: issue.team?.id,
    teamKey: issue.team?.key,
    teamName: issue.team?.name,
    stateName: issue.state?.name,
    stateType: issue.state?.type,
    assigneeId: issue.assignee?.id,
    assigneeName: issue.assignee?.name,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

export function buildLinearImportPreview(issue: LinearIssue): LinearImportPreview {
  const description = cleanText(issue.description) ?? "(no description)";
  const details = [
    description,
    "",
    `Source: ${issue.url}`,
    `Linear: ${issue.identifier}`,
    issue.team?.key || issue.team?.name ? `Team: ${issue.team.key ?? issue.team.name}` : undefined,
    issue.state?.name ? `State: ${issue.state.name}` : undefined,
  ].filter(Boolean).join("\n");

  /*
  FNXC:LinearImport 2026-07-02-00:00:
  Imported Linear tasks need provider provenance that survives outside the plugin route response. Store the stable Linear issue id, human identifier, URL, and team/workspace hints in source metadata so duplicate detection works even when two teams reuse similar display identifiers.
  */
  return {
    title: `[${issue.identifier}] ${issue.title}`,
    description: details,
    sourceIssue: {
      provider: "linear",
      repository: linearRepository(issue),
      externalIssueId: issue.id,
      issueNumber: Number.parseInt(issue.identifier.replace(/^[A-Z]+-/iu, ""), 10) || 0,
      url: issue.url,
    },
    sourceMetadata: buildLinearSourceMetadata(issue),
    duplicateKeys: getLinearDuplicateKeys(issue),
  };
}

function getTaskSourceMetadata(task: Task): Record<string, unknown> {
  return task.source?.sourceMetadata ?? {};
}

export function taskMatchesLinearIssue(task: Task, issue: Pick<LinearIssue, "id" | "identifier" | "url">): boolean {
  const metadata = getTaskSourceMetadata(task);
  if (task.sourceIssue?.provider === "linear") {
    if (task.sourceIssue.externalIssueId === issue.id) return true;
    if (task.sourceIssue.url && task.sourceIssue.url === issue.url) return true;
  }
  if (task.source?.sourceType === "api" && metadata.provider === "linear") {
    if (metadata.issueId === issue.id || metadata.identifier === issue.identifier || metadata.url === issue.url) return true;
  }
  const description = typeof task.description === "string" ? task.description : "";
  return description.includes(`Source: ${issue.url}`);
}

export async function findExistingLinearTask(taskStore: { listTasks?: (options?: Record<string, unknown>) => Promise<Task[]> }, issue: Pick<LinearIssue, "id" | "identifier" | "url">): Promise<Task | null> {
  if (typeof taskStore.listTasks !== "function") return null;
  const tasks = await taskStore.listTasks({ includeArchived: false, slim: false });
  return tasks.find((task) => taskMatchesLinearIssue(task, issue)) ?? null;
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-16:35:
NO explicit `column`. An imported Linear issue enters INTAKE, and `createTask` resolves which column
that is from the workflow it selects (`resolvedEntryColumn`); an explicit `column` OVERRIDES that
resolution, which is exactly how this import kept naming `triage` after the column stopped existing.

`triage` was DELETED by U11 — the default board's lanes are `todo | in-progress | in-review | done |
archived` — so every Linear import wrote its card into a lane no workflow declares. Nothing rejects
it and nothing logs it: the route reports success with a task id, and the card is not on the board.

Identical shape and identical fix to the GitLab importer (#2843). Worth stating that this one is the
reason to distrust "we fixed the import path": the two importers were written from the same template
and only one of them was found by looking at the forge everybody uses.
*/
export function buildLinearTaskCreateInput(issue: LinearIssue): TaskCreateInput {
  const preview = buildLinearImportPreview(issue);
  return {
    title: preview.title,
    description: preview.description,
    sourceIssue: preview.sourceIssue,
    source: {
      sourceType: "api",
      sourceMetadata: preview.sourceMetadata,
    },
  };
}

export interface ImportLinearIssueResult {
  imported: boolean;
  duplicate: boolean;
  taskId?: string;
  task?: Task;
  issue: LinearImportPreview;
}

export async function importLinearIssue(taskStore: { listTasks?: (options?: Record<string, unknown>) => Promise<Task[]>; createTask?: (input: TaskCreateInput) => Promise<Task> }, issue: LinearIssue): Promise<ImportLinearIssueResult> {
  const preview = buildLinearImportPreview(issue);
  const existing = await findExistingLinearTask(taskStore, issue);
  if (existing) {
    return { imported: false, duplicate: true, taskId: existing.id, task: existing, issue: preview };
  }
  if (typeof taskStore.createTask !== "function") {
    throw new Error("Plugin task store cannot create tasks in this context.");
  }
  const task = await taskStore.createTask(buildLinearTaskCreateInput(issue));
  return { imported: true, duplicate: false, taskId: task.id, task, issue: preview };
}
