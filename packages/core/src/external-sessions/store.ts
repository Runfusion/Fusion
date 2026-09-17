import { and, eq, lt, sql } from "drizzle-orm";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import { externalSessionHosts, externalSessionStreams, externalSessions } from "../postgres/schema/project.js";
import { redactSecrets } from "../secrets/redact-secrets.js";
import {
  externalSessionIdentifier, externalSessionIngestionSchema, externalSessionHeartbeatSchema,
  externalSessionId, externalSessionDigest, ExternalSessionConflict,
  type ExternalSessionPrincipal, type ExternalSessionAcknowledgement,
} from "./contract.js";

/**
 * FNXC:ExternalSessions 2026-09-17-04:00:
 * The observation and stream position commit atomically. A lost response can be retried after
 * restart without creating tasks or regressing state. One locked host row serializes streams
 * for that principal. A stream is a durable spool, not a process lifetime; only 16 are allowed
 * per host/project so callers cannot create an unbounded receipt ledger. Keep positions on rollback.
 */
export class ExternalSessionStore {
  constructor(private readonly layer: AsyncDataLayer, private readonly principal: ExternalSessionPrincipal) {
    externalSessionIdentifier.parse(principal.projectId);
    externalSessionIdentifier.parse(principal.hostId);
    if (layer.projectId !== principal.projectId) throw new Error("External sessions require a matching project-bound data layer");
  }

  async heartbeat(value: unknown, now = new Date().toISOString()): Promise<void> {
    const { collectorVersion } = externalSessionHeartbeatSchema.parse(value);
    await this.layer.db.insert(externalSessionHosts).values({ ...this.principal, collectorVersion, lastHeartbeatAt: now })
      .onConflictDoUpdate({ target: [externalSessionHosts.projectId, externalSessionHosts.hostId],
        set: { collectorVersion, lastHeartbeatAt: now },
        setWhere: sql`${externalSessionHosts.lastHeartbeatAt} IS NULL OR ${externalSessionHosts.lastHeartbeatAt} < ${now}` });
  }

  async ingest(value: unknown): Promise<ExternalSessionAcknowledgement> {
    const input = externalSessionIngestionSchema.parse(value);
    const sessionId = externalSessionId(this.principal, input.session);
    const digest = externalSessionDigest(input);
    const observationDigest = externalSessionDigest(input.session);
    const receivedAt = new Date().toISOString();
    const { projectId, hostId } = this.principal;
    const hostScope = and(eq(externalSessionHosts.projectId, projectId), eq(externalSessionHosts.hostId, hostId));
    const streamScope = and(eq(externalSessionStreams.projectId, projectId), eq(externalSessionStreams.hostId, hostId), eq(externalSessionStreams.streamId, input.streamId));
    return this.layer.transactionImmediate(async tx => {
      // Replay/backfill creates an observed host but never fabricates a heartbeat.
      await tx.insert(externalSessionHosts).values({ projectId, hostId, collectorVersion: input.collectorVersion }).onConflictDoNothing();
      await tx.select().from(externalSessionHosts).where(hostScope).for("update");
      let [stream] = await tx.select().from(externalSessionStreams).where(streamScope);
      if (!stream) {
        const streams = await tx.select({ streamId: externalSessionStreams.streamId }).from(externalSessionStreams)
          .where(and(eq(externalSessionStreams.projectId, projectId), eq(externalSessionStreams.hostId, hostId))).limit(16);
        if (streams.length >= 16) throw new ExternalSessionConflict("stream-limit");
        [stream] = await tx.insert(externalSessionStreams).values({ projectId, hostId, streamId: input.streamId }).returning();
      }
      if (input.sequence <= stream.acknowledgedSequence) {
        if (input.sequence === stream.acknowledgedSequence && digest !== stream.lastEventDigest) {
          throw new ExternalSessionConflict("sequence-conflict", stream.acknowledgedSequence);
        }
        return { schemaVersion: 1, streamId: input.streamId, acknowledgedSequence: stream.acknowledgedSequence, sessionId, applied: false };
      }
      if (input.sequence !== stream.acknowledgedSequence + 1) throw new ExternalSessionConflict("sequence-gap", stream.acknowledgedSequence);
      const scope = and(eq(externalSessions.projectId, projectId), eq(externalSessions.id, sessionId));
      const [previous] = await tx.select().from(externalSessions).where(scope);
      if (previous?.revision === input.session.revision && previous.observationDigest !== observationDigest) {
        throw new ExternalSessionConflict("revision-conflict", stream.acknowledgedSequence);
      }
      const observation = { ...input.session,
        ...(input.session.title !== undefined ? { title: redactSecrets(input.session.title) } : {}),
        ...(input.session.projectPath !== undefined ? { projectPath: redactSecrets(input.session.projectPath) } : {}),
      };
      const applied = await tx.insert(externalSessions).values({ projectId, id: sessionId, hostId,
        provider: observation.provider, nativeSessionId: observation.nativeSessionId,
        revision: observation.revision, observation, observationDigest, receivedAt })
        .onConflictDoUpdate({ target: [externalSessions.projectId, externalSessions.id],
          set: { revision: observation.revision, observation, observationDigest, receivedAt },
          setWhere: lt(externalSessions.revision, observation.revision) }).returning({ id: externalSessions.id });
      await tx.update(externalSessionStreams).set({ acknowledgedSequence: input.sequence,
        lastEventId: input.eventId, lastEventDigest: digest, acknowledgedAt: receivedAt }).where(streamScope);
      return { schemaVersion: 1, streamId: input.streamId, acknowledgedSequence: input.sequence, sessionId, applied: applied.length > 0 };
    });
  }

  async get(id: string) {
    const [row] = await this.layer.db.select().from(externalSessions)
      .where(and(eq(externalSessions.projectId, this.principal.projectId), eq(externalSessions.hostId, this.principal.hostId), eq(externalSessions.id, id)));
    return row ?? null;
  }

  async getHost() {
    const [row] = await this.layer.db.select().from(externalSessionHosts)
      .where(and(eq(externalSessionHosts.projectId, this.principal.projectId), eq(externalSessionHosts.hostId, this.principal.hostId)));
    return row ?? null;
  }
}
