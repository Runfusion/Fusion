/**
 * Durable PostgreSQL store for experimental CLI Agent Executor sessions.
 *
 * FNXC:CliAgentPostgres 2026-07-14-12:00:
 * CLI-agent execution must remain available after the PostgreSQL cutover. Keep
 * the runtime-facing API synchronous by hydrating a project-scoped cache before
 * construction, while serializing every mutation through the injected
 * AsyncDataLayer. Callers that cross a durability boundary (PTY launch and
 * runtime shutdown) await flush().
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, desc, eq } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import { fromJson } from "../db/db-helpers.js";
import {
  isCliAgentState,
  isCliSessionPurpose,
  isCliTerminationReason,
  type CliAgentState,
  type CliAutonomyPosture,
  type CliSession,
  type CliSessionCreateInput,
  type CliSessionPurpose,
  type CliSessionUpdateInput,
  type CliTerminationReason,
} from "./cli-session-types.js";

export interface CliSessionStoreEvents {
  "cli-session:created": [session: CliSession];
  "cli-session:updated": [session: CliSession];
  "cli-session:deleted": [sessionId: string];
}

type CliSessionRow = typeof schema.project.cliSessions.$inferSelect;

function parsePosture(value: string | null): CliAutonomyPosture | null {
  return fromJson<CliAutonomyPosture>(value) ?? null;
}

function rowToSession(row: CliSessionRow): CliSession {
  return {
    id: row.id,
    taskId: row.taskId,
    chatSessionId: row.chatSessionId,
    purpose: row.purpose as CliSessionPurpose,
    // FNXC:MultiProjectIsolation 2026-07-15-23:40: the domain projectId now maps to owner_project_id; project_id is the trigger/GUC-owned RLS partition (migration 0011). The store always writes it, so hydrated rows are non-null.
    projectId: row.ownerProjectId ?? "",
    adapterId: row.adapterId,
    agentState: row.agentState as CliAgentState,
    terminationReason: row.terminationReason as CliTerminationReason | null,
    nativeSessionId: row.nativeSessionId,
    resumeAttempts: row.resumeAttempts,
    autonomyPosture: parsePosture(row.autonomyPosture),
    worktreePath: row.worktreePath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class CliSessionStore extends EventEmitter<CliSessionStoreEvents> {
  private readonly sessions = new Map<string, CliSession>();
  private writeTail: Promise<void> = Promise.resolve();
  private writeError: unknown;

  private constructor(
    private readonly layer: AsyncDataLayer,
    private readonly projectId: string,
  ) {
    super();
    this.setMaxListeners(100);
  }

  /** Hydrate all project sessions before exposing the synchronous cache API. */
  static async create(layer: AsyncDataLayer, projectId: string): Promise<CliSessionStore> {
    const store = new CliSessionStore(layer, projectId);
    const rows = await layer.db
      .select()
      .from(schema.project.cliSessions)
      .where(eq(schema.project.cliSessions.ownerProjectId, projectId))
      .orderBy(desc(schema.project.cliSessions.updatedAt));
    for (const row of rows) store.sessions.set(row.id, rowToSession(row));
    return store;
  }

  /** Wait until all mutations queued before this call are durable. */
  async flush(): Promise<void> {
    await this.writeTail;
    if (this.writeError !== undefined) throw this.writeError;
  }

  private enqueue(write: () => Promise<unknown>): void {
    this.writeTail = this.writeTail
      .then(async () => {
        await write();
      })
      .catch((error: unknown) => {
        // Event-driven state transitions cannot await storage directly. Retain
        // the first failure for the next explicit durability boundary without
        // creating an unhandled rejection, and keep later writes ordered.
        this.writeError ??= error;
      });
  }

  private assertAgentState(value: unknown): asserts value is CliAgentState {
    if (!isCliAgentState(value)) throw new Error(`Invalid CLI agent state: ${JSON.stringify(value)}`);
  }

  private assertPurpose(value: unknown): asserts value is CliSessionPurpose {
    if (!isCliSessionPurpose(value)) throw new Error(`Invalid CLI session purpose: ${JSON.stringify(value)}`);
  }

  private assertTerminationReason(value: unknown): asserts value is CliTerminationReason | null {
    if (value !== null && value !== undefined && !isCliTerminationReason(value)) {
      throw new Error(`Invalid CLI termination reason: ${JSON.stringify(value)}`);
    }
  }

  createSession(input: CliSessionCreateInput): CliSession {
    this.assertPurpose(input.purpose);
    const agentState = input.agentState ?? "starting";
    this.assertAgentState(agentState);
    this.assertTerminationReason(input.terminationReason ?? null);
    if (!input.projectId) throw new Error("CLI session requires a projectId");
    if (input.projectId !== this.projectId) throw new Error(`CLI session projectId must be ${this.projectId}`);
    if (!input.adapterId) throw new Error("CLI session requires an adapterId");

    const now = new Date().toISOString();
    const session: CliSession = {
      id: input.id ?? `cli-${randomUUID().slice(0, 8)}`,
      taskId: input.taskId ?? null,
      chatSessionId: input.chatSessionId ?? null,
      purpose: input.purpose,
      projectId: input.projectId,
      adapterId: input.adapterId,
      agentState,
      terminationReason: input.terminationReason ?? null,
      nativeSessionId: input.nativeSessionId ?? null,
      resumeAttempts: input.resumeAttempts ?? 0,
      autonomyPosture: input.autonomyPosture ?? null,
      worktreePath: input.worktreePath ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    // FNXC:MultiProjectIsolation 2026-07-15-23:40: write the session's domain project to
    // owner_project_id and never project_id — the trigger/GUC owns the RLS partition.
    const { projectId: ownerProjectId, ...columns } = session;
    this.enqueue(() => this.layer.db.insert(schema.project.cliSessions).values({
      ...columns,
      ownerProjectId,
      autonomyPosture: session.autonomyPosture ? JSON.stringify(session.autonomyPosture) : null,
    }));
    this.emit("cli-session:created", session);
    return session;
  }

  getSession(id: string): CliSession | undefined {
    return this.sessions.get(id);
  }

  listSessions(options?: {
    taskId?: string;
    chatSessionId?: string;
    projectId?: string;
    agentState?: CliAgentState;
    purpose?: CliSessionPurpose;
  }): CliSession[] {
    if (options?.agentState !== undefined) this.assertAgentState(options.agentState);
    if (options?.purpose !== undefined) this.assertPurpose(options.purpose);
    return [...this.sessions.values()]
      .filter((session) => options?.taskId === undefined || session.taskId === options.taskId)
      .filter((session) => options?.chatSessionId === undefined || session.chatSessionId === options.chatSessionId)
      .filter((session) => options?.projectId === undefined || session.projectId === options.projectId)
      .filter((session) => options?.agentState === undefined || session.agentState === options.agentState)
      .filter((session) => options?.purpose === undefined || session.purpose === options.purpose)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  listByTask(taskId: string): CliSession[] {
    return this.listSessions({ taskId });
  }

  listByChatSession(chatSessionId: string): CliSession[] {
    return this.listSessions({ chatSessionId });
  }

  updateSession(id: string, input: CliSessionUpdateInput): CliSession | undefined {
    const existing = this.sessions.get(id);
    if (!existing) return undefined;
    if (input.agentState !== undefined) this.assertAgentState(input.agentState);
    if (input.terminationReason !== undefined) this.assertTerminationReason(input.terminationReason);
    const updated: CliSession = { ...existing, ...input, updatedAt: new Date().toISOString() };
    this.sessions.set(id, updated);
    this.enqueue(() => this.layer.db
      .update(schema.project.cliSessions)
      .set({
        taskId: updated.taskId,
        chatSessionId: updated.chatSessionId,
        agentState: updated.agentState,
        terminationReason: updated.terminationReason,
        nativeSessionId: updated.nativeSessionId,
        resumeAttempts: updated.resumeAttempts,
        autonomyPosture: updated.autonomyPosture ? JSON.stringify(updated.autonomyPosture) : null,
        worktreePath: updated.worktreePath,
        updatedAt: updated.updatedAt,
      })
      .where(and(
        eq(schema.project.cliSessions.id, id),
        eq(schema.project.cliSessions.ownerProjectId, this.projectId),
      )));
    this.emit("cli-session:updated", updated);
    return updated;
  }

  deleteSession(id: string): boolean {
    if (!this.sessions.delete(id)) return false;
    this.enqueue(() => this.layer.db
      .delete(schema.project.cliSessions)
      .where(and(
        eq(schema.project.cliSessions.id, id),
        eq(schema.project.cliSessions.ownerProjectId, this.projectId),
      )));
    this.emit("cli-session:deleted", id);
    return true;
  }
}
