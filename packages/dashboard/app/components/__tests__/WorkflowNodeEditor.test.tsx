import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import type { WorkflowDefinition } from "@fusion/core";
import { irToFlow, flowToIr, emptyWorkflowIr, emptyWorkflowLayout, foreachChildFlowId } from "../workflow-flow-mapping";
import { BUILTIN_STEPWISE_CODING_WORKFLOW_IR } from "@fusion/core";

vi.mock("../../api", () => ({
  fetchWorkflows: vi.fn(),
  createWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
  compileWorkflow: vi.fn(),
  fetchTraits: vi.fn(),
  fetchStepParsers: vi.fn(),
  fetchModels: vi.fn(),
  fetchAgents: vi.fn(),
  fetchDiscoveredSkills: vi.fn(),
}));

import { fireEvent } from "@testing-library/react";
import { fetchWorkflows, fetchTraits, fetchStepParsers, updateWorkflow, compileWorkflow, createWorkflow, fetchModels } from "../../api";
import type { TraitCatalogEntry } from "../../api";
import { WorkflowNodeEditor } from "../WorkflowNodeEditor";

const TRAIT_CATALOG: TraitCatalogEntry[] = [
  { id: "intake", name: "Intake", builtin: true, flags: { intake: true } },
  { id: "complete", name: "Complete", builtin: true, flags: { complete: true } },
  { id: "wip", name: "WIP", builtin: true, flags: { countsTowardWip: true } },
  { id: "hold", name: "Hold", builtin: true, flags: { hold: true } },
];

function v2Def(): WorkflowDefinition {
  return {
    id: "WF-002",
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
  const d = v2Def();
  return { ...d, id: "builtin:coding", name: "Default coding workflow" };
}

function def(): WorkflowDefinition {
  return {
    id: "WF-001",
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
});

describe("WorkflowNodeEditor", () => {
  beforeEach(() => {
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the empty state when there are no workflows (no canvas)", async () => {
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    expect(await screen.findByText("Workflows")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/No workflows yet/i)).toBeInTheDocument());
    expect(screen.getByText(/Select or create a workflow/i)).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<WorkflowNodeEditor isOpen={false} onClose={() => {}} addToast={() => {}} />);
    expect(container).toBeEmptyDOMElement();
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

// ── U8: step-inversion authoring (foreach/step-review/parse-steps/code) ──────

/** A custom v2 workflow with a foreach (one step-execute child + a step-review)
 *  so the editor's group/template + edge inspector surfaces have something to
 *  render and round-trip. */
function stepwiseDef(): WorkflowDefinition {
  return {
    id: "WF-STEP",
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
  });

  it("auto-populates a step-execute child when a foreach is added from the palette", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2Def()]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({ ...v2Def(), ...(updates as object) }));
    vi.mocked(compileWorkflow).mockResolvedValue({ steps: [] });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByText("Save");
    // Adding a foreach renders a group node with an empty inspector hint absent
    // (it has a child) and an inspector for the foreach.
    fireEvent.click(screen.getByText("For-each step").closest("button")!);
    await waitFor(() => expect(screen.getByTestId("wf-node-foreach")).toBeInTheDocument());
    // The foreach inspector shows the Mode select (KTD-3).
    expect(screen.getByText("Mode")).toBeInTheDocument();
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
    fireEvent.click(screen.getByText("Code").closest("button")!);
    const source = (await screen.findByText("Source (TypeScript)")).parentElement!.querySelector("textarea")! as HTMLTextAreaElement;
    fireEvent.change(source, { target: { value: "export default async()=>({outcome:'success'})" } });
    expect(source.value).toContain("outcome:'success'");
    const timeout = screen.getByText("Timeout (ms)").parentElement!.querySelector("input")! as HTMLInputElement;
    fireEvent.change(timeout, { target: { value: "12000" } });
    expect(timeout.value).toBe("12000");
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
});
