import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import { ExternalSessionReader } from "./reader.js";
import { externalSessionIdentifier } from "./contract.js";
import { externalSessionReadId } from "./read-contract.js";
import { redactSecrets } from "../secrets/redact-secrets.js";

export const feedbackSubmitSchema = z.object({ commandId: z.string().uuid(), generation: externalSessionIdentifier, text: z.string().trim().min(1).max(8000) }).strict();
export const feedbackClaimSchema = z.object({ sessionId: externalSessionReadId, generation: externalSessionIdentifier }).strict();
export const feedbackAckSchema = feedbackClaimSchema.extend({ commandId: z.string().uuid(), status: z.enum(["delivered", "uncertain"]) }).strict();
type Row = { id: string; session_id: string; generation: string; text: string; fingerprint: string; state: string; created_at: string; expires_at: string; delivered_at: string | null };
export class ExternalFeedbackConflict extends Error {}
const receipt = (r: Row, now: string) => ({ commandId: r.id, status: r.state === "queued" && r.expires_at <= now ? "expired" : r.state === "claimed" ? "uncertain" : r.state, createdAt: r.created_at, expiresAt: r.expires_at, deliveredAt: r.delivered_at });

export class ExternalSessionFeedback {
  constructor(private layer: AsyncDataLayer, private projectId: string) {
    if (layer.projectId !== projectId) throw new Error("Feedback requires matching project storage");
  }
  async list(sessionId: string, now = new Date().toISOString()) {
    const rows = await this.layer.db.execute(sql`SELECT * FROM project.external_session_feedback WHERE project_id=${this.projectId} AND session_id=${sessionId} ORDER BY created_at DESC, id DESC LIMIT 20`);
    return (rows as unknown as Row[]).map(r => receipt(r, now));
  }
  async submit(sessionId: string, value: unknown, now = new Date().toISOString()) {
    const b = feedbackSubmitSchema.parse(value);
    const text = redactSecrets(b.text).slice(0, 8000);
    const fingerprint = createHash("sha256").update(JSON.stringify([sessionId, b.generation, text])).digest("hex");
    return this.layer.transactionImmediate(async tx => {
      // Serializes the bounded queue for one native identity, including concurrent double clicks.
      await tx.execute(sql`SELECT id FROM project.external_sessions WHERE project_id=${this.projectId} AND id=${sessionId} FOR UPDATE`);
      const existing = (await tx.execute(sql`SELECT * FROM project.external_session_feedback WHERE project_id=${this.projectId} AND id=${b.commandId}`))[0] as unknown as Row | undefined;
      if (existing) { if (existing.fingerprint !== fingerprint) throw new ExternalFeedbackConflict("Feedback id already used"); return receipt(existing, now); }
      const s = await new ExternalSessionReader({ ...this.layer, db: tx } as AsyncDataLayer, this.projectId).get(sessionId, Date.parse(now));
      if (!s || !s.collectorConnected || ["completed", "failed"].includes(s.observation.activity) || s.observation.feedback?.generation !== b.generation || s.observation.feedback.expiresAt <= now) throw new ExternalFeedbackConflict("Agent is offline or native feedback is unavailable");
      await tx.execute(sql`UPDATE project.external_session_feedback SET state='expired', text='' WHERE project_id=${this.projectId} AND session_id=${sessionId} AND state='queued' AND (expires_at<=${now} OR generation<>${b.generation})`);
      const queued = await tx.execute(sql`SELECT id FROM project.external_session_feedback WHERE project_id=${this.projectId} AND session_id=${sessionId} AND state='queued' LIMIT 20`);
      if (queued.length >= 20) throw new ExternalFeedbackConflict("Agent feedback queue is full");
      const expires = new Date(Date.parse(now) + 300_000).toISOString();
      const rows = await tx.execute(sql`INSERT INTO project.external_session_feedback (project_id,id,session_id,generation,text,fingerprint,state,created_at,expires_at) VALUES (${this.projectId},${b.commandId},${sessionId},${b.generation},${text},${fingerprint},'queued',${now},${expires}) RETURNING *`);
      return receipt(rows[0] as unknown as Row, now);
    });
  }
  async claim(hostId: string, value: unknown, now = new Date().toISOString()) {
    const b = feedbackClaimSchema.parse(value);
    return this.layer.transactionImmediate(async tx => {
      await tx.execute(sql`SELECT id FROM project.external_sessions WHERE project_id=${this.projectId} AND id=${b.sessionId} FOR UPDATE`);
      const s = await new ExternalSessionReader({ ...this.layer, db: tx } as AsyncDataLayer, this.projectId).get(b.sessionId, Date.parse(now));
      if (!s || !s.collectorConnected || s.hostId !== hostId || ["completed", "failed"].includes(s.observation.activity) || s.observation.feedback?.generation !== b.generation || s.observation.feedback.expiresAt <= now) return { command: null };
      await tx.execute(sql`UPDATE project.external_session_feedback SET state='expired', text='' WHERE project_id=${this.projectId} AND session_id=${b.sessionId} AND state='queued' AND (expires_at<=${now} OR generation<>${b.generation})`);
      const rows = await tx.execute(sql`SELECT * FROM project.external_session_feedback WHERE project_id=${this.projectId} AND session_id=${b.sessionId} AND generation=${b.generation} AND state='queued' AND expires_at>${now} ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      const r = rows[0] as unknown as Row | undefined; if (!r) return { command: null };
      // FNXC:RemoteAgents 2026-09-18-05:22: A lost claim response becomes uncertain. A native hook never receives this command again automatically.
      await tx.execute(sql`UPDATE project.external_session_feedback SET state='claimed' WHERE project_id=${this.projectId} AND id=${r.id} AND session_id=${b.sessionId}`);
      return { command: { commandId: r.id, sessionId: b.sessionId, hostId, nativeSessionId: s.nativeSessionId, provider: s.provider, generation: r.generation, text: r.text, expiresAt: r.expires_at } };
    });
  }
  async acknowledge(hostId: string, value: unknown, now = new Date().toISOString()) {
    const b = feedbackAckSchema.parse(value);
    const s = await new ExternalSessionReader(this.layer, this.projectId).get(b.sessionId);
    if (!s || s.hostId !== hostId) throw new ExternalFeedbackConflict("Feedback host scope mismatch");
    const rows = await this.layer.db.execute(sql`UPDATE project.external_session_feedback SET state=${b.status}, delivered_at=${b.status === "delivered" ? now : null}, text='' WHERE project_id=${this.projectId} AND id=${b.commandId} AND session_id=${b.sessionId} AND generation=${b.generation} AND state='claimed' RETURNING id`);
    return { acknowledged: rows.length > 0 };
  }
}
