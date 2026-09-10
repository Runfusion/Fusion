import { createEmptyWhiteboardDocument, validateWhiteboardDocument, type WhiteboardDocument, type WhiteboardFrame, type WhiteboardRelation, type WhiteboardText } from "@fusion/core";
export type WhiteboardObjectId = string;
export interface WhiteboardClipboard { frames: WhiteboardFrame[]; texts: WhiteboardText[]; relations: WhiteboardRelation[] }
export interface WhiteboardEditorState { document: WhiteboardDocument; past: WhiteboardDocument[]; future: WhiteboardDocument[]; selectedIds: string[]; clipboard: WhiteboardClipboard | null; zoom: number; pan: { x: number; y: number } }
export type WhiteboardCommand =
  | { type: "replace"; document: WhiteboardDocument }
  | { type: "add-frame"; frame: WhiteboardFrame } | { type: "add-text"; text: WhiteboardText } | { type: "edit-text"; id: string; text: string }
  | { type: "move"; ids: string[]; dx: number; dy: number } | { type: "resize-frame"; id: string; width: number; height: number }
  | { type: "delete"; ids: string[] } | { type: "duplicate"; ids: string[]; idFactory?: () => string }
  | { type: "set-frame"; textId: string; frameId?: string; x: number; y: number }
  | { type: "connect"; relation: WhiteboardRelation }
  | { type: "add-branch"; relationId: string; branch: WhiteboardRelation["branches"][number]; junction: { x: number; y: number } }
  | { type: "set-junction"; relationId: string; x: number; y: number }
  | { type: "annotate-relation"; relationId: string; annotation?: string }
  | { type: "annotate-branch"; relationId: string; branchId: string; annotation?: string };
export const createWhiteboardEditorState = (document = createEmptyWhiteboardDocument()): WhiteboardEditorState => ({ document: structuredClone(document), past: [], future: [], selectedIds: [], clipboard: null, zoom: 1, pan: { x: 0, y: 0 } });
const clone = <T,>(value: T): T => structuredClone(value);
const commit = (state: WhiteboardEditorState, document: WhiteboardDocument, selection = state.selectedIds): WhiteboardEditorState => ({ ...state, document: validateWhiteboardDocument(document), past: [...state.past.slice(-99), clone(state.document)], future: [], selectedIds: selection });
const objectIds = (doc: WhiteboardDocument) => new Set([...doc.frames.map((x) => x.id), ...doc.texts.map((x) => x.id)]);

/* FNXC:WhiteboardCommands 2026-09-10-05:42: All durable canvas changes are pure document commands and one command equals one bounded undo entry. Frame movement never rewrites child-local coordinates; cloning remaps identities and retains only internally complete relation branches. */
export function applyWhiteboardCommand(state: WhiteboardEditorState, command: WhiteboardCommand): WhiteboardEditorState {
  const doc = clone(state.document);
  switch (command.type) {
    case "replace": return commit(state, command.document, []);
    case "add-frame": doc.frames.push(clone(command.frame)); return commit(state, doc, [command.frame.id]);
    case "add-text": doc.texts.push(clone(command.text)); return commit(state, doc, [command.text.id]);
    case "edit-text": { const item = doc.texts.find((x) => x.id === command.id); if (item) item.text = command.text; break; }
    case "move": { const ids = new Set(command.ids); for (const frame of doc.frames) if (ids.has(frame.id)) { frame.x += command.dx; frame.y += command.dy; } for (const text of doc.texts) if (ids.has(text.id) && (!text.frameId || !ids.has(text.frameId))) { text.x += command.dx; text.y += command.dy; } break; }
    case "resize-frame": { const frame = doc.frames.find((x) => x.id === command.id); if (frame) { const children = doc.texts.filter((x) => x.frameId === frame.id); const minWidth = Math.max(80, ...children.map((x) => x.x + (x.width ?? 80) + 16)); const minHeight = Math.max(60, ...children.map((x) => x.y + (x.height ?? 32) + 16)); frame.width = Math.max(command.width, minWidth); frame.height = Math.max(command.height, minHeight); } break; }
    case "set-frame": { const text = doc.texts.find((x) => x.id === command.textId); if (text) { text.frameId = command.frameId; text.x = command.x; text.y = command.y; } break; }
    case "connect": doc.relations.push(clone(command.relation)); break;
    case "add-branch": { const relation = doc.relations.find((x) => x.id === command.relationId); if (relation && !relation.branches.some((branch) => branch.targetId === command.branch.targetId)) { relation.branches.push(clone(command.branch)); relation.junction ??= clone(command.junction); } break; }
    case "set-junction": { const relation = doc.relations.find((x) => x.id === command.relationId); if (relation?.junction) relation.junction = { x: command.x, y: command.y }; break; }
    case "annotate-relation": { const relation = doc.relations.find((x) => x.id === command.relationId); if (relation) relation.annotation = command.annotation; break; }
    case "annotate-branch": { const branch = doc.relations.find((x) => x.id === command.relationId)?.branches.find((x) => x.id === command.branchId); if (branch) branch.annotation = command.annotation; break; }
    case "delete": { const ids = new Set(command.ids); doc.frames = doc.frames.filter((x) => !ids.has(x.id)); doc.texts = doc.texts.filter((x) => !ids.has(x.id) && !x.frameId?.startsWith("__removed__")).map((x) => ids.has(x.frameId ?? "") ? { ...x, frameId: undefined } : x); doc.relations = doc.relations.filter((x) => !ids.has(x.id) && !ids.has(x.sourceId)).map((x) => ({ ...x, branches: x.branches.filter((b) => !ids.has(b.id) && !ids.has(b.targetId)) })).filter((x) => x.branches.length); return commit(state, doc, state.selectedIds.filter((x) => !ids.has(x))); }
    case "duplicate": { const selected = new Set(command.ids); const make = command.idFactory ?? (() => crypto.randomUUID()); const remap = new Map<string, string>(); const frames = doc.frames.filter((x) => selected.has(x.id)); const texts = doc.texts.filter((x) => selected.has(x.id) || (x.frameId && selected.has(x.frameId))); for (const item of [...frames, ...texts]) remap.set(item.id, make()); const newFrames = frames.map((x) => ({ ...x, id: remap.get(x.id)!, x: x.x + 24, y: x.y + 24 })); const newTexts = texts.map((x) => ({ ...x, id: remap.get(x.id)!, frameId: x.frameId ? remap.get(x.frameId) : undefined, x: x.x + (x.frameId ? 0 : 24), y: x.y + (x.frameId ? 0 : 24) })); const newRelations = doc.relations.filter((x) => selected.has(x.id) || remap.has(x.sourceId)).map((x) => ({ ...x, id: make(), sourceId: remap.get(x.sourceId) ?? "", branches: x.branches.filter((b) => remap.has(b.targetId)).map((b) => ({ ...b, id: make(), targetId: remap.get(b.targetId)! })) })).filter((x) => x.sourceId && x.branches.length); doc.frames.push(...newFrames); doc.texts.push(...newTexts); doc.relations.push(...newRelations); return commit(state, doc, [...newFrames, ...newTexts].map((x) => x.id)); }
  }
  return commit(state, doc);
}
export function undoWhiteboard(state: WhiteboardEditorState): WhiteboardEditorState { const previous = state.past.at(-1); return previous ? { ...state, document: clone(previous), past: state.past.slice(0, -1), future: [clone(state.document), ...state.future], selectedIds: [] } : state; }
export function redoWhiteboard(state: WhiteboardEditorState): WhiteboardEditorState { const next = state.future[0]; return next ? { ...state, document: clone(next), past: [...state.past, clone(state.document)], future: state.future.slice(1), selectedIds: [] } : state; }
export function copyWhiteboardSelection(state: WhiteboardEditorState): WhiteboardEditorState { const ids = new Set(state.selectedIds); const frames = state.document.frames.filter((x) => ids.has(x.id)); const texts = state.document.texts.filter((x) => ids.has(x.id) || (x.frameId && ids.has(x.frameId))); const included = new Set([...frames, ...texts].map((x) => x.id)); const relations = state.document.relations.filter((x) => included.has(x.sourceId)).map((x) => ({ ...x, branches: x.branches.filter((b) => included.has(b.targetId)) })).filter((x) => x.branches.length); return { ...state, clipboard: clone({ frames, texts, relations }) }; }
export function pasteWhiteboardClipboard(state: WhiteboardEditorState, idFactory: () => string = () => crypto.randomUUID()): WhiteboardEditorState {
  if (!state.clipboard) return state;
  const doc = clone(state.document); const remap = new Map<string, string>();
  for (const item of [...state.clipboard.frames, ...state.clipboard.texts]) remap.set(item.id, idFactory());
  const frames = state.clipboard.frames.map((item) => ({ ...clone(item), id: remap.get(item.id)!, x: item.x + 24, y: item.y + 24 }));
  const texts = state.clipboard.texts.map((item) => ({ ...clone(item), id: remap.get(item.id)!, frameId: item.frameId ? remap.get(item.frameId) : undefined, x: item.x + (item.frameId ? 0 : 24), y: item.y + (item.frameId ? 0 : 24) }));
  const relations = state.clipboard.relations.map((relation) => ({ ...clone(relation), id: idFactory(), sourceId: remap.get(relation.sourceId) ?? "", branches: relation.branches.filter((branch) => remap.has(branch.targetId)).map((branch) => ({ ...branch, id: idFactory(), targetId: remap.get(branch.targetId)! })) })).filter((relation) => relation.sourceId && relation.branches.length);
  doc.frames.push(...frames); doc.texts.push(...texts); doc.relations.push(...relations); return commit(state, doc, [...frames, ...texts].map((item) => item.id));
}
export function setWhiteboardSelection(state: WhiteboardEditorState, ids: string[]): WhiteboardEditorState { const valid = objectIds(state.document); return { ...state, selectedIds: [...new Set(ids.filter((id) => valid.has(id) || state.document.relations.some((r) => r.id === id || r.branches.some((b) => b.id === id))))] }; }
export function setWhiteboardViewport(state: WhiteboardEditorState, zoom: number, pan: { x: number; y: number }): WhiteboardEditorState { return { ...state, zoom: Math.min(4, Math.max(.1, zoom)), pan }; }
