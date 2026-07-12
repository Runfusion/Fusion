import { readFileSync } from "node:fs";
import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import { parseWorkflowIr, type WorkflowDefinition, type Settings } from "@fusion/core";

// FNXC:WorkflowStepTemplate 2026-06-25-00:00: U6 deleted the built-in
// WORKFLOW_STEP_TEMPLATES catalog. These palette tests only need an arbitrary set of
// step templates returned by `fetchWorkflowStepTemplates` to verify palette rendering +
// insertion; this local fixture replaces the deleted catalog (the editor is
// template-agnostic — it renders whatever the API returns). `WorkflowStepTemplate` is
// imported below (type-only imports hoist).
const STEP_TEMPLATE_FIXTURES: WorkflowStepTemplate[] = [
  { id: "documentation-review", name: "Documentation Review", description: "doc review", prompt: "You review docs.", category: "Quality", toolMode: "readonly" },
  { id: "qa-check", name: "QA Check", description: "qa", prompt: "You run QA.", category: "Quality", toolMode: "coding" },
  { id: "security-audit", name: "Security Audit", description: "sec", prompt: "You audit security.", category: "Security", toolMode: "readonly" },
  { id: "performance-review", name: "Performance Review", description: "perf", prompt: "You review perf.", category: "Quality", toolMode: "readonly" },
  { id: "accessibility-check", name: "Accessibility Check", description: "a11y", prompt: "You check a11y.", category: "Quality", toolMode: "readonly" },
  { id: "browser-verification", name: "Browser Verification", description: "browser", prompt: "You verify in a browser.", category: "Quality", toolMode: "coding" },
  { id: "frontend-ux-design", name: "Frontend UX Design", description: "ux", prompt: "You review UX.", category: "Quality", toolMode: "readonly" },
];
import type { Agent, BoardWorkflowDefinition } from "../../api";
import {
  irToFlow,
  flowToIr,
  emptyWorkflowIr,
  emptyWorkflowLayout,
  foreachChildFlowId,
  WF_EDGE_INTERACTION_WIDTH,
  isVisualOnlyWorkflowEdge,
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
  fetchWorkflowPromptOverrides: vi.fn().mockResolvedValue({ stored: {}, effective: {}, defaults: {} }),
  updateWorkflowPromptOverrides: vi.fn().mockResolvedValue({ stored: {}, effective: {}, defaults: {} }),
}));

import { fireEvent } from "@testing-library/react";
import {
  fetchWorkflows,
  fetchTraits,
  fetchStepParsers,
  updateWorkflow,
  createWorkflow,
  deleteWorkflow,
  fetchModels,
  exportWorkflow,
  importWorkflow,
  designWorkflow,
  ApiRequestError,
  fetchWorkflowStepTemplates,
  fetchPluginWorkflowStepTemplates,
  fetchAgents,
  fetchConfig,
  fetchSettings,
  fetchWorkflowPromptOverrides,
  updateWorkflowPromptOverrides,
} from "../../api";
import type { TraitCatalogEntry } from "../../api";
import type { WorkflowStepTemplate } from "@fusion/core";
import { beforeEach as viBeforeEach } from "vitest";
import { WorkflowNodeEditor } from "../WorkflowNodeEditor";
import { WorkflowSwitcher } from "../WorkflowSwitcher";
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

function defineElementMetric(element: Element, property: "clientWidth" | "scrollWidth", value: number) {
  Object.defineProperty(element, property, { configurable: true, value });
}

function assertSimpleEditorTabScrollOwner(shell: HTMLElement, width: number) {
  const tabStrip = within(shell).getByRole("navigation", { name: /workflow editor sections/i });
  const editorBody = shell.closest(".wf-editor-body");
  const editorModal = shell.closest(".wf-editor-modal");
  expect(editorBody).not.toBeNull();
  expect(editorModal).not.toBeNull();

  defineElementMetric(tabStrip, "clientWidth", width);
  defineElementMetric(tabStrip, "scrollWidth", width * 2);
  for (const containedElement of [shell, editorBody!, editorModal!, document.documentElement, document.body]) {
    defineElementMetric(containedElement, "clientWidth", width);
    defineElementMetric(containedElement, "scrollWidth", width);
  }

  const tabButtons = within(tabStrip).getAllByRole("button");
  // FNXC:WorkflowSimpleEditor 2026-06-29-13:16: The regression invariant is the complete six-tab simple-editor strip; do not let a test pass by measuring a reduced or renamed tab set that hides overflow instead of preserving horizontal scroll.
  expect(tabButtons.map((button) => button.textContent)).toEqual(["Graph", "Add", "Settings", "Fields", "Columns", "Actions"]);
  expect(tabStrip).toHaveClass("wf-mobile-tabs");
  for (const tabButton of tabButtons) {
    expect(tabButton).toHaveClass("wf-mobile-tab");
  }
  expect(tabStrip.scrollWidth).toBeGreaterThan(tabStrip.clientWidth);
  expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth + 1);
  expect(editorBody!.scrollWidth).toBeLessThanOrEqual(editorBody!.clientWidth + 1);
  expect(editorModal!.scrollWidth).toBeLessThanOrEqual(editorModal!.clientWidth + 1);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
  expect(document.body.scrollWidth).toBeLessThanOrEqual(document.body.clientWidth + 1);
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
  vi.mocked(fetchWorkflowPromptOverrides).mockResolvedValue({ stored: {}, effective: {}, defaults: {} });
  vi.mocked(updateWorkflowPromptOverrides).mockResolvedValue({ stored: {}, effective: {}, defaults: {} });
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

// FNXC:WorkflowOptionalGroup 2026-06-21-18:00: `v2DefWithOptional` and its
// optional-step DECLARATION hydration/save test are removed — the declaration
// authoring panel is retired (optional-group nodes now).

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
    name: "PR lifecycle",
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
    if (isVisualOnlyWorkflowEdge(edge) && edge.data?.boundary === "entry") {
      expect(edge.sourceHandle, `${definition.id} edge ${edge.id} source handle`).toBe("template-boundary-entry");
      expect(edge.targetHandle, `${definition.id} edge ${edge.id} target handle`).toBeUndefined();
    } else if (isVisualOnlyWorkflowEdge(edge) && edge.data?.boundary === "exit") {
      expect(edge.sourceHandle, `${definition.id} edge ${edge.id} source handle`).toBeUndefined();
      expect(edge.targetHandle, `${definition.id} edge ${edge.id} target handle`).toBe("template-boundary-exit");
    } else {
      expect(edge.sourceHandle, `${definition.id} edge ${edge.id} source handle`).toBeUndefined();
      expect(edge.targetHandle, `${definition.id} edge ${edge.id} target handle`).toBeUndefined();
    }
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

function thinkingModelDef(): WorkflowDefinition {
  return {
    id: "WF-THINKING",
    kind: "workflow",
    name: "Thinking workflow",
    description: "",
    ir: {
      version: "v2",
      name: "Thinking workflow",
      columns: [
        { id: "triage", name: "Triage", traits: [{ trait: "intake" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "triage" },
        { id: "model", kind: "prompt", column: "triage", config: { name: "Model node", executor: "model", prompt: "run" } },
        { id: "review", kind: "step-review", column: "triage", config: { type: "code", thinkingLevel: "low" } },
        { id: "script", kind: "script", column: "triage", config: { scriptName: "lint" } },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "model" },
        { from: "model", to: "review" },
        { from: "review", to: "script", condition: "outcome:approve" },
        { from: "review", to: "model", condition: "outcome:revise", kind: "rework" },
        { from: "script", to: "end" },
      ],
    },
    layout: { start: { x: 0, y: 20 }, model: { x: 120, y: 60 }, review: { x: 240, y: 120 }, script: { x: 360, y: 180 }, end: { x: 480, y: 240 } },
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
    // FNXC:WorkflowOptionalGroup 2026-06-21-15:30: the coding built-in's pre-merge `workflow-step` seam was migrated to a `browser-verification` optional-group (U6), which now carries the failure->end edge in its place.
    // FNXC:CodeReviewStep 2026-06-25-00:00: the default-on `code-review` optional-group is also on the pre-merge success path with its own failure->end edge (see builtin-code-review-group.test.ts), so it is an expected failure->end source too. This corrected a stale assertion that predated the code-review group's addition.
    // FNXC:WorkflowPlanReview 2026-06-29-23:18: FN-7265 removed the coding workflow's duplicate plan-review gate; Plan Review failures route through the plan-replan optional remediation loop instead of directly to end, so this renderability guard tracks the remaining failure-to-end sources without expecting a stale `plan-review` edge.
    expect(failuresToEnd.map((edge) => edge.source).sort()).toEqual([
      "execute",
      "merge-attempt",
      "planning",
      "review",
    ]);
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "browser-verification", target: "browser-verification-remediation" }),
      expect.objectContaining({ source: "code-review", target: "code-review-remediation" }),
      expect.objectContaining({ source: "browser-verification-remediation", target: "browser-verification" }),
      expect.objectContaining({ source: "code-review-remediation", target: "code-review" }),
    ]));
    expect(new Set(failuresToEnd.map((edge) => edge.id)).size).toBe(failuresToEnd.length);
    expect(failuresToEnd.every((edge) => edge.interactionWidth === WF_EDGE_INTERACTION_WIDTH)).toBe(true);
  });
});

/*
FNXC:WorkflowSimpleView 2026-07-10-12:00:
The editor now defaults to the simplified view ("simple"); this legacy suite
was authored against the advanced canvas and the row-list (old "simple
editor") behaviors, so it pins the persisted view-mode keys per test. The
simplified view has its own dedicated suite below ("simplified view modes").
*/
beforeEach(() => {
  localStorage.setItem("fusion:wf-editor-view-mode", "advanced");
  localStorage.setItem("fusion:wf-mobile-graph-style", "list");
});

afterEach(() => {
  localStorage.removeItem("fusion:wf-editor-view-mode");
  localStorage.removeItem("fusion:wf-mobile-graph-style");
});

describe("WorkflowNodeEditor", () => {
  beforeEach(() => {
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
  });

  afterEach(() => {
    localStorage.removeItem("fusion:wf-left-sidebar-collapsed");
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

  it("renders workflow lifecycle warnings returned by the store", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([
      {
        ...v2Def(),
        lifecycleWarnings: [
          {
            code: "missing-merge-region",
            message: "Full task workflows should include a merge region so done is backed by merge proof.",
          },
          {
            code: "optional-group-after-execution",
            nodeId: "plan-review",
            message: "Plan Review should be ordered before parse/execution.",
          },
        ],
      },
    ]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    // FNXC:WorkflowEditor 2026-07-12-10:30: banner is a collapsed-by-default
    // disclosure: a count summary line, with details revealed on expand.
    const banner = await screen.findByTestId("wf-lifecycle-warnings");
    expect(banner).toHaveTextContent("2 lifecycle warnings");
    expect(banner).not.toHaveAttribute("open");
    fireEvent.click(screen.getByTestId("wf-lifecycle-warnings-toggle"));
    expect(banner).toHaveAttribute("open");
    expect(banner).toHaveTextContent("missing-merge-region");
    expect(banner).toHaveTextContent("optional-group-after-execution");
    expect(banner).toHaveTextContent("plan-review");
  });

  it("lets desktop users collapse and restore the workflow sidebar", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    expect(await screen.findByTestId("wf-workflow-name")).toHaveTextContent("QA");
    const body = screen.getByTestId("wf-new-workflow").closest(".wf-editor-body");
    expect(body).not.toBeNull();
    expect(body!).not.toHaveClass("wf-editor-body--sidebar-collapsed");
    expect(screen.queryByTestId("wf-sidebar-restore")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("wf-sidebar-collapse"));

    expect(body!).toHaveClass("wf-editor-body--sidebar-collapsed");
    const restoreButton = screen.getByTestId("wf-sidebar-restore");
    expect(restoreButton).toHaveAccessibleName("Show workflow sidebar");
    expect(restoreButton).toHaveTextContent("");
    expect(screen.getByTestId("wf-workflow-name").previousElementSibling).toBe(restoreButton);

    fireEvent.click(screen.getByTestId("wf-sidebar-restore"));

    expect(body!).not.toHaveClass("wf-editor-body--sidebar-collapsed");
    expect(screen.queryByTestId("wf-sidebar-restore")).not.toBeInTheDocument();
  });

  it("lets users collapse and restore the workflow mini map", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    expect(await screen.findByTestId("wf-workflow-name")).toHaveTextContent("QA");
    const toggle = await screen.findByTestId("wf-minimap-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("Hide mini map");
    expect(document.body.querySelector(".react-flow__minimap")).toBeTruthy();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("Show mini map");
    expect(document.body.querySelector(".react-flow__minimap")).toBeNull();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("Hide mini map");
    expect(document.body.querySelector(".react-flow__minimap")).toBeTruthy();
  });

  it("lets desktop users switch to the list layout and back", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    expect(await screen.findByTestId("wf-workflow-name")).toHaveTextContent("QA");
    expect(screen.queryByTestId("wf-mobile-shell")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("wf-view-mode-list"));

    expect(await screen.findByTestId("wf-mobile-shell")).toBeInTheDocument();
    expect(screen.getByTestId("wf-mobile-tab-graph")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "start start" })).toBeInTheDocument();
    expect(screen.getByTestId("wf-view-mode-list")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByTestId("wf-view-mode-advanced"));

    await waitFor(() => expect(screen.queryByTestId("wf-mobile-shell")).not.toBeInTheDocument());
    expect(screen.getByTestId("wf-view-mode-advanced")).toHaveAttribute("aria-pressed", "true");
  });

  it("surfaces the full styled simple-editor affordance set at desktop width", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    expect(await screen.findByTestId("wf-workflow-name")).toHaveTextContent("QA");
    fireEvent.click(screen.getByTestId("wf-view-mode-list"));

    const shell = await screen.findByTestId("wf-mobile-shell");
    for (const panel of ["graph", "add", "settings", "fields", "columns", "actions"]) {
      expect(within(shell).getByTestId(`wf-mobile-tab-${panel}`)).toBeInTheDocument();
    }
    assertSimpleEditorTabScrollOwner(shell, 1024);

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

  it("renders automatic mobile simple layout with the tab strip as scroll owner", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "QA" }));

    const shell = await screen.findByTestId("wf-mobile-shell");
    expect(screen.queryByTestId("wf-view-mode-toggle")).not.toBeInTheDocument();
    assertSimpleEditorTabScrollOwner(shell, 375);
  });

  it("creates a condition-capable edge from the mobile simple graph without the canvas", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "QA" }));
    await screen.findByText("Save");
    const shell = await screen.findByTestId("wf-mobile-shell");
    assertSimpleEditorTabScrollOwner(shell, 375);
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
    fireEvent.click(screen.getByTestId("wf-view-mode-list"));
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
    fireEvent.click(screen.getByTestId("wf-view-mode-list"));
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
    fireEvent.click(screen.getByTestId("wf-view-mode-list"));
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

  it("routes modal sizing through FloatingWindow without stale overlay or native resize shells", () => {
    const css = readFileSync("app/components/WorkflowNodeEditor.css", "utf8");
    const modalBlock = css.match(/\.wf-editor-modal \{[\s\S]*?\n\}/)?.[0] ?? "";
    const mobileBlock = css.slice(css.indexOf("@media (max-width: 768px)"));

    expect(modalBlock).toContain("width: 100%;");
    expect(modalBlock).toContain("height: 100%;");
    expect(modalBlock).toContain("resize: none;");
    expect(modalBlock).not.toContain("resize: both");
    expect(css).toContain(".floating-window--workflow-editor .floating-window__body");
    expect(mobileBlock).toContain(".floating-window--workflow-editor");
    expect(mobileBlock).toContain(".floating-window--workflow-editor .floating-window__resize-handle");
    expect(mobileBlock).toContain("display: none;");
    expect(mobileBlock).not.toContain(".modal-overlay:has(.wf-editor-modal");
  });

  it("lets tablet users switch to the simple graph layout", async () => {
    mockWorkflowEditorViewport("tablet");
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    expect(await screen.findByTestId("wf-workflow-name")).toHaveTextContent("QA");
    fireEvent.click(screen.getByTestId("wf-view-mode-list"));

    const shell = await screen.findByTestId("wf-mobile-shell");
    expect(screen.getByTestId("wf-mobile-tab-actions")).toBeInTheDocument();
    assertSimpleEditorTabScrollOwner(shell, 834);
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

  it("opens the selected workflow from a real dropdown edit button into the floating modal", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def(), v2Def()]);
    const switcherWorkflows: BoardWorkflowDefinition[] = [
      { id: "WF-001", name: "QA", columns: [] },
      { id: "WF-002", name: "Custom", columns: [] },
    ];

    function DropdownEditHarness() {
      const [editorWorkflowId, setEditorWorkflowId] = useState<string | undefined>();
      const [editorOpen, setEditorOpen] = useState(false);
      return (
        <>
          <WorkflowSwitcher
            workflows={switcherWorkflows}
            value="WF-001"
            onChange={() => {}}
            counts={new Map()}
            onEditWorkflow={(workflowId) => {
              setEditorWorkflowId(workflowId);
              setEditorOpen(true);
            }}
          />
          <WorkflowNodeEditor
            isOpen={editorOpen}
            onClose={() => setEditorOpen(false)}
            addToast={() => {}}
            initialWorkflowId={editorWorkflowId}
          />
        </>
      );
    }

    render(<DropdownEditHarness />);
    fireEvent.click(screen.getByTestId("workflow-switcher"));
    fireEvent.click(await screen.findByTestId("workflow-switcher-edit-WF-002"));

    expect(await screen.findByTestId("wf-workflow-name")).toHaveTextContent("Custom");
    expect(screen.getByTestId("floating-window-workflow-node-editor")).toBeInTheDocument();
    expect(screen.getByTestId("floating-window-resize-se")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Custom" })[0]).toHaveClass("active");
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

  it("opens node details from the desktop compact simple editor row click", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await screen.findByText("Save");
    fireEvent.click(screen.getByTestId("wf-view-mode-list"));
    const lintRow = await screen.findByTestId("mobile-wf-node-lint");
    fireEvent.click(within(lintRow).getAllByRole("button")[0]);

    const inspector = await screen.findByTestId("wf-node-inspector");
    expect(within(inspector).getByLabelText("Prompt")).toBeInTheDocument();
    expect(inspector.closest(".wf-editor-body")).not.toHaveClass("wf-editor-body--mobile-node-detail");
  });

  it("opens custom and built-in simple editor inspectors while leaving end nodes closed", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def(), builtinDef()]);
    vi.mocked(fetchWorkflowPromptOverrides).mockResolvedValue({
      stored: {},
      effective: { execute: "Default execute prompt" },
      defaults: { execute: "Default execute prompt" },
    });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await screen.findByText("Save");
    fireEvent.click(screen.getByTestId("wf-view-mode-list"));
    fireEvent.click(within(await screen.findByTestId("mobile-wf-node-start")).getAllByRole("button")[0]);

    const startInspector = await screen.findByTestId("wf-node-inspector");
    expect(within(startInspector).getByTestId("wf-start-inspector")).toBeInTheDocument();
    expect(within(startInspector).queryByLabelText("Name")).not.toBeInTheDocument();

    fireEvent.click(within(await screen.findByTestId("mobile-wf-node-end")).getAllByRole("button")[0]);
    await waitFor(() => expect(screen.queryByTestId("wf-node-inspector")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Default coding workflow" }));
    await screen.findByTestId("wf-readonly-banner");
    fireEvent.click(within((await screen.findAllByTestId("mobile-wf-node-execute"))[0]).getAllByRole("button")[0]);

    const builtinInspector = await screen.findByTestId("wf-node-inspector");
    const prompt = within(builtinInspector).getByLabelText("Prompt") as HTMLTextAreaElement;
    expect(prompt).not.toHaveAttribute("readonly");
    expect(prompt).toHaveValue("Default execute prompt");
    expect(within(builtinInspector).getByText(/structure is read-only/i)).toBeInTheDocument();
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

    const reopenedInspector = await screen.findByTestId("wf-node-inspector");
    expect(reopenedInspector.closest(".wf-editor-body")).toHaveClass("wf-editor-body--mobile-node-detail");
    expect(screen.getByTestId("wf-inspector-toggle")).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByTestId("wf-inspector-toggle"));
    await waitFor(() => expect(screen.queryByTestId("wf-node-inspector")).not.toBeInTheDocument());
    fireEvent.click(within(await screen.findByTestId("mobile-wf-node-merge")).getAllByRole("button")[0]);

    const nextInspector = await screen.findByTestId("wf-node-inspector");
    expect(within(nextInspector).getByLabelText("Name")).toBeInTheDocument();
    expect(nextInspector.closest(".wf-editor-body")).toHaveClass("wf-editor-body--mobile-node-detail");
  });

  it("edits the start node entry column from the desktop inspector and saves it", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({
      ...v2Def(),
      ...(updates as object),
    }));

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

  // FNXC:WorkflowEditor 2026-06-21-10:00: Every node's detail pane carries a Help section describing what it does and its inputs/outputs/edges.
  it("renders a Help section in the node detail pane", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await screen.findByText("Save");
    fireEvent.click(await screen.findByTestId("wf-node-start"));

    const inspector = await screen.findByTestId("wf-node-inspector");
    const help = within(inspector).getByTestId("wf-node-help");
    expect(help).toHaveTextContent("What does this node do?");
    expect(help).toHaveTextContent("Inputs");
    expect(help).toHaveTextContent("Outputs");
    expect(help).toHaveTextContent("Edges");
    // Editor (non-policy) nodes are not flagged engine-managed.
    expect(within(inspector).queryByTestId("wf-node-help-engine-managed")).not.toBeInTheDocument();
  });

  it("keeps built-in start node entry-column controls read-only", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await screen.findByTestId("wf-readonly-banner");
    fireEvent.click(await screen.findByTestId("wf-node-start"));

    const inspector = await screen.findByTestId("wf-node-inspector");
    expect(within(inspector).getByText(/structure is read-only/i)).toBeInTheDocument();
    expect(within(inspector).getByTestId("wf-start-entry-column")).toBeDisabled();
  });

  it("edits and resets built-in prompt overrides from the node inspector", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);
    vi.mocked(fetchWorkflowPromptOverrides).mockResolvedValue({
      stored: {},
      effective: { execute: "Default execute prompt" },
      defaults: { execute: "Default execute prompt" },
    });
    vi.mocked(updateWorkflowPromptOverrides)
      .mockResolvedValueOnce({
        stored: { execute: "Custom execute prompt" },
        effective: { execute: "Custom execute prompt" },
        defaults: { execute: "Default execute prompt" },
      })
      .mockResolvedValueOnce({
        stored: {},
        effective: { execute: "Default execute prompt" },
        defaults: { execute: "Default execute prompt" },
      });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await selectBuiltinExecutePromptNode();
    const inspector = await screen.findByTestId("wf-node-inspector");
    const prompt = within(inspector).getByLabelText("Prompt") as HTMLTextAreaElement;
    expect(prompt).not.toHaveAttribute("readonly");
    expect(within(inspector).getByRole("button", { name: "Reset to default" })).toBeDisabled();

    fireEvent.change(prompt, { target: { value: "Custom execute prompt" } });
    fireEvent.blur(prompt);

    await waitFor(() =>
      expect(updateWorkflowPromptOverrides).toHaveBeenCalledWith("builtin:coding", { execute: "Custom execute prompt" }, undefined),
    );
    expect(await within(inspector).findByTestId("wf-prompt-overridden")).toHaveTextContent("Overridden");
    const reset = within(inspector).getByRole("button", { name: "Reset to default" });
    expect(reset).not.toBeDisabled();

    fireEvent.click(reset);
    await waitFor(() =>
      expect(updateWorkflowPromptOverrides).toHaveBeenLastCalledWith("builtin:coding", { execute: null }, undefined),
    );
    await waitFor(() => expect(prompt).toHaveValue("Default execute prompt"));
  });

  it("edits gate prompts and shows reset controls in mobile built-in panels", async () => {
    mockWorkflowEditorViewport("mobile");
    const gateWorkflow: WorkflowDefinition = {
      ...builtinDef(),
      ir: {
        version: "v2",
        name: "Gate built-in",
        columns: [],
        nodes: [
          { id: "start", kind: "start" },
          { id: "security", kind: "gate", config: { prompt: "Default security prompt" } },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "security", condition: "success" },
          { from: "security", to: "end", condition: "success" },
        ],
      },
      layout: {},
    };
    vi.mocked(fetchWorkflows).mockResolvedValue([gateWorkflow]);
    vi.mocked(fetchWorkflowPromptOverrides).mockResolvedValue({
      stored: { security: "Custom security prompt" },
      effective: { security: "Custom security prompt" },
      defaults: { security: "Default security prompt" },
    });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Default coding workflow" }));
    fireEvent.click(within(await screen.findByTestId("mobile-wf-node-security")).getAllByRole("button")[0]);

    const inspector = await screen.findByTestId("wf-node-inspector");
    const prompt = within(inspector).getByLabelText("Prompt") as HTMLTextAreaElement;
    expect(prompt).not.toHaveAttribute("readonly");
    expect(prompt).toHaveValue("Custom security prompt");
    expect(within(inspector).getByTestId("wf-prompt-overridden")).toHaveTextContent("Overridden");
    expect(within(inspector).getByRole("button", { name: "Reset to default" })).not.toBeDisabled();
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

  it("wires thinking controls only on workflow model pickers and persists clear semantics", async () => {
    const source = thinkingModelDef();
    vi.mocked(fetchWorkflows).mockResolvedValue([source]);
    vi.mocked(fetchModels).mockResolvedValue({ models: [{ provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" }] });
    vi.mocked(fetchSettings).mockResolvedValue({ defaultThinkingLevel: "medium" } as Settings);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({ ...source, ...(updates as object) }));

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await screen.findByText("Save");
    fireEvent.click(screen.getByTestId("wf-view-mode-list"));

    fireEvent.click(within(await screen.findByTestId("mobile-wf-node-model")).getAllByRole("button")[0]);
    let inspector = await screen.findByTestId("wf-node-inspector");
    expect(within(inspector).getByTestId("custom-model-dropdown-thinking-badge")).toHaveTextContent("Default (medium)");
    fireEvent.click(within(inspector).getByRole("button", { name: "Model" }));
    await screen.findByTestId("custom-model-dropdown-thinking");
    fireEvent.change(screen.getAllByTestId("custom-model-dropdown-thinking").at(-1)!, { target: { value: "high" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    let saved = vi.mocked(updateWorkflow).mock.calls.at(-1)?.[1] as { ir?: WorkflowDefinition["ir"] };
    expect(saved.ir?.nodes.find((node) => node.id === "model")?.config?.thinkingLevel).toBe("high");

    fireEvent.click(within(await screen.findByTestId("mobile-wf-node-review")).getAllByRole("button")[0]);
    inspector = await screen.findByTestId("wf-node-inspector");
    expect(within(inspector).getByTestId("custom-model-dropdown-thinking-badge")).toHaveTextContent("Low");
    fireEvent.click(within(inspector).getByRole("button", { name: "Review model (optional)" }));
    await screen.findByTestId("custom-model-dropdown-thinking");
    fireEvent.change(screen.getAllByTestId("custom-model-dropdown-thinking").at(-1)!, { target: { value: "" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalledTimes(2));
    saved = vi.mocked(updateWorkflow).mock.calls.at(-1)?.[1] as { ir?: WorkflowDefinition["ir"] };
    expect(saved.ir?.nodes.find((node) => node.id === "review")?.config).not.toHaveProperty("thinkingLevel");

    fireEvent.click(within(await screen.findByTestId("mobile-wf-node-script")).getAllByRole("button")[0]);
    inspector = await screen.findByTestId("wf-node-inspector");
    expect(within(inspector).queryByTestId("custom-model-dropdown-thinking-badge")).not.toBeInTheDocument();
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

  it("edits and resets built-in prompt overrides in the fullscreen editor", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);
    vi.mocked(fetchWorkflowPromptOverrides).mockResolvedValue({
      stored: { execute: "Existing execute override" },
      effective: { execute: "Existing execute override" },
      defaults: { execute: "Default execute prompt" },
    });
    vi.mocked(updateWorkflowPromptOverrides)
      .mockResolvedValueOnce({
        stored: { execute: "Fullscreen execute override" },
        effective: { execute: "Fullscreen execute override" },
        defaults: { execute: "Default execute prompt" },
      })
      .mockResolvedValueOnce({
        stored: {},
        effective: { execute: "Default execute prompt" },
        defaults: { execute: "Default execute prompt" },
      });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await selectBuiltinExecutePromptNode();
    fireEvent.click(await screen.findByRole("button", { name: "Expand prompt editor" }));

    const fullscreenPromptEditor = getPromptFullscreenOverlay();
    expect(fullscreenPromptEditor).toBeInTheDocument();
    const textarea = getPromptFullscreenTextarea();
    expect(textarea).not.toHaveAttribute("readonly");
    expect(textarea).toHaveValue("Existing execute override");
    expect(within(fullscreenPromptEditor!).getByTestId("wf-prompt-overridden")).toHaveTextContent("Overridden");

    fireEvent.change(textarea, { target: { value: "Fullscreen execute override" } });
    fireEvent.blur(textarea);
    await waitFor(() =>
      expect(updateWorkflowPromptOverrides).toHaveBeenCalledWith("builtin:coding", { execute: "Fullscreen execute override" }, undefined),
    );

    fireEvent.click(within(fullscreenPromptEditor!).getByRole("button", { name: "Reset to default" }));
    await waitFor(() =>
      expect(updateWorkflowPromptOverrides).toHaveBeenLastCalledWith("builtin:coding", { execute: null }, undefined),
    );
    await waitFor(() => expect(textarea).toHaveValue("Default execute prompt"));
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

// FNXC:EmbeddedPresentation 2026-06-22-12:00:
// presentation="embedded" was a zero-coverage branch. These assert the embedded contract via useEmbeddedPresentation:
// no fixed floating/overlay chrome, Escape does NOT dismiss (escapeEnabled is false), and the embedded root class renders.
describe("WorkflowNodeEditor — embedded presentation", () => {
  beforeEach(() => {
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the embedded root class and no modal overlay", async () => {
    const { container } = render(
      <WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} presentation="embedded" />,
    );

    expect(await screen.findByText("Workflows")).toBeInTheDocument();
    expect(container.querySelector(".workflow-editor-embedded")).not.toBeNull();
    expect(container.querySelector(".wf-editor-modal--embedded")).not.toBeNull();
    // No fixed full-screen overlay host or floating-window chrome in embedded mode.
    expect(container.querySelector(".modal-overlay")).toBeNull();
    expect(container.querySelector(".wf-editor-overlay")).toBeNull();
    expect(document.body.querySelector(".floating-window--workflow-editor")).toBeNull();
    expect(document.body.querySelector(".floating-window__resize-handle")).toBeNull();
  });

  it("does not dismiss on Escape in embedded mode", async () => {
    const onClose = vi.fn();
    const { container } = render(
      <WorkflowNodeEditor isOpen onClose={onClose} addToast={() => {}} presentation="embedded" />,
    );

    expect(await screen.findByText("Workflows")).toBeInTheDocument();
    // Escape is handled on the modal element (onKeyDown), so fire it there — not on document.
    const embeddedModal = container.querySelector(".wf-editor-modal--embedded")!;
    fireEvent.keyDown(embeddedModal, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("uses FloatingWindow chrome and Escape-to-close in modal mode", async () => {
    const onClose = vi.fn();
    render(<WorkflowNodeEditor isOpen onClose={onClose} addToast={() => {}} />);

    expect(await screen.findByText("Workflows")).toBeInTheDocument();
    const floating = document.body.querySelector(".floating-window--workflow-editor") as HTMLElement | null;
    expect(floating).not.toBeNull();
    expect(screen.getByTestId("floating-window-workflow-node-editor")).toBe(floating);
    expect(screen.getByTestId("floating-window-overlay-workflow-node-editor")).toHaveAttribute("aria-modal", "false");
    expect(document.body.querySelector(".wf-editor-overlay")).toBeNull();
    expect(document.body.querySelector(".modal-overlay .wf-editor-modal")).toBeNull();
    expect(document.body.querySelector(".wf-editor-modal--embedded")).toBeNull();
    expect(document.body.querySelectorAll(".wf-editor-close")).toHaveLength(1);
    expect(screen.getByTestId("floating-window-resize-se")).toBeInTheDocument();
    expect(screen.queryByTestId("floating-window-drag-handle-workflow-node-editor")).not.toBeInTheDocument();
    expect(floating!.querySelector(".wf-editor-header")).not.toBeNull();
    // Modal-mode Escape is handled on the modal element (onKeyDown), not document.
    const modal = floating!.querySelector(".wf-editor-modal")!;
    fireEvent.keyDown(modal, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
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
    const banner = await screen.findByTestId("wf-readonly-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent("Workflow structure is read-only; prompts are editable.");
    expect(banner).not.toHaveTextContent(/built-in/i);
    expect(banner.querySelector(".workflow-icon--builtin")).toBeInTheDocument();
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
    render(
      <WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />,
    );
    await screen.findByTestId("wf-node-start");
    // React Flow positions step nodes via a translate transform on their wrapper.
    const wrapperFor = (id: string) =>
      document.body.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
    // After load, the step node should have been auto-laid-out (positioned).
    await waitFor(() => {
      const transform = wrapperFor("step")?.style.transform ?? "";
      expect(transform).not.toBe("");
    });
  });

  it("starts the canvas viewport at the top-left on first open", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    render(
      <WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />,
    );

    await screen.findByTestId("wf-node-start");

    await waitFor(() => {
      const viewport = document.body.querySelector<HTMLElement>(".react-flow__viewport");
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

/** A v2 workflow with an optional-group container (defaultOn:false) holding one
 *  template child, so the editor's optional-group surfaces have something to
 *  render, toggle, and delete. */
function optionalGroupDef(): WorkflowDefinition {
  return {
    id: "WF-OPT",
    kind: "workflow",
    name: "Optional",
    description: "",
    ir: {
      version: "v2",
      name: "Optional",
      columns: [
        { id: "plan", name: "Plan", traits: [{ trait: "intake" }] },
        { id: "in-progress", name: "In progress", traits: [] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "plan" },
        {
          id: "opt",
          kind: "optional-group",
          column: "in-progress",
          config: {
            defaultOn: false,
            name: "Browser verification",
            template: {
              nodes: [{ id: "verify", kind: "prompt", config: { prompt: "verify in browser" } }],
              edges: [],
            },
          },
        },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "opt", condition: "success" },
        { from: "opt", to: "end", condition: "success" },
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

  // FNXC:WorkflowOptionalGroup 2026-06-21-11:30: An optional-group must be
  // authorable like a foreach/loop — added from the palette as a registered group
  // container (not react-flow__node-default), filled with nodes, named, toggled
  // for defaultOn, and deleted with its children cascaded.
  it("adds an optional-group from the palette and round-trips its template on save", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({ ...v2Def(), ...(updates as object) }));

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByText("Save");
    expect(await screen.findByTestId("wf-column-panel")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Optional group").closest("button")!);
    // Renders via the registered group component (wf-node-optional-group), NOT
    // React Flow's default fallback.
    await waitFor(() => expect(screen.getByTestId("wf-node-optional-group")).toBeInTheDocument(), { timeout: 5000 });
    // No empty hint — the palette seeded an optional step inside.
    expect(screen.queryByTestId("wf-optional-group-empty")).not.toBeInTheDocument();

    const seededChildId = await waitFor(() => {
      const childIds = [...document.querySelectorAll<HTMLElement>(".react-flow__node")]
        .map((node) => node.dataset.id)
        .filter((nodeId): nodeId is string => Boolean(nodeId?.includes("::")));
      expect(childIds).toHaveLength(1);
      return childIds[0];
    });
    const seededGroupId = seededChildId.split("::")[0];
    /*
     * FNXC:WorkflowOptionalGroup 2026-06-29-23:56:
     * Newly authored optional groups must render the same generated entry/exit guide anchors as loaded IR. This catches the palette/mobile add path that previously inserted a parent and child with no immediate boundary refresh, leaving the seeded child visually disconnected until a later save/reload recomputed editor-only boundary state.
     */
    await waitFor(() => {
      expect(
        document.body.querySelector(`.react-flow__handle.source[data-nodeid="${seededGroupId}"][data-handleid="template-boundary-entry"]`),
      ).toBeInTheDocument();
      expect(
        document.body.querySelector(`.react-flow__handle.target[data-nodeid="${seededGroupId}"][data-handleid="template-boundary-exit"]`),
      ).toBeInTheDocument();
      expect(document.body.querySelector(`.react-flow__handle.target[data-nodeid="${seededChildId}"][data-handlepos="left"]`)).toBeInTheDocument();
      expect(document.body.querySelector(`.react-flow__handle.source[data-nodeid="${seededChildId}"][data-handlepos="right"]`)).toBeInTheDocument();
    });

    await waitFor(() => expect(screen.getAllByLabelText(/Column name/i).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("Save").closest("button")!);
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    const [, updates] = vi.mocked(updateWorkflow).mock.calls[0];
    const ir = (updates as { ir: { nodes: { id: string; kind: string; config?: Record<string, unknown> }[] } }).ir;
    const group = ir.nodes.find((n) => n.kind === "optional-group");
    expect(group).toBeTruthy();
    const template = group!.config!.template as { nodes: unknown[] };
    expect(template.nodes).toHaveLength(1);
  });

  it("edits optional-group maxRevisions and unbounded revision mode", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([optionalGroupDef()]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({ ...optionalGroupDef(), ...(updates as object) }));

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByText("Save");
    fireEvent.click(await screen.findByTestId("wf-node-optional-group"));

    const maxInput = await screen.findByTestId("wf-optional-group-max-revisions") as HTMLInputElement;
    const unbounded = await screen.findByTestId("wf-optional-group-max-revisions-unbounded") as HTMLInputElement;
    expect(maxInput.disabled).toBe(false);
    expect(unbounded.checked).toBe(false);

    fireEvent.change(maxInput, { target: { value: "2" } });
    fireEvent.click(screen.getByText("Save").closest("button")!);
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalledTimes(1));
    let [, updates] = vi.mocked(updateWorkflow).mock.calls[0];
    let ir = (updates as { ir: { nodes: { kind: string; config?: Record<string, unknown> }[] } }).ir;
    let opt = ir.nodes.find((n) => n.kind === "optional-group");
    expect(opt!.config!.maxRevisions).toBe(2);
  });

  it("persists optional-group unbounded maxRevisions mode", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([optionalGroupDef()]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({ ...optionalGroupDef(), ...(updates as object) }));

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByText("Save");
    fireEvent.click(await screen.findByTestId("wf-node-optional-group"));

    const unbounded = await screen.findByTestId("wf-optional-group-max-revisions-unbounded") as HTMLInputElement;
    fireEvent.click(unbounded);
    expect(unbounded.checked).toBe(true);
    await waitFor(() => expect((screen.getByTestId("wf-optional-group-max-revisions") as HTMLInputElement).disabled).toBe(true));
    fireEvent.click(screen.getByText("Save").closest("button")!);

    await waitFor(() => expect(updateWorkflow).toHaveBeenCalledTimes(1));
    const [, updates] = vi.mocked(updateWorkflow).mock.calls[0];
    const ir = (updates as { ir: { nodes: { kind: string; config?: Record<string, unknown> }[] } }).ir;
    const opt = ir.nodes.find((n) => n.kind === "optional-group");
    expect(opt!.config!.maxRevisions).toBe("unbounded");
  });

  it("clears optional-group maxRevisions by deleting the config key", async () => {
    const def = optionalGroupDef();
    const opt = def.ir.nodes.find((node) => node.kind === "optional-group")!;
    opt.config = { ...opt.config, maxRevisions: 2 };
    vi.mocked(fetchWorkflows).mockResolvedValue([def]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({ ...def, ...(updates as object) }));

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByText("Save");
    fireEvent.click(await screen.findByTestId("wf-node-optional-group"));

    const maxInput = await screen.findByTestId("wf-optional-group-max-revisions") as HTMLInputElement;
    expect(maxInput.value).toBe("2");
    fireEvent.change(maxInput, { target: { value: "" } });
    fireEvent.click(screen.getByText("Save").closest("button")!);

    await waitFor(() => expect(updateWorkflow).toHaveBeenCalledTimes(1));
    const [, updates] = vi.mocked(updateWorkflow).mock.calls[0];
    const ir = (updates as { ir: { nodes: { kind: string; config?: Record<string, unknown> }[] } }).ir;
    const saved = ir.nodes.find((node) => node.kind === "optional-group")!;
    expect(saved.config!).not.toHaveProperty("maxRevisions");
  });

  it("renders optional-group maxRevisions controls in the mobile inspector", async () => {
    mockWorkflowEditorViewport("mobile");
    vi.mocked(fetchWorkflows).mockResolvedValue([optionalGroupDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Optional" }));
    const optRow = await screen.findByTestId("mobile-wf-node-opt");
    fireEvent.click(within(optRow).getAllByRole("button")[0]);

    expect(await screen.findByTestId("wf-optional-group-max-revisions")).toBeInTheDocument();
    expect(await screen.findByTestId("wf-optional-group-max-revisions-unbounded")).toBeInTheDocument();
  });

  it("does not render optional-group maxRevisions controls for non-optional nodes", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([optionalGroupDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByText("Save");
    const promptNode = await waitFor(() => {
      const node = document.querySelector(`.react-flow__node[data-id="${foreachChildFlowId("opt", "verify")}"]`);
      expect(node).toBeInTheDocument();
      return node as HTMLElement;
    });
    fireEvent.click(promptNode);
    expect(screen.queryByTestId("wf-optional-group-max-revisions")).not.toBeInTheDocument();
    expect(screen.queryByTestId("wf-optional-group-max-revisions-unbounded")).not.toBeInTheDocument();
  });

  it("toggles optional-group defaultOn, marks the editor dirty, and persists on save", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([optionalGroupDef()]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({ ...optionalGroupDef(), ...(updates as object) }));

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByText("Save");
    const group = await screen.findByTestId("wf-node-optional-group");
    fireEvent.click(group);

    const toggle = await screen.findByTestId("wf-optional-group-default-on");
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    expect((toggle as HTMLInputElement).checked).toBe(true);

    await waitFor(() => expect(screen.getAllByLabelText(/Column name/i).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("Save").closest("button")!);
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    const [, updates] = vi.mocked(updateWorkflow).mock.calls[0];
    const ir = (updates as { ir: { nodes: { kind: string; config?: Record<string, unknown> }[] } }).ir;
    const opt = ir.nodes.find((n) => n.kind === "optional-group");
    expect(opt!.config!.defaultOn).toBe(true);
  });

  it("deletes an optional-group and removes its parentId children (no orphans)", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([optionalGroupDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    const group = await screen.findByTestId("wf-node-optional-group");
    // The seeded template child renders as a parented flow node.
    await waitFor(() =>
      expect(
        document.querySelector(`.react-flow__node[data-id="${foreachChildFlowId("opt", "verify")}"]`),
      ).toBeInTheDocument(),
    );
    fireEvent.click(group);
    fireEvent.click(await screen.findByTestId("wf-delete-node"));
    await waitFor(() => expect(screen.queryByTestId("wf-node-optional-group")).not.toBeInTheDocument());
    // The template child is gone too (cascade) — no orphaned parentId node.
    expect(
      document.querySelector(`.react-flow__node[data-id="${foreachChildFlowId("opt", "verify")}"]`),
    ).not.toBeInTheDocument();
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
    name: "Coding (per-step review)",
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
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await screen.findByTestId("wf-readonly-banner");
    await waitFor(() => expect(screen.getAllByTestId("wf-node-hold").length).toBeGreaterThan(0));
    const builtInFlow = irToFlow(builtinPrDef());
    for (const edge of builtInFlow.edges.filter((candidate) => candidate.source === "pr-create")) {
      expect(document.body.querySelector(`.react-flow__handle[data-nodeid="${edge.source}"][data-handlepos="right"]`)).toBeInTheDocument();
      expect(document.body.querySelector(`.react-flow__handle[data-nodeid="${edge.target}"][data-handlepos="left"]`)).toBeInTheDocument();
    }
    expect(builtInFlow.edges.some((edge) => edge.label === "open")).toBe(true);
    expect(builtInFlow.edges.some((edge) => edge.label === "failed")).toBe(true);
    expect(builtInFlow.edges.some((edge) => edge.label === "failure")).toBe(true);

    fireEvent.click(screen.getByText("Custom"));
    await waitFor(() => expect(screen.queryByTestId("wf-readonly-banner")).not.toBeInTheDocument());
    const customFlow = irToFlow(v2Def());
    for (const edge of customFlow.edges) {
      expect(document.body.querySelector(`.react-flow__handle[data-nodeid="${edge.source}"][data-handlepos="right"]`)).toBeInTheDocument();
      expect(document.body.querySelector(`.react-flow__handle[data-nodeid="${edge.target}"][data-handlepos="left"]`)).toBeInTheDocument();
    }
    expect(customFlow.edges.every((edge) => edge.label === "success")).toBe(true);
  });

  it("renders optional-group boundary connector handles for built-in single-child templates", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    await screen.findByTestId("wf-readonly-banner");
    await waitFor(() => expect(screen.getAllByTestId("wf-node-optional-group").length).toBeGreaterThanOrEqual(2));

    const flow = irToFlow(builtinDef());
    const byId = new Map(flow.nodes.map((node) => [node.id, node] as const));
    for (const [groupId, childId] of [
      ["plan-review", "plan-review-step"],
      ["code-review", "code-review-step"],
    ] as const) {
      const childFlowId = `${groupId}::${childId}`;
      expect(byId.get(childFlowId)?.data.optionalGroupBoundary, `${groupId} child boundary`).toEqual({ entry: true, exit: true });

      const boundaryEdges = flow.edges.filter((edge) => isVisualOnlyWorkflowEdge(edge) && (edge.source === groupId || edge.target === groupId));
      expect(boundaryEdges, `${groupId} visual boundary edges`).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: groupId, sourceHandle: "template-boundary-entry", target: childFlowId }),
        expect.objectContaining({ source: childFlowId, target: groupId, targetHandle: "template-boundary-exit" }),
      ]));
      /*
       * FNXC:WorkflowOptionalGroup 2026-06-29-22:47:
       * Built-in Plan Review and Code Review optional blocks each contain one template child. The desktop editor must render both the normal container handles and the side-correct boundary handles used by visual-only connector edges so entry attaches from the left boundary and exit attaches to the right boundary, while persistence still filters those visual-only edges in mapping tests.
       *
       * FNXC:WorkflowOptionalGroup 2026-06-29-23:20:
       * Boundary guide handles remain in the DOM solely as generated edge anchors. They must not carry React Flow's connectable affordance because user-authored edges from optional-boundary-* handles would persist fake group↔child topology.
       */
      for (const [nodeId, position] of [
        [groupId, "left"],
        [groupId, "right"],
        [childFlowId, "left"],
        [childFlowId, "right"],
      ] as const) {
        expect(
          document.body.querySelector(`.react-flow__handle[data-nodeid="${nodeId}"][data-handlepos="${position}"]`),
          `${nodeId} ${position} handle`,
        ).toBeInTheDocument();
      }
      const entryBoundaryHandle = document.body.querySelector(
        `.react-flow__handle.source[data-nodeid="${groupId}"][data-handlepos="left"][data-handleid="template-boundary-entry"]`,
      );
      const exitBoundaryHandle = document.body.querySelector(
        `.react-flow__handle.target[data-nodeid="${groupId}"][data-handlepos="right"][data-handleid="template-boundary-exit"]`,
      );
      expect(entryBoundaryHandle, `${groupId} left boundary source handle`).toBeInTheDocument();
      expect(exitBoundaryHandle, `${groupId} right boundary target handle`).toBeInTheDocument();
      expect(entryBoundaryHandle, `${groupId} left boundary source handle connectability`).not.toHaveClass("connectable");
      expect(exitBoundaryHandle, `${groupId} right boundary target handle connectability`).not.toHaveClass("connectable");
    }
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

// FNXC:WorkflowEditor 2026-07-01-00:00: the U2 interpreter-only banner describe
// block was removed with the linear WorkflowStep compiler. Branching graphs now
// run on the graph interpreter directly; there is no post-save compile check and
// no interpreter-only banner, so there is nothing left to assert here.

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

  it("does not let parent Escape close the floating editor while create dialog is open", async () => {
    const onClose = vi.fn();
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    render(<WorkflowNodeEditor isOpen onClose={onClose} addToast={() => {}} initialAction="create" />);

    expect(await screen.findByTestId("wf-create-dialog")).toBeInTheDocument();
    const modal = document.body.querySelector(".floating-window--workflow-editor .wf-editor-modal")!;
    fireEvent.keyDown(modal, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("wf-create-dialog")).toBeInTheDocument();
  });

  it("creates and activates a workflow on a valid submit", async () => {
    const addToast = vi.fn();
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    vi.mocked(createWorkflow).mockResolvedValue({ ...v2Def(), id: "WF-NEW", name: "Pipeline" });
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={addToast} />);
    fireEvent.click(await screen.findByTestId("wf-new-workflow"));
    fireEvent.change(await screen.findByTestId("wf-create-name"), { target: { value: "Pipeline" } });
    fireEvent.change(screen.getByTestId("wf-create-icon"), { target: { value: "🚀" } });
    fireEvent.click(screen.getByTestId("wf-create-submit"));

    await waitFor(() => expect(createWorkflow).toHaveBeenCalled());
    const [input] = vi.mocked(createWorkflow).mock.calls[0];
    expect((input as { name: string; icon?: string }).name).toBe("Pipeline");
    expect((input as { icon?: string }).icon).toBe("🚀");
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

    // Fusion + user workflow present; fragment excluded.
    expect(screen.getByText("Fusion workflows")).toBeInTheDocument();
    expect(screen.queryByText("Built-in workflows")).not.toBeInTheDocument();
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
    expect((screen.getByTestId("wf-create-icon") as HTMLInputElement).value).toBe("✨");
  });

  it("keeps a typed copy name while defaulting built-in template icons", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    fireEvent.click(await screen.findByTestId("wf-new-workflow"));
    await screen.findByTestId("wf-create-dialog");

    fireEvent.change(screen.getByTestId("wf-create-name"), { target: { value: "My custom pipeline" } });
    fireEvent.click(screen.getByTestId("wf-template-option-builtin:coding"));

    expect((screen.getByTestId("wf-create-name") as HTMLInputElement).value).toBe("My custom pipeline");
    expect((screen.getByTestId("wf-create-description") as HTMLTextAreaElement).value).toBe(
      "Ships with Fusion",
    );
    expect((screen.getByTestId("wf-create-icon") as HTMLInputElement).value).toBe("✨");
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
    const created = input as { name: string; description?: string; icon?: string; kind?: string; ir: { nodes: { id: string }[] } };
    expect(created.kind).toBe("workflow");
    expect(created.description).toBe("Ships with Fusion");
    expect(created.icon).toBe("✨");
    // Same node count as the source IR.
    expect(created.ir.nodes).toHaveLength(builtin.ir.nodes.length);
    // Every node id is fresh (none shared with the source).
    const sourceIds = new Set(builtin.ir.nodes.map((n) => n.id));
    for (const n of created.ir.nodes) {
      expect(sourceIds.has(n.id)).toBe(false);
    }
  });

  it("custom template picker preserves existing custom icons without empty shells", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([{ ...v2Def(), icon: "🧪" }]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    fireEvent.click(await screen.findByTestId("wf-new-workflow"));
    await screen.findByTestId("wf-create-dialog");

    const customOption = screen.getByTestId("wf-template-option-WF-002");
    expect(customOption.querySelector(".workflow-icon--custom")).toHaveTextContent("🧪");
    expect(screen.getByTestId("wf-template-option-blank").querySelector(".workflow-icon")).toBeNull();

    fireEvent.click(customOption);
    expect((screen.getByTestId("wf-create-icon") as HTMLInputElement).value).toBe("🧪");
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

// FNXC:WorkflowStepCRUD 2026-06-26-14:00: U7c removed the "U2 legacy-step migration
// notice" describe block along with the on-open migration trigger and its notice UI.

// ── U5: import/export ───────────────────────────────────────────────────────

describe("WorkflowNodeEditor — U5 import/export", () => {
  beforeEach(() => {
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
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
    expect(within(section).getByText("Fusion steps")).toBeInTheDocument();
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
    // All 8 step entries present pre-filter. Match only the primary "insert as
    // node" buttons, excluding the sibling "-optional-group" insert variant.
    const primaryStep = /^wf-tpl-step-(?!.*-optional-group$).*/;
    expect(screen.getAllByTestId(primaryStep).length).toBe(8);
    // Filter to "Step 3" → only that step survives.
    fireEvent.change(filter, { target: { value: "Step 3" } });
    await waitFor(() => expect(screen.getAllByTestId(primaryStep).length).toBe(1));
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
    expect(within(section).getByText("Fusion steps")).toBeInTheDocument();
    expect(within(section).queryByText("Built-in steps")).not.toBeInTheDocument();
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

  // FNXC:WorkflowOptionalGroup 2026-06-21-14:50: All seven built-in add-ons must
  // surface in the palette and insert two ways — as a single node (today's
  // behavior, reusing stepTemplateToNode) and wrapped in an optional-group
  // container (reusing insertFragment). These tests pin U5/R5.
  it("surfaces all seven built-in add-ons in the palette", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);
    vi.mocked(fetchWorkflowStepTemplates).mockResolvedValue({
      templates: STEP_TEMPLATE_FIXTURES,
    });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByTestId("wf-palette-templates");

    // Every add-on id is present as a primary "insert as node" button AND offers
    // the "as optional group" sibling variant.
    for (const tpl of STEP_TEMPLATE_FIXTURES) {
      expect(screen.getByTestId(`wf-tpl-step-${tpl.id}`)).toBeInTheDocument();
      expect(
        screen.getByTestId(`wf-tpl-step-${tpl.id}-optional-group`),
      ).toBeInTheDocument();
    }
    expect(STEP_TEMPLATE_FIXTURES).toHaveLength(7);
  });

  it("inserts an add-on as a single node carrying its template config", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({ ...def(), ...(updates as object) }));
    vi.mocked(fetchWorkflowStepTemplates).mockResolvedValue({
      templates: STEP_TEMPLATE_FIXTURES,
    });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByTestId("wf-palette-templates");
    await screen.findByTestId("wf-node-gate", undefined, { timeout: 3000 });

    const before = screen.queryAllByTestId("wf-node-prompt").length;
    fireEvent.click(screen.getByTestId("wf-tpl-step-documentation-review"));
    await waitFor(
      () => expect(screen.queryAllByTestId("wf-node-prompt").length).toBe(before + 1),
      { timeout: 3000 },
    );

    fireEvent.click(screen.getByText("Save").closest("button")!);
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    const [, updates] = vi.mocked(updateWorkflow).mock.calls[0];
    const ir = (updates as { ir: { nodes: { kind: string; config?: Record<string, unknown> }[] } }).ir;
    const docTpl = STEP_TEMPLATE_FIXTURES.find((tpl) => tpl.id === "documentation-review")!;
    const inserted = ir.nodes.find((n) => n.config?.name === docTpl.name);
    expect(inserted).toBeTruthy();
    expect(inserted!.kind).toBe(docTpl.mode === "script" ? "script" : "prompt");
  });

  it("inserts an add-on as an optional-group whose template holds the projected node and defaultOn matches", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({ ...def(), ...(updates as object) }));
    vi.mocked(fetchWorkflowStepTemplates).mockResolvedValue({
      templates: STEP_TEMPLATE_FIXTURES,
    });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByTestId("wf-palette-templates");
    await screen.findByTestId("wf-node-gate", undefined, { timeout: 3000 });

    fireEvent.click(screen.getByTestId("wf-tpl-step-security-audit-optional-group"));
    // The wrapped add-on renders as a registered optional-group container.
    await waitFor(
      () => expect(screen.getByTestId("wf-node-optional-group")).toBeInTheDocument(),
      { timeout: 5000 },
    );

    fireEvent.click(screen.getByText("Save").closest("button")!);
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    const [, updates] = vi.mocked(updateWorkflow).mock.calls[0];
    const ir = (updates as { ir: { nodes: { kind: string; config?: Record<string, unknown> }[] } }).ir;
    const secTpl = STEP_TEMPLATE_FIXTURES.find((tpl) => tpl.id === "security-audit")!;
    const group = ir.nodes.find((n) => n.kind === "optional-group");
    expect(group).toBeTruthy();
    expect(group!.config!.defaultOn).toBe(secTpl.defaultOn ?? false);
    const template = group!.config!.template as { nodes: { kind: string; config?: Record<string, unknown> }[] };
    expect(template.nodes).toHaveLength(1);
    expect(template.nodes[0].config?.name).toBe(secTpl.name);
  });

  it("remaps ids when the same add-on subgraph is inserted twice (no collision)", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({ ...def(), ...(updates as object) }));
    vi.mocked(fetchWorkflowStepTemplates).mockResolvedValue({
      templates: STEP_TEMPLATE_FIXTURES,
    });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByTestId("wf-palette-templates");
    await screen.findByTestId("wf-node-gate", undefined, { timeout: 3000 });

    fireEvent.click(screen.getByTestId("wf-tpl-step-security-audit-optional-group"));
    await waitFor(
      () => expect(screen.queryAllByTestId("wf-node-optional-group").length).toBe(1),
      { timeout: 5000 },
    );
    fireEvent.click(screen.getByTestId("wf-tpl-step-security-audit-optional-group"));
    await waitFor(
      () => expect(screen.queryAllByTestId("wf-node-optional-group").length).toBe(2),
      { timeout: 5000 },
    );

    fireEvent.click(screen.getByText("Save").closest("button")!);
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    const [, updates] = vi.mocked(updateWorkflow).mock.calls[0];
    const ir = (updates as { ir: { nodes: { id: string; kind: string }[] } }).ir;
    const groupIds = ir.nodes.filter((n) => n.kind === "optional-group").map((n) => n.id);
    expect(groupIds).toHaveLength(2);
    expect(new Set(groupIds).size).toBe(2);
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
      strippedApprovalFlags: false,
      ...over,
    };
  }

  beforeEach(() => {
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
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

  // FNXC:WorkflowEditor 2026-07-01-00:00: the "interpreterOnly seeds the info
  // banner" test was removed with the linear compiler — branching AI-designed
  // workflows are accepted and run on the graph interpreter with no banner.

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

function settingsWithStaleWorkflowFlags(): Settings {
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
    vi.mocked(fetchSettings).mockResolvedValue(settingsWithStaleWorkflowFlags());
    vi.mocked(fetchAgents).mockResolvedValue(agentList());
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the per-column agent picker enabled with registry agents by default", async () => {
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

  it("keeps the picker enabled when stale workflow flags are absent", async () => {
    vi.mocked(fetchSettings).mockResolvedValue({} as Settings);
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    const picker = (await screen.findByTestId("wf-column-agent-select-triage")) as HTMLSelectElement;
    await waitFor(() => expect(picker.disabled).toBe(false));
    expect(picker.title).not.toMatch(/workflowColumns/);
    expect(picker.title).not.toMatch(/workflowGraphExecutor/);
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

/*
FNXC:WorkflowSimpleView 2026-07-10-12:00:
Simplified graphical view coverage: default mode, mode persistence, the
add-step dialog (palette + search), insert-on-edge affordances, read-only
built-in gating, and the mobile canvas/list graph-style toggle. Surface
enumeration for the new affordances: desktop simple toolbar, edge "+"
buttons, the add-step dialog, the segmented view switch, and both mobile
graph styles.
*/
describe("WorkflowNodeEditor simplified view modes", () => {
  beforeEach(() => {
    // Exercise the REAL defaults (simple view / mobile canvas style) instead
    // of the legacy-suite pins from the file-level hook.
    localStorage.removeItem("fusion:wf-editor-view-mode");
    localStorage.removeItem("fusion:wf-mobile-graph-style");
    vi.mocked(fetchWorkflows).mockResolvedValue([def()]);
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("defaults desktop to the simplified graphical view", async () => {
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    expect(await screen.findByTestId("wf-simple-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("wf-view-mode-simple")).toHaveAttribute("aria-pressed", "true");
    // Advanced-only chrome is absent: palette buttons, templates, minimap toggle.
    expect(document.querySelector(".wf-palette-btn")).toBeNull();
    expect(screen.queryByTestId("wf-palette-templates")).not.toBeInTheDocument();
    expect(screen.queryByTestId("wf-minimap-toggle")).not.toBeInTheDocument();
    // The simplified toolbar keeps the common actions.
    expect(screen.getByTestId("wf-simple-toolbar-add-step")).toBeInTheDocument();
    expect(screen.getByTestId("wf-simple-ai-edit")).toBeInTheDocument();
    expect(screen.getByText("Save")).toBeInTheDocument();
    // Node cards render on the simplified canvas.
    expect(await screen.findByTestId("wf-simple-node-gate")).toBeInTheDocument();
    expect(screen.getByTestId("wf-simple-node-start")).toBeInTheDocument();
  });

  it("persists the chosen view mode and honors it on remount", async () => {
    const first = render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByTestId("wf-simple-canvas");

    fireEvent.click(screen.getByTestId("wf-view-mode-advanced"));
    await waitFor(() => expect(screen.queryByTestId("wf-simple-canvas")).not.toBeInTheDocument());
    expect(localStorage.getItem("fusion:wf-editor-view-mode")).toBe("advanced");
    expect(document.querySelector(".wf-palette-btn")).not.toBeNull();

    first.unmount();
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByTestId("wf-workflow-name");
    expect(screen.getByTestId("wf-view-mode-advanced")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("wf-simple-canvas")).not.toBeInTheDocument();
  });

  it("opens the searchable add-step dialog and adds the picked node", async () => {
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByTestId("wf-simple-canvas");

    fireEvent.click(screen.getByTestId("wf-simple-toolbar-add-step"));
    const dialog = await screen.findByTestId("wf-add-step-modal");
    expect(within(dialog).getByText("Agent steps")).toBeInTheDocument();
    expect(within(dialog).getByText("Automation")).toBeInTheDocument();
    expect(within(dialog).getByText("Flow control")).toBeInTheDocument();

    // Search narrows the catalog.
    fireEvent.change(within(dialog).getByTestId("wf-add-step-search"), { target: { value: "script" } });
    expect(within(dialog).queryByTestId("wf-add-step-prompt-prompt")).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByTestId("wf-add-step-script-script"));
    await waitFor(() => expect(screen.queryByTestId("wf-add-step-modal")).not.toBeInTheDocument());
    // def() has an unambiguous edge into end, so the pick inserts there and
    // the new node lands selected with the inspector open.
    expect(await screen.findByTestId("wf-node-inspector")).toBeInTheDocument();
    expect(await screen.findByTestId("wf-simple-node-script")).toBeInTheDocument();
  });

  /* NOTE: the per-edge "+" button itself cannot render under jsdom — React
     Flow only mounts edge components once nodes have measured dimensions.
     Its insert behavior is covered by insertNodeOnEdge unit tests
     (workflow-simple-layout.test.ts) and the toolbar-pick test above, which
     exercises the same insertFromAddStep path end-to-end. */

  it("keeps built-in workflows read-only in the simplified view", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([builtinDef()]);
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);

    expect(await screen.findByTestId("wf-simple-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("wf-readonly-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("wf-simple-toolbar-add-step")).not.toBeInTheDocument();
    expect(screen.queryByTestId("wf-simple-add-step")).not.toBeInTheDocument();
    expect(document.querySelector('[data-testid^="wf-simple-insert-"]')).toBeNull();
  });

  it("splices an edge-targeted fragment pick into the targeted edge", async () => {
    // FNXC:WorkflowSimpleView 2026-07-12-10:30: PR #2006 review — fragment
    // picks from an edge-targeted add-step dialog must rewire
    // source→fragment→target instead of dropping a disconnected subgraph.
    vi.mocked(fetchWorkflows).mockResolvedValue([def(), fragmentDef()]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({ ...def(), ...(updates as object) }));
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByTestId("wf-simple-canvas");

    // def() has a single edge into end, so the toolbar add targets that edge.
    fireEvent.click(screen.getByTestId("wf-simple-toolbar-add-step"));
    const dialog = await screen.findByTestId("wf-add-step-modal");
    fireEvent.click(within(dialog).getByTestId("wf-add-step-fragment-WF-FRAG"));
    await waitFor(() => expect(screen.queryByTestId("wf-add-step-modal")).not.toBeInTheDocument());

    // Save and inspect the serialized IR: merge no longer feeds end directly;
    // the fragment's lint gate sits between them.
    fireEvent.click(screen.getByText("Save").closest("button")!);
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalledTimes(1));
    const [, updates] = vi.mocked(updateWorkflow).mock.calls[0];
    const ir = (updates as { ir: { nodes: Array<{ id: string; kind: string }>; edges: Array<{ from: string; to: string; condition?: string }> } }).ir;
    const insertedGate = ir.nodes.find((n) => n.kind === "gate" && n.id !== "lint");
    expect(insertedGate).toBeDefined();
    expect(ir.edges.some((e) => e.from === "merge" && e.to === "end")).toBe(false);
    expect(ir.edges.some((e) => e.from === "merge" && e.to === insertedGate!.id)).toBe(true);
    expect(ir.edges.some((e) => e.from === insertedGate!.id && e.to === "end")).toBe(true);
  });

  it("defaults the mobile graph tab to the simplified canvas with a list fallback", async () => {
    mockWorkflowEditorViewport("mobile");
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "QA" }));

    await screen.findByTestId("wf-mobile-shell");
    expect(await screen.findByTestId("wf-mobile-simple-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("wf-mobile-graph-style-canvas")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("mobile-wf-graph")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("wf-mobile-graph-style-list"));
    expect(await screen.findByTestId("mobile-wf-graph")).toBeInTheDocument();
    expect(screen.queryByTestId("wf-mobile-simple-canvas")).not.toBeInTheDocument();
    expect(localStorage.getItem("fusion:wf-mobile-graph-style")).toBe("list");
  });
});
