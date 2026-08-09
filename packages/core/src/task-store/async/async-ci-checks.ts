import { and, eq, lt, sql } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";

export const GITHUB_CHECK_STATE_RETENTION_MS = 14 * 86_400_000;

export interface GitHubCheckStateInput {
  repo: string;
  headSha: string;
  checkName: string;
  state: string;
  eventKind?: "check_suite" | "workflow_run" | "status";
  externalId?: string;
  detailsUrl?: string;
  reportedAt: string;
  meta?: Record<string, unknown>;
}

export interface GitHubCheckState {
  repo: string;
  headSha: string;
  checkName: string;
  state: string;
  eventKind?: "check_suite" | "workflow_run" | "status";
  externalId?: string;
  detailsUrl?: string;
  reportedAt: string;
}

/*
FNXC:PrMergeEventDrivenChecks 2026-08-09-14:35:
GitHub CI is project-owned state. Rejecting an absent partition prevents writes, reads, or retention
from silently entering the legacy bucket and lets a different project's green check satisfy a gate.
*/
function requireProjectId(projectId: string): string {
  const normalized = projectId.trim();
  if (!normalized) throw new Error("GitHub check state operations require asyncLayer.projectId");
  return normalized;
}

function normalizeRepo(value: string): string { return value.trim().toLowerCase(); }
function normalizeSha(value: string): string { return value.trim().toLowerCase(); }

export async function recordGitHubCheckStateAsync(
  layer: AsyncDataLayer,
  input: GitHubCheckStateInput,
  projectId: string,
): Promise<boolean> {
  const ownerProjectId = requireProjectId(projectId);
  const now = new Date().toISOString();
  const repo = normalizeRepo(input.repo);
  const headSha = normalizeSha(input.headSha);
  const checkName = input.checkName.trim();
  const result = await layer.db.execute(sql`
    INSERT INTO project.github_check_states
      (project_id, repo, head_sha, check_name, state, event_kind, external_id, details_url, reported_at, received_at, created_at, updated_at, meta)
    VALUES (${ownerProjectId}, ${repo}, ${headSha}, ${checkName}, ${input.state}, ${input.eventKind ?? null}, ${input.externalId ?? null}, ${input.detailsUrl ?? null}, ${input.reportedAt}, ${now}, ${now}, ${now}, ${input.meta ?? null})
    ON CONFLICT (project_id, repo, head_sha, check_name) DO UPDATE SET
      state = EXCLUDED.state, event_kind = EXCLUDED.event_kind, external_id = EXCLUDED.external_id,
      details_url = EXCLUDED.details_url, reported_at = EXCLUDED.reported_at, received_at = EXCLUDED.received_at,
      updated_at = EXCLUDED.updated_at, meta = EXCLUDED.meta
    WHERE EXCLUDED.reported_at >= project.github_check_states.reported_at
  `);
  return result.count > 0;
}

export async function listGitHubCheckStatesAsync(
  layer: AsyncDataLayer,
  input: { repo: string; headSha: string },
  projectId: string,
): Promise<GitHubCheckState[]> {
  const ownerProjectId = requireProjectId(projectId);
  const rows = await layer.db.select().from(schema.project.githubCheckStates).where(and(
    eq(schema.project.githubCheckStates.projectId, ownerProjectId),
    eq(schema.project.githubCheckStates.repo, normalizeRepo(input.repo)),
    eq(schema.project.githubCheckStates.headSha, normalizeSha(input.headSha)),
  ));
  return rows.map((row) => ({
    repo: row.repo, headSha: row.headSha, checkName: row.checkName, state: row.state,
    eventKind: row.eventKind as GitHubCheckState["eventKind"], externalId: row.externalId ?? undefined,
    detailsUrl: row.detailsUrl ?? undefined, reportedAt: row.reportedAt,
  }));
}

export async function pruneGitHubCheckStatesAsync(
  layer: AsyncDataLayer,
  projectId: string,
  retentionMs = GITHUB_CHECK_STATE_RETENTION_MS,
): Promise<number> {
  const ownerProjectId = requireProjectId(projectId);
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  const result = await layer.db.delete(schema.project.githubCheckStates).where(and(
    eq(schema.project.githubCheckStates.projectId, ownerProjectId),
    lt(schema.project.githubCheckStates.receivedAt, cutoff),
  ));
  return result.count;
}

export function createIngestedCheckResolver(layer: AsyncDataLayer | null | undefined) {
  const projectId = layer?.projectId?.trim();
  if (!layer || !projectId) return undefined;
  return async (input: { owner: string; repo: string; headSha: string }) =>
    listGitHubCheckStatesAsync(layer, { repo: `${input.owner}/${input.repo}`, headSha: input.headSha }, projectId);
}
