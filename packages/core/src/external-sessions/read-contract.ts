import { z } from "zod";
import { externalSessionIdentifier, type ExternalSessionObservation } from "./contract.js";

export const externalSessionReadId = z.string().regex(/^[a-f0-9]{64}$/);
export const externalSessionListQuerySchema = z.object({
  hostId: externalSessionIdentifier.optional(),
  provider: externalSessionIdentifier.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();
export type ExternalSessionListQuery = z.input<typeof externalSessionListQuerySchema>;

const cursorSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: externalSessionIdentifier,
  hostId: externalSessionIdentifier.optional(),
  provider: externalSessionIdentifier.optional(),
  afterId: externalSessionReadId,
}).strict();

/**
 * FNXC:RemoteAgents 2026-09-17-23:19:
 * The remote-agent view reads across hosts within one registered Fusion project. Its cursor
 * binds that project and exact filters, and orders by immutable identity so activity updates
 * cannot move existing cards across a page boundary. Refresh to discover new earlier identities.
 */
export function externalSessionPageCursor(projectId: string, query: ExternalSessionListQuery, afterId: string): string {
  return Buffer.from(JSON.stringify(cursorSchema.parse({ schemaVersion: 1, projectId,
    ...(query.hostId !== undefined ? { hostId: query.hostId } : {}),
    ...(query.provider !== undefined ? { provider: query.provider } : {}), afterId }))).toString("base64url");
}

export function externalSessionCursorAfter(projectId: string, query: ExternalSessionListQuery): string | undefined {
  const parsed = externalSessionListQuerySchema.parse(query);
  if (parsed.cursor === undefined) return undefined;
  const cursor = cursorSchema.parse(JSON.parse(Buffer.from(parsed.cursor, "base64url").toString("utf8")));
  if (cursor.projectId !== projectId || cursor.hostId !== parsed.hostId || cursor.provider !== parsed.provider) {
    throw new Error("External session cursor scope mismatch");
  }
  return cursor.afterId;
}

export interface ExternalSessionView {
  id: string;
  hostId: string;
  provider: string;
  nativeSessionId: string;
  revision: number;
  observation: ExternalSessionObservation;
  receivedAt: string;
  lastHeartbeatAt: string | null;
  collectorConnected: boolean;
  activityStale: boolean;
}
export interface ExternalSessionPage {
  schemaVersion: 1;
  sessions: ExternalSessionView[];
  nextCursor: string | null;
}
