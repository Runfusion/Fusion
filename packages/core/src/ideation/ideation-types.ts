/**
 * Persisted ideation domain types.
 *
 * FNXC:Ideation 2026-07-30-15:30:
 * An idea must remain a bounded, project-scoped session until an explicitly
 * selected candidate converges into the canonical Mission hierarchy. Persisted
 * linkage prevents a successful handoff from degrading into orphan prose.
 */

export const IDEATION_SESSION_STATUSES = ["open", "converged", "archived"] as const;
export type IdeationSessionStatus = (typeof IDEATION_SESSION_STATUSES)[number];

export const IDEATION_CANDIDATE_ORIGINS = ["agent", "human", "research"] as const;
export type IdeationCandidateOrigin = (typeof IDEATION_CANDIDATE_ORIGINS)[number];

export interface IdeationSession {
  id: string;
  title: string;
  prompt?: string;
  status: IdeationSessionStatus;
  /** Canonical Mission selected or created when the session converges. */
  targetMissionId?: string;
  /** Optional canonical Feature selected as the handoff destination. */
  targetFeatureId?: string;
  createdAt: string;
  updatedAt: string;
  convergedAt?: string;
}

export interface IdeationCandidate {
  id: string;
  sessionId: string;
  content: string;
  origin: IdeationCandidateOrigin;
  sourceRef?: string;
  selected: boolean;
  linkedMissionId?: string;
  linkedFeatureId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IdeationSessionCreateInput {
  title: string;
  prompt?: string;
}

export interface IdeationCandidateCreateInput {
  content: string;
  origin: IdeationCandidateOrigin;
  sourceRef?: string;
}

export interface IdeationCandidateUpdateInput {
  content?: string;
  origin?: IdeationCandidateOrigin;
  sourceRef?: string;
}

export interface IdeationConvergeInput {
  /** Attach to an existing mission instead of creating a new Mission. */
  targetMissionId?: string;
  /** Optional existing Feature within the target mission. */
  targetFeatureId?: string;
}

export interface IdeationSessionWithCandidates extends IdeationSession {
  candidates: IdeationCandidate[];
}
