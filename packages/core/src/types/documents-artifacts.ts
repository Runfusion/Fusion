/**
 * FNXC:CodeOrganization 2026-07-21-12:00:
 * Task documents, artifacts, review-artifact helpers, native structure, and goal citations peeled from types.ts.
 */

import type { ReviewArtifactsMode } from "./execution-and-ui.js";

export interface TaskDocument {
  /** UUID primary key */
  id: string;
  /** Task this document belongs to */
  taskId: string;
  /** Document key (e.g., "plan", "notes", "research"). Alphanumeric, hyphens, underscores. */
  key: string;
  /** Document body content */
  content: string;
  /** Monotonically increasing revision number (starts at 1) */
  revision: number;
  /** SHA-256 of exact UTF-8 content, formatted `sha256:<64 lowercase hex>`. */
  contentHash: string;
  /** Who created/last-edited this revision: "user" | "agent" | "system" */
  author: string;
  /** Optional extensible metadata (JSON object) */
  metadata?: Record<string, unknown>;
  /** ISO-8601 creation timestamp */
  createdAt: string;
  /** ISO-8601 last-update timestamp */
  updatedAt: string;
}

export interface TaskDocumentRevision {
  /** Auto-increment row ID */
  id: number;
  /** Task this revision belongs to */
  taskId: string;
  /** Document key */
  key: string;
  /** Snapshot of document content at this revision */
  content: string;
  /** Revision number of this snapshot */
  revision: number;
  /** Author who created this revision */
  author: string;
  /** Optional metadata snapshot */
  metadata?: Record<string, unknown>;
  /** ISO-8601 timestamp when this revision was archived */
  createdAt: string;
}

export interface TaskDocumentCreateInput {
  /** Document key. Must match /^[a-zA-Z0-9_-]{1,64}$/ */
  key: string;
  /** Document body content */
  content: string;
  /** Author (defaults to "user" if not provided) */
  author?: string;
  /** Optional extensible metadata */
  metadata?: Record<string, unknown>;
  /** CAS expectation. Zero requires absence; positive values require an existing matching revision. */
  expectedRevision?: number;
  /** CAS expectation requiring an existing document with this canonical SHA-256 content hash. */
  expectedContentHash?: string;
}

/**
 * FNXC:ArchivedTaskDocumentPublication 2026-07-20-15:36:
 * Archived evidence can only gain an operator-attributed correction through a dedicated additive contract. The caller supplies no replacement content or parent metadata, and both exact-current CAS expectations plus a non-empty audit reason are mandatory. This contract is intentionally absent from agent document-write tools.
 */
export interface ArchivedTaskDocumentAdditionInput {
  /** Existing document key. Must match the ordinary task-document key grammar. */
  key: string;
  /** Non-empty bytes appended after the canonical archived-addition boundary. */
  appendContent: string;
  /** Existing positive revision that must still be current under the transaction lock. */
  expectedRevision: number;
  /** Canonical SHA-256 hash of the exact current UTF-8 content. */
  expectedContentHash: string;
  /** Non-empty operator attribution persisted on the new current revision. */
  author: string;
  /** Non-empty operator justification used only in ids/outcomes-only audit metadata. */
  reason: string;
}

export interface ArchivedTaskDocumentAdditionResult {
  document: TaskDocument;
  previousRevision: number;
  previousContentHash: string;
  appendedContentHash: string;
}

/**
 * TaskDocument extended with its parent task metadata for display in the documents view.
 */
export interface TaskDocumentWithTask extends TaskDocument {
  /** Title of the parent task */
  taskTitle?: string;
  /** Description of the parent task */
  taskDescription?: string;
  /** Column of the parent task (e.g., "triage", "todo", "in-progress", "done", "in-review", "archived") */
  taskColumn?: string;
}

/** Supported artifact media classes for the persisted artifact registry. */
export type ArtifactType = "document" | "image" | "video" | "audio" | "other";

/**
 * FNXC:ReportPipeline 2026-07-19-10:00:
 * Report screenshots are local image artifacts with this explicit provenance.
 * Only the reference may reach report egress; screenshot pixels never do.
 */
export const REPORT_ATTACHMENT_SOURCE = "report-attachment";

/**
 * FNXC:ArtifactRegistry 2026-06-19-22:04:
 * Agents need a first-class registry for multi-type artifacts that are visible across agents and tasks. Store binary media on disk and persist only metadata plus relative URIs in SQLite so query paths stay lightweight and never inline binary bytes.
 */
export interface Artifact {
  /** UUID primary key */
  id: string;
  /** Artifact media class used for filtering and presentation */
  type: ArtifactType;
  /** Human-readable artifact title */
  title: string;
  /** Optional longer description or caption */
  description?: string;
  /** Optional MIME type for inline text or binary media */
  mimeType?: string;
  /** Optional content size in bytes, set from binary data when persisted on disk */
  sizeBytes?: number;
  /** Relative stored path; task artifacts are anchored at the task dir, while task-less registry artifacts are anchored at `.fusion/` */
  uri?: string;
  /** Optional inline text body for text/document artifacts */
  content?: string;
  /** Agent, user, or system identifier that registered the artifact */
  authorId: string;
  /** Class of actor that registered the artifact */
  authorType: "agent" | "user" | "system";
  /** Optional task this artifact is associated with */
  taskId?: string;
  /** Optional extensible metadata (JSON object) */
  metadata?: Record<string, unknown>;
  /** ISO-8601 creation timestamp */
  createdAt: string;
  /** ISO-8601 last-update timestamp */
  updatedAt: string;
}

export interface ArtifactCreateInput {
  /** Artifact media class used for filtering and presentation */
  type: ArtifactType;
  /** Human-readable artifact title */
  title: string;
  /** Optional longer description or caption */
  description?: string;
  /** Optional MIME type for inline text or binary media */
  mimeType?: string;
  /** Optional content size in bytes for inline or externally referenced content */
  sizeBytes?: number;
  /** Optional relative URI when content is already stored outside SQLite */
  uri?: string;
  /** Optional inline text body for text/document artifacts */
  content?: string;
  /** Agent, user, or system identifier registering the artifact */
  authorId: string;
  /** Class of actor registering the artifact */
  authorType: "agent" | "user" | "system";
  /** Optional task this artifact is associated with */
  taskId?: string;
  /** Optional extensible metadata (JSON object) */
  metadata?: Record<string, unknown>;
  /** Optional binary payload; the store persists it on disk and records a relative URI */
  data?: Buffer;
}

/** Artifact extended with optional parent task metadata for cross-task registry views. */
export interface ArtifactWithTask extends Artifact {
  /** Title of the parent task */
  taskTitle?: string;
  /** Description of the parent task */
  taskDescription?: string;
  /** Column of the parent task (e.g., "triage", "todo", "in-progress", "done", "in-review", "archived") */
  taskColumn?: string;
}


/*
FNXC:ReviewArtifacts 2026-07-17-12:00:
Remote-desktop producers can register a document descriptor through the existing
artifact registry by assigning this MIME type. The descriptor remains a document
in the gallery, avoiding a raw external-session link while still making the
review deliverable visible on both review surfaces.
*/
export const LIVE_DEMO_ARTIFACT_MIME_TYPE = "application/vnd.runfusion.live-demo+json";

/*
FNXC:ReviewArtifacts 2026-07-17-12:00:
Review surfaces admit feature videos and explicitly marked live-demo descriptors.
Ordinary documents remain excluded; the marker uses the existing persisted
mimeType field because agent artifact registration already forwards it without
requiring a parallel schema or metadata-registration path.
*/
export function isReviewArtifact(artifact: Pick<Artifact, "type" | "mimeType">): boolean {
  return artifact.type === "video"
    || (artifact.type === "document" && artifact.mimeType?.toLowerCase().split(";", 1)[0] === LIVE_DEMO_ARTIFACT_MIME_TYPE);
}

/** Reads the persisted PROMPT.md override without adding task-store persistence. */
export function parseReviewArtifactsModeOverride(prompt: string | undefined): ReviewArtifactsMode | undefined {
  if (!prompt) return undefined;
  const match = prompt.match(/^\*\*Review Artifacts:\*\*\s*(off|user-facing|on)\s*$/im);
  return match?.[1]?.toLowerCase() as ReviewArtifactsMode | undefined;
}

/** Resolves review-artifact generation policy: PROMPT header → project setting → conservative default. */
export function resolveReviewArtifactsMode(
  // Structural pick avoids importing ProjectSettings from types.ts (cycle).
  settings: { reviewArtifacts?: ReviewArtifactsMode },
  prompt?: string,
): ReviewArtifactsMode {
  return parseReviewArtifactsModeOverride(prompt) ?? settings.reviewArtifacts ?? "off";
}

export type ReviewArtifactTaskClassification = "user-facing" | "backend" | "trivial";

/*
FNXC:ReviewArtifacts 2026-07-17-13:00:
The `user-facing` policy must be a real generation gate, not a label that
producers reinterpret. Triage may declare a task classification in PROMPT.md;
otherwise a task with the standard frontend UX contract is user-facing and all
other work conservatively remains backend. This keeps trivial/backend work from
silently producing review media while allowing `on` or the existing mode header
to explicitly opt in.
*/
export function classifyReviewArtifactTask(prompt: string | undefined): ReviewArtifactTaskClassification {
  const explicit = prompt?.match(/^\*\*Review Artifact Task Type:\*\*\s*(user-facing|backend|trivial)\s*$/im)?.[1]?.toLowerCase();
  if (explicit === "user-facing" || explicit === "backend" || explicit === "trivial") return explicit;
  if (/^##\s+Frontend UX Criteria\s*$/im.test(prompt ?? "")) return "user-facing";
  return "backend";
}

/**
 * Determines whether an automatic review-artifact producer may generate media
 * for a task. A mode marker still wins policy resolution; task classification
 * controls the `user-facing` mode only.
 */
export function isReviewArtifactGenerationEligible(
  // Structural pick avoids importing ProjectSettings from types.ts (cycle).
  settings: { reviewArtifacts?: ReviewArtifactsMode },
  prompt?: string,
  classification = classifyReviewArtifactTask(prompt),
): boolean {
  const mode = resolveReviewArtifactsMode(settings, prompt);
  return mode === "on" || (mode === "user-facing" && classification === "user-facing");
}

/**
 * FNXC:NativeStructureEmbed 2026-07-16-12:00:
 * Chat and mail share this compact reference contract so their consumers never invent
 * incompatible structure identifiers. `roadmap-item` is resolved through the roadmap plugin's
 * PostgreSQL-safe adapter and is missing-only because roadmap entities have no soft-delete state.
 */
export interface NativeStructureRef {
  kind: "mission" | "milestone" | "research-finding" | "eval-result" | "goal" | "roadmap-item";
  id: string;
  projectId?: string;
}

/**
 * FNXC:NativeStructureEmbed 2026-07-16-12:00:
 * Dashboard destinations are callback/view-state based rather than HTML routes. Consumers use
 * this stable descriptor with their navigation callback; it is intentionally not a URL.
 *
 * FNXC:NativeStructureEmbed 2026-07-19-12:30:
 * Roadmap-item descriptors carry optional hierarchy context for the hosted `roadmaps` view;
 * consumers pass this object to onOpen instead of manufacturing a deep-link URL.
 */
export interface NativeStructureOpenTarget {
  view: "missions" | "insights" | "evals" | "goals" | "roadmaps";
  id: string;
  missionId?: string;
  roadmapId?: string;
  milestoneId?: string;
}

/**
 * FNXC:NativeStructureEmbed 2026-07-18-18:15:
 * A previewable native structure projected by the dashboard read layer.
 */
export interface NativeStructurePreviewPayload {
  available: true;
  kind: NativeStructureRef["kind"];
  kindLabel: string;
  title: string;
  excerpt: string;
  openTarget: NativeStructureOpenTarget;
}

/**
 * FNXC:NativeStructureEmbed 2026-07-18-18:15:
 * A native structure whose existing lifecycle state makes it unavailable for preview.
 */
export interface NativeStructureUnavailablePayload {
  available: false;
  kind: NativeStructureRef["kind"];
  id: string;
  reason: "missing" | "soft-deleted";
}

/**
 * FNXC:NativeStructureEmbed 2026-07-16-12:00:
 * Unavailability is a typed result so shared consumers show a safe placeholder instead of
 * crashing. Eval results have no archive lifecycle and therefore only return `missing`.
 */
export type NativeStructurePreviewResult = NativeStructurePreviewPayload | NativeStructureUnavailablePayload;

/**
 * Goal-citation Slice 2 success-signal surfaces where goal IDs are extracted.
 */
export type GoalCitationSurface = "agent_log" | "task_document";

/**
 * A unique extracted goal ID and the index of its first appearance in source text.
 */
export interface GoalCitationMatch {
  goalId: string;
  index: number;
}

/**
 * Input payload for recording a single observed goal citation in the Slice 2 success-signal trail.
 * `snippet` must be a bounded source-text substring (≤200 chars), never the full source body.
 */
export interface GoalCitationInput {
  goalId: string;
  agentId: string;
  taskId?: string;
  surface: GoalCitationSurface;
  sourceRef: string;
  snippet: string;
  timestamp?: string;
}

/**
 * Persisted goal-citation audit row used to measure Slice 2 anchoring success signal.
 * `snippet` is always a bounded substring (≤200 chars), not full source content.
 */
export interface GoalCitation extends Required<Pick<GoalCitationInput, "goalId" | "agentId" | "surface" | "sourceRef" | "snippet">> {
  id: number;
  taskId?: string;
  timestamp: string;
}

/**
 * Filter contract for querying goal-citation success-signal rows across scanned surfaces.
 * Snippet payloads remain bounded substrings (≤200 chars) of original text.
 */
export interface GoalCitationFilter {
  goalId?: string;
  agentId?: string;
  taskId?: string;
  surface?: GoalCitationSurface;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

export const DOCUMENT_KEY_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Shared GitHub owner/repo slug validation for repo override inputs. */
export const REPO_OVERRIDE_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function validateDocumentKey(key: string): void {
  if (!DOCUMENT_KEY_RE.test(key)) {
    throw new Error(
      `Invalid document key: "${key}". Must be 1-64 characters: letters, digits, hyphens, or underscores.`,
    );
  }
}

/** Build canonical research enrichment document key from a run id. */
export function buildResearchDocumentKey(runId: string): string {
  const sanitizedRunId = runId.replace(/[^A-Za-z0-9_-]/g, "");
  if (!sanitizedRunId) {
    throw new Error("Invalid research run id: sanitized run id is empty");
  }
  const key = `research-${sanitizedRunId}`;
  validateDocumentKey(key);
  return key;
}
