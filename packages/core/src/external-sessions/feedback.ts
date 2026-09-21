import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, lte, ne, or } from "drizzle-orm";
import { z } from "zod";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import { externalSessionFeedback, externalSessions } from "../postgres/schema/project.js";
import { ExternalSessionReader } from "./reader.js";
import { externalSessionIdentifier } from "./contract.js";
import { externalSessionReadId } from "./read-contract.js";
import { redactSecrets } from "../secrets/redact-secrets.js";

export const feedbackSubmitSchema = z.object({ commandId: z.string().uuid(), generation: externalSessionIdentifier, text: z.string().trim().min(1).max(8000) }).strict();
export const feedbackClaimSchema = z.object({ sessionId: externalSessionReadId, generation: externalSessionIdentifier }).strict();
export const feedbackAckSchema = feedbackClaimSchema.extend({ commandId: z.string().uuid(), status: z.enum(["delivered", "uncertain"]) }).strict();
type Row = typeof externalSessionFeedback.$inferSelect;
export class ExternalFeedbackConflict extends Error {}
const receipt = (r: Row, now: string) => ({ commandId: r.id, status: r.state === "queued" && r.expiresAt <= now ? "expired" : r.state === "claimed" ? "uncertain" : r.state, createdAt: r.createdAt, expiresAt: r.expiresAt, deliveredAt: r.deliveredAt });

export class ExternalSessionFeedback {
  constructor(private layer: AsyncDataLayer, private projectId: string) {
    if (layer.projectId !== projectId) throw new Error("Feedback requires matching project storage");
  }
  async list(sessionId: string, now = new Date().toISOString()) {
    const rows = await this.layer.db.select().from(externalSessionFeedback)
      .where(and(eq(externalSessionFeedback.projectId, this.projectId), eq(externalSessionFeedback.sessionId, sessionId)))
      .orderBy(desc(externalSessionFeedback.createdAt), desc(externalSessionFeedback.id)).limit(20);
    return rows.map(r => receipt(r, now));
  }
  async submit(sessionId: string, value: unknown, now = new Date().toISOString()) {
    const b = feedbackSubmitSchema.parse(value);
    const text = redactSecrets(b.text).slice(0, 8000);
    const fingerprint = createHash("sha256").update(JSON.stringify([sessionId, b.generation, text])).digest("hex");
    return this.layer.transactionImmediate(async tx => {
      // Serializes the bounded queue for one native identity, including concurrent double clicks.
      await tx.select({ id: externalSessions.id }).from(externalSessions)
        .where(and(eq(externalSessions.projectId, this.projectId), eq(externalSessions.id, sessionId))).for("update");
      const [existing] = await tx.select().from(externalSessionFeedback)
        .where(and(eq(externalSessionFeedback.projectId, this.projectId), eq(externalSessionFeedback.id, b.commandId))).limit(1);
      if (existing) { if (existing.fingerprint !== fingerprint) throw new ExternalFeedbackConflict("Feedback id already used"); return receipt(existing, now); }
      const s = await new ExternalSessionReader({ ...this.layer, db: tx } as AsyncDataLayer, this.projectId).get(sessionId, Date.parse(now));
      if (!s || !s.collectorConnected || ["completed", "failed"].includes(s.observation.activity) || s.observation.feedback?.generation !== b.generation || s.observation.feedback.expiresAt <= now) throw new ExternalFeedbackConflict("Agent is offline or native feedback is unavailable");
      await tx.update(externalSessionFeedback).set({ state: "expired", text: "" }).where(and(
        eq(externalSessionFeedback.projectId, this.projectId), eq(externalSessionFeedback.sessionId, sessionId),
        eq(externalSessionFeedback.state, "queued"), or(lte(externalSessionFeedback.expiresAt, now), ne(externalSessionFeedback.generation, b.generation)),
      ));
      const queued = await tx.select({ id: externalSessionFeedback.id }).from(externalSessionFeedback).where(and(
        eq(externalSessionFeedback.projectId, this.projectId), eq(externalSessionFeedback.sessionId, sessionId), eq(externalSessionFeedback.state, "queued"),
      )).limit(20);
      if (queued.length >= 20) throw new ExternalFeedbackConflict("Agent feedback queue is full");
      const expires = new Date(Date.parse(now) + 300_000).toISOString();
      const [row] = await tx.insert(externalSessionFeedback).values({ projectId: this.projectId, id: b.commandId, sessionId, generation: b.generation, text, fingerprint, state: "queued", createdAt: now, expiresAt: expires }).returning();
      return receipt(row, now);
    });
  }
  async claim(hostId: string, value: unknown, now = new Date().toISOString()) {
    const b = feedbackClaimSchema.parse(value);
    return this.layer.transactionImmediate(async tx => {
      await tx.select({ id: externalSessions.id }).from(externalSessions)
        .where(and(eq(externalSessions.projectId, this.projectId), eq(externalSessions.id, b.sessionId))).for("update");
      const s = await new ExternalSessionReader({ ...this.layer, db: tx } as AsyncDataLayer, this.projectId).get(b.sessionId, Date.parse(now));
      if (!s || !s.collectorConnected || s.hostId !== hostId || ["completed", "failed"].includes(s.observation.activity) || s.observation.feedback?.generation !== b.generation || s.observation.feedback.expiresAt <= now) return { command: null };
      await tx.update(externalSessionFeedback).set({ state: "expired", text: "" }).where(and(
        eq(externalSessionFeedback.projectId, this.projectId), eq(externalSessionFeedback.sessionId, b.sessionId),
        eq(externalSessionFeedback.state, "queued"), or(lte(externalSessionFeedback.expiresAt, now), ne(externalSessionFeedback.generation, b.generation)),
      ));
      const [r] = await tx.select().from(externalSessionFeedback).where(and(
        eq(externalSessionFeedback.projectId, this.projectId), eq(externalSessionFeedback.sessionId, b.sessionId),
        eq(externalSessionFeedback.generation, b.generation), eq(externalSessionFeedback.state, "queued"), gt(externalSessionFeedback.expiresAt, now),
      )).orderBy(asc(externalSessionFeedback.createdAt), asc(externalSessionFeedback.id)).limit(1).for("update", { skipLocked: true });
      if (!r) return { command: null };
      // FNXC:RemoteAgents 2026-09-18-05:22: A lost claim response becomes uncertain. A native hook never receives this command again automatically.
      await tx.update(externalSessionFeedback).set({ state: "claimed" }).where(and(
        eq(externalSessionFeedback.projectId, this.projectId), eq(externalSessionFeedback.id, r.id), eq(externalSessionFeedback.sessionId, b.sessionId),
      ));
      return { command: { commandId: r.id, sessionId: b.sessionId, hostId, nativeSessionId: s.nativeSessionId, provider: s.provider, generation: r.generation, text: r.text, expiresAt: r.expiresAt } };
    });
  }
  async acknowledge(hostId: string, value: unknown, now = new Date().toISOString()) {
    const b = feedbackAckSchema.parse(value);
    const s = await new ExternalSessionReader(this.layer, this.projectId).get(b.sessionId);
    if (!s || s.hostId !== hostId) throw new ExternalFeedbackConflict("Feedback host scope mismatch");
    // FNXC:RemoteAgents 2026-09-21-04:51: Keep every feedback predicate in Drizzle's parameterized builder so session text and identities never become SQL source.
    const rows = await this.layer.db.update(externalSessionFeedback).set({ state: b.status, deliveredAt: b.status === "delivered" ? now : null, text: "" }).where(and(
      eq(externalSessionFeedback.projectId, this.projectId), eq(externalSessionFeedback.id, b.commandId),
      eq(externalSessionFeedback.sessionId, b.sessionId), eq(externalSessionFeedback.generation, b.generation), eq(externalSessionFeedback.state, "claimed"),
    )).returning({ id: externalSessionFeedback.id });
    return { acknowledged: rows.length > 0 };
  }
}
