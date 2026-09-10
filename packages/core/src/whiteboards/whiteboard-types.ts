export const WHITEBOARD_TITLE_MAX_LENGTH = 200;
export const WHITEBOARD_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;
export const WHITEBOARD_MAX_FRAMES = 500;
export const WHITEBOARD_MAX_TEXTS = 5_000;
export const WHITEBOARD_MAX_RELATIONS = 5_000;
export const WHITEBOARD_MAX_BRANCHES = 10_000;

export type WhiteboardFrameType = "screen" | "functional-area" | "process-step";
export type WhiteboardTextRole = "idea" | "title" | "body" | "ui-label" | "ui-control-placeholder";
export interface WhiteboardPoint { x: number; y: number }
export interface WhiteboardFrame extends WhiteboardPoint { id: string; type: WhiteboardFrameType; width: number; height: number; title?: string }
export interface WhiteboardText extends WhiteboardPoint { id: string; role: WhiteboardTextRole; text: string; frameId?: string; width?: number; height?: number }
export interface WhiteboardRelationBranch { id: string; targetId: string; annotation?: string }
export interface WhiteboardRelation { id: string; sourceId: string; annotation?: string; junction?: WhiteboardPoint; branches: WhiteboardRelationBranch[] }
export interface WhiteboardDocumentV1 { version: 1; frames: WhiteboardFrame[]; texts: WhiteboardText[]; relations: WhiteboardRelation[] }

export type WhiteboardDocument = WhiteboardDocumentV1;

export interface ProjectWhiteboardSummary { id: string; title: string; revision: number; createdAt: string; updatedAt: string }
export interface ProjectWhiteboard extends ProjectWhiteboardSummary { document: WhiteboardDocumentV1 }
export interface WhiteboardRevision { revision: number; title: string; document: WhiteboardDocumentV1; createdAt: string }

export const createEmptyWhiteboardDocument = (): WhiteboardDocumentV1 => ({ version: 1, frames: [], texts: [], relations: [] });

export class WhiteboardValidationError extends Error {
  readonly code = "WHITEBOARD_INVALID";
  constructor(message: string) { super(message); this.name = "WhiteboardValidationError"; }
}
export class WhiteboardRevisionConflictError extends Error {
  readonly code = "WHITEBOARD_REVISION_CONFLICT";
  constructor(readonly id: string, readonly expectedRevision: number) { super(`Whiteboard ${id} changed since revision ${expectedRevision}`); this.name = "WhiteboardRevisionConflictError"; }
}
export class WhiteboardNotFoundError extends Error {
  readonly code = "WHITEBOARD_NOT_FOUND";
  constructor(readonly id: string) { super(`Whiteboard ${id} not found`); this.name = "WhiteboardNotFoundError"; }
}

function fail(message: string): never { throw new WhiteboardValidationError(message); }
function finite(value: unknown, label: string): asserts value is number { if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be finite`); }
function id(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !value.trim() || value.length > 200) fail(`${label} is invalid`); }
function optionalText(value: unknown, label: string): void { if (value !== undefined && (typeof value !== "string" || value.length > 10_000)) fail(`${label} is invalid`); }

/*
FNXC:WhiteboardAlpha 2026-09-10-05:42:
The canonical v1 document is bounded and reference-complete before any persistence or canvas projection. Frames are deliberately flat; frame-owned text stores local coordinates, while multi-target relations persist one selectable junction and stable branch identities instead of duplicating relations.

FNXC:WhiteboardAlpha 2026-09-10-07:17:
Every frame, text, relation, and branch identifier shares one global namespace because each becomes a selectable React Flow identity. Frames reject a `frameId` property explicitly so unknown-field tolerance cannot accidentally encode unsupported nesting.
*/
export function validateWhiteboardDocument(value: unknown): WhiteboardDocumentV1 {
  let bytes: number;
  try { bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { fail("document must be JSON serializable"); }
  if (bytes > WHITEBOARD_DOCUMENT_MAX_BYTES) fail("document exceeds 5 MiB");
  if (!value || typeof value !== "object") fail("document must be an object");
  const doc = value as Partial<WhiteboardDocumentV1>;
  if (doc.version !== 1 || !Array.isArray(doc.frames) || !Array.isArray(doc.texts) || !Array.isArray(doc.relations)) fail("document must use Whiteboard v1");
  if (doc.frames.length > WHITEBOARD_MAX_FRAMES || doc.texts.length > WHITEBOARD_MAX_TEXTS || doc.relations.length > WHITEBOARD_MAX_RELATIONS) fail("document object limit exceeded");
  const allIds = new Set<string>();
  const nodeIds = new Set<string>();
  const frameIds = new Set<string>();
  for (const frame of doc.frames) {
    id(frame.id, "frame id"); if (allIds.has(frame.id)) fail("duplicate object id"); allIds.add(frame.id); nodeIds.add(frame.id); frameIds.add(frame.id);
    if ("frameId" in frame) fail("nested frames are not supported");
    if (!["screen", "functional-area", "process-step"].includes(frame.type)) fail("invalid frame type");
    finite(frame.x, "frame x"); finite(frame.y, "frame y"); finite(frame.width, "frame width"); finite(frame.height, "frame height");
    if (frame.width <= 0 || frame.height <= 0) fail("frame dimensions must be positive"); optionalText(frame.title, "frame title");
  }
  for (const text of doc.texts) {
    id(text.id, "text id"); if (allIds.has(text.id)) fail("duplicate object id"); allIds.add(text.id); nodeIds.add(text.id);
    if (!["idea", "title", "body", "ui-label", "ui-control-placeholder"].includes(text.role)) fail("invalid text role");
    if (typeof text.text !== "string") fail("text content is invalid"); finite(text.x, "text x"); finite(text.y, "text y");
    if (text.width !== undefined) { finite(text.width, "text width"); if (text.width <= 0) fail("text width must be positive"); }
    if (text.height !== undefined) { finite(text.height, "text height"); if (text.height <= 0) fail("text height must be positive"); }
    if (text.frameId !== undefined && !frameIds.has(text.frameId)) fail("text frame does not exist");
  }
  let branches = 0;
  for (const relation of doc.relations) {
    id(relation.id, "relation id"); if (allIds.has(relation.id)) fail("duplicate object id"); allIds.add(relation.id);
    if (!nodeIds.has(relation.sourceId)) fail("relation source does not exist"); optionalText(relation.annotation, "relation annotation");
    if (!Array.isArray(relation.branches) || relation.branches.length < 1) fail("relation requires a branch");
    if (relation.junction) { finite(relation.junction.x, "junction x"); finite(relation.junction.y, "junction y"); }
    const targets = new Set<string>(); branches += relation.branches.length;
    for (const branch of relation.branches) { id(branch.id, "branch id"); if (allIds.has(branch.id)) fail("duplicate object id"); allIds.add(branch.id); if (!nodeIds.has(branch.targetId)) fail("relation target does not exist"); if (targets.has(branch.targetId)) fail("duplicate relation target"); targets.add(branch.targetId); optionalText(branch.annotation, "branch annotation"); }
  }
  if (branches > WHITEBOARD_MAX_BRANCHES) fail("document branch limit exceeded");
  return structuredClone(doc as WhiteboardDocumentV1);
}

export function validateWhiteboardTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > WHITEBOARD_TITLE_MAX_LENGTH) throw new WhiteboardValidationError("title must contain 1 to 200 characters");
  return value.trim();
}
