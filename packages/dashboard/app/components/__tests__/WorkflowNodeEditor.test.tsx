import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import { parseWorkflowIr, type WorkflowDefinition, type Settings } from "@fusion/core";
import type { Agent } from "../../api";
import {
  irToFlow,
  flowToIr,
  emptyWorkflowIr,
  emptyWorkflowLayout,
  foreachChildFlowId,
  WF_EDGE_INTERACTION_WIDTH,
} from "../workflow-flow-mapping";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  BUILTIN_PR_WORKFLOW_IR,
  BUILTIN_STEPWISE_CODING_WORKFLOW_IR,
  BUILTIN_WORKFLOWS,
} from "@fusion/core";

vi.mock("../../api", () => ({
  fetchWorkflows: vi.fn(),
  createWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
  compileWorkflow: vi.fn(),
  exportWorkflow: vi.fn(),
  importWorkflow: vi.fn(),
  designWorkflow: vi.fn(),
  ApiRequestError: class ApiRequestError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "ApiRequestError";
      this.status = status;
    }
  },
  migrateLegacyWorkflowSteps: vi.fn(),
  fetchTraits: vi.fn(),
  fetchStepParsers: vi.fn(),
  fetchModels: vi.fn(),
  fetchAgents: vi.fn(),
  fetchDiscoveredSkills: vi.fn(),
  // Default to resolved empty lists so editors mounted by tests that don't
  // exercise the Templates section don't reject the on-open prefetch.
  fetchWorkflowStepTemplates: vi.fn().mockResolvedValue({ templates: [] }),
  fetchPluginWorkflowStepTemplates: vi.fn().mockResolvedValue({ templates: [] }),
  // useAppSettings (threaded into the editor for the column-agent flag gate, U6)
  // imports these from the same module; provide resolved stubs so the real hook
  // does not throw on undefined fns.
  fetchConfig: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
  updateWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
}));

import { fireEvent } from "@testing-library/react";
import {
  fetchWorkflows,
  fetchTraits,
  fetchStepParsers,
  updateWorkflow,
  compileWorkflow,
  createWorkflow,
  deleteWorkflow,
  fetchModels,
  migrateLegacyWorkflowSteps,
  exportWorkflow,
  importWorkflow,
  designWorkflow,
  ApiRequestError,
  fetchWorkflowStepTemplates,
  fetchPluginWorkflowStepTemplates,
  fetchAgents,
  fetchConfig,
  fetchSettings,
} from "../../api";
import type { TraitCatalogEntry } from "../../api";
import type { WorkflowStepTemplate } from "@fusion/core";
import { beforeEach as viBeforeEach } from "vitest";
import { WorkflowNodeEditor } from "../WorkflowNodeEditor";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";
import { MOBILE_MEDIA_QUERY } from "../../hooks/useViewportMode";

function getPromptFullscreenOverlay() {
  return document.body.querySelector(".wf-prompt-editor--fullscreen") as HTMLElement | null;
}

function getPromptFullscreenTextarea() {
  const overlay = getPromptFullscreenOverlay();
  expect(overlay).not.toBeNull();
  return within(overlay!).getByLabelText("Prompt") as HTMLTextAreaElement;
}

function mockWorkflowEditorViewport(mode: "desktop" | "mobile" | "tablet" = "desktop") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches:
        (mode === "mobile" && (query === MOBILE_MEDIA_QUERY || query === "(max-width: 768px)")) ||
        (mode === "tablet" && query === "(min-width: 769px) and (max-width: 1024px)"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// useAppSettings (threaded into the editor for the column-agent flag gate)
// fetches config + settings on mount via the mocked api module. Default both to
// resolved empties for every test so the real hook never rejects; column-agent
// tests override fetchSettings to flip the flags on. fetchAgents defaults empty.
viBeforeEach(() => {
  mockWorkflowEditorViewport("desktop");
  vi.mocked(fetchConfig).mockResolvedValue({ maxConcurrent: 2, rootDir: "." });
  vi.mocked(fetchSettings).mockResolvedValue({} as never);
  vi.mocked(fetchAgents).mockResolvedValue([]);
});

const TRAIT_CATALOG: TraitCatalogEntry[] = [
  { id: "intake", name: "Intake", builtin: true, flags: { intake: true } },
  { id: "complete", name: "Complete", builtin: true, flags: { complete: true } },
  { id: "wip", name: "WIP", builtin: true, flags: { countsTowardWip: true } },
  { id: "hold", name: "Hold", builtin: true, flags: { hold: true } },
];

function v2Def(): WorkflowDefinition {
  return {
    id: "WF-002",
    kind: "workflow",
    name: "Custom",
    description: "",
    ir: {
      version: "v2",
      name: "Custom",
      columns: [
        { id: "triage", name: "Triage", traits: [{ trait: "intake" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "triage" },
        { id: "step", kind: "prompt", column: "triage", config: { prompt: "do" } },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "step", condition: "success" },
        { from: "step", to: "end", condition: "success" },
      ],
    },
    layout: {
      start: { x: 0, y: 20 },
      step: { x: 120, y: 60 },
      end: { x: 360, y: 240 },
    },
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}

function builtinDef(): WorkflowDefinition {
  return {
    id: "builtin:coding",
    kind: "workflow",
    name: "Default coding workflow",
    description: "Ships with Fusion",
    ir: BUILTIN_CODING_WORKFLOW_IR,
    layout: {},
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}

function builtinPrDef(): WorkflowDefinition {
  return {
    id: "builtin:pr-workflow",
    kind: "fragment",
    name: "PR lifecycle (built-in)",
    description: "Ships with Fusion",
    ir: BUILTIN_PR_WORKFLOW_IR,
    layout: {},
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}

async function selectBuiltinExecutePromptNode() {
  await screen.findByTestId("wf-readonly-banner");
  const promptNodes = await screen.findAllByTestId("wf-node-prompt");
  const executeNode = promptNodes.find((node) => within(node).queryByText("Execute"));
  expect(executeNode).toBeTruthy();
  fireEvent.click(executeNode!);
  return executeNode!;
}

function edgeRenderableAssertion(definition: WorkflowDefinition) {
  const flow = irToFlow(definition);
  const nodeIds = new Set(flow.nodes.map((node) => node.id));
  expect(flow.edges.length, `${definition.id} should project edges`).toBeGreaterThan(0);
  for (const edge of flow.edges) {
    expect(nodeIds.has(edge.source), `${definition.id} edge ${edge.id} source ${edge.source}`).toBe(true);
    expect(nodeIds.has(edge.target), `${definition.id} edge ${edge.id} target ${edge.target}`).toBe(true);
    expect(edge.interactionWidth, `${definition.id} edge ${edge.id} interaction width`).toBe(
      WF_EDGE_INTERACTION_WIDTH,
    );
    expect(edge.zIndex, `${definition.id} edge ${edge.id} z-index`).toBeGreaterThan(0);
    expect(edge.sourceHandle, `${definition.id} edge ${edge.id} source handle`).toBeUndefined();
    expect(edge.targetHandle, `${definition.id} edge ${edge.id} target handle`).toBeUndefined();
  }
  return flow;
}

function fragmentDef(): WorkflowDefinition {
  return {
    id: "WF-FRAG",
    kind: "fragment",
    name: "Lint fragment",
    description: "A single lint step",
    ir: {
      version: "v1",
      name: "Lint fragment",
      nodes: [{ id: "lint", kind: "gate", config: { scriptName: "lint" } }],
      edges: [],
    },
    layout: { lint: { x: 0, y: 0 } },
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}

function def(): WorkflowDefinition {
  return {
    id: "WF-001",
    kind: "workflow",
    name: "QA",
    description: "",
    ir: {
      version: "v1",
      name: "QA",
      nodes: [
        { id: "start", kind: "start" },
        { id: "lint", kind: "gate", config: { name: "Lint", scriptName: "lint", gateMode: "gate" } },
        { id: "merge", kind: "prompt", config: { seam: "merge", name: "Merge boundary" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "lint", condition: "success" },
        { from: "lint", to: "merge", condition: "success" },
        { from: "merge", to: "end", condition: "success" },
      ],
    },
    layout: { start: { x: 0, y: 0 }, lint: { x: 120, y: 0 }, merge: { x: 240, y: 0 }, end: { x: 360, y: 0 } },
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}

function scriptDef(): WorkflowDefinition {
  return {
    id: "WF-SCRIPT",
    kind: "workflow",
    name: "Script workflow",
    description: "",
    ir: {
      version: "v2",
      name: "Script workflow",
      columns: [
        { id: "triage", name: "Triage", traits: [{ trait: "intake" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "triage" },
        { id: "run", kind: "script", column: "triage", config: { scriptName: "test" } },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "run", condition: "success" },
        { from: "run", to: "end", condition: "success" },
      ],
    },
    layout: { start: { x: 0, y: 20 }, run: { x: 120, y: 60 }, end: { x: 360, y: 240 } },
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}

function plainConnectDef(): WorkflowDefinition {
  return {
    id: "WF-PLAIN-CONNECT",
    kind: "workflow",
    name: "Plain connect",
    description: "",
    ir: {
      version: "v2",
      name: "Plain connect",
      columns: [
        { id: "triage", name: "Triage", traits: [{ trait: "intake" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "triage" },
        { id: "draft", kind: "step-review", column: "triage", config: { type: "code" } },
        { id: "review", kind: "prompt", column: "triage", config: { prompt: "review" } },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "draft", condition: "success" },
        { from: "review", to: "end", condition: "success" },
      ],
    },
    layout: {
      start: { x: 0, y: 20 },
      draft: { x: 120, y: 60 },
      review: { x: 240, y: 120 },
      end: { x: 360, y: 240 },
    },
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}

describe("workflow-flow-mapping", () => {
  it("round-trips IR through flow and back, preserving structure and layout", () => {
    const original = def();
    const flow = irToFlow(original);
    expect(flow.nodes).toHaveLength(4);
    expect(flow.nodes.find((n) => n.id === "lint")?.type).toBe("gate");
    expect(flow.nodes.find((n) => n.id === "merge")?.type).toBe("merge");
    expect(flow.nodes.find((n) => n.id === "start")?.position).toEqual({ x: 0, y: 0 });

    const { ir, layout } = flowToIr(original.name, flow.nodes, flow.edges);
    expect(ir.nodes.map((n) => n.id)).toEqual(["start", "lint", "merge", "end"]);
    // merge marker maps back to a prompt node carrying the seam config.
    const mergeNode = ir.nodes.find((n) => n.id === "merge");
    expect(mergeNode?.kind).toBe("prompt");
    expect(mergeNode?.config?.seam).toBe("merge");
    expect(ir.edges).toHaveLength(3);
    expect(layout.lint).toEqual({ x: 120, y: 0 });
  });

  it("emptyWorkflowIr seeds a connected start→end graph", () => {
    const ir = emptyWorkflowIr("New");
    expect(ir.nodes.map((n) => n.kind)).toEqual(["start", "end"]);
    expect(ir.edges).toEqual([{ from: "start", to: "end", condition: "success" }]);
    expect(emptyWorkflowLayout().start).toBeDefined();
  });

  it("projects every built-in workflow to connected, clickable React Flow edges", () => {
    expect(BUILTIN_WORKFLOWS.map((workflow) => workflow.id).sort()).toEqual(
      expect.arrayContaining(["builtin:coding", "builtin:stepwise-coding", "builtin:pr-workflow"]),
    );
    expect(BUILTIN_WORKFLOWS.find((workflow) => workflow.id === "builtin:pr-workflow")?.kind).toBe("fragment");

    for (const workflow of BUILTIN_WORKFLOWS) {
      edgeRenderableAssertion(workflow);
    }
  });

  it("keeps built-in edge endpoints connected when layout is empty, undefined, or populated", () => {
    const populated = BUILTIN_WORKFLOWS.find((workflow) => workflow.id === "builtin:pr-workflow");
    expect(populated).toBeDefined();
    edgeRenderableAssertion(populated!);
    edgeRenderableAssertion({ ...populated!, layout: {} });
    edgeRenderableAssertion({ ...populated!, layout: undefined });
  });

  it("projects custom v1 and v2 workflows to the same connected edge contract", () => {
    edgeRenderableAssertion(def());
    edgeRenderableAssertion(v2Def());
  });

  it("preserves duplicate and parallel built-in edges with valid endpoints and hit targets", () => {
    const { edges } = edgeRenderableAssertion(builtinDef());
    const failuresToEnd = edges.filter((edge) => edge.target === "end" && edge.data?.condition === "failure");
    expect(failuresToEnd.map((edge) => edge.source).sort()).toEqual([
      "execute",
      "merge-attempt",
      "planning",
      "review",
      "workflow-step",
    ]);
    expect(new Set(failuresToEnd.map((edge) => edge.id)).size).toBe(failuresToEnd.length);
    expect(failuresToEnd.every((edge) => edge.interactionWidth === WF_EDGE_INTERACTION_WIDTH)).toBe(true);
  });
});

describe("WorkflowNodeEditor", () => {
  beforeEach(() => {
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
  });

  afterEach(() => {
    localStorage.removeItem("fusion:wf-sidebar-settings-collapsed");
    localStorage.removeItem("fusion:wf-templates-collapsed");
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the empty state when there are no workflows (no canvas)", async () => {
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    expect(await screen.findByText("Workflows")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/No workflows yet/i)).toBeInTheDocument());
    expect(screen.getByText(/No workflow selected/i)).toBeInTheDocument();
    expect(screen.getByTestId("wf-empty-create")).toBeInTheDocument();
    expect(screen.queryByTestId("wf-mobile-select-note")).not.toBeInTheDocument();
  });

  it("preselects the first populated workflow on desktop", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def(), v2Def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    expect(await screen.findByTestId("wf-workflow-name")).toHaveTextContent("QA");
    expect(screen.queryByTestId("wf-mobile-select-note")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "QA" })[0]).toHaveClass("active");
  });

  it("lets desktop users switch to the simple graph layout and back", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    expect(await screen.findByTestId("wf-workflow-name")).toHaveTextContent("QA");
    expect(screen.queryByTestId("wf-mobile-shell")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("wf-layout-toggle"));

    expect(await screen.findByTestId("wf-mobile-shell")).toBeInTheDocument();
    expect(screen.getByTestId("wf-mobile-tab-graph")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "start start" })).toBeInTheDocument();
    expect(screen.getByTestId("wf-layout-toggle")).toHaveTextContent("Show canvas editor");

    fireEvent.click(screen.getByTestId("wf-layout-toggle"));

    await waitFor(() => expect(screen.queryByTestId("wf-mobile-shell")).not.toBeInTheDocument());
    expect(screen.getByTestId("wf-layout-toggle")).toHaveTextContent("Show simple editor");
  });

  it("surfaces the full styled simple-editor affordance set at desktop width", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    expect(await screen.findByTestId("wf-workflow-name")).toHaveTextContent("QA");
    fireEvent.click(screen.getByTestId("wf-layout-toggle"));

    const shell = await screen.findByTestId("wf-mobile-shell");
    for (const panel of ["graph", "add", "settings", "fields", "columns", "actions"]) {
      expect(within(shell).getByTestId(`wf-mobile-tab-${panel}`)).toBeInTheDocument();
    }

    fireEvent.click(screen.getByTestId("wf-mobile-tab-actions"));
    expect(screen.getByTestId("wf-mobile-save")).toBeInTheDocument();
    expect(screen.getByTestId("wf-mobile-ai-edit")).toBeInTheDocument();
    expect(screen.getByTestId("wf-mobile-auto-layout")).toBeInTheDocument();
    expect(screen.getByTestId("wf-mobile-export")).toBeInTheDocument();
    expect(screen.getByTestId("wf-mobile-delete")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("wf-mobile-tab-add"));
    expect(screen.getByTestId("wf-mobile-add-prompt-prompt")).toBeInTheDocument();
    expect(screen.getByTestId("wf-mobile-add-script-script")).toBeInTheDocument();
    expect(screen.getByTestId("wf-mobile-add-gate-gate")).toBeInTheDocument();
  });

  it("creates a condition-capable edge from the mobile simple graph without the canvas", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "QA" }));
    await screen.findByText("Save");
    const shell = await screen.findByTestId("wf-mobile-shell");
    expect(within(shell).queryByTestId("rf__wrapper")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-wf-connect-start")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-wf-connect-end")).not.toBeInTheDocument();

    fireEvent.click(await screen.findByTestId("mobile-wf-connect-lint"));
    fireEvent.change(screen.getByTestId("mobile-wf-connect-target-lint"), { target: { value: "end" } });

    const inspector = await screen.findByTestId("wf-edge-inspector");
    expect(within(inspector).getByTestId("wf-edge-condition")).toHaveValue("success");
    expect(screen.getAllByText("end").length).toBeGreaterThan(1);
  });

  it("creates a verdict-source edge in the desktop compact simple graph", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([plainConnectDef()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    expect(await screen.findByTestId("wf-workflow-name")).toHaveTextContent("Plain connect");
    fireEvent.click(screen.getByTestId("wf-layout-toggle"));
    await screen.findByTestId("wf-mobile-shell");

    fireEvent.click(await screen.findByTestId("mobile-wf-connect-draft"));
    fireEvent.change(screen.getByTestId("mobile-wf-connect-target-draft"), { target: { value: "review" } });

    const inspector = await screen.findByTestId("wf-edge-inspector");
    expect(within(inspector).queryByTestId("wf-edge-condition")).not.toBeInTheDocument();
    expect(within(inspector).getByTestId("wf-edge-verdict")).toHaveValue("");
  });

  it("hides simple-graph connection controls for built-in read-only workflows", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Default coding workflow" }));
    await screen.findByTestId("wf-mobile-shell");
    expect(screen.queryByTestId(/mobile-wf-connect-/)).not.toBeInTheDocument();
  });

  it("rejects cyclic desktop compact-graph connections with a toast", async () => {
    mockWorkflowEditorViewport("desktop");
    const addToast = vi.fn();
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={addToast} />);

    await screen.findByText("Save");
    expect(await screen.findByTestId("wf-workflow-name")).toHaveTextContent("QA");
    fireEvent.click(screen.getByTestId("wf-layout-toggle"));
    await screen.findByTestId("wf-mobile-shell");

    fireEvent.click(await screen.findByTestId("mobile-wf-connect-merge"));
    fireEvent.change(screen.getByTestId("mobile-wf-connect-target-merge"), { target: { value: "lint" } });
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(
      "That connection would create a cycle — only rework edges inside a for-each template may loop back",
      "warning",
    ));
    expect(screen.queryByText("merge → lint")).not.toBeInTheDocument();
    expect(screen.queryByTestId("wf-edge-inspector")).not.toBeInTheDocument();
  });

  it("rejects cyclic simple-graph connections with a toast", async () => {
    mockWorkflowEditorViewport("mobile");
    const addToast = vi.fn();
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={addToast} />);

    fireEvent.click(await screen.findByRole("button", { name: "QA" }));
    await screen.findByTestId("wf-mobile-shell");

    fireEvent.click(await screen.findByTestId("mobile-wf-connect-merge"));
    fireEvent.change(screen.getByTestId("mobile-wf-connect-target-merge"), { target: { value: "lint" } });
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(
      "That connection would create a cycle — only rework edges inside a for-each template may loop back",
      "warning",
    ));
    expect(screen.queryByTestId("wf-edge-inspector")).not.toBeInTheDocument();
  });

  it("offers connection controls for editable foreach template children in the simple graph", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([stepwiseDef()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Stepwise" }));
    await screen.findByTestId("wf-mobile-shell");
    expect(await screen.findByTestId(`mobile-wf-connect-${foreachChildFlowId("loop", "exec")}`)).toBeInTheDocument();
  });

  it("surfaces built-in simple-editor actions at desktop width", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    expect(await screen.findByTestId("wf-workflow-name")).toHaveTextContent("Default coding workflow");
    fireEvent.click(screen.getByTestId("wf-layout-toggle"));
    await screen.findByTestId("wf-mobile-shell");

    fireEvent.click(screen.getByTestId("wf-mobile-tab-actions"));
    expect(screen.getByTestId("wf-mobile-export")).toBeInTheDocument();
    expect(screen.getByTestId("wf-mobile-duplicate")).toBeInTheDocument();
    expect(screen.queryByTestId("wf-mobile-save")).not.toBeInTheDocument();
    expect(screen.queryByTestId("wf-mobile-delete")).not.toBeInTheDocument();
  });

  it("keeps simple-editor shell styling outside the mobile media query", () => {
    const css = readFileSync("app/components/WorkflowNodeEditor.css", "utf8");
    const mobileMediaIndex = css.indexOf("@media (max-width: 768px)");

    expect(css.indexOf("--wf-editor-touch-target")).toBeGreaterThanOrEqual(0);
    expect(css.indexOf("--wf-editor-touch-target")).toBeLessThan(mobileMediaIndex);
    expect(css.indexOf(".wf-mobile-tab {")).toBeLessThan(mobileMediaIndex);
    expect(css.indexOf(".wf-mobile-actions .wf-editor-action")).toBeLessThan(mobileMediaIndex);
  });

  it("lets tablet users switch to the simple graph layout", async () => {
    mockWorkflowEditorViewport("tablet");
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    expect(await screen.findByTestId("wf-workflow-name")).toHaveTextContent("QA");
    fireEvent.click(screen.getByTestId("wf-layout-toggle"));

    expect(await screen.findByTestId("wf-mobile-shell")).toBeInTheDocument();
    expect(screen.getByTestId("wf-mobile-tab-actions")).toBeInTheDocument();
  });

  it("preselects the matching initial workflow id on desktop", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def(), v2Def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} initialWorkflowId="WF-002" />);

    expect(await screen.findByTestId("wf-workflow-name")).toHaveTextContent("Custom");
    expect(screen.queryByTestId("wf-mobile-select-note")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "QA" })).not.toHaveClass("active");
    expect(screen.getAllByRole("button", { name: "Custom" })[0]).toHaveClass("active");
  });

  it("falls back to the first workflow on desktop when the initial workflow id is missing", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def(), v2Def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} initialWorkflowId="WF-missing" />);

    expect(await screen.findByTestId("wf-workflow-name")).toHaveTextContent("QA");
    expect(screen.queryByTestId("wf-mobile-select-note")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "QA" })[0]).toHaveClass("active");
    expect(screen.getByRole("button", { name: "Custom" })).not.toHaveClass("active");
  });

  it("skips the mobile workflow list stage when the initial workflow id is valid", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([def(), v2Def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} initialWorkflowId="WF-002" />);

    expect(await screen.findByTestId("wf-workflow-name")).toHaveTextContent("Custom");
    expect(screen.queryByTestId("wf-mobile-select-note")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "QA" })).not.toHaveClass("active");
    expect(screen.getAllByRole("button", { name: "Custom" })[0]).toHaveClass("active");
  });

  it("opens populated mobile workflows on the list with no preselected workflow", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([def(), v2Def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    expect(await screen.findByTestId("wf-mobile-select-note")).toHaveTextContent("Select a workflow to edit.");
    expect(screen.getByText(/No workflow selected/i)).toBeInTheDocument();
    expect(screen.queryByTestId("wf-workflow-name")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "QA" })).not.toHaveClass("active");
    expect(screen.getByRole("button", { name: "Custom" })).not.toHaveClass("active");
  });

  it("selects by workflow id on mobile even when workflow names are duplicated", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([
      { ...def(), id: "WF-DUP-A", name: "QA" },
      { ...v2Def(), id: "WF-DUP-B", name: "QA" },
    ]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await screen.findByTestId("wf-mobile-select-note");
    const qaButtons = screen.getAllByRole("button", { name: "QA" });
    expect(qaButtons).toHaveLength(2);
    expect(qaButtons[0]).not.toHaveClass("active");
    expect(qaButtons[1]).not.toHaveClass("active");

    fireEvent.click(qaButtons[1]);

    await waitFor(() => expect(qaButtons[1]).toHaveClass("active"));
    expect(qaButtons[0]).not.toHaveClass("active");
    expect(screen.queryByTestId("wf-mobile-select-note")).not.toBeInTheDocument();
    expect(await screen.findByTestId("wf-workflow-name")).toHaveTextContent("QA");
  });

  it("collapses and expands the selected node inspector on mobile", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "QA" }));
    const mobileGateRow = await screen.findByTestId("mobile-wf-node-lint");
    fireEvent.click(within(mobileGateRow).getAllByRole("button")[0]);

    const inspector = await screen.findByTestId("wf-node-inspector");
    expect(within(inspector).getByLabelText("Prompt")).toBeInTheDocument();
    expect(inspector.closest(".wf-editor-body")).toHaveClass("wf-editor-body--mobile-node-detail");

    fireEvent.click(screen.getByTestId("wf-inspector-toggle"));

    await waitFor(() => expect(screen.queryByTestId("wf-node-inspector")).not.toBeInTheDocument());
    expect(screen.queryByLabelText("Prompt")).not.toBeInTheDocument();
    expect(await screen.findByTestId("mobile-wf-graph")).toBeVisible();

    fireEvent.click(within(await screen.findByTestId("mobile-wf-node-lint")).getAllByRole("button")[0]);

    expect(await screen.findByTestId("wf-node-inspector")).toBeInTheDocument();
    expect(screen.getByTestId("wf-inspector-toggle")).toHaveAttribute("aria-expanded", "true");
  });

  it("edits the start node entry column from the desktop inspector and saves it", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({
      ...v2Def(),
      ...(updates as object),
    }));
    vi.mocked(compileWorkflow).mockResolvedValue({ steps: [] });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await screen.findByText("Save");
    await screen.findByTestId("wf-column-panel");
    fireEvent.click(await screen.findByTestId("wf-node-start"));

    const inspector = await screen.findByTestId("wf-node-inspector");
    expect(within(inspector).getByTestId("wf-start-inspector")).toHaveTextContent(
      "The start node marks where a task enters the workflow.",
    );
    expect(within(inspector).queryByLabelText("Name")).not.toBeInTheDocument();
    const entryColumn = within(inspector).getByTestId("wf-start-entry-column");
    expect(entryColumn).toHaveValue("triage");
    expect(within(inspector).getByRole("option", { name: "— Auto (first column)" })).toHaveValue("");

    fireEvent.change(entryColumn, { target: { value: "done" } });
    expect(entryColumn).toHaveValue("done");

    fireEvent.click(screen.getByText("Save").closest("button")!);

    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    const [, updates] = vi.mocked(updateWorkflow).mock.calls[0];
    const ir = (updates as { ir: WorkflowDefinition["ir"] }).ir;
    const start = ir.nodes.find((node) => node.kind === "start");
    expect(start?.column).toBe("done");
  });

  it("renders the start inspector without the entry-column select for v1 workflows", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await screen.findByText("Save");
    fireEvent.click(await screen.findByTestId("wf-node-start"));

    const inspector = await screen.findByTestId("wf-node-inspector");
    expect(within(inspector).getByTestId("wf-start-inspector")).toHaveTextContent(
      "The start node marks where a task enters the workflow.",
    );
    expect(within(inspector).queryByTestId("wf-start-entry-column")).not.toBeInTheDocument();
    expect(within(inspector).queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("keeps built-in start node entry-column controls read-only", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await screen.findByTestId("wf-readonly-banner");
    fireEvent.click(await screen.findByTestId("wf-node-start"));

    const inspector = await screen.findByTestId("wf-node-inspector");
    expect(within(inspector).getByText(/Read-only built-in/i)).toBeInTheDocument();
    expect(within(inspector).getByTestId("wf-start-entry-column")).toBeDisabled();
  });

  it("opens the start node inspector from the mobile node-detail stage", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Custom" }));
    fireEvent.click(within(await screen.findByTestId("mobile-wf-node-start")).getAllByRole("button")[0]);

    const inspector = await screen.findByTestId("wf-node-inspector");
    expect(inspector.closest(".wf-editor-body")).toHaveClass("wf-editor-body--mobile-node-detail");
    expect(within(inspector).getByTestId("wf-start-entry-column")).toHaveValue("triage");

    fireEvent.click(screen.getByTestId("wf-inspector-toggle"));
    await waitFor(() => expect(screen.queryByTestId("wf-node-inspector")).not.toBeInTheDocument());
    fireEvent.click(within(await screen.findByTestId("mobile-wf-node-start")).getAllByRole("button")[0]);

    expect(await screen.findByTestId("wf-node-inspector")).toBeInTheDocument();
    expect(screen.getByTestId("wf-inspector-toggle")).toHaveAttribute("aria-expanded", "true");
  });

  it("leaves the end node without an editable inspector", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await screen.findByText("Save");
    fireEvent.click(await screen.findByTestId("wf-node-end"));

    await waitFor(() => expect(screen.queryByTestId("wf-node-inspector")).not.toBeInTheDocument());
  });

  it("opens selected edge details as a dismissible full-screen mobile stage", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Custom" }));
    await screen.findByText("Save");
    await screen.findByTestId("mobile-wf-graph");

    const mobileEdgeChip = await screen.findByTestId("mobile-wf-edge-e-step-end-1");
    fireEvent.click(mobileEdgeChip);

    const edgeInspector = await screen.findByTestId("wf-edge-inspector");
    const editorBody = edgeInspector.closest(".wf-editor-body");
    expect(editorBody).toHaveClass("wf-editor-body--mobile-edge-detail");
    expect(editorBody).not.toHaveClass("wf-editor-body--mobile-node-detail");
    expect(within(edgeInspector).getByRole("button", { name: /delete edge/i })).toBeInTheDocument();
    expect(screen.getByTestId("wf-mobile-shell").closest(".wf-editor-canvas-wrap")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("wf-edge-inspector-close"));
    await waitFor(() => expect(screen.queryByTestId("wf-edge-inspector")).not.toBeInTheDocument());
    expect(await screen.findByTestId("mobile-wf-graph")).toBeVisible();

    fireEvent.click(within(await screen.findByTestId("mobile-wf-node-step")).getAllByRole("button")[0]);

    const nodeInspector = await screen.findByTestId("wf-node-inspector");
    expect(nodeInspector.closest(".wf-editor-body")).toHaveClass("wf-editor-body--mobile-node-detail");
    expect(nodeInspector.closest(".wf-editor-body")).not.toHaveClass("wf-editor-body--mobile-edge-detail");
  });

  it("auto-expands the mobile inspector when selecting another node", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "QA" }));
    fireEvent.click(within(await screen.findByTestId("mobile-wf-node-lint")).getAllByRole("button")[0]);
    expect(await screen.findByTestId("wf-node-inspector")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("wf-inspector-toggle"));
    await waitFor(() => expect(screen.queryByTestId("wf-node-inspector")).not.toBeInTheDocument());

    fireEvent.click(within(await screen.findByTestId("mobile-wf-node-merge")).getAllByRole("button")[0]);

    const inspector = await screen.findByTestId("wf-node-inspector");
    expect(within(inspector).getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByTestId("wf-inspector-toggle")).toHaveAttribute("aria-expanded", "true");
  });

  it("shows a prompt expand button and toggles fullscreen for prompt nodes", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await screen.findByText("Save");
    fireEvent.click(await screen.findByTestId("wf-node-prompt"));

    const expand = await screen.findByRole("button", { name: "Expand prompt editor" });
    expect(expand).toBeInTheDocument();

    const inlinePromptEditor = expand.closest(".wf-prompt-editor");
    expect(inlinePromptEditor).not.toBeNull();
    expect(inlinePromptEditor).not.toHaveClass("wf-prompt-editor--fullscreen");
    expect(getPromptFullscreenOverlay()).toBeNull();

    fireEvent.click(expand);

    const fullscreenPromptEditor = getPromptFullscreenOverlay();
    expect(fullscreenPromptEditor).toBeInTheDocument();
    expect(inlinePromptEditor).not.toHaveClass("wf-prompt-editor--fullscreen");
    expect(within(fullscreenPromptEditor!).getByRole("button", { name: "Collapse prompt editor" })).toBeVisible();
    expect(getPromptFullscreenTextarea()).not.toHaveAttribute("rows");

    fireEvent.click(within(fullscreenPromptEditor!).getByRole("button", { name: "Collapse prompt editor" }));

    expect(getPromptFullscreenOverlay()).toBeNull();
    expect(screen.getByRole("button", { name: "Expand prompt editor" })).toBeInTheDocument();
  });

  it("collapses the fullscreen prompt editor on Escape", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await screen.findByText("Save");
    fireEvent.click(await screen.findByTestId("wf-node-prompt"));
    fireEvent.click(await screen.findByRole("button", { name: "Expand prompt editor" }));

    const promptEditor = getPromptFullscreenOverlay();
    expect(promptEditor).toBeInTheDocument();

    fireEvent.keyDown(promptEditor!, { key: "Escape" });

    expect(getPromptFullscreenOverlay()).toBeNull();
    expect(screen.getByRole("button", { name: "Expand prompt editor" })).toBeInTheDocument();
  });

  it("shows the prompt expand button for gate nodes with an empty prompt", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "QA" }));
    fireEvent.click(await screen.findByTestId("wf-node-gate"));

    const inspector = await screen.findByTestId("wf-node-inspector");
    expect(within(inspector).getByLabelText("Prompt")).toHaveValue("");
    expect(within(inspector).getByRole("button", { name: "Expand prompt editor" })).toBeInTheDocument();
  });

  it("opens the fullscreen prompt editor from the mobile prompt inspector", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Custom" }));
    fireEvent.click(await screen.findByTestId("wf-node-prompt"));

    const inspector = await screen.findByTestId("wf-node-inspector");
    fireEvent.click(within(inspector).getByRole("button", { name: "Expand prompt editor" }));

    const fullscreenPromptEditor = getPromptFullscreenOverlay();
    expect(fullscreenPromptEditor).toBeInTheDocument();
    expect(within(fullscreenPromptEditor!).getByRole("button", { name: "Collapse prompt editor" })).toBeVisible();
    expect(getPromptFullscreenTextarea()).toHaveFocus();
  });

  it("closes the fullscreen prompt editor with the mobile collapse button", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Custom" }));
    fireEvent.click(await screen.findByTestId("wf-node-prompt"));
    fireEvent.click(await screen.findByRole("button", { name: "Expand prompt editor" }));

    const fullscreenPromptEditor = getPromptFullscreenOverlay();
    expect(fullscreenPromptEditor).toBeInTheDocument();

    fireEvent.click(within(fullscreenPromptEditor!).getByRole("button", { name: "Collapse prompt editor" }));

    expect(getPromptFullscreenOverlay()).toBeNull();
  });

  it("closes the fullscreen prompt editor with Escape on mobile", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Custom" }));
    fireEvent.click(await screen.findByTestId("wf-node-prompt"));
    fireEvent.click(await screen.findByRole("button", { name: "Expand prompt editor" }));

    const fullscreenPromptEditor = getPromptFullscreenOverlay();
    expect(fullscreenPromptEditor).toBeInTheDocument();

    fireEvent.keyDown(fullscreenPromptEditor!, { key: "Escape" });

    expect(getPromptFullscreenOverlay()).toBeNull();
  });

  it("shows a non-disabled expand button and read-only prompt for builtin workflow prompt nodes", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await selectBuiltinExecutePromptNode();
    const inspector = await screen.findByTestId("wf-node-inspector");
    expect(within(inspector).getByLabelText("Prompt")).toHaveAttribute("readonly");

    const expand = within(inspector).getByRole("button", { name: "Expand prompt editor" });
    expect(expand).toBeInTheDocument();
    expect(expand).not.toBeDisabled();
  });

  it("opens and collapses the fullscreen prompt editor for builtin workflows", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await selectBuiltinExecutePromptNode();
    fireEvent.click(await screen.findByRole("button", { name: "Expand prompt editor" }));

    const fullscreenPromptEditor = getPromptFullscreenOverlay();
    expect(fullscreenPromptEditor).toBeInTheDocument();
    expect(fullscreenPromptEditor).toHaveClass("wf-prompt-editor--fullscreen");
    expect(getPromptFullscreenTextarea()).toHaveAttribute("readonly");

    fireEvent.click(within(fullscreenPromptEditor!).getByRole("button", { name: "Collapse prompt editor" }));

    expect(getPromptFullscreenOverlay()).toBeNull();
  });

  it("opens and collapses the fullscreen prompt editor for builtin workflows on mobile", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Default coding workflow" }));
    await selectBuiltinExecutePromptNode();
    const inspector = await screen.findByTestId("wf-node-inspector");
    fireEvent.click(within(inspector).getByRole("button", { name: "Expand prompt editor" }));

    const fullscreenPromptEditor = getPromptFullscreenOverlay();
    expect(fullscreenPromptEditor).toBeInTheDocument();
    expect(fullscreenPromptEditor).toHaveClass("wf-prompt-editor--fullscreen");

    fireEvent.click(within(fullscreenPromptEditor!).getByRole("button", { name: "Collapse prompt editor" }));

    expect(getPromptFullscreenOverlay()).toBeNull();
  });

  it("persists mobile fullscreen prompt edits back to the inline textarea", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Custom" }));
    fireEvent.click(await screen.findByTestId("wf-node-prompt"));
    fireEvent.click(await screen.findByRole("button", { name: "Expand prompt editor" }));

    const fullscreenPromptEditor = getPromptFullscreenOverlay();
    expect(fullscreenPromptEditor).toBeInTheDocument();

    fireEvent.change(getPromptFullscreenTextarea(), { target: { value: "mobile edit" } });
    fireEvent.click(within(fullscreenPromptEditor!).getByRole("button", { name: "Collapse prompt editor" }));

    const inspector = await screen.findByTestId("wf-node-inspector");
    expect(within(inspector).getByLabelText("Prompt")).toHaveValue("mobile edit");
  });

  it("opens the fullscreen prompt editor for empty mobile gate prompts", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "QA" }));
    fireEvent.click(await screen.findByTestId("wf-node-gate"));

    const inspector = await screen.findByTestId("wf-node-inspector");
    fireEvent.click(within(inspector).getByRole("button", { name: "Expand prompt editor" }));

    const fullscreenPromptEditor = getPromptFullscreenOverlay();
    expect(fullscreenPromptEditor).toBeInTheDocument();
    expect(within(fullscreenPromptEditor!).getByLabelText("Prompt")).toHaveValue("");
  });

  it("does not show the prompt expand button for non-prompt nodes", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([scriptDef()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await screen.findByText("Save");
    fireEvent.click(await screen.findByTestId("wf-node-script"));

    const inspector = await screen.findByTestId("wf-node-inspector");
    expect(within(inspector).getByLabelText("Script name")).toBeInTheDocument();
    expect(within(inspector).queryByRole("button", { name: "Expand prompt editor" })).not.toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<WorkflowNodeEditor isOpen={false} onClose={() => {}} addToast={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("WorkflowNodeEditor — U1 card-style nodes", () => {
  beforeEach(() => {
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders a config-summary row for a configured node", async () => {
    // def()'s gate node "Lint" has gateMode "gate" → summary "Gate (blocks)".
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    const gate = await screen.findByTestId("wf-node-gate");
    const summary = await within(gate).findByTestId("wf-node-summary");
    expect(summary).toHaveTextContent("Gate (blocks)");
  });

  it("does not render a summary row for structural nodes (start/end)", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    const start = await screen.findByTestId("wf-node-start");
    expect(within(start).queryByTestId("wf-node-summary")).not.toBeInTheDocument();
  });
});

describe("WorkflowNodeEditor — U10 columns/traits/holds", () => {
  beforeEach(() => {
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the column panel with the workflow's columns and trait pickers", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    expect(await screen.findByTestId("wf-column-panel")).toBeInTheDocument();
    expect(await screen.findByTestId("wf-column-triage")).toBeInTheDocument();
    expect(screen.getByTestId("wf-column-done")).toBeInTheDocument();
    // Trait picker fed by the catalog endpoint.
    await waitFor(() => expect(screen.getAllByText("Complete").length).toBeGreaterThan(0));
  });

  it("blocks save with a count summary when a node is unplaced", async () => {
    const addToast = vi.fn();
    // A def whose 'step' node sits far below all bands → unplaced.
    const d = v2Def();
    d.layout = { ...d.layout, step: { x: 120, y: 5000 } };
    // Strip the explicit column so placement is position-derived.
    if (d.ir.version === "v2") d.ir.nodes = d.ir.nodes.map((n) => (n.id === "step" ? { ...n, column: undefined } : n));
    vi.mocked(fetchWorkflows).mockResolvedValue([d]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={addToast} />);
    const saveBtn = await screen.findByText("Save");
    await waitFor(() => expect(screen.getByTestId("wf-unplaced-summary")).toBeInTheDocument());
    fireEvent.click(saveBtn.closest("button")!);

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/not placed in a column/i), "error"),
    );
    expect(updateWorkflow).not.toHaveBeenCalled();
    // Inline node badge present.
    expect(screen.getByTestId("wf-node-error-badge")).toBeInTheDocument();
  });

  it("renders a trait conflict on the column and blocks save", async () => {
    const addToast = vi.fn();
    const d = v2Def();
    // Make 'done' both complete and wip — a composition conflict.
    if (d.ir.version === "v2") {
      d.ir.columns = d.ir.columns.map((c) =>
        c.id === "done" ? { ...c, traits: [{ trait: "complete" }, { trait: "wip" }] } : c,
      );
    }
    vi.mocked(fetchWorkflows).mockResolvedValue([d]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={addToast} />);
    const doneCol = await screen.findByTestId("wf-column-done");
    await waitFor(() => expect(doneCol).toHaveAttribute("data-column-error", "true"));

    fireEvent.click((await screen.findByText("Save")).closest("button")!);
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/trait conflicts/i), "error"),
    );
    expect(updateWorkflow).not.toHaveBeenCalled();
  });

  it("surfaces a seam-in-branch server error as a node badge", async () => {
    const addToast = vi.fn();
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    vi.mocked(updateWorkflow).mockRejectedValue(
      new Error("seam 'merge' node 'step' is forbidden inside a parallel branch of split 's1'"),
    );

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={addToast} />);
    // Wait for graph/column hydration before saving — clicking Save mid-hydration
    // races the error→node-badge mapping (same flake class as the v1-save race).
    expect(await screen.findByTestId("wf-column-panel")).toBeInTheDocument();
    fireEvent.click((await screen.findByText("Save")).closest("button")!);

    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    await waitFor(
      () =>
        expect(screen.getByTestId("wf-node-error-badge")).toHaveTextContent(/forbidden inside a parallel branch/i),
      { timeout: 5000 },
    );
  });

  it("opens a built-in read-only with a Duplicate to customize CTA replacing the toolbar", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);
    vi.mocked(createWorkflow).mockResolvedValue({ ...v2Def(), id: "WF-copy", name: "Copy" });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    expect(await screen.findByTestId("wf-readonly-banner")).toBeInTheDocument();
    // No Save button (toolbar replaced).
    expect(screen.queryByText("Save")).not.toBeInTheDocument();
    const dup = screen.getByText(/Duplicate to customize/i);
    expect(dup).toBeInTheDocument();
    fireEvent.click(dup.closest("button")!);
    await waitFor(() => expect(createWorkflow).toHaveBeenCalled());
  });

  it("clears stale node column references after deleting all columns and re-adding one", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({
      ...v2Def(),
      ...(updates as object),
    }));
    vi.mocked(compileWorkflow).mockResolvedValue({ steps: [] });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByText("Save");
    await waitFor(() => expect(screen.getAllByLabelText(/Column name/i).length).toBe(2));

    while (screen.queryAllByLabelText("Remove column").length > 0) {
      fireEvent.click(screen.getAllByLabelText("Remove column")[0]);
    }
    await waitFor(() => expect(screen.queryAllByLabelText(/Column name/i)).toHaveLength(0));

    fireEvent.click(screen.getByText("Add column").closest("button")!);
    const [newColumnName] = await screen.findAllByLabelText(/Column name/i);
    fireEvent.change(newColumnName, { target: { value: "Todo" } });

    fireEvent.click(screen.getByText("Save").closest("button")!);

    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    expect(screen.queryByText(/references undefined column/i)).not.toBeInTheDocument();
    const [, updates] = vi.mocked(updateWorkflow).mock.calls[0];
    const ir = (updates as { ir: WorkflowDefinition["ir"] }).ir;
    expect(() => parseWorkflowIr(ir)).not.toThrow();
    if (ir.version !== "v2") throw new Error("expected v2");
    const columnIds = new Set(ir.columns.map((column) => column.id));
    expect(ir.nodes.every((node) => node.column === undefined || columnIds.has(node.column))).toBe(true);
  });

  it("saves a valid v2 workflow round-tripping columns to the API", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({
      ...v2Def(),
      ...(updates as object),
    }));
    vi.mocked(compileWorkflow).mockResolvedValue({ steps: [] });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    // Wait for the column panel to hydrate before saving — saving earlier
    // races the async columns state and flowToIr would emit a v1 IR.
    await screen.findByText("Save");
    await waitFor(() => expect(screen.getAllByLabelText(/Column name/i).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("Save").closest("button")!);

    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    const [, updates] = vi.mocked(updateWorkflow).mock.calls[0];
    expect((updates as { ir: { version: string } }).ir.version).toBe("v2");
    expect((updates as { ir: { columns: unknown[] } }).ir.columns).toHaveLength(2);
  });
});

// ── U3: deletion UX (delete buttons + cascade) ──────────────────────────────

describe("WorkflowNodeEditor — U3 deletion", () => {
  beforeEach(() => {
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
  });
  afterEach(() => cleanup());

  it("shows a Delete node button when a node is selected and removes the node on click", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    const gate = await screen.findByTestId("wf-node-gate");
    fireEvent.click(gate);
    const delBtn = await screen.findByTestId("wf-delete-node");
    fireEvent.click(delBtn);
    // The gate node is removed from the canvas.
    await waitFor(() => expect(screen.queryByTestId("wf-node-gate")).not.toBeInTheDocument());
    // Selecting nothing → the delete button is gone too.
    expect(screen.queryByTestId("wf-delete-node")).not.toBeInTheDocument();
  });

  it("does not render a Delete node button for built-in workflows", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([
      { ...def(), id: "builtin:coding", name: "Built-in" },
    ]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    const gate = await screen.findByTestId("wf-node-gate");
    fireEvent.click(gate);
    // Inspector renders (read-only note) but no delete button.
    await screen.findByTestId("wf-readonly-banner");
    expect(screen.queryByTestId("wf-delete-node")).not.toBeInTheDocument();
  });
});

describe("WorkflowNodeEditor — U5 auto-layout", () => {
  beforeEach(() => {
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
  });
  afterEach(() => cleanup());

  it("shows the Auto-layout button for an editable workflow", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByTestId("wf-node-start");
    expect(screen.getByTestId("wf-auto-layout")).toBeInTheDocument();
  });

  it("does not show the Auto-layout button for a built-in workflow", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByTestId("wf-readonly-banner");
    expect(screen.queryByTestId("wf-auto-layout")).not.toBeInTheDocument();
  });

  it("runs auto-layout on load (nodes are positioned at layout positions)", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    const { container } = render(
      <WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />,
    );
    await screen.findByTestId("wf-node-start");
    // React Flow positions step nodes via a translate transform on their wrapper.
    const wrapperFor = (id: string) =>
      container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
    // After load, the step node should have been auto-laid-out (positioned).
    await waitFor(() => {
      const transform = wrapperFor("step")?.style.transform ?? "";
      expect(transform).not.toBe("");
    });
  });

  it("starts the canvas viewport at the top-left on first open", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    const { container } = render(
      <WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />,
    );

    await screen.findByTestId("wf-node-start");

    await waitFor(() => {
      const viewport = container.querySelector<HTMLElement>(".react-flow__viewport");
      expect(viewport).not.toBeNull();
      expect(viewport?.style.transform).toMatch(/translate\(0px,\s*0px\)/);
      expect(viewport?.style.transform).toContain("scale(1)");
    });
  });

  it("clicking auto-layout still works after initial load", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    render(
      <WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />,
    );
    await screen.findByTestId("wf-node-start");
    // The auto-layout button should still be present and clickable.
    const btn = screen.getByTestId("wf-auto-layout");
    expect(btn).toBeInTheDocument();
    // Clicking it should not throw.
    fireEvent.click(btn);
  });
});

// ── U8: step-inversion authoring (foreach/step-review/parse-steps/code) ──────

/** A custom v2 workflow with a foreach (one step-execute child + a step-review)
 *  so the editor's group/template + edge inspector surfaces have something to
 *  render and round-trip. */
function stepwiseDef(): WorkflowDefinition {
  return {
    id: "WF-STEP",
    kind: "workflow",
    name: "Stepwise",
    description: "",
    ir: {
      version: "v2",
      name: "Stepwise",
      columns: [
        { id: "plan", name: "Plan", traits: [{ trait: "intake" }] },
        { id: "in-progress", name: "In progress", traits: [] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      artifacts: [{ key: "PROMPT.md", role: "step-source" }],
      nodes: [
        { id: "start", kind: "start", column: "plan" },
        { id: "parse", kind: "parse-steps", column: "plan", config: { artifact: "PROMPT.md", parser: "step-headings" } },
        {
          id: "loop",
          kind: "foreach",
          column: "in-progress",
          config: {
            source: "task-steps",
            mode: "sequential",
            isolation: "shared",
            template: {
              nodes: [
                { id: "exec", kind: "prompt", config: { seam: "step-execute" } },
                { id: "review", kind: "step-review", config: { type: "code" } },
              ],
              edges: [
                { from: "exec", to: "review", condition: "success" },
                { from: "review", to: "exec", condition: "outcome:approve" },
              ],
            },
          },
        },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "parse", condition: "success" },
        { from: "parse", to: "loop", condition: "success" },
        { from: "loop", to: "end", condition: "success" },
      ],
    },
    layout: {},
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}

describe("WorkflowNodeEditor — U8 step-inversion authoring", () => {
  beforeEach(() => {
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("offers the new step-inversion palette entries (i18n defaults present)", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByText("Save");
    expect(screen.getByText("For-each step")).toBeInTheDocument();
    expect(screen.getByText("Step review")).toBeInTheDocument();
    expect(screen.getByText("Parse steps")).toBeInTheDocument();
    expect(screen.getByText("Code")).toBeInTheDocument();
    expect(screen.getByText("Notify")).toBeInTheDocument();
  });

  it("auto-populates a step-execute child when a foreach is added from the palette", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({ ...v2Def(), ...(updates as object) }));
    vi.mocked(compileWorkflow).mockResolvedValue({ steps: [] });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByText("Save");
    // Wait for graph/column hydration before driving the palette — clicking
    // mid-hydration races the flow-state seeding and the added node may never
    // render (same flake class as the seam-in-branch badge deflake, 86867c57b).
    expect(await screen.findByTestId("wf-column-panel")).toBeInTheDocument();
    // Adding a foreach renders a group node with an empty inspector hint absent
    // (it has a child) and an inspector for the foreach.
    fireEvent.click(screen.getByText("For-each step").closest("button")!);
    // 5s timeout: React Flow group-node mount can exceed the 1s default under
    // cold-transform shard load (observed intermittently in CI-like runs).
    await waitFor(() => expect(screen.getByTestId("wf-node-foreach")).toBeInTheDocument(), { timeout: 5000 });
    // The foreach inspector shows the Mode select (KTD-3).
    await waitFor(() => expect(screen.getByText("Mode")).toBeInTheDocument());
    // No empty-state hint because the palette seeded a step-execute child.
    expect(screen.queryByTestId("wf-foreach-empty")).not.toBeInTheDocument();

    // Save and assert the foreach round-trips with exactly one step-execute child.
    await waitFor(() => expect(screen.getAllByLabelText(/Column name/i).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("Save").closest("button")!);
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    const [, updates] = vi.mocked(updateWorkflow).mock.calls[0];
    const ir = (updates as { ir: { nodes: { kind: string; config?: Record<string, unknown> }[] } }).ir;
    const foreach = ir.nodes.find((n) => n.kind === "foreach");
    expect(foreach).toBeTruthy();
    const template = foreach!.config!.template as { nodes: { config?: Record<string, unknown> }[] };
    expect(template.nodes).toHaveLength(1);
    expect(template.nodes[0].config?.seam).toBe("step-execute");
  });

  it("edits foreach mode/isolation/concurrency/maxReworkCycles inspector fields", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([stepwiseDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    const group = await screen.findByTestId("wf-node-foreach");
    fireEvent.click(group);

    const modeSel = (await screen.findByText("Mode")).parentElement!.querySelector("select")!;
    // Switching to parallel flips isolation away from the (now disabled) shared
    // option and reveals the concurrency input.
    fireEvent.change(modeSel, { target: { value: "parallel" } });
    await waitFor(() => expect(screen.getByText("Concurrency")).toBeInTheDocument());
    const isoSel = screen.getByText("Isolation").parentElement!.querySelector("select")! as HTMLSelectElement;
    expect(isoSel.value).toBe("worktree");
    const sharedOpt = isoSel.querySelector('option[value="shared"]') as HTMLOptionElement;
    expect(sharedOpt.disabled).toBe(true);

    const maxRework = screen.getByText("Max rework cycles").parentElement!.querySelector("input")!;
    fireEvent.change(maxRework, { target: { value: "5" } });
    expect((maxRework as HTMLInputElement).value).toBe("5");
  });

  it("edits step-review type and shows the verdict edge inspector with a rework toggle", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([stepwiseDef()]);
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    // Select the step-review template child.
    const reviewNode = await screen.findByTestId("wf-node-step-review");
    fireEvent.click(reviewNode);
    const typeSel = (await screen.findByText("Review type")).parentElement!.querySelector("select")! as HTMLSelectElement;
    expect(typeSel.value).toBe("code");
    fireEvent.change(typeSel, { target: { value: "plan" } });
    expect(typeSel.value).toBe("plan");
  });

  it("round-trips a rework edge created/removed via the edge inspector contract", () => {
    // React Flow does not render edges under jsdom (it needs measured node
    // dimensions), so the in-browser edge-click path is exercised at the mapping
    // level: the edge inspector's only effect is to stamp `data.kind` (rework)
    // and the `outcome:<verdict>` condition onto the selected flow edge; flowToIr
    // must fold that into the foreach template as kind:"rework". (The full
    // template round-trip — including rework edges — is covered in
    // workflow-flow-mapping.test.ts.)
    const def = stepwiseDef();
    const { nodes, edges } = irToFlow(def);
    const columns = def.ir.version === "v2" ? def.ir.columns : [];

    // Simulate the edge inspector toggling the review→exec edge to rework.
    const reworked = edges.map((e) =>
      e.source.endsWith("::review") && e.target.endsWith("::exec")
        ? { ...e, data: { ...(e.data ?? {}), condition: "outcome:approve", kind: "rework" } }
        : e,
    );
    const { ir: out } = flowToIr("Stepwise", nodes, reworked, columns);
    const foreach = out.nodes.find((n) => n.kind === "foreach")!;
    const template = foreach.config!.template as { edges: { condition?: string; kind?: string }[] };
    expect(template.edges.find((e) => e.condition === "outcome:approve")?.kind).toBe("rework");

    // Removing rework (toggle off) drops the kind on round-trip.
    const cleared = edges.map((e) =>
      e.source.endsWith("::review") && e.target.endsWith("::exec")
        ? { ...e, data: { ...(e.data ?? {}), condition: "outcome:approve", kind: undefined } }
        : e,
    );
    const { ir: out2 } = flowToIr("Stepwise", nodes, cleared, columns);
    const fe2 = out2.nodes.find((n) => n.kind === "foreach")!;
    const tpl2 = fe2.config!.template as { edges: { condition?: string; kind?: string }[] };
    expect(tpl2.edges.find((e) => e.condition === "outcome:approve")?.kind).toBeUndefined();
  });

  it("surfaces a parseWorkflowIr validation error inline at save (unrouted approve edge)", async () => {
    const addToast = vi.fn();
    vi.mocked(fetchWorkflows).mockResolvedValue([stepwiseDef()]);
    vi.mocked(updateWorkflow).mockRejectedValue(
      new Error("step-review node 'review' must route outcome:revise"),
    );
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={addToast} />);
    await screen.findByText("Save");
    await waitFor(() => expect(screen.getAllByLabelText(/Column name/i).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("Save").closest("button")!);
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    // Validation banner renders the server error inline.
    await waitFor(() =>
      expect(screen.getByText(/must route outcome:revise/i)).toBeInTheDocument(),
    );
    expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/must route outcome:revise/i), "error");
  });

  it("edits parse-steps artifact (from declared artifacts) and parser", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([stepwiseDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    const parseNode = await screen.findByTestId("wf-node-parse-steps");
    fireEvent.click(parseNode);
    const artifactSel = (await screen.findByText("Artifact")).parentElement!.querySelector("select")! as HTMLSelectElement;
    // Sourced from the workflow's declared artifacts.
    expect(artifactSel.value).toBe("PROMPT.md");
    const parserSel = screen.getByText("Parser").parentElement!.querySelector("select")! as HTMLSelectElement;
    fireEvent.change(parserSel, { target: { value: "json-steps" } });
    expect(parserSel.value).toBe("json-steps");
  });

  it("offers plugin step parsers from the live catalog (KTD-12)", async () => {
    vi.mocked(fetchStepParsers).mockResolvedValue([
      "step-headings",
      "json-steps",
      "plugin:acme:yaml-steps",
    ]);
    vi.mocked(fetchWorkflows).mockResolvedValue([stepwiseDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    const parseNode = await screen.findByTestId("wf-node-parse-steps");
    fireEvent.click(parseNode);
    const parserSel = (await screen.findByText("Parser")).parentElement!.querySelector("select")! as HTMLSelectElement;
    // The plugin parser option becomes available once the catalog resolves...
    await waitFor(() =>
      expect(
        Array.from(parserSel.options).some((o) => o.value === "plugin:acme:yaml-steps"),
      ).toBe(true),
    );
    // ...and is selectable.
    fireEvent.change(parserSel, { target: { value: "plugin:acme:yaml-steps" } });
    expect(parserSel.value).toBe("plugin:acme:yaml-steps");
  });

  it("falls back to the built-in parser pair when the catalog fetch fails", async () => {
    vi.mocked(fetchStepParsers).mockRejectedValue(new Error("offline"));
    vi.mocked(fetchWorkflows).mockResolvedValue([stepwiseDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    const parseNode = await screen.findByTestId("wf-node-parse-steps");
    fireEvent.click(parseNode);
    const parserSel = (await screen.findByText("Parser")).parentElement!.querySelector("select")! as HTMLSelectElement;
    const values = Array.from(parserSel.options).map((o) => o.value);
    expect(values).toContain("step-headings");
    expect(values).toContain("json-steps");
  });

  it("edits a code node source and timeout", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByText("Save");
    // Wait for graph/column hydration before driving the palette — clicking
    // mid-hydration races the flow-state seeding and the added node may never
    // render (same flake class as foreach palette add, 86867c57b).
    expect(await screen.findByTestId("wf-column-panel")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Code").closest("button")!);
    await waitFor(() => expect(screen.getByTestId("wf-node-code")).toBeInTheDocument(), { timeout: 5000 });
    const source = (await screen.findByText("Source (TypeScript)")).parentElement!.querySelector("textarea")! as HTMLTextAreaElement;
    fireEvent.change(source, { target: { value: "export default async()=>({outcome:'success'})" } });
    expect(source.value).toContain("outcome:'success'");
    const timeout = (await screen.findByText("Timeout (ms)")).parentElement!.querySelector("input")! as HTMLInputElement;
    fireEvent.change(timeout, { target: { value: "12000" } });
    expect(timeout.value).toBe("12000");
  });

  it("edits notify event, title, and message fields", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({ ...v2Def(), ...(updates as object) }));
    vi.mocked(compileWorkflow).mockResolvedValue({ steps: [] });
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByText("Save");
    expect(await screen.findByTestId("wf-column-panel")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Notify").closest("button")!);
    await waitFor(() => expect(screen.getByTestId("wf-node-notify")).toBeInTheDocument());

    const eventSelect = (await screen.findByText("Event type")).parentElement!.querySelector("select")! as HTMLSelectElement;
    expect(eventSelect.value).toBe("in-review");
    fireEvent.change(eventSelect, { target: { value: "workflow-notify" } });
    expect(eventSelect.value).toBe("workflow-notify");

    const title = screen.getByText("Title (optional)").parentElement!.querySelector("input")! as HTMLInputElement;
    fireEvent.change(title, { target: { value: "{{taskTitle}} done" } });
    expect(title.value).toBe("{{taskTitle}} done");

    const message = screen.getByText("Message (optional)").parentElement!.querySelector("textarea")! as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "Task {{taskId}} reached {{workflowName}}" } });
    expect(message.value).toContain("{{workflowName}}");

    fireEvent.click(screen.getByText("Save").closest("button")!);
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    const [, updates] = vi.mocked(updateWorkflow).mock.calls[0];
    const ir = (updates as { ir: { nodes: { kind: string; config?: Record<string, unknown> }[] } }).ir;
    const notify = ir.nodes.find((n) => n.kind === "notify");
    expect(notify?.config).toMatchObject({
      event: "workflow-notify",
      title: "{{taskTitle}} done",
      message: "Task {{taskId}} reached {{workflowName}}",
    });
  });

  it("toggles notify custom event input and preserves it across reselect", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByText("Save");
    expect(await screen.findByTestId("wf-column-panel")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Notify").closest("button")!);
    await waitFor(() => expect(screen.getByTestId("wf-node-notify")).toBeInTheDocument());

    const eventSelect = (await screen.findByText("Event type")).parentElement!.querySelector("select")! as HTMLSelectElement;
    fireEvent.change(eventSelect, { target: { value: "__custom" } });
    const custom = (await screen.findByText("Custom event")).parentElement!.querySelector("input")! as HTMLInputElement;
    expect(custom.value).toBe("custom-event");
    fireEvent.change(custom, { target: { value: "deploy-finished" } });
    expect(custom.value).toBe("deploy-finished");

    fireEvent.click(screen.getByTestId("wf-node-start"));
    await waitFor(() => expect(screen.queryByText("Custom event")).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId("wf-node-notify"));
    const preserved = (await screen.findByText("Custom event")).parentElement!.querySelector("input")! as HTMLInputElement;
    expect(preserved.value).toBe("deploy-finished");
  });
});

// ── Regression: selecting the real stepwise built-in renders the foreach group
//    node (group type, NOT a plain default node) with its template children
//    expanded (parentId set), and duplicating it preserves the template. ───────

/** The on-disk built-in stepwise workflow as the server serves it (the IR is the
 *  source of truth; the dashboard wraps it in a WorkflowDefinition). */
function builtinStepwiseDef(): WorkflowDefinition {
  return {
    id: "builtin:stepwise-coding",
    kind: "workflow",
    name: "Stepwise coding (built-in)",
    description: "",
    ir: BUILTIN_STEPWISE_CODING_WORKFLOW_IR,
    layout: {},
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}

describe("WorkflowNodeEditor — built-in stepwise selection render path", () => {
  beforeEach(() => {
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the steps foreach as a group node (not a plain default) with its template children expanded", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinStepwiseDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    // The built-in selection banner replaces the editing toolbar.
    await screen.findByTestId("wf-readonly-banner");

    // The `steps` foreach renders via the registered group component
    // (ForeachGroupNode → data-testid wf-node-foreach), NOT React Flow's default
    // node fallback. A default node would expose no wf-node-foreach testid.
    const foreachGroup = await screen.findByTestId("wf-node-foreach");
    expect(foreachGroup).toBeInTheDocument();

    // parse-steps likewise renders via its registered component.
    expect(await screen.findByTestId("wf-node-parse-steps")).toBeInTheDocument();

    // The foreach template children (parentId-partitioned) are present in the
    // canvas: the step-execute prompt and the per-step review node.
    const flowNodeIds = [...document.querySelectorAll(".react-flow__node")].map((n) =>
      n.getAttribute("data-id"),
    );
    expect(flowNodeIds).toContain(foreachChildFlowId("steps", "step-execute"));
    expect(flowNodeIds).toContain(foreachChildFlowId("steps", "step-review"));
    expect(flowNodeIds).toContain(foreachChildFlowId("steps", "step-done"));
  });

  it("renders built-in and custom workflow nodes with handles matching projected edges", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinPrDef(), v2Def()]);
    const { container } = render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await screen.findByTestId("wf-readonly-banner");
    await waitFor(() => expect(screen.getAllByTestId("wf-node-hold").length).toBeGreaterThan(0));
    const builtInFlow = irToFlow(builtinPrDef());
    for (const edge of builtInFlow.edges.filter((candidate) => candidate.source === "pr-create")) {
      expect(container.querySelector(`.react-flow__handle[data-nodeid="${edge.source}"][data-handlepos="right"]`)).toBeInTheDocument();
      expect(container.querySelector(`.react-flow__handle[data-nodeid="${edge.target}"][data-handlepos="left"]`)).toBeInTheDocument();
    }
    expect(builtInFlow.edges.some((edge) => edge.label === "open")).toBe(true);
    expect(builtInFlow.edges.some((edge) => edge.label === "failed")).toBe(true);
    expect(builtInFlow.edges.some((edge) => edge.label === "failure")).toBe(true);

    fireEvent.click(screen.getByText("Custom"));
    await waitFor(() => expect(screen.queryByTestId("wf-readonly-banner")).not.toBeInTheDocument());
    const customFlow = irToFlow(v2Def());
    for (const edge of customFlow.edges) {
      expect(container.querySelector(`.react-flow__handle[data-nodeid="${edge.source}"][data-handlepos="right"]`)).toBeInTheDocument();
      expect(container.querySelector(`.react-flow__handle[data-nodeid="${edge.target}"][data-handlepos="left"]`)).toBeInTheDocument();
    }
    expect(customFlow.edges.every((edge) => edge.label === "success")).toBe(true);
  });

  it("irToFlow on the built-in stepwise IR yields a foreach group + rework-styled template edge (editor load path)", () => {
    // Mirrors exactly what the editor's load effect feeds React Flow:
    //   const flow = irToFlow(activeWorkflow)
    const { nodes, edges } = irToFlow(builtinStepwiseDef());
    const group = nodes.find((n) => n.id === "steps");
    expect(group?.type).toBe("foreach");
    const children = nodes.filter((n) => n.parentId === "steps");
    expect(children.map((c) => c.id).sort()).toEqual(
      [
        foreachChildFlowId("steps", "step-execute"),
        foreachChildFlowId("steps", "step-review"),
        foreachChildFlowId("steps", "step-done"),
      ].sort(),
    );
    // The intra-template rework edge (step-review → step-execute) renders with
    // its rework styling so the editor shows the bounded loop-back.
    const reworkEdges = edges.filter((e) => e.data?.kind === "rework");
    expect(reworkEdges.length).toBeGreaterThan(0);
    expect(group?.zIndex).toBeLessThan(reworkEdges[0]?.zIndex ?? 0);
    expect(reworkEdges.every((e) => e.animated === true && e.className === "wf-edge-rework")).toBe(true);
    expect(reworkEdges.some((e) => e.source === foreachChildFlowId("steps", "step-review"))).toBe(true);
  });

  it("Duplicate-to-customize preserves the foreach template through the editor's save path", () => {
    // "Duplicate to customize" copies the built-in IR verbatim into a new
    // editable workflow; the user then saves, which round-trips through the
    // editor's flowToIr on the exact nodes/edges irToFlow produced. Assert the
    // template (incl. the rework edge) survives that round-trip.
    const def = builtinStepwiseDef();
    const { nodes, edges } = irToFlow(def);
    const columns = def.ir.version === "v2" ? def.ir.columns : [];
    const { ir: out } = flowToIr(def.name, nodes, edges, columns);
    if (out.version !== "v2") throw new Error("expected v2");
    const steps = out.nodes.find((n) => n.id === "steps");
    expect(steps?.kind).toBe("foreach");
    const template = steps!.config!.template as {
      nodes: { id: string }[];
      edges: { from: string; to: string; condition?: string; kind?: string }[];
    };
    expect(template.nodes.map((n) => n.id).sort()).toEqual(
      ["step-done", "step-execute", "step-review"].sort(),
    );
    // The two rework edges (revise/rethink → step-execute) survive with kind+condition.
    const reworks = template.edges.filter((e) => e.kind === "rework");
    expect(reworks.map((e) => e.condition).sort()).toEqual(
      ["outcome:revise", "outcome:rethink"].sort(),
    );
    expect(reworks.every((e) => e.from === "step-review" && e.to === "step-execute")).toBe(true);
    // The approve edge routes to the template exit and is NOT a rework edge.
    const approve = template.edges.find((e) => e.condition === "outcome:approve");
    expect(approve).toMatchObject({ from: "step-review", to: "step-done" });
    expect(approve?.kind).toBeUndefined();
  });

  it("shows the built-in seam prompt text in the read-only node inspector", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await screen.findByTestId("wf-readonly-banner");
    const promptNodes = await screen.findAllByTestId("wf-node-prompt");
    const executeNode = promptNodes.find((node) => within(node).queryByText("Execute"));
    expect(executeNode).toBeTruthy();

    fireEvent.click(executeNode!);

    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toContain(
      "task execution agent",
    );
  });

  it("opens workflow settings on the Values tab from the editor sidebar", async () => {
    localStorage.setItem("fusion:wf-sidebar-settings-collapsed", "0");
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} projectId="p1" />);

    await screen.findByTestId("wf-settings-values");
    expect(screen.getByTestId("wf-settings-tab-values")).toHaveAttribute("aria-selected", "true");
  });
});

// ── U2: edge-condition authoring (compile-banner split) ─────────────────────
describe("WorkflowNodeEditor — U2 interpreter-only banner", () => {
  beforeEach(() => {
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({
      ...v2Def(),
      ...(updates as object),
    }));
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  async function saveActive() {
    await screen.findByText("Save");
    await waitFor(() => expect(screen.getAllByLabelText(/Column name/i).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("Save").closest("button")!);
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
  }

  it("shows an info-tone status banner (not an error) when compile rejects with the interpreter-deferred suffix", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    vi.mocked(compileWorkflow).mockRejectedValue(
      new Error(
        "node 'step' branches into 2 edges — graphs with branches require the workflow interpreter (deferred)",
      ),
    );

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await saveActive();

    const banner = await screen.findByTestId("wf-interpreter-only-banner");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner.className).toMatch(/wf-editor-banner--info/);
    // No alert-toned error banner.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the warning error banner for other (non-interpreter) compile errors", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    vi.mocked(compileWorkflow).mockRejectedValue(new Error("node 'step' has no outgoing edge"));

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await saveActive();

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(/no outgoing edge/i);
    expect(screen.queryByTestId("wf-interpreter-only-banner")).not.toBeInTheDocument();
  });
});

// ── U4: dialogs, inline rename/description, dirty guard ─────────────────────

/** Render the editor wrapped in a ConfirmDialogProvider so confirm()/discard
 *  prompts mount their ConfirmDialog (the app mounts this provider globally in
 *  App.tsx). The ConfirmDialog's primary button carries the supplied label. */
function renderWithConfirm(ui: import("react").ReactElement) {
  return render(<ConfirmDialogProvider>{ui}</ConfirmDialogProvider>);
}

describe("WorkflowNodeEditor — U4 create dialog / delete / inline rename / dirty guard", () => {
  beforeEach(() => {
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // ── Create dialog (KTD-7) ──────────────────────────────────────────────────

  it("opens the create dialog and blocks an empty name with an inline error", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    fireEvent.click(await screen.findByTestId("wf-new-workflow"));
    expect(await screen.findByTestId("wf-create-dialog")).toBeInTheDocument();

    // Submitting with a whitespace-only name shows the inline error and does NOT
    // call createWorkflow or close the dialog.
    fireEvent.change(screen.getByTestId("wf-create-name"), { target: { value: "  " } });
    fireEvent.click(screen.getByTestId("wf-create-submit"));
    expect(await screen.findByTestId("wf-create-error")).toBeInTheDocument();
    expect(createWorkflow).not.toHaveBeenCalled();
    expect(screen.getByTestId("wf-create-dialog")).toBeInTheDocument();
  });

  it("can open directly into the create dialog", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} initialAction="create" />);

    expect(await screen.findByTestId("wf-create-dialog")).toBeInTheDocument();
  });

  it("creates and activates a workflow on a valid submit", async () => {
    const addToast = vi.fn();
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    vi.mocked(createWorkflow).mockResolvedValue({ ...v2Def(), id: "WF-NEW", name: "Pipeline" });
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={addToast} />);
    fireEvent.click(await screen.findByTestId("wf-new-workflow"));
    fireEvent.change(await screen.findByTestId("wf-create-name"), { target: { value: "Pipeline" } });
    fireEvent.click(screen.getByTestId("wf-create-submit"));

    await waitFor(() => expect(createWorkflow).toHaveBeenCalled());
    const [input] = vi.mocked(createWorkflow).mock.calls[0];
    expect((input as { name: string }).name).toBe("Pipeline");
    // Dialog closes and the new workflow is active (its name shows in the strip).
    await waitFor(() => expect(screen.queryByTestId("wf-create-dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("wf-workflow-name")).toHaveTextContent("Pipeline"));
    expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/Pipeline/), "success");
  });

  it("surfaces a server rejection inline and keeps the dialog open with input preserved", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    vi.mocked(createWorkflow).mockRejectedValue(new Error("A workflow named 'Dup' already exists"));
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    fireEvent.click(await screen.findByTestId("wf-new-workflow"));
    const nameInput = await screen.findByTestId("wf-create-name");
    fireEvent.change(nameInput, { target: { value: "Dup" } });
    fireEvent.click(screen.getByTestId("wf-create-submit"));

    await waitFor(() => expect(screen.getByTestId("wf-create-error")).toHaveTextContent(/already exists/i));
    // Dialog stays open; the typed name is preserved.
    expect(screen.getByTestId("wf-create-dialog")).toBeInTheDocument();
    expect((nameInput as HTMLInputElement).value).toBe("Dup");
  });

  // ── Template picker (U4/R7) ────────────────────────────────────────────────

  it("shows Blank first (selected), built-ins, and user workflows; fragments absent", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef(), v2Def(), fragmentDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    // Open via the strip "New workflow" button (the empty CTA only shows with no
    // workflows; here we have some, so use the toolbar button).
    fireEvent.click(await screen.findByTestId("wf-new-workflow"));
    await screen.findByTestId("wf-create-dialog");

    const blank = screen.getByTestId("wf-template-option-blank");
    expect(blank).toHaveAttribute("aria-checked", "true");
    // Blank is the first radio in the group.
    const group = screen.getByTestId("wf-template-list");
    const options = within(group).getAllByRole("radio");
    expect(options[0]).toBe(blank);

    // Built-in + user workflow present; fragment excluded.
    expect(screen.getByTestId("wf-template-option-builtin:coding")).toBeInTheDocument();
    expect(screen.getByTestId("wf-template-option-WF-002")).toBeInTheDocument();
    expect(screen.queryByTestId("wf-template-option-WF-FRAG")).not.toBeInTheDocument();
  });

  it("renders node count text for template entries", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    fireEvent.click(await screen.findByTestId("wf-new-workflow"));
    await screen.findByTestId("wf-create-dialog");
    // v2Def has 3 IR nodes (start, step, end).
    expect(screen.getByTestId("wf-template-option-WF-002")).toHaveTextContent("3 nodes");
  });

  it("with no user workflows lists Blank + built-ins only (no Your-workflows header)", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    fireEvent.click(await screen.findByTestId("wf-new-workflow"));
    await screen.findByTestId("wf-create-dialog");
    expect(screen.getByTestId("wf-template-option-blank")).toBeInTheDocument();
    expect(screen.getByTestId("wf-template-option-builtin:coding")).toBeInTheDocument();
    expect(screen.queryByText("Your workflows")).not.toBeInTheDocument();
  });

  it("selecting a builtin template prefills '<name> copy' and inherits the description", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    fireEvent.click(await screen.findByTestId("wf-new-workflow"));
    await screen.findByTestId("wf-create-dialog");

    fireEvent.click(screen.getByTestId("wf-template-option-builtin:coding"));
    expect((screen.getByTestId("wf-create-name") as HTMLInputElement).value).toBe(
      "Default coding workflow copy",
    );
    expect((screen.getByTestId("wf-create-description") as HTMLTextAreaElement).value).toBe(
      "Ships with Fusion",
    );
  });

  it("submitting a template seeds a fresh-ID copy: same node count, all ids differ, description inherited", async () => {
    const builtin = builtinDef();
    vi.mocked(fetchWorkflows).mockResolvedValue([builtin]);
    vi.mocked(createWorkflow).mockResolvedValue({ ...v2Def(), id: "WF-NEW", name: "Default coding workflow copy" });
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    fireEvent.click(await screen.findByTestId("wf-new-workflow"));
    await screen.findByTestId("wf-create-dialog");

    fireEvent.click(screen.getByTestId("wf-template-option-builtin:coding"));
    fireEvent.click(screen.getByTestId("wf-create-submit"));

    await waitFor(() => expect(createWorkflow).toHaveBeenCalled());
    const [input] = vi.mocked(createWorkflow).mock.calls[0];
    const created = input as { name: string; description?: string; kind?: string; ir: { nodes: { id: string }[] } };
    expect(created.kind).toBe("workflow");
    expect(created.description).toBe("Ships with Fusion");
    // Same node count as the source IR.
    expect(created.ir.nodes).toHaveLength(builtin.ir.nodes.length);
    // Every node id is fresh (none shared with the source).
    const sourceIds = new Set(builtin.ir.nodes.map((n) => n.id));
    for (const n of created.ir.nodes) {
      expect(sourceIds.has(n.id)).toBe(false);
    }
  });

  it("blank flow seeds an emptyWorkflowIr-shaped graph (start → end)", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);
    vi.mocked(createWorkflow).mockResolvedValue({ ...v2Def(), id: "WF-NEW", name: "Fresh" });
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    fireEvent.click(await screen.findByTestId("wf-new-workflow"));
    await screen.findByTestId("wf-create-dialog");

    // Blank is default-selected; just name + submit.
    fireEvent.change(screen.getByTestId("wf-create-name"), { target: { value: "Fresh" } });
    fireEvent.click(screen.getByTestId("wf-create-submit"));

    await waitFor(() => expect(createWorkflow).toHaveBeenCalled());
    const [input] = vi.mocked(createWorkflow).mock.calls[0];
    const created = input as { ir: { nodes: { kind: string }[]; edges: unknown[] } };
    expect(created.ir.nodes.map((n) => n.kind)).toEqual(["start", "end"]);
    expect(created.ir.edges).toHaveLength(1);
  });

  it("ArrowDown moves the selected radio (keyboard a11y)", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    fireEvent.click(await screen.findByTestId("wf-new-workflow"));
    await screen.findByTestId("wf-create-dialog");

    const blank = screen.getByTestId("wf-template-option-blank");
    expect(blank).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(blank, { key: "ArrowDown" });
    expect(blank).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("wf-template-option-builtin:coding")).toHaveAttribute("aria-checked", "true");
  });

  // ── Delete confirm ─────────────────────────────────────────────────────────

  it("does not delete when no ConfirmDialogProvider is mounted (fallback cancels)", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    fireEvent.click((await screen.findByText("Delete")).closest("button")!);
    // The no-op fallback resolves false → deleteWorkflow is never called.
    // Let the async fallback settle deterministically (no wall-clock delay).
    await Promise.resolve();
    await Promise.resolve();
    expect(deleteWorkflow).not.toHaveBeenCalled();
  });

  it("deletes after confirming in the ConfirmDialog (with provider)", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    vi.mocked(deleteWorkflow).mockResolvedValue(undefined);
    renderWithConfirm(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    fireEvent.click((await screen.findByText("Delete")).closest("button")!);
    // The confirm dialog's primary (danger) button carries the "Delete" label.
    const dialog = await screen.findByRole("dialog", { name: /Delete workflow\?/i });
    const confirmBtn = within(dialog).getByRole("button", { name: "Delete" });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(deleteWorkflow).toHaveBeenCalledWith("WF-002", undefined));
  });

  // ── Inline rename (KTD-10) ─────────────────────────────────────────────────

  it("renames the workflow inline: click → input prefilled → Enter commits", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByText("Save");
    await waitFor(() => expect(screen.getAllByLabelText(/Column name/i).length).toBeGreaterThan(0));
    const nameBtn = await screen.findByTestId("wf-workflow-name");
    expect(nameBtn).toHaveTextContent("Custom");
    fireEvent.click(nameBtn);
    const input = (await screen.findByTestId("wf-workflow-name-input")) as HTMLInputElement;
    expect(input.value).toBe("Custom");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("wf-workflow-name")).toHaveTextContent("Renamed"));
  });

  it("cancels an inline rename on Escape (value reverts)", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    // Wait for the editor to fully stabilize (column panel rendered) before
    // interacting — clicking mid-load races the initial render cycle.
    await screen.findByText("Save");
    await waitFor(() => expect(screen.getAllByLabelText(/Column name/i).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByTestId("wf-workflow-name"));
    const input = (await screen.findByTestId("wf-workflow-name-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Throwaway" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("wf-workflow-name")).toHaveTextContent("Custom"));
  });

  it("shows a built-in workflow name as plain text (no rename input on click)", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    const nameEl = await screen.findByTestId("wf-workflow-name");
    // Built-in renders a plain <span>, not a clickable button.
    expect(nameEl.tagName).toBe("SPAN");
    fireEvent.click(nameEl);
    expect(screen.queryByTestId("wf-workflow-name-input")).not.toBeInTheDocument();
  });

  it("persists a renamed name through the save PATCH", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({ ...v2Def(), ...(updates as object) }));
    vi.mocked(compileWorkflow).mockResolvedValue({ steps: [] });
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByText("Save");
    await waitFor(() => expect(screen.getAllByLabelText(/Column name/i).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByTestId("wf-workflow-name"));
    const input = await screen.findByTestId("wf-workflow-name-input");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByText("Save").closest("button")!);
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    const [, updates] = vi.mocked(updateWorkflow).mock.calls[0];
    expect((updates as { name?: string }).name).toBe("Renamed");
  });

  // ── Dirty guard ────────────────────────────────────────────────────────────

  it("closes immediately with no confirm when there are no edits", async () => {
    const onClose = vi.fn();
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    renderWithConfirm(<WorkflowNodeEditor isOpen onClose={onClose} addToast={() => {}} />);
    // Wait for the workflow to load (clean snapshot established).
    await screen.findByTestId("wf-workflow-name");
    fireEvent.click(screen.getByLabelText("Close workflow editor"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // No discard confirm dialog appeared.
    expect(screen.queryByRole("dialog", { name: /Discard unsaved changes/i })).not.toBeInTheDocument();
  });

  it("load → immediately close produces no spurious dirty prompt", async () => {
    // Regression for mapping-default asymmetry: the loaded snapshot is computed
    // through flowToIr(irToFlow(...)) so default-materialization matches the live
    // side and a freshly-loaded workflow is never dirty.
    const onClose = vi.fn();
    vi.mocked(fetchWorkflows).mockResolvedValue([stepwiseDef()]);
    renderWithConfirm(<WorkflowNodeEditor isOpen onClose={onClose} addToast={() => {}} />);
    await screen.findByTestId("wf-node-foreach");
    fireEvent.click(screen.getByLabelText("Close workflow editor"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: /Discard unsaved changes/i })).not.toBeInTheDocument();
  });

  it("prompts to discard on close when dirty; confirming closes, cancelling keeps it open", async () => {
    const onClose = vi.fn();
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    renderWithConfirm(<WorkflowNodeEditor isOpen onClose={onClose} addToast={() => {}} />);
    await screen.findByText("Save");
    await waitFor(() => expect(screen.getAllByLabelText(/Column name/i).length).toBeGreaterThan(0));
    // Make an edit: inline rename.
    fireEvent.click(screen.getByTestId("wf-workflow-name"));
    const input = await screen.findByTestId("wf-workflow-name-input");
    fireEvent.change(input, { target: { value: "Edited" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Close → discard confirm appears. Cancel keeps the editor open.
    fireEvent.click(screen.getByLabelText("Close workflow editor"));
    const dialog = await screen.findByRole("dialog", { name: /Discard unsaved changes/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /Cancel/i }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Discard unsaved changes/i })).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();

    // Close again → confirm → onClose fires.
    fireEvent.click(screen.getByLabelText("Close workflow editor"));
    const dialog2 = await screen.findByRole("dialog", { name: /Discard unsaved changes/i });
    fireEvent.click(within(dialog2).getByRole("button", { name: /Discard/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("prompts to discard when switching workflows while dirty", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([
      v2Def(),
      { ...v2Def(), id: "WF-OTHER", name: "Other" },
    ]);
    renderWithConfirm(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByText("Save");
    await waitFor(() => expect(screen.getAllByLabelText(/Column name/i).length).toBeGreaterThan(0));
    // Edit the active workflow.
    fireEvent.click(screen.getByTestId("wf-workflow-name"));
    const input = await screen.findByTestId("wf-workflow-name-input");
    fireEvent.change(input, { target: { value: "Edited" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Switch to the other workflow in the sidebar → discard confirm.
    fireEvent.click(screen.getByText("Other"));
    const dialog = await screen.findByRole("dialog", { name: /Discard unsaved changes/i });
    // Cancel keeps the current workflow (name still "Edited").
    fireEvent.click(within(dialog).getByRole("button", { name: /Cancel/i }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Discard unsaved changes/i })).not.toBeInTheDocument());
    expect(screen.getByTestId("wf-workflow-name")).toHaveTextContent("Edited");
  });
});

// ── U6: empty / onboarding states ───────────────────────────────────────────

// A user-owned workflow whose graph is only start→end (no user-authored nodes).
function trivialUserDef(): WorkflowDefinition {
  return {
    id: "WF-TRIVIAL",
    kind: "workflow",
    name: "Trivial",
    description: "",
    ir: {
      version: "v1",
      name: "Trivial",
      nodes: [
        { id: "start", kind: "start" },
        { id: "end", kind: "end" },
      ],
      edges: [{ from: "start", to: "end", condition: "success" }],
    },
    layout: { start: { x: 0, y: 0 }, end: { x: 240, y: 0 } },
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}

describe("WorkflowNodeEditor — U6 empty/onboarding states", () => {
  beforeEach(() => {
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("no-workflow empty state CTA opens the create dialog", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    const cta = await screen.findByTestId("wf-empty-create");
    expect(screen.queryByTestId("wf-create-dialog")).not.toBeInTheDocument();
    fireEvent.click(cta);
    expect(await screen.findByTestId("wf-create-dialog")).toBeInTheDocument();
  });

  it("renders the trivial-graph palette hint for a user-owned start→end workflow", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([trivialUserDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    // Wait for hydration (the palette appears for editable workflows).
    await screen.findByText("Save");
    expect(await screen.findByTestId("wf-trivial-hint")).toBeInTheDocument();
  });

  it("hides the trivial-graph hint once a user node exists", async () => {
    // v2Def() carries a "prompt" step → a user-authored node.
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByText("Save");
    await screen.findByTestId("wf-column-panel");
    expect(screen.queryByTestId("wf-trivial-hint")).not.toBeInTheDocument();
  });

  it("never renders the trivial-graph hint for a built-in workflow", async () => {
    // Built-in that is itself trivial (start→end only) — must still not show the hint.
    const builtinTrivial: WorkflowDefinition = { ...trivialUserDef(), id: "builtin:trivial", name: "Built-in" };
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinTrivial]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    expect(await screen.findByTestId("wf-readonly-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("wf-trivial-hint")).not.toBeInTheDocument();
  });
});

describe("WorkflowNodeEditor — U2 legacy-step migration notice", () => {
  beforeEach(() => {
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("shows the one-time notice when migration converted steps", async () => {
    vi.mocked(migrateLegacyWorkflowSteps).mockResolvedValue({ migrated: 2, skipped: 0, combinedWorkflowId: "WF-010" });
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} projectId="p1" />);
    expect(await screen.findByTestId("wf-migration-notice")).toBeInTheDocument();
    expect(migrateLegacyWorkflowSteps).toHaveBeenCalledWith("p1");
  });

  it("dismisses the notice, persisting the dismissal so it stays hidden on re-open", async () => {
    vi.mocked(migrateLegacyWorkflowSteps).mockResolvedValue({ migrated: 2, skipped: 0, combinedWorkflowId: "WF-010" });
    const { unmount } = render(
      <WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} projectId="p1" />,
    );
    const notice = await screen.findByTestId("wf-migration-notice");
    expect(notice).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("wf-migration-notice-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("wf-migration-notice")).not.toBeInTheDocument());
    expect(localStorage.getItem("fusion:wf-migration-notice-dismissed:p1")).toBe("1");

    // Re-open the editor: the persisted dismissal keeps the notice hidden even
    // though migration still reports migrated > 0.
    unmount();
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} projectId="p1" />);
    await screen.findByTestId("wf-new-workflow");
    expect(screen.queryByTestId("wf-migration-notice")).not.toBeInTheDocument();
  });

  it("does not show the notice when migration converted nothing", async () => {
    vi.mocked(migrateLegacyWorkflowSteps).mockResolvedValue({ migrated: 0, skipped: 3 });
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} projectId="p1" />);
    await screen.findByTestId("wf-new-workflow");
    expect(screen.queryByTestId("wf-migration-notice")).not.toBeInTheDocument();
  });
});

// ── U5: import/export ───────────────────────────────────────────────────────

describe("WorkflowNodeEditor — U5 import/export", () => {
  beforeEach(() => {
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
    vi.mocked(migrateLegacyWorkflowSteps).mockResolvedValue({ migrated: 0, skipped: 0 });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("export button is enabled on a clean canvas and disabled after an edit", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    const exportBtn = await screen.findByTestId("wf-export");
    // Clean canvas → enabled.
    await waitFor(() => expect(exportBtn).not.toBeDisabled());

    // Make an edit: rename the workflow (click the name, type a new value).
    fireEvent.click(screen.getByTestId("wf-workflow-name"));
    const nameInput = await screen.findByTestId("wf-workflow-name-input");
    fireEvent.change(nameInput, { target: { value: "Custom edited" } });

    await waitFor(() => expect(screen.getByTestId("wf-export")).toBeDisabled());
  });

  it("export click downloads via exportWorkflow", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    vi.mocked(exportWorkflow).mockResolvedValue({
      fusionWorkflowExport: 1,
      schemaVersion: 109,
      kind: "workflow",
      name: "Custom",
      description: "",
      ir: v2Def().ir,
      layout: {},
    });
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    const exportBtn = await screen.findByTestId("wf-export");
    await waitFor(() => expect(exportBtn).not.toBeDisabled());
    fireEvent.click(exportBtn);
    await waitFor(() => expect(exportWorkflow).toHaveBeenCalledWith("WF-002", undefined));
  });

  it("import success refreshes the list, activates the imported workflow, and toasts", async () => {
    const addToast = vi.fn();
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    const imported: WorkflowDefinition = { ...v2Def(), id: "WF-IMP", name: "Brought in" };
    vi.mocked(importWorkflow).mockResolvedValue({
      workflow: imported,
      strippedApprovalFlags: false,
      warnings: [],
    });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={addToast} />);
    await screen.findByTestId("wf-import");
    // After the import resolves, loadWorkflows re-runs; return the imported one.
    vi.mocked(fetchWorkflows).mockResolvedValue([imported]);

    const fileInput = screen.getByTestId("wf-import-input") as HTMLInputElement;
    const file = new File([JSON.stringify({ fusionWorkflowExport: 1 })], "wf.json", { type: "application/json" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(importWorkflow).toHaveBeenCalled());
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/Brought in/), "success"),
    );
    // Imported workflow is now active in the sidebar (its list item carries the
    // active class) and rendered into the canvas — appearing more than once.
    await waitFor(() => expect(screen.getAllByText("Brought in").length).toBeGreaterThan(0));
    const activeItem = document.querySelector(".wf-editor-list-item.active");
    expect(activeItem).toHaveTextContent("Brought in");
  });

  it("import 4xx renders the persistent inline error region; list unchanged", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    vi.mocked(importWorkflow).mockRejectedValue(
      new ApiRequestError("Not a Fusion workflow export file", 400),
    );

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByTestId("wf-import");

    const fileInput = screen.getByTestId("wf-import-input") as HTMLInputElement;
    const file = new File([JSON.stringify({ nope: true })], "wf.json", { type: "application/json" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    const errorRegion = await screen.findByTestId("wf-import-error");
    expect(errorRegion).toHaveTextContent("Not a Fusion workflow export file");
    expect(errorRegion).toHaveAttribute("role", "alert");
    // List unchanged: still no workflows.
    expect(screen.getByText(/No workflows yet/i)).toBeInTheDocument();
  });

  it("import strip notice toast fires when approval flags were removed", async () => {
    const addToast = vi.fn();
    const imported: WorkflowDefinition = { ...v2Def(), id: "WF-IMP2", name: "Stripped in" };
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    vi.mocked(importWorkflow).mockResolvedValue({
      workflow: imported,
      strippedApprovalFlags: true,
      warnings: [],
    });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={addToast} />);
    await screen.findByTestId("wf-import");
    vi.mocked(fetchWorkflows).mockResolvedValue([imported]);

    const fileInput = screen.getByTestId("wf-import-input") as HTMLInputElement;
    const file = new File([JSON.stringify({ fusionWorkflowExport: 1 })], "wf.json", { type: "application/json" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(
        expect.stringMatching(/Auto-approval flags were removed/),
        "warning",
      ),
    );
  });
});

describe("WorkflowNodeEditor — U9 palette Templates section", () => {
  // A clean prompt-mode built-in step template + a script-mode one.
  function stepTpl(over: Partial<WorkflowStepTemplate> = {}): WorkflowStepTemplate {
    return {
      id: "qa-check",
      name: "QA Check",
      description: "Run lint and tests",
      category: "Quality",
      prompt: "You are a QA tester.",
      ...over,
    };
  }

  function pluginTpl(): { pluginId: string; template: WorkflowStepTemplate } {
    return {
      pluginId: "acme-plugin",
      template: stepTpl({ id: "acme-scan", name: "Acme Scan", prompt: "Scan it." }),
    };
  }

  // A clean fragment (no seam) — one gate node.
  function cleanFragment(over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
    return {
      id: "WF-FRAG-A",
      kind: "fragment",
      name: "Lint fragment",
      description: "A single lint step",
      ir: {
        version: "v1",
        name: "Lint fragment",
        nodes: [
          { id: "start", kind: "start" },
          { id: "lint", kind: "gate", config: { name: "Lint", scriptName: "lint", gateMode: "gate" } },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "lint", condition: "success" },
          { from: "lint", to: "end", condition: "success" },
        ],
      },
      layout: {},
      createdAt: "2026-06-03T00:00:00.000Z",
      updatedAt: "2026-06-03T00:00:00.000Z",
      ...over,
    };
  }

  // A fragment that carries a "merge" seam (collides with def()'s merge node).
  function mergeFragment(): WorkflowDefinition {
    return {
      id: "WF-FRAG-MERGE",
      kind: "fragment",
      name: "Boundary fragment",
      description: "Carries a merge seam",
      ir: {
        version: "v1",
        name: "Boundary fragment",
        nodes: [
          { id: "start", kind: "start" },
          { id: "m", kind: "prompt", config: { seam: "merge" } },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "m", condition: "success" },
          { from: "m", to: "end", condition: "success" },
        ],
      },
      layout: {},
      createdAt: "2026-06-03T00:00:00.000Z",
      updatedAt: "2026-06-03T00:00:00.000Z",
    };
  }

  beforeEach(() => {
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
    vi.mocked(migrateLegacyWorkflowSteps).mockResolvedValue({ migrated: 0, skipped: 0 });
    vi.mocked(fetchWorkflowStepTemplates).mockResolvedValue({ templates: [] });
    vi.mocked(fetchPluginWorkflowStepTemplates).mockResolvedValue({ templates: [] });
    try {
      localStorage.removeItem("fusion:wf-templates-collapsed");
    } catch {
      // ignore
    }
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders three subsections — alphabetical, with plugin owner badge", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([
      def(),
      cleanFragment({ id: "WF-FRAG-B", name: "Zeta fragment" }),
      cleanFragment({ id: "WF-FRAG-A", name: "Alpha fragment" }),
    ]);
    vi.mocked(fetchWorkflowStepTemplates).mockResolvedValue({
      templates: [stepTpl({ id: "zed", name: "Zed Step" }), stepTpl({ id: "qa-check", name: "QA Check" })],
    });
    vi.mocked(fetchPluginWorkflowStepTemplates).mockResolvedValue({ templates: [pluginTpl()] });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    const section = await screen.findByTestId("wf-palette-templates");
    // Three subsection headers present.
    expect(within(section).getByText("Fragments")).toBeInTheDocument();
    expect(within(section).getByText("Built-in steps")).toBeInTheDocument();
    expect(within(section).getByText("Plugin steps")).toBeInTheDocument();

    // Fragments alphabetical: Alpha before Zeta.
    expect(screen.getByTestId("wf-tpl-fragment-WF-FRAG-A")).toBeInTheDocument();
    const fragBtns = within(section)
      .getAllByText(/fragment/i)
      .map((n) => n.textContent);
    const alphaIdx = fragBtns.findIndex((t) => /Alpha/.test(t ?? ""));
    const zetaIdx = fragBtns.findIndex((t) => /Zeta/.test(t ?? ""));
    expect(alphaIdx).toBeLessThan(zetaIdx);

    // Plugin entry shows the owner badge.
    const pluginEntry = screen.getByTestId("wf-tpl-plugin-acme-scan");
    expect(pluginEntry).toHaveTextContent("acme-plugin");
  });

  it("starts Templates collapsed by default on mobile", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);
    vi.mocked(fetchWorkflowStepTemplates).mockResolvedValue({ templates: [stepTpl()] });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "QA" }));
    const toggle = await screen.findByTestId("wf-templates-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("wf-tpl-step-qa-check")).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(await screen.findByTestId("wf-tpl-step-qa-check")).toBeInTheDocument();
  });

  it("clicking a step-template entry adds a pre-configured node", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);
    vi.mocked(fetchWorkflowStepTemplates).mockResolvedValue({
      templates: [stepTpl({ id: "qa-check", name: "QA Check", prompt: "test it" })],
    });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByTestId("wf-palette-templates");
    // Canvas can lag the palette under cold-transform shard load.
    await screen.findByTestId("wf-node-gate", undefined, { timeout: 3000 });

    const before = screen.queryAllByTestId("wf-node-prompt").length;
    fireEvent.click(screen.getByTestId("wf-tpl-step-qa-check"));
    await waitFor(
      () => expect(screen.queryAllByTestId("wf-node-prompt").length).toBe(before + 1),
      { timeout: 3000 },
    );
  });

  it("clicking a fragment with a duplicate merge seam surfaces the desktop inline conflict; no insertion", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def(), mergeFragment()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByTestId("wf-palette-templates");
    /*
     * FNXC:WorkflowNodeEditor 2026-06-19-18:10:
     * The duplicate-merge-seam guard must not wait for React Flow nodes before protecting insertion.
     * Click as soon as the palette is usable, then prove the loaded merge prompt remains the only prompt node after the conflict surfaces.
     */
    fireEvent.click(screen.getByTestId("wf-tpl-fragment-WF-FRAG-MERGE"));

    const conflict = await screen.findByTestId("wf-tpl-conflict");
    expect(conflict).toHaveAttribute("role", "alert");
    expect(conflict).toHaveTextContent(/merge/);
    await screen.findByTestId("wf-node-gate");
    await waitFor(() => expect(document.querySelectorAll('.wf-node[data-testid^="wf-node-"]')).toHaveLength(4));
  });

  it("clicking a duplicate merge fragment surfaces the mobile inline conflict; no insertion", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([def(), mergeFragment()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "QA" }));
    const graph = await screen.findByTestId("wf-mobile-shell");
    const beforeNodes = within(graph).queryAllByTestId(/^mobile-wf-node-/).length;

    fireEvent.click(screen.getByTestId("wf-mobile-tab-add"));
    fireEvent.click(await screen.findByTestId("wf-mobile-tpl-fragment-WF-FRAG-MERGE"));

    const conflict = await screen.findByTestId("wf-mobile-tpl-conflict");
    expect(conflict).toHaveAttribute("role", "alert");
    expect(conflict).toHaveTextContent(/merge/);
    fireEvent.click(screen.getByTestId("wf-mobile-tab-graph"));
    await waitFor(() => expect(screen.getAllByTestId(/^mobile-wf-node-/)).toHaveLength(beforeNodes));
  });

  it("clicking a clean fragment inserts its non-start/end nodes", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def(), cleanFragment()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByTestId("wf-palette-templates");

    const beforeGates = screen.queryAllByTestId("wf-node-gate").length;
    fireEvent.click(screen.getByTestId("wf-tpl-fragment-WF-FRAG-A"));
    // cleanFragment has exactly one body node (the gate) after start/end strip.
    await waitFor(() =>
      expect(screen.getAllByTestId("wf-node-gate").length).toBe(beforeGates + 1),
    );
  });

  it("filter input is absent with ≤8 entries and present with >8; filtering narrows entries", async () => {
    // 1 fragment + 8 built-in steps = 9 entries (> 8).
    const manySteps = Array.from({ length: 8 }, (_, i) =>
      stepTpl({ id: `s-${i}`, name: `Step ${i}` }),
    );
    vi.mocked(fetchWorkflows).mockResolvedValue([def(), cleanFragment()]);
    vi.mocked(fetchWorkflowStepTemplates).mockResolvedValue({ templates: manySteps });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByTestId("wf-palette-templates");

    const filter = await screen.findByTestId("wf-template-filter");
    // All 8 step entries present pre-filter.
    expect(screen.getAllByTestId(/^wf-tpl-step-/).length).toBe(8);
    // Filter to "Step 3" → only that step survives.
    fireEvent.change(filter, { target: { value: "Step 3" } });
    await waitFor(() => expect(screen.getAllByTestId(/^wf-tpl-step-/).length).toBe(1));
    expect(screen.getByTestId("wf-tpl-step-s-3")).toBeInTheDocument();
    // Fragment (name "Lint fragment") no longer matches.
    expect(screen.queryByTestId("wf-tpl-fragment-WF-FRAG-A")).not.toBeInTheDocument();
  });

  it("filter input absent with ≤8 entries", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def(), cleanFragment()]);
    vi.mocked(fetchWorkflowStepTemplates).mockResolvedValue({
      templates: [stepTpl(), stepTpl({ id: "two", name: "Two" })],
    });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByTestId("wf-palette-templates");
    expect(screen.queryByTestId("wf-template-filter")).not.toBeInTheDocument();
  });

  it("hides the Fragments subsection when no fragments exist", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);
    vi.mocked(fetchWorkflowStepTemplates).mockResolvedValue({ templates: [stepTpl()] });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    const section = await screen.findByTestId("wf-palette-templates");
    expect(within(section).queryByText("Fragments")).not.toBeInTheDocument();
    expect(within(section).getByText("Built-in steps")).toBeInTheDocument();
  });

  it("disables all entries when the active workflow is a built-in", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef(), cleanFragment()]);
    vi.mocked(fetchWorkflowStepTemplates).mockResolvedValue({ templates: [stepTpl()] });
    vi.mocked(fetchPluginWorkflowStepTemplates).mockResolvedValue({ templates: [pluginTpl()] });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByTestId("wf-palette-templates");

    expect(screen.getByTestId("wf-tpl-fragment-WF-FRAG-A")).toBeDisabled();
    expect(screen.getByTestId("wf-tpl-step-qa-check")).toBeDisabled();
    expect(screen.getByTestId("wf-tpl-plugin-acme-scan")).toBeDisabled();
  });
});

// ── U10: Design-with-AI editor affordances ──────────────────────────────────

describe("WorkflowNodeEditor — U10 design-with-AI", () => {
  // A distinctive designed IR: a single script node so the canvas renders
  // `wf-node-script` (absent from the active v2Def, which has a prompt node).
  function designedResult(over: Partial<import("../../api").DesignWorkflowResult> = {}) {
    return {
      ir: {
        version: "v1" as const,
        name: "AI designed",
        nodes: [
          { id: "start", kind: "start" as const },
          { id: "ai-lint", kind: "script" as const, config: { scriptName: "lint" } },
          { id: "end", kind: "end" as const },
        ],
        edges: [
          { from: "start", to: "ai-lint", condition: "success" as const },
          { from: "ai-lint", to: "end", condition: "success" as const },
        ],
      },
      layout: { start: { x: 0, y: 0 }, "ai-lint": { x: 120, y: 0 }, end: { x: 240, y: 0 } },
      interpreterOnly: false,
      strippedApprovalFlags: false,
      ...over,
    };
  }

  beforeEach(() => {
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
    vi.mocked(migrateLegacyWorkflowSteps).mockResolvedValue({ migrated: 0, skipped: 0 });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // ── Create dialog flow ─────────────────────────────────────────────────────

  it("toggle reveals the prompt textarea; success creates the workflow from the returned IR and closes the dialog", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    vi.mocked(designWorkflow).mockResolvedValue(designedResult());
    vi.mocked(createWorkflow).mockResolvedValue({ ...v2Def(), id: "WF-AI", name: "AI: do the thing" });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    fireEvent.click(await screen.findByTestId("wf-new-workflow"));
    await screen.findByTestId("wf-create-dialog");

    // Textarea hidden until toggled.
    expect(screen.queryByTestId("wf-ai-prompt")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("wf-ai-toggle"));
    const prompt = await screen.findByTestId("wf-ai-prompt");
    fireEvent.change(prompt, { target: { value: "do the thing" } });
    fireEvent.click(screen.getByTestId("wf-ai-submit"));

    await waitFor(() => expect(designWorkflow).toHaveBeenCalledWith(
      { prompt: "do the thing" },
      undefined,
      expect.any(AbortSignal),
    ));
    await waitFor(() => expect(createWorkflow).toHaveBeenCalled());
    const [input] = vi.mocked(createWorkflow).mock.calls[0];
    // createWorkflow seeded from the returned IR (node ids/count match).
    const ir = (input as { ir: { nodes: Array<{ id: string }> } }).ir;
    expect(ir.nodes.map((n) => n.id)).toEqual(["start", "ai-lint", "end"]);
    // Dialog closed.
    await waitFor(() => expect(screen.queryByTestId("wf-create-dialog")).not.toBeInTheDocument());
  });

  it("422 rejection shows the inline error; createWorkflow not called; dialog stays open", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    vi.mocked(designWorkflow).mockRejectedValue(
      new ApiRequestError("The AI response was not valid JSON.", 422),
    );

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    fireEvent.click(await screen.findByTestId("wf-new-workflow"));
    await screen.findByTestId("wf-create-dialog");
    fireEvent.click(screen.getByTestId("wf-ai-toggle"));
    fireEvent.change(await screen.findByTestId("wf-ai-prompt"), { target: { value: "bad" } });
    fireEvent.click(screen.getByTestId("wf-ai-submit"));

    const err = await screen.findByTestId("wf-ai-error");
    expect(err).toHaveTextContent("The AI response was not valid JSON.");
    expect(err).toHaveAttribute("role", "alert");
    expect(createWorkflow).not.toHaveBeenCalled();
    expect(screen.getByTestId("wf-create-dialog")).toBeInTheDocument();
  });

  it("in-flight: submit disabled + Cancel visible; cancel aborts and re-enables", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    let rejectFn: ((e: unknown) => void) | undefined;
    vi.mocked(designWorkflow).mockImplementation((_input, _pid, signal) => {
      return new Promise((_resolve, reject) => {
        rejectFn = reject;
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    fireEvent.click(await screen.findByTestId("wf-new-workflow"));
    await screen.findByTestId("wf-create-dialog");
    fireEvent.click(screen.getByTestId("wf-ai-toggle"));
    fireEvent.change(await screen.findByTestId("wf-ai-prompt"), { target: { value: "slow one" } });
    fireEvent.click(screen.getByTestId("wf-ai-submit"));

    // In-flight: submit disabled, Cancel visible, section aria-busy.
    await waitFor(() => expect(screen.getByTestId("wf-ai-submit")).toBeDisabled());
    expect(screen.getByTestId("wf-ai-cancel")).toBeInTheDocument();
    expect(screen.getByTestId("wf-ai-create")).toHaveAttribute("aria-busy", "true");

    // Cancel aborts → re-enables, no error shown.
    fireEvent.click(screen.getByTestId("wf-ai-cancel"));
    await waitFor(() => expect(screen.getByTestId("wf-ai-submit")).not.toBeDisabled());
    expect(screen.queryByTestId("wf-ai-error")).not.toBeInTheDocument();
    expect(createWorkflow).not.toHaveBeenCalled();
    expect(rejectFn).toBeDefined();
  });

  it("interpreterOnly result seeds the info banner after the workflow loads", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    vi.mocked(designWorkflow).mockResolvedValue(designedResult({ interpreterOnly: true }));
    vi.mocked(createWorkflow).mockResolvedValue({ ...v2Def(), id: "WF-AI", name: "AI branchy" });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    fireEvent.click(await screen.findByTestId("wf-new-workflow"));
    await screen.findByTestId("wf-create-dialog");
    fireEvent.click(screen.getByTestId("wf-ai-toggle"));
    fireEvent.change(await screen.findByTestId("wf-ai-prompt"), { target: { value: "branchy" } });
    fireEvent.click(screen.getByTestId("wf-ai-submit"));

    expect(await screen.findByTestId("wf-interpreter-only-banner")).toBeInTheDocument();
  });

  // ── Toolbar flow ───────────────────────────────────────────────────────────

  it("hides the toolbar Design-with-AI button for built-ins", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByTestId("wf-readonly-banner");
    expect(screen.queryByTestId("wf-ai-edit")).not.toBeInTheDocument();
  });

  it("toolbar flow over a clean canvas: success confirms then replaces the graph and leaves it dirty", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    vi.mocked(designWorkflow).mockResolvedValue(designedResult());

    renderWithConfirm(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    // Open the panel and submit against the active workflow (no edits = clean).
    fireEvent.click(await screen.findByTestId("wf-ai-edit"));
    fireEvent.change(await screen.findByTestId("wf-ai-edit-prompt"), { target: { value: "rebuild it" } });
    fireEvent.click(screen.getByTestId("wf-ai-edit-submit"));

    await waitFor(() => expect(designWorkflow).toHaveBeenCalledWith(
      { prompt: "rebuild it", workflowId: "WF-002" },
      undefined,
      expect.any(AbortSignal),
    ));
    // Always-confirm replace dialog (even though clean).
    const dialog = await screen.findByRole("dialog", { name: /Replace graph/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /Replace/i }));

    // Canvas replaced: the designed script node appears.
    await waitFor(() => expect(screen.getByTestId("wf-node-script")).toBeInTheDocument());
    // Dirty: closing now prompts the discard guard.
    fireEvent.click(screen.getByLabelText("Close workflow editor"));
    expect(await screen.findByRole("dialog", { name: /Discard unsaved changes/i })).toBeInTheDocument();
  });

  it("toolbar flow: cancelling the replace confirm keeps the canvas unchanged", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    vi.mocked(designWorkflow).mockResolvedValue(designedResult());

    renderWithConfirm(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    // Wait for the editor to fully stabilize before interacting — clicking
    // the name strip mid-hydration races the initial render cycle.
    await screen.findByText("Save");
    await waitFor(() => expect(screen.getAllByLabelText(/Column name/i).length).toBeGreaterThan(0));
    // Make a dirty edit first (inline rename) so we can prove it survives a cancel.
    fireEvent.click(screen.getByTestId("wf-workflow-name"));
    const input = await screen.findByTestId("wf-workflow-name-input");
    fireEvent.change(input, { target: { value: "Kept name" } });
    fireEvent.keyDown(input, { key: "Enter" });

    fireEvent.click(screen.getByTestId("wf-ai-edit"));
    fireEvent.change(await screen.findByTestId("wf-ai-edit-prompt"), { target: { value: "replace pls" } });
    fireEvent.click(screen.getByTestId("wf-ai-edit-submit"));

    const dialog = await screen.findByRole("dialog", { name: /Replace graph/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /Cancel/i }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Replace graph/i })).not.toBeInTheDocument(),
    );

    // The designed script node was NOT inserted; the prior edit is intact.
    expect(screen.queryByTestId("wf-node-script")).not.toBeInTheDocument();
    expect(screen.getByTestId("wf-workflow-name")).toHaveTextContent("Kept name");
  });

  it("toolbar flow: 422 shows the inline panel error and leaves the canvas untouched", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    vi.mocked(designWorkflow).mockRejectedValue(
      new ApiRequestError("Invalid workflow IR", 422),
    );

    renderWithConfirm(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    fireEvent.click(await screen.findByTestId("wf-ai-edit"));
    fireEvent.change(await screen.findByTestId("wf-ai-edit-prompt"), { target: { value: "nope" } });
    fireEvent.click(screen.getByTestId("wf-ai-edit-submit"));

    const err = await screen.findByTestId("wf-ai-edit-error");
    expect(err).toHaveTextContent("Invalid workflow IR");
    expect(err).toHaveAttribute("role", "alert");
    // No replace confirm appeared; canvas unchanged (no script node).
    expect(screen.queryByRole("dialog", { name: /Replace graph/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("wf-node-script")).not.toBeInTheDocument();
  });
});

// ── U6: per-column agent picker, mode toggle, stale-id + override surfaces ────

function flagsOn(): Settings {
  return { experimentalFeatures: { workflowColumns: true, workflowGraphExecutor: true } } as Settings;
}

function agentList(): Agent[] {
  return [
    { id: "agent-001", name: "Reviewer" } as Agent,
    { id: "agent-002", name: "Implementer" } as Agent,
  ];
}

/** A v2 def whose `triage` column binds agent-001 in the given mode, and whose
 *  `step` node is declared in `triage` (so an override note can surface). */
function boundDef(mode: "defer" | "override", agentId = "agent-001"): WorkflowDefinition {
  const d = v2Def();
  if (d.ir.version === "v2") {
    d.ir.columns = d.ir.columns.map((c) =>
      c.id === "triage" ? { ...c, agent: { agentId, mode } } : c,
    );
  }
  return d;
}

describe("WorkflowNodeEditor — U6 column agents", () => {
  beforeEach(() => {
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
    vi.mocked(fetchSettings).mockResolvedValue(flagsOn());
    vi.mocked(fetchAgents).mockResolvedValue(agentList());
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the per-column agent picker enabled with registry agents when flags are on", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    const picker = (await screen.findByTestId("wf-column-agent-select-triage")) as HTMLSelectElement;
    await waitFor(() => expect(picker.disabled).toBe(false));
    await waitFor(() =>
      expect(Array.from(picker.options).some((o) => o.value === "agent-001")).toBe(true),
    );
    // "(none)" is the default selection for an unbound column.
    expect(picker.value).toBe("");
  });

  it("disables the picker with a flag-naming hint when the flags are off", async () => {
    vi.mocked(fetchSettings).mockResolvedValue({} as Settings);
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    const picker = (await screen.findByTestId("wf-column-agent-select-triage")) as HTMLSelectElement;
    await waitFor(() => expect(picker.disabled).toBe(true));
    expect(picker.title).toMatch(/workflowColumns/);
    expect(picker.title).toMatch(/workflowGraphExecutor/);
  });

  it("selecting an agent reveals the defer/override mode toggle (default defer) and writes the binding", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({ ...v2Def(), ...(updates as object) }));
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    const picker = (await screen.findByTestId("wf-column-agent-select-triage")) as HTMLSelectElement;
    await waitFor(() => expect(picker.disabled).toBe(false));
    fireEvent.change(picker, { target: { value: "agent-001" } });

    // Mode toggle appears; defer is checked by default.
    const deferRadio = (await screen.findByText("Defer")).closest("label")!.querySelector("input")! as HTMLInputElement;
    expect(deferRadio.checked).toBe(true);
    // Badge reflects the bound agent name.
    expect(await screen.findByTestId("wf-column-agent-badge-triage")).toHaveTextContent("Reviewer");

    // Save round-trips the binding into the IR.
    fireEvent.click(screen.getByText("Save").closest("button")!);
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    const [, updates] = vi.mocked(updateWorkflow).mock.calls[0];
    const cols = (updates as { ir: { columns: { id: string; agent?: { agentId: string; mode: string } }[] } }).ir.columns;
    const triage = cols.find((c) => c.id === "triage");
    expect(triage?.agent).toEqual({ agentId: "agent-001", mode: "defer" });
  });

  it("toggling the mode to override saves the binding with mode: override", async () => {
    // Start from a deferred binding so the mode toggle is already visible.
    vi.mocked(fetchWorkflows).mockResolvedValue([boundDef("defer")]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({ ...boundDef("defer"), ...(updates as object) }));
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    const picker = (await screen.findByTestId("wf-column-agent-select-triage")) as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe("agent-001"));

    // Defer is the initial mode; flip to Override.
    const deferRadio = (await screen.findByText("Defer")).closest("label")!.querySelector("input")! as HTMLInputElement;
    expect(deferRadio.checked).toBe(true);
    const overrideRadio = screen.getByText("Override").closest("label")!.querySelector("input")! as HTMLInputElement;
    fireEvent.click(overrideRadio);
    await waitFor(() => expect(overrideRadio.checked).toBe(true));

    // Save round-trips the updated mode into the IR.
    fireEvent.click(screen.getByText("Save").closest("button")!);
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    const [, updates] = vi.mocked(updateWorkflow).mock.calls[0];
    const cols = (updates as { ir: { columns: { id: string; agent?: { agentId: string; mode: string } }[] } }).ir.columns;
    const triage = cols.find((c) => c.id === "triage");
    expect(triage?.agent).toEqual({ agentId: "agent-001", mode: "override" });
  });

  it("clearing to (none) removes the agent key entirely (no agent: null)", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([boundDef("defer")]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({ ...boundDef("defer"), ...(updates as object) }));
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    const picker = (await screen.findByTestId("wf-column-agent-select-triage")) as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe("agent-001"));
    fireEvent.change(picker, { target: { value: "" } });

    fireEvent.click(screen.getByText("Save").closest("button")!);
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    const [, updates] = vi.mocked(updateWorkflow).mock.calls[0];
    const cols = (updates as { ir: { columns: { id: string; agent?: unknown }[] } }).ir.columns;
    const triage = cols.find((c) => c.id === "triage")!;
    expect("agent" in triage).toBe(false);
  });

  it("renders a not-found warning for a stored agentId absent from the registry, preserving the value", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([boundDef("defer", "agent-ghost")]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    // The stale id surfaces a not-found annotation and remains the picker value.
    const stale = await screen.findByTestId("wf-column-agent-stale-triage");
    expect(stale).toHaveTextContent(/agent-ghost/);
    const picker = screen.getByTestId("wf-column-agent-select-triage") as HTMLSelectElement;
    expect(picker.value).toBe("agent-ghost");
  });

  it("surfaces an inline error near the picker when the agents fetch fails", async () => {
    vi.mocked(fetchAgents).mockRejectedValue(new Error("agents offline"));
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByTestId("wf-column-panel");
    await waitFor(() => expect(screen.getAllByText(/agents offline/i).length).toBeGreaterThan(0));
  });

  it("shows the overridden-by-column-agent note on a node inside an override column", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([boundDef("override")]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    // Select the prompt node placed in the override column.
    const node = await screen.findByTestId("wf-node-prompt");
    fireEvent.click(node);
    const note = await screen.findByTestId("wf-node-overridden-by-column-agent");
    expect(note).toHaveTextContent(/Overridden by column agent/i);
    expect(note).toHaveTextContent("Reviewer");
  });
});
