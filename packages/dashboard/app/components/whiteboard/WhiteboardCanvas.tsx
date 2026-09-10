import "@xyflow/react/dist/style.css";
import "./WhiteboardCanvas.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  AlignHorizontalSpaceAround,
  AlignVerticalSpaceAround,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  Frame,
  GitBranchPlus,
  LayoutGrid,
  Redo2,
  StickyNote,
  Trash2,
  Undo2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WhiteboardDocument, WhiteboardFrameType, WhiteboardTextRole } from "@fusion/core";
import {
  applyWhiteboardCommand,
  copyWhiteboardSelection,
  createWhiteboardEditorState,
  pasteWhiteboardClipboard,
  redoWhiteboard,
  setWhiteboardSelection,
  undoWhiteboard,
} from "./whiteboard-document";
import { projectWhiteboardToFlow, type WhiteboardFlowData } from "./whiteboard-flow";
import { alignWhiteboard, distributeWhiteboard, layoutWhiteboard } from "./whiteboard-layout";

export interface WhiteboardCanvasProps {
  document: WhiteboardDocument;
  onChange: (document: WhiteboardDocument) => void;
}

interface EditableTextData extends WhiteboardFlowData {
  textId: string;
  onTextChange: (id: string, text: string) => void;
}

const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const annotationValue = (value: string) => value || undefined;

function EditableTextNode({ data }: NodeProps<Node<EditableTextData>>) {
  return <div className="whiteboard-text-node">
    <Handle type="target" position={Position.Left} />
    <textarea
      aria-label={`Edit text ${data.textId}`}
      value={String(data.label ?? "")}
      onChange={(event) => data.onTextChange(data.textId, event.target.value)}
    />
    <Handle type="source" position={Position.Right} />
  </div>;
}

const nodeTypes = { whiteboardText: EditableTextNode };

/*
FNXC:WhiteboardCanvasEditing 2026-09-10-07:17:
The production canvas must expose every structural v1 operation without requiring JSON edits. Text is editable in-place, a selected relation can accept additional targets, junctions remain draggable, and the inspector owns frame sizing, text membership, and relation or branch annotations on desktop and mobile.
*/
function Canvas({ document, onChange }: WhiteboardCanvasProps) {
  const { t } = useTranslation("app");
  const [editor, setEditor] = useState(() => createWhiteboardEditorState(document));
  const [branchRelationId, setBranchRelationId] = useState<string | null>(null);
  const publishedDocument = useRef<WhiteboardDocument | null>(null);

  useEffect(() => {
    if (document !== publishedDocument.current) setEditor(createWhiteboardEditorState(document));
    publishedDocument.current = null;
  }, [document]);

  const publish = useCallback((next: typeof editor) => {
    setEditor(next);
    if (next.document !== editor.document) {
      publishedDocument.current = next.document;
      onChange(next.document);
    }
  }, [editor, onChange]);
  const command = useCallback((value: Parameters<typeof applyWhiteboardCommand>[1]) => {
    publish(applyWhiteboardCommand(editor, value));
  }, [editor, publish]);
  const editText = useCallback((id: string, text: string) => command({ type: "edit-text", id, text }), [command]);

  const baseProjection = useMemo(() => projectWhiteboardToFlow(editor.document), [editor.document]);
  const projection = useMemo(() => ({
    ...baseProjection,
    nodes: baseProjection.nodes.map((node) => node.data.kind === "text" ? {
      ...node,
      type: "whiteboardText",
      data: { ...node.data, textId: node.id, onTextChange: editText },
    } : node),
  }), [baseProjection, editText]);

  const addFrame = (type: WhiteboardFrameType) => command({ type: "add-frame", frame: { id: uid("frame"), type, x: 80, y: 80, width: 320, height: 220, title: t(`whiteboard.frame.${type}`, type) } });
  const addText = (role: WhiteboardTextRole) => command({ type: "add-text", text: { id: uid("text"), role, text: t(`whiteboard.text.${role}`, role), x: 120, y: 120, width: 180, height: 64 } });
  const absolutePosition = (id: string) => {
    const text = editor.document.texts.find((item) => item.id === id);
    if (text) {
      const frame = editor.document.frames.find((item) => item.id === text.frameId);
      return { x: text.x + (frame?.x ?? 0), y: text.y + (frame?.y ?? 0) };
    }
    const frame = editor.document.frames.find((item) => item.id === id);
    return frame ? { x: frame.x, y: frame.y } : { x: 0, y: 0 };
  };
  const onConnect = (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const existing = branchRelationId ? editor.document.relations.find((item) => item.id === branchRelationId) : undefined;
    if (existing) {
      if (existing.branches.some((branch) => branch.targetId === connection.target)) return;
      const source = absolutePosition(existing.sourceId);
      const target = absolutePosition(connection.target);
      command({
        type: "add-branch",
        relationId: existing.id,
        branch: { id: uid("branch"), targetId: connection.target },
        junction: existing.junction ?? { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 },
      });
      setBranchRelationId(null);
      return;
    }
    command({ type: "connect", relation: { id: uid("relation"), sourceId: connection.source, branches: [{ id: uid("branch"), targetId: connection.target }] } });
  };
  const onNodeDragStop = (_event: unknown, node: Node) => {
    if (node.id.startsWith("junction:")) {
      command({ type: "set-junction", relationId: node.id.slice("junction:".length), x: node.position.x, y: node.position.y });
      return;
    }
    const source = projection.nodes.find((item) => item.id === node.id);
    if (source) command({ type: "move", ids: [node.id], dx: node.position.x - source.position.x, dy: node.position.y - source.position.y });
  };
  const onSelectionChange = ({ nodes, edges }: { nodes: Node[]; edges: Array<{ id: string; data?: Record<string, unknown> }> }) => {
    const ids = [
      ...nodes.map((node) => node.id.startsWith("junction:") ? node.id.slice("junction:".length) : node.id),
      ...edges.map((edge) => edge.data?.segment === "trunk" ? String(edge.data.relationId) : edge.id),
    ];
    setEditor((current) => setWhiteboardSelection(current, ids));
  };

  const selectedText = editor.document.texts.find((item) => editor.selectedIds.includes(item.id));
  const selectedFrame = editor.document.frames.find((item) => editor.selectedIds.includes(item.id));
  const selectedRelation = editor.document.relations.find((item) => editor.selectedIds.includes(item.id) || item.branches.some((branch) => editor.selectedIds.includes(branch.id)));
  const selectedBranch = selectedRelation?.branches.find((branch) => editor.selectedIds.includes(branch.id));

  const setTextFrame = (frameId: string) => {
    if (!selectedText) return;
    const absolute = absolutePosition(selectedText.id);
    const frame = editor.document.frames.find((item) => item.id === frameId);
    command({ type: "set-frame", textId: selectedText.id, frameId: frame?.id, x: absolute.x - (frame?.x ?? 0), y: absolute.y - (frame?.y ?? 0) });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select")) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === "z") { event.preventDefault(); publish(event.shiftKey ? redoWhiteboard(editor) : undoWhiteboard(editor)); }
      else if (modifier && event.key.toLowerCase() === "c") { event.preventDefault(); setEditor(copyWhiteboardSelection(editor)); }
      else if (modifier && event.key.toLowerCase() === "v") { event.preventDefault(); publish(pasteWhiteboardClipboard(editor)); }
      else if (event.key === "Delete" && editor.selectedIds.length) { event.preventDefault(); command({ type: "delete", ids: editor.selectedIds }); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [command, editor, publish]);

  return <div className="whiteboard-canvas-shell">
    <div className="whiteboard-toolbar" role="toolbar" aria-label={t("whiteboard.tools", "Whiteboard tools")}>
      <button className="btn" type="button" onClick={() => addText("idea")}><StickyNote aria-hidden="true" />{t("whiteboard.addIdea", "Idea")}</button>
      <button className="btn" type="button" onClick={() => addFrame("screen")}><Frame aria-hidden="true" />{t("whiteboard.addScreen", "Screen")}</button>
      <button className="btn" type="button" onClick={() => addFrame("functional-area")}>{t("whiteboard.addArea", "Functional area")}</button>
      <button className="btn" type="button" onClick={() => addFrame("process-step")}>{t("whiteboard.addStep", "Process step")}</button>
      <button className="btn btn-icon" type="button" aria-label={t("common.undo", "Undo")} disabled={!editor.past.length} onClick={() => publish(undoWhiteboard(editor))}><Undo2 /></button>
      <button className="btn btn-icon" type="button" aria-label={t("common.redo", "Redo")} disabled={!editor.future.length} onClick={() => publish(redoWhiteboard(editor))}><Redo2 /></button>
      <button className="btn btn-icon" type="button" aria-label={t("common.copy", "Copy")} disabled={!editor.selectedIds.length} onClick={() => setEditor(copyWhiteboardSelection(editor))}><ClipboardCopy /></button>
      <button className="btn btn-icon" type="button" aria-label={t("common.paste", "Paste")} disabled={!editor.clipboard} onClick={() => publish(pasteWhiteboardClipboard(editor))}><ClipboardPaste /></button>
      <button className="btn" type="button" disabled={!editor.selectedIds.length} onClick={() => command({ type: "duplicate", ids: editor.selectedIds })}><Copy />{t("common.duplicate", "Duplicate")}</button>
      <button className="btn" type="button" disabled={!editor.selectedIds.length} onClick={() => command({ type: "delete", ids: editor.selectedIds })}><Trash2 />{t("common.delete", "Delete")}</button>
      <button className="btn" type="button" onClick={() => command({ type: "replace", document: alignWhiteboard(editor.document, editor.selectedIds, "horizontal") })}><AlignHorizontalSpaceAround />{t("whiteboard.align", "Align")}</button>
      <button className="btn" type="button" onClick={() => command({ type: "replace", document: distributeWhiteboard(editor.document, editor.selectedIds, "horizontal") })}><AlignVerticalSpaceAround />{t("whiteboard.distribute", "Distribute")}</button>
      <button className="btn" type="button" onClick={() => command({ type: "replace", document: layoutWhiteboard(editor.document, editor.selectedIds) })}><LayoutGrid />{t("whiteboard.layout", "Arrange")}</button>
    </div>
    <div className="whiteboard-canvas" data-testid="whiteboard-canvas">
      <ReactFlow
        nodes={projection.nodes}
        edges={projection.edges}
        nodeTypes={nodeTypes}
        fitView
        panOnDrag
        zoomOnPinch
        multiSelectionKeyCode="Shift"
        onConnect={onConnect}
        onNodeDragStop={onNodeDragStop}
        onSelectionChange={onSelectionChange}
      >
        <Background /><Controls showInteractive={false} />
      </ReactFlow>
    </div>
    <aside className="whiteboard-inspector" aria-label={t("whiteboard.inspector", "Selection inspector")}>
      {selectedText && <div className="whiteboard-inspector-fields">
        <label>{t("whiteboard.textContent", "Text")}<textarea className="input" value={selectedText.text} onChange={(event) => editText(selectedText.id, event.target.value)} /></label>
        <label>{t("whiteboard.frameMembership", "Frame")}<select className="input" value={selectedText.frameId ?? ""} onChange={(event) => setTextFrame(event.target.value)}><option value="">{t("whiteboard.noFrame", "No frame")}</option>{editor.document.frames.map((frame) => <option key={frame.id} value={frame.id}>{frame.title ?? frame.type}</option>)}</select></label>
      </div>}
      {selectedFrame && <div className="whiteboard-inspector-fields">
        <label>{t("whiteboard.frameWidth", "Frame width")}<input className="input" type="number" min="1" value={selectedFrame.width} onChange={(event) => command({ type: "resize-frame", id: selectedFrame.id, width: Number(event.target.value), height: selectedFrame.height })} /></label>
        <label>{t("whiteboard.frameHeight", "Frame height")}<input className="input" type="number" min="1" value={selectedFrame.height} onChange={(event) => command({ type: "resize-frame", id: selectedFrame.id, width: selectedFrame.width, height: Number(event.target.value) })} /></label>
      </div>}
      {selectedRelation && <div className="whiteboard-inspector-fields">
        <label>{t("whiteboard.relationAnnotation", "Relation annotation")}<input className="input" value={selectedRelation.annotation ?? ""} onChange={(event) => command({ type: "annotate-relation", relationId: selectedRelation.id, annotation: annotationValue(event.target.value) })} /></label>
        {selectedBranch && <label>{t("whiteboard.branchAnnotation", "Branch annotation")}<input className="input" value={selectedBranch.annotation ?? ""} onChange={(event) => command({ type: "annotate-branch", relationId: selectedRelation.id, branchId: selectedBranch.id, annotation: annotationValue(event.target.value) })} /></label>}
        <div className="whiteboard-annotation-actions">
          {selectedBranch && ["Oui", "Non"].map((annotation) => <button key={annotation} className="btn" type="button" onClick={() => command({ type: "annotate-branch", relationId: selectedRelation.id, branchId: selectedBranch.id, annotation })}>{annotation}</button>)}
          {selectedBranch && <button className="btn" type="button" onClick={() => command({ type: "annotate-branch", relationId: selectedRelation.id, branchId: selectedBranch.id, annotation: undefined })}>{t("whiteboard.removeAnnotation", "Remove annotation")}</button>}
        </div>
        <button className="btn" type="button" aria-pressed={branchRelationId === selectedRelation.id} onClick={() => setBranchRelationId((current) => current === selectedRelation.id ? null : selectedRelation.id)}><GitBranchPlus />{t("whiteboard.addBranch", "Add branch")}</button>
        {branchRelationId === selectedRelation.id && <p role="status">{t("whiteboard.addBranchHint", "Connect the relation source to another target")}</p>}
      </div>}
      {!selectedText && !selectedFrame && !selectedRelation && <p>{t("whiteboard.selectHint", "Select an item to edit it")}</p>}
      <div className="whiteboard-role-grid">{(["idea", "title", "body", "ui-label", "ui-control-placeholder"] as WhiteboardTextRole[]).map((role) => <button key={role} className="btn" type="button" onClick={() => addText(role)}>{role}</button>)}</div>
    </aside>
  </div>;
}

export function WhiteboardCanvas(props: WhiteboardCanvasProps) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}
