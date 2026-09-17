import { createHash } from "node:crypto";
import { z } from "zod";

function containsControlCharacters(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
export const externalSessionIdentifier = z.string().min(1).max(256).refine(value => value.trim() === value && !containsControlCharacters(value));
const counter = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const displayText = (max: number) => z.string().max(max).refine(value => !containsControlCharacters(value));

/**
 * FNXC:ExternalSessions 2026-09-17-04:00:
 * Native identity is host/provider/native id within a Fusion project. Paths and titles are
 * display metadata only. Observations cannot enroll tasks, claim runtime ownership, or grant controls.
 * Provider names are open identifiers; this public contract never names a particular collector.
 */
export const externalSessionObservationSchema = z.object({
  provider: externalSessionIdentifier,
  nativeSessionId: externalSessionIdentifier,
  revision: counter,
  activity: z.enum(["working", "waiting", "completed", "failed", "unknown"]),
  observedAt: z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString()),
  title: displayText(512).optional(),
  projectPath: displayText(4096).optional(),
}).strict();

export const externalSessionIngestionSchema = z.object({
  schemaVersion: z.literal(1),
  streamId: externalSessionIdentifier,
  sequence: counter,
  eventId: externalSessionIdentifier,
  collectorVersion: externalSessionIdentifier,
  session: externalSessionObservationSchema,
}).strict();

export const externalSessionHeartbeatSchema = z.object({
  schemaVersion: z.literal(1),
  collectorVersion: externalSessionIdentifier,
}).strict();

export type ExternalSessionObservation = z.infer<typeof externalSessionObservationSchema>;
export type ExternalSessionIngestion = z.infer<typeof externalSessionIngestionSchema>;
export interface ExternalSessionPrincipal { projectId: string; hostId: string }
export interface ExternalSessionAcknowledgement {
  schemaVersion: 1;
  streamId: string;
  acknowledgedSequence: number;
  sessionId: string;
  applied: boolean;
}

export function externalSessionId(principal: ExternalSessionPrincipal, session: Pick<ExternalSessionObservation, "provider" | "nativeSessionId">): string {
  return createHash("sha256").update(JSON.stringify([principal.projectId, principal.hostId, session.provider, session.nativeSessionId])).digest("hex");
}

/** Canonicalized validated data gives retries the same digest even when JSON key order differs. */
export function externalSessionDigest(value: ExternalSessionObservation | ExternalSessionIngestion): string {
  const canonical = "session" in value
    ? externalSessionIngestionSchema.parse(value)
    : externalSessionObservationSchema.parse(value);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Host connectivity and agent activity are independent signals, using distinct clocks. */
export function externalSessionFreshness(observation: ExternalSessionObservation, heartbeatAt: string | null, now: number, staleAfterMs = 60_000) {
  return {
    collectorConnected: heartbeatAt !== null && now - Date.parse(heartbeatAt) < staleAfterMs,
    activityStale: (observation.activity === "working" || observation.activity === "waiting")
      && now - Date.parse(observation.observedAt) >= staleAfterMs,
  };
}

export class ExternalSessionConflict extends Error {
  constructor(readonly code: "sequence-gap" | "sequence-conflict" | "revision-conflict" | "stream-limit", readonly acknowledgedSequence?: number) {
    super(code);
  }
}
