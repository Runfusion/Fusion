import { EventEmitter } from "node:events";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import { AsyncMissionStore } from "./async-mission-store.js";
import { getFeature, getMilestone, getMission, getSlice } from "./async-mission-store-queries.js";
import type {
  IdeationCandidate, IdeationCandidateCreateInput, IdeationCandidateUpdateInput,
  IdeationConvergeInput, IdeationSession, IdeationSessionCreateInput, IdeationSessionWithCandidates,
} from "../ideation/ideation-types.js";
import {
  archiveIdeationSession, createIdeationCandidate, createIdeationSession, deleteIdeationSession,
  getIdeationCandidate, getIdeationSession, listIdeationCandidates, listIdeationSessions,
  persistIdeationConvergence, updateIdeationCandidate,
} from "./async-ideation-store-queries.js";

export interface IdeationStoreEvents {
  "session:created": [IdeationSession];
  "session:converged": [IdeationSession, IdeationCandidate];
  "session:archived": [IdeationSession];
  "candidate:created": [IdeationCandidate];
  "candidate:updated": [IdeationCandidate];
}

/**
 * PostgreSQL-backed bounded ideation sessions.
 *
 * FNXC:Ideation 2026-07-30-15:30:
 * Convergence is deliberately one `transactionImmediate` spanning the canonical
 * MissionStore handoff and ideation selection/linkage writes. Throwing from any
 * handoff step rolls back both domains, preventing an orphan Mission or a
 * falsely converged session.
 */
export class AsyncIdeationStore extends EventEmitter<IdeationStoreEvents> {
  private idSequence = 0;

  constructor(private readonly layer: AsyncDataLayer, private readonly missionStore: AsyncMissionStore) {
    super();
  }

  private generateId(prefix: "IS" | "IC"): string {
    this.idSequence += 1;
    return `${prefix}-${Date.now().toString(36).toUpperCase()}-${this.idSequence.toString(36).toUpperCase().padStart(4, "0")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  }

  async createSession(input: IdeationSessionCreateInput): Promise<IdeationSession> {
    const title = input.title.trim();
    if (!title) throw new Error("Ideation session title is required");
    const now = new Date().toISOString();
    const session: IdeationSession = { id: this.generateId("IS"), title, prompt: input.prompt?.trim() || undefined, status: "open", createdAt: now, updatedAt: now };
    await this.layer.transactionImmediate(async (tx) => createIdeationSession(tx, session));
    this.emit("session:created", session);
    return session;
  }

  async getSession(id: string): Promise<IdeationSession | undefined> { return getIdeationSession(this.layer.db, id); }
  async listSessions(): Promise<IdeationSession[]> { return listIdeationSessions(this.layer.db); }

  async getSessionWithCandidates(id: string): Promise<IdeationSessionWithCandidates | undefined> {
    const session = await this.getSession(id);
    return session ? { ...session, candidates: await this.listCandidates(id) } : undefined;
  }

  async addCandidate(sessionId: string, input: IdeationCandidateCreateInput): Promise<IdeationCandidate> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Ideation session ${sessionId} not found`);
    if (session.status !== "open") throw new Error(`Ideation session ${sessionId} is not open`);
    const content = input.content.trim();
    if (!content) throw new Error("Ideation candidate content is required");
    const now = new Date().toISOString();
    const candidate: IdeationCandidate = { id: this.generateId("IC"), sessionId, content, origin: input.origin, sourceRef: input.sourceRef?.trim() || undefined, selected: false, createdAt: now, updatedAt: now };
    await this.layer.transactionImmediate(async (tx) => createIdeationCandidate(tx, candidate));
    this.emit("candidate:created", candidate);
    return candidate;
  }

  async listCandidates(sessionId: string): Promise<IdeationCandidate[]> { return listIdeationCandidates(this.layer.db, sessionId); }

  async updateCandidate(id: string, input: IdeationCandidateUpdateInput): Promise<IdeationCandidate> {
    const current = await getIdeationCandidate(this.layer.db, id);
    if (!current) throw new Error(`Ideation candidate ${id} not found`);
    const session = await this.getSession(current.sessionId);
    if (!session || session.status !== "open") throw new Error(`Ideation candidate ${id} cannot be changed after convergence`);
    const candidate: IdeationCandidate = { ...current, ...input, content: input.content === undefined ? current.content : input.content.trim(), sourceRef: input.sourceRef === undefined ? current.sourceRef : input.sourceRef?.trim() || undefined, updatedAt: new Date().toISOString() };
    if (!candidate.content) throw new Error("Ideation candidate content is required");
    const updated = await this.layer.transactionImmediate(async (tx) => updateIdeationCandidate(tx, candidate));
    this.emit("candidate:updated", updated);
    return updated;
  }

  async convergeSession(sessionId: string, candidateId: string, input: IdeationConvergeInput = {}): Promise<IdeationSessionWithCandidates> {
    const result = await this.layer.transactionImmediate(async (tx) => {
      const session = await getIdeationSession(tx, sessionId);
      if (!session) throw new Error(`Ideation session ${sessionId} not found`);
      if (session.status !== "open") throw new Error(`Ideation session ${sessionId} is already ${session.status}`);
      const candidate = await getIdeationCandidate(tx, candidateId);
      if (!candidate || candidate.sessionId !== sessionId) throw new Error(`Ideation candidate ${candidateId} does not belong to session ${sessionId}`);

      let missionId = input.targetMissionId;
      if (missionId) {
        const mission = await getMission(tx, missionId);
        if (!mission) throw new Error(`Mission ${missionId} not found`);
      } else {
        const mission = await this.missionStore.createMission({ title: candidate.content.slice(0, 200), description: session.prompt ? `${session.prompt}\n\n${candidate.content}` : candidate.content }, tx);
        missionId = mission.id;
      }

      if (input.targetFeatureId) {
        const feature = await getFeature(tx, input.targetFeatureId);
        if (!feature) throw new Error(`Feature ${input.targetFeatureId} not found`);
        const slice = await getSlice(tx, feature.sliceId);
        const milestone = slice ? await getMilestone(tx, slice.milestoneId) : undefined;
        if (!milestone || milestone.missionId !== missionId) throw new Error(`Feature ${input.targetFeatureId} does not belong to mission ${missionId}`);
      }

      const now = new Date().toISOString();
      const converged: IdeationSession = { ...session, status: "converged", targetMissionId: missionId, targetFeatureId: input.targetFeatureId, convergedAt: now, updatedAt: now };
      const selected: IdeationCandidate = { ...candidate, selected: true, linkedMissionId: missionId, linkedFeatureId: input.targetFeatureId, updatedAt: now };
      await persistIdeationConvergence(tx, converged, selected);
      return { session: converged, candidate: selected };
    });
    this.emit("session:converged", result.session, result.candidate);
    return { ...result.session, candidates: await this.listCandidates(sessionId) };
  }

  async archiveSession(id: string): Promise<IdeationSession> {
    const session = await this.getSession(id);
    if (!session) throw new Error(`Ideation session ${id} not found`);
    const archived = await this.layer.transactionImmediate(async (tx) => archiveIdeationSession(tx, { ...session, status: "archived", updatedAt: new Date().toISOString() }));
    this.emit("session:archived", archived);
    return archived;
  }

  async deleteSession(id: string): Promise<void> {
    await this.layer.transactionImmediate(async (tx) => deleteIdeationSession(tx, id));
  }

  /** Allows future canonical operations to join this store's write boundary. */
  async transactionImmediate<T>(callback: (tx: DbTransaction) => Promise<T>): Promise<T> { return this.layer.transactionImmediate(callback); }
}
