import { and, asc, eq, sql, type AnyColumn, type SQL } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import type { IdeationCandidate, IdeationSession } from "../ideation/ideation-types.js";

export type IdeationQueryHandle = AsyncDataLayer["db"] | DbTransaction;

function projectPartition(): SQL<string> {
  return sql<string>`COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__')`;
}

function projectScope(column: AnyColumn): SQL {
  return eq(column, projectPartition());
}

function rowToSession(row: typeof schema.project.ideationSessions.$inferSelect): IdeationSession {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt ?? undefined,
    status: row.status as IdeationSession["status"],
    targetMissionId: row.targetMissionId ?? undefined,
    targetFeatureId: row.targetFeatureId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    convergedAt: row.convergedAt ?? undefined,
  };
}

function rowToCandidate(row: typeof schema.project.ideationCandidates.$inferSelect): IdeationCandidate {
  return {
    id: row.id,
    sessionId: row.sessionId,
    content: row.content,
    origin: row.origin as IdeationCandidate["origin"],
    sourceRef: row.sourceRef ?? undefined,
    selected: row.selected === 1,
    linkedMissionId: row.linkedMissionId ?? undefined,
    linkedFeatureId: row.linkedFeatureId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createIdeationSession(handle: IdeationQueryHandle, session: IdeationSession): Promise<IdeationSession> {
  await handle.insert(schema.project.ideationSessions).values({
    id: session.id, title: session.title, prompt: session.prompt ?? null, status: session.status,
    targetMissionId: session.targetMissionId ?? null, targetFeatureId: session.targetFeatureId ?? null,
    createdAt: session.createdAt, updatedAt: session.updatedAt, convergedAt: session.convergedAt ?? null,
  });
  return session;
}

export async function getIdeationSession(handle: IdeationQueryHandle, id: string): Promise<IdeationSession | undefined> {
  const rows = await handle.select().from(schema.project.ideationSessions)
    .where(and(projectScope(schema.project.ideationSessions.projectId), eq(schema.project.ideationSessions.id, id))).limit(1);
  return rows[0] ? rowToSession(rows[0]) : undefined;
}

export async function listIdeationSessions(handle: IdeationQueryHandle): Promise<IdeationSession[]> {
  const rows = await handle.select().from(schema.project.ideationSessions)
    .where(projectScope(schema.project.ideationSessions.projectId))
    .orderBy(asc(schema.project.ideationSessions.createdAt), asc(schema.project.ideationSessions.id));
  return rows.map(rowToSession);
}

export async function createIdeationCandidate(handle: IdeationQueryHandle, candidate: IdeationCandidate): Promise<IdeationCandidate> {
  await handle.insert(schema.project.ideationCandidates).values({
    id: candidate.id, sessionId: candidate.sessionId, content: candidate.content, origin: candidate.origin,
    sourceRef: candidate.sourceRef ?? null, selected: candidate.selected ? 1 : 0,
    linkedMissionId: candidate.linkedMissionId ?? null, linkedFeatureId: candidate.linkedFeatureId ?? null,
    createdAt: candidate.createdAt, updatedAt: candidate.updatedAt,
  });
  return candidate;
}

export async function getIdeationCandidate(handle: IdeationQueryHandle, id: string): Promise<IdeationCandidate | undefined> {
  const rows = await handle.select().from(schema.project.ideationCandidates)
    .where(and(projectScope(schema.project.ideationCandidates.projectId), eq(schema.project.ideationCandidates.id, id))).limit(1);
  return rows[0] ? rowToCandidate(rows[0]) : undefined;
}

export async function listIdeationCandidates(handle: IdeationQueryHandle, sessionId: string): Promise<IdeationCandidate[]> {
  const rows = await handle.select().from(schema.project.ideationCandidates)
    .where(and(projectScope(schema.project.ideationCandidates.projectId), eq(schema.project.ideationCandidates.sessionId, sessionId)))
    .orderBy(asc(schema.project.ideationCandidates.createdAt), asc(schema.project.ideationCandidates.id));
  return rows.map(rowToCandidate);
}

export async function updateIdeationCandidate(handle: IdeationQueryHandle, candidate: IdeationCandidate): Promise<IdeationCandidate> {
  const rows = await handle.update(schema.project.ideationCandidates).set({
    content: candidate.content, origin: candidate.origin, sourceRef: candidate.sourceRef ?? null,
    selected: candidate.selected ? 1 : 0, linkedMissionId: candidate.linkedMissionId ?? null,
    linkedFeatureId: candidate.linkedFeatureId ?? null, updatedAt: candidate.updatedAt,
  }).where(and(projectScope(schema.project.ideationCandidates.projectId), eq(schema.project.ideationCandidates.id, candidate.id))).returning();
  if (!rows[0]) throw new Error(`Ideation candidate ${candidate.id} not found`);
  return rowToCandidate(rows[0]);
}

export async function persistIdeationConvergence(handle: IdeationQueryHandle, session: IdeationSession, candidate: IdeationCandidate): Promise<void> {
  await handle.update(schema.project.ideationSessions).set({ status: session.status, targetMissionId: session.targetMissionId ?? null,
    targetFeatureId: session.targetFeatureId ?? null, updatedAt: session.updatedAt, convergedAt: session.convergedAt ?? null,
  }).where(and(projectScope(schema.project.ideationSessions.projectId), eq(schema.project.ideationSessions.id, session.id)));
  await updateIdeationCandidate(handle, candidate);
}

export async function archiveIdeationSession(handle: IdeationQueryHandle, session: IdeationSession): Promise<IdeationSession> {
  const rows = await handle.update(schema.project.ideationSessions).set({ status: session.status, updatedAt: session.updatedAt })
    .where(and(projectScope(schema.project.ideationSessions.projectId), eq(schema.project.ideationSessions.id, session.id))).returning();
  if (!rows[0]) throw new Error(`Ideation session ${session.id} not found`);
  return rowToSession(rows[0]);
}

export async function deleteIdeationSession(handle: IdeationQueryHandle, id: string): Promise<void> {
  await handle.delete(schema.project.ideationSessions)
    .where(and(projectScope(schema.project.ideationSessions.projectId), eq(schema.project.ideationSessions.id, id)));
}
