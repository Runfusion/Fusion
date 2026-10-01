import { createHash } from "node:crypto";
import { z } from "zod";

function containsControlCharacters(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
export const externalSessionIdentifier = z.string().min(1).max(256).refine(value => value.trim() === value && !containsControlCharacters(value));
const counter = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const displayText = (max: number) => z.string().max(max).refine(value => !containsControlCharacters(value));
const tokenCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/*
 * FNXC:ExternalSessions 2026-09-23-11:31:
 * External timestamps must describe real instants. Zod's datetime syntax check accepts impossible
 * offsets that JavaScript cannot parse, so validate parseability before any ISO normalization.
 */
const isoInstant = z.string().datetime({ offset: true }).refine(value => !Number.isNaN(Date.parse(value)));
const canonicalInstant = isoInstant.transform(value => new Date(value).toISOString());
export const externalSessionUsageSchema = z.object({
  model: externalSessionIdentifier, inputTokens: tokenCount, cachedInputTokens: tokenCount,
  cacheWriteTokens: tokenCount, cacheWriteHourTokens: tokenCount, outputTokens: tokenCount,
  reasoningTokens: tokenCount.nullable(), fast: z.boolean(), longContext: z.boolean(),
}).strict();

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
  observedAt: canonicalInstant,
  title: displayText(512).optional(),
  projectPath: displayText(4096).optional(),
  // FNXC:RemoteAgents 2026-09-18-05:22: Standalone collectors supply bounded native activity and deduplicated usage snapshots. Native hooks advertise a fenced generation; no AgentPulse service participates.
  model: externalSessionIdentifier.optional(),
  usage: z.array(externalSessionUsageSchema).max(64).optional(),
  usageComplete: z.boolean().optional(),
  recentActivity: z.array(z.object({ kind: z.enum(["prompt", "response", "tool"]), at: isoInstant, text: z.string().max(2048) }).strict()).max(10).optional(),
  feedback: z.object({ generation: externalSessionIdentifier, expiresAt: canonicalInstant }).strict().optional(),
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

/** Canonicalize validated metadata without revalidating text that redaction can expand. */
export function externalSessionDigest(value: ExternalSessionObservation | ExternalSessionIngestion): string {
  const canonical = JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Host connectivity and agent activity are independent signals, using distinct clocks. */
export function externalSessionHostConnected(heartbeatAt: string | null, now: number, staleAfterMs = 60_000) {
  return heartbeatAt !== null && now - Date.parse(heartbeatAt) < staleAfterMs;
}
export function externalSessionFreshness(observation: ExternalSessionObservation, heartbeatAt: string | null, now: number, staleAfterMs = 60_000) {
  return {
    collectorConnected: externalSessionHostConnected(heartbeatAt, now, staleAfterMs),
    activityStale: (observation.activity === "working" || observation.activity === "waiting")
      && now - Date.parse(observation.observedAt) >= staleAfterMs,
  };
}

export class ExternalSessionConflict extends Error {
  constructor(readonly code: "sequence-gap" | "sequence-conflict" | "revision-conflict" | "stream-limit", readonly acknowledgedSequence?: number) {
    super(code);
  }
}
