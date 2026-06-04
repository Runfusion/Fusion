import "@xyflow/react/dist/style.css";
import "./WorkflowNodeEditor.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Node as FlowNode,
  type Edge as FlowEdge,
} from "@xyflow/react";
import { X, Plus, Trash2, Save, MessageSquare, Terminal, Shield, GitMerge, Loader2, HelpCircle } from "lucide-react";
import type { WorkflowDefinition } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import {
  fetchWorkflows,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  compileWorkflow,
  fetchModels,
  fetchAgents,
  fetchDiscoveredSkills,
  type ModelInfo,
} from "../api";
import type { Agent } from "../api";
import type { DiscoveredSkill } from "../api";
import type { ToastType } from "../hooks/useToast";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss";
import { useModalResizePersist } from "../hooks/useModalResizePersist";
import { workflowNodeTypes, type WorkflowFlowNodeData, type WorkflowEditorNodeKind } from "./nodes/WorkflowNodeTypes";
import { irToFlow, flowToIr, emptyWorkflowIr, emptyWorkflowLayout } from "./workflow-flow-mapping";
import { CustomModelDropdown } from "./CustomModelDropdown";

type ExecutorKind = "model" | "agent" | "skill" | "cli";

// Mirror of @fusion/core's isBuiltinWorkflowId / BUILTIN_WORKFLOW_ID_PREFIX.
// Inlined because the dashboard app build aliases "@fusion/core" to its
// types-only entry (which doesn't re-export builtin-workflows), and importing
// the function would pull the eager BUILTIN_WORKFLOWS construction into the
// browser bundle for a one-line prefix check.
const isBuiltinWorkflowId = (id: string): boolean => id.startsWith("builtin:");

function getModelDropdownValue(provider: string, modelId: string): string {
  return provider && modelId ? `${provider}/${modelId}` : "";
}

function parseModelDropdownValue(value: string): { provider: string; modelId: string } {
  if (!value) return { provider: "", modelId: "" };
  const slashIndex = value.indexOf("/");
  if (slashIndex === -1) return { provider: "", modelId: "" };
  return { provider: value.slice(0, slashIndex), modelId: value.slice(slashIndex + 1) };
}

interface WorkflowNodeEditorProps {
  isOpen: boolean;
  onClose: () => void;
  addToast: (message: string, type?: ToastType) => void;
  projectId?: string;
}

let nodeSeq = 0;
function newNodeId(): string {
  nodeSeq += 1;
  return `n-${Date.now().toString(36)}-${nodeSeq}`;
}

const PALETTE: Array<{ kind: WorkflowEditorNodeKind; label: string; icon: typeof MessageSquare; presetConfig?: Record<string, unknown> }> = [
  { kind: "prompt", label: "Prompt", icon: MessageSquare },
  { kind: "prompt", label: "User input", icon: HelpCircle, presetConfig: { awaitInput: true } },
  { kind: "script", label: "Script", icon: Terminal },
  { kind: "gate", label: "Gate", icon: Shield },
  { kind: "merge", label: "Merge boundary", icon: GitMerge },
];

function InnerEditor({
  onClose,
  addToast,
  projectId,
  modalRef,
}: Omit<WorkflowNodeEditorProps, "isOpen"> & { modalRef: React.RefObject<HTMLDivElement | null> }) {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode<WorkflowFlowNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const activeWorkflow = useMemo(() => workflows.find((w) => w.id === activeId), [workflows, activeId]);
  const isBuiltin = !!activeWorkflow && isBuiltinWorkflowId(activeWorkflow.id);

  const loadWorkflows = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchWorkflows(projectId);
      setWorkflows(data);
      setActiveId((prev) => prev ?? data[0]?.id ?? null);
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to load workflows", "error");
    } finally {
      setLoading(false);
    }
  }, [projectId, addToast]);

  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

  // Load the active workflow graph into the canvas.
  useEffect(() => {
    if (!activeWorkflow) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const flow = irToFlow(activeWorkflow);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setSelectedNodeId(null);
    setValidationError(null);
  }, [activeWorkflow, setNodes, setEdges]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) =>
        addEdge({ ...connection, label: "success", data: { condition: "success" } }, eds),
      );
    },
    [setEdges],
  );

  const addNode = useCallback(
    (kind: WorkflowEditorNodeKind, nodeLabel?: string, presetConfig?: Record<string, unknown>) => {
      const id = newNodeId();
      const label = nodeLabel ?? (kind === "merge" ? "Merge boundary" : kind.charAt(0).toUpperCase() + kind.slice(1));
      const baseConfig = kind === "gate" ? { gateMode: "gate" } : {};
      const config = presetConfig ? { ...baseConfig, ...presetConfig } : baseConfig;
      setNodes((ns) => [
        ...ns,
        {
          id,
          type: kind,
          position: { x: 200 + ns.length * 40, y: 240 + (ns.length % 3) * 70 },
          data: { kind, label, config },
          deletable: true,
        },
      ]);
      setSelectedNodeId(id);
    },
    [setNodes],
  );

  const updateSelectedData = useCallback(
    (
      patch:
        | Partial<WorkflowFlowNodeData>
        | {
            config:
              | Record<string, unknown>
              | ((prev: Record<string, unknown>) => Record<string, unknown>);
          },
    ) => {
      if (!selectedNodeId) return;
      setNodes((ns) =>
        ns.map((n) =>
          n.id === selectedNodeId
            ? {
                ...n,
                data: {
                  ...n.data,
                  ...("config" in patch
                    ? {
                        config:
                          typeof patch.config === "function"
                            ? patch.config((n.data.config ?? {}) as Record<string, unknown>)
                            : { ...(n.data.config ?? {}), ...patch.config },
                      }
                    : patch),
                },
              }
            : n,
        ),
      );
    },
    [selectedNodeId, setNodes],
  );

  const handleCreateWorkflow = useCallback(async () => {
    const name = window.prompt("New workflow name");
    if (!name?.trim()) return;
    try {
      const created = await createWorkflow(
        { name: name.trim(), ir: emptyWorkflowIr(name.trim()), layout: emptyWorkflowLayout() },
        projectId,
      );
      setWorkflows((ws) => [...ws, created]);
      setActiveId(created.id);
      addToast(`Created workflow "${created.name}"`, "success");
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to create workflow", "error");
    }
  }, [projectId, addToast]);

  const handleDeleteWorkflow = useCallback(async () => {
    if (!activeWorkflow) return;
    if (isBuiltinWorkflowId(activeWorkflow.id)) return; // built-ins are read-only
    if (!window.confirm(`Delete workflow "${activeWorkflow.name}"?`)) return;
    try {
      await deleteWorkflow(activeWorkflow.id, projectId);
      setWorkflows((ws) => ws.filter((w) => w.id !== activeWorkflow.id));
      setActiveId(null);
      addToast("Workflow deleted", "success");
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to delete workflow", "error");
    }
  }, [activeWorkflow, projectId, addToast]);

  const handleDuplicate = useCallback(async () => {
    if (!activeWorkflow) return;
    try {
      const created = await createWorkflow(
        {
          name: `${activeWorkflow.name} (copy)`,
          description: activeWorkflow.description,
          ir: activeWorkflow.ir,
          layout: activeWorkflow.layout,
        },
        projectId,
      );
      setWorkflows((ws) => [...ws, created]);
      setActiveId(created.id);
      addToast(`Duplicated to "${created.name}" — editable`, "success");
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to duplicate workflow", "error");
    }
  }, [activeWorkflow, projectId, addToast]);

  const handleSave = useCallback(async () => {
    if (!activeWorkflow) return;
    if (isBuiltinWorkflowId(activeWorkflow.id)) return; // built-ins are read-only
    setSaving(true);
    setValidationError(null);
    try {
      const { ir, layout } = flowToIr(activeWorkflow.name, nodes, edges);
      const updated = await updateWorkflow(activeWorkflow.id, { ir, layout }, projectId);
      setWorkflows((ws) => ws.map((w) => (w.id === updated.id ? updated : w)));
      // Validate by compiling — surfaces non-linear graphs as a banner.
      try {
        await compileWorkflow(updated.id, projectId);
        addToast("Workflow saved", "success");
      } catch (compileErr) {
        setValidationError(getErrorMessage(compileErr) || "Workflow saved but cannot be compiled");
      }
    } catch (err) {
      const message = getErrorMessage(err) || "Failed to save workflow";
      setValidationError(message);
      addToast(message, "error");
    } finally {
      setSaving(false);
    }
  }, [activeWorkflow, nodes, edges, projectId, addToast]);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;

  // Lazy-loaded executor resources
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<DiscoveredSkill[]>([]);

  const currentExecutor = (selectedNode?.data.config?.executor as ExecutorKind | undefined) ?? "model";

  useEffect(() => {
    if (!selectedNode || (selectedNode.data.kind !== "prompt" && selectedNode.data.kind !== "gate")) return;
    if (currentExecutor === "model" && models.length === 0) {
      fetchModels().then((res) => setModels(res.models)).catch((err) => {
        addToast(getErrorMessage(err) || "Failed to load models", "error");
      });
    } else if (currentExecutor === "agent" && agents.length === 0) {
      fetchAgents().then(setAgents).catch((err) => {
        addToast(getErrorMessage(err) || "Failed to load agents", "error");
      });
    } else if (currentExecutor === "skill" && skills.length === 0) {
      fetchDiscoveredSkills(projectId).then(setSkills).catch((err) => {
        addToast(getErrorMessage(err) || "Failed to load skills", "error");
      });
    }
  }, [
    currentExecutor,
    selectedNode?.id,
    selectedNode?.data.kind,
    projectId,
    addToast,
    models.length,
    agents.length,
    skills.length,
  ]);

  const overlayProps = useOverlayDismiss(onClose);

  return (
    <div className="modal-overlay open wf-editor-overlay" {...overlayProps}>
      <div className="modal wf-editor-modal" ref={modalRef} onClick={(e) => e.stopPropagation()}>
        <header className="wf-editor-header">
          <h2>Workflows</h2>
          <button className="wf-editor-close" onClick={onClose} aria-label="Close workflow editor">
            <X size={18} />
          </button>
        </header>

        <div className="wf-editor-body">
          <aside className="wf-editor-sidebar">
            <button className="wf-editor-new" onClick={handleCreateWorkflow}>
              <Plus size={14} /> New workflow
            </button>
            {loading ? (
              <div className="wf-editor-empty">
                <Loader2 size={16} className="wf-spin" /> Loading…
              </div>
            ) : workflows.length === 0 ? (
              <div className="wf-editor-empty">No workflows yet.</div>
            ) : (
              <ul className="wf-editor-list">
                {workflows.map((w) => (
                  <li key={w.id}>
                    <button
                      className={`wf-editor-list-item${w.id === activeId ? " active" : ""}`}
                      onClick={() => setActiveId(w.id)}
                    >
                      {w.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section className="wf-editor-canvas-wrap">
            {activeWorkflow ? (
              <>
                <div className="wf-editor-toolbar">
                  <div className="wf-editor-palette">
                    {PALETTE.map(({ kind, label, icon: Icon, presetConfig }) => (
                      <button
                        key={label}
                        className="wf-palette-btn"
                        onClick={() => addNode(kind, label, presetConfig)}
                        disabled={isBuiltin}
                        title={isBuiltin ? "Built-in workflows are read-only — duplicate to edit" : undefined}
                      >
                        <Icon size={13} /> {label}
                      </button>
                    ))}
                  </div>
                  <div className="wf-editor-actions">
                    {isBuiltin ? (
                      <>
                        <span className="wf-editor-readonly-note" role="status">
                          Read-only built-in
                        </span>
                        <button className="wf-editor-save" onClick={handleDuplicate}>
                          <Plus size={13} /> Duplicate to edit
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="wf-editor-delete" onClick={handleDeleteWorkflow}>
                          <Trash2 size={13} /> Delete
                        </button>
                        <button className="wf-editor-save" onClick={handleSave} disabled={saving}>
                          {saving ? <Loader2 size={13} className="wf-spin" /> : <Save size={13} />} Save
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {validationError && (
                  <div className="wf-editor-banner" role="alert">
                    {validationError}
                  </div>
                )}

                <div className="wf-editor-canvas">
                  <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={workflowNodeTypes}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    onNodeClick={(_, node) => setSelectedNodeId(node.id)}
                    onPaneClick={() => setSelectedNodeId(null)}
                    fitView
                  >
                    <Background />
                    <Controls />
                    <MiniMap pannable zoomable />
                  </ReactFlow>
                </div>
              </>
            ) : (
              <div className="wf-editor-empty wf-editor-canvas-empty">
                Select or create a workflow to start editing.
              </div>
            )}
          </section>

          {selectedNode && selectedNode.data.kind !== "start" && selectedNode.data.kind !== "end" && (
            <aside className="wf-editor-inspector">
              <h3>Node</h3>
              {isBuiltin && (
                <p className="wf-inspector-note wf-inspector-note--info">
                  Read-only built-in — duplicate the workflow to edit nodes.
                </p>
              )}
              <fieldset className="wf-inspector-fields" disabled={isBuiltin}>
              <label className="wf-field">
                <span>Name</span>
                <input
                  value={selectedNode.data.label}
                  onChange={(e) => updateSelectedData({ label: e.target.value })}
                />
              </label>

              {selectedNode.data.kind === "prompt" || selectedNode.data.kind === "gate" ? (
                <label className="wf-field">
                  <span>Prompt</span>
                  <textarea
                    rows={5}
                    value={String(selectedNode.data.config?.prompt ?? "")}
                    onChange={(e) => updateSelectedData({ config: { prompt: e.target.value } })}
                  />
                </label>
              ) : null}

              {selectedNode.data.kind === "prompt" ? (
                <>
                  <label className="wf-field">
                    <span>Executor</span>
                    <select
                      value={currentExecutor}
                      onChange={(e) => updateSelectedData({ config: { executor: e.target.value } })}
                    >
                      <option value="model">Model</option>
                      <option value="agent">Agent</option>
                      <option value="skill">Skill</option>
                      <option value="cli">CLI / script</option>
                    </select>
                  </label>

                  {currentExecutor === "model" && (
                    <label className="wf-field">
                      <span>Model</span>
                      <CustomModelDropdown
                        label="Model"
                        models={models}
                        value={getModelDropdownValue(
                          String(selectedNode.data.config?.modelProvider ?? ""),
                          String(selectedNode.data.config?.modelId ?? ""),
                        )}
                        onChange={(value) => {
                          const { provider, modelId } = parseModelDropdownValue(value);
                          updateSelectedData({ config: { modelProvider: provider || undefined, modelId: modelId || undefined } });
                        }}
                      />
                    </label>
                  )}

                  {currentExecutor === "agent" && (
                    <label className="wf-field">
                      <span>Agent</span>
                      <select
                        value={String(selectedNode.data.config?.agentId ?? "")}
                        onChange={(e) => updateSelectedData({ config: { agentId: e.target.value || undefined } })}
                      >
                        <option value="">— select agent —</option>
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    </label>
                  )}

                  {currentExecutor === "skill" && (
                    <label className="wf-field">
                      <span>Skill</span>
                      <select
                        value={String(selectedNode.data.config?.skillName ?? "")}
                        onChange={(e) => updateSelectedData({ config: { skillName: e.target.value || undefined } })}
                      >
                        <option value="">— select skill —</option>
                        {skills.map((s) => (
                          <option key={s.id} value={s.name}>{s.name}</option>
                        ))}
                      </select>
                    </label>
                  )}

                  {currentExecutor === "cli" && (
                    <>
                      <label className="wf-field">
                        <span>CLI mode</span>
                        <select
                          value={String(selectedNode.data.config?.cliMode ?? "command")}
                          onChange={(e) => updateSelectedData({ config: { cliMode: e.target.value } })}
                        >
                          <option value="command">Command</option>
                          <option value="script">Named script</option>
                        </select>
                      </label>
                      {(selectedNode.data.config?.cliMode ?? "command") === "command" ? (
                        <label className="wf-field">
                          <span>Command</span>
                          <textarea
                            rows={3}
                            placeholder="npm test -- --runInBand"
                            value={String(selectedNode.data.config?.cliCommand ?? "")}
                            onChange={(e) => updateSelectedData({ config: { cliCommand: e.target.value } })}
                          />
                          <p className="wf-inspector-note wf-inspector-note--info">
                            Runs an arbitrary command in the task worktree. The first time this exact command runs, the task pauses for your approval. The node prompt is passed via FUSION_NODE_PROMPT.
                          </p>
                          <label className="wf-field wf-field--checkbox">
                            <input
                              type="checkbox"
                              checked={selectedNode.data.config?.cliSkipApproval === true}
                              onChange={(e) => updateSelectedData({ config: { cliSkipApproval: e.target.checked } })}
                            />
                            <span>Skip first-run approval (runs without pausing)</span>
                          </label>
                        </label>
                      ) : (
                        <label className="wf-field">
                          <span>Script name</span>
                          <input
                            value={String(selectedNode.data.config?.scriptName ?? "")}
                            onChange={(e) => updateSelectedData({ config: { scriptName: e.target.value } })}
                          />
                          <span className="wf-inspector-note">Named script from project settings. The node prompt is passed via FUSION_NODE_PROMPT.</span>
                        </label>
                      )}
                    </>
                  )}

                  <label className="wf-field wf-field--checkbox">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedNode.data.config?.autoApprove)}
                      onChange={(e) => updateSelectedData({ config: { autoApprove: e.target.checked } })}
                    />
                    <span>Auto-approve requests</span>
                  </label>
                  {Boolean(selectedNode.data.config?.autoApprove) && (
                    <p className="wf-inspector-note">
                      Runs without pausing for approval — e.g. a CLI command executes on its first run without waiting for your sign-off.
                    </p>
                  )}

                  <label className="wf-field">
                    <span>Max retries</span>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      placeholder="default"
                      value={selectedNode.data.config?.maxRetries != null ? String(selectedNode.data.config.maxRetries) : ""}
                      onChange={(e) => {
                        const val = e.target.value.trim();
                        if (val === "") {
                          updateSelectedData({
                            config: (prev) => {
                              const next = { ...prev };
                              delete next.maxRetries;
                              return next;
                            },
                          });
                        } else {
                          const num = parseInt(val, 10);
                          if (!isNaN(num)) updateSelectedData({ config: { maxRetries: num } });
                        }
                      }}
                    />
                  </label>

                  <label className="wf-field wf-field--checkbox">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedNode.data.config?.awaitInput)}
                      onChange={(e) => updateSelectedData({ config: { awaitInput: e.target.checked } })}
                    />
                    <span>Wait for user input</span>
                  </label>
                  {Boolean(selectedNode.data.config?.awaitInput) && (
                    <p className="wf-inspector-note wf-inspector-note--info">
                      This node pauses the task until you reply in the task's comments and unpause. The Prompt field above is shown to the user as the question.
                    </p>
                  )}
                </>
              ) : null}

              {selectedNode.data.kind === "script" ? (
                <label className="wf-field">
                  <span>Script name</span>
                  <input
                    value={String(selectedNode.data.config?.scriptName ?? "")}
                    onChange={(e) => updateSelectedData({ config: { scriptName: e.target.value } })}
                  />
                </label>
              ) : null}

              {selectedNode.data.kind !== "merge" ? (
                <label className="wf-field">
                  <span>Gate mode</span>
                  <select
                    // Default display must match the compiler's defaults:
                    // gate and script nodes block by default, prompt is advisory.
                    value={String(
                      selectedNode.data.config?.gateMode
                        ?? (selectedNode.data.kind === "prompt" ? "advisory" : "gate"),
                    )}
                    onChange={(e) => updateSelectedData({ config: { gateMode: e.target.value } })}
                  >
                    <option value="advisory">Advisory</option>
                    <option value="gate">Gate (blocks)</option>
                  </select>
                </label>
              ) : (
                <p className="wf-inspector-note">
                  Steps before this marker run pre-merge; steps after run post-merge.
                </p>
              )}
              </fieldset>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

export function WorkflowNodeEditor({ isOpen, ...rest }: WorkflowNodeEditorProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  useModalResizePersist(modalRef, isOpen, "fusion:workflow-node-editor-size");
  if (!isOpen) return null;
  return (
    <ReactFlowProvider>
      <InnerEditor {...rest} modalRef={modalRef} />
    </ReactFlowProvider>
  );
}
