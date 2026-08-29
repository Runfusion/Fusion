import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { useState } from "react";
import type { WorkflowDefinition } from "@fusion/core";
import type { WorkflowFieldDefinition } from "../../api";
import { WorkflowFieldsPanel } from "../WorkflowFieldsPanel";

// ── Standalone (controlled) harness ──────────────────────────────────────────
// The panel is a controlled component (fields + onChange). A tiny stateful host
// mirrors how WorkflowNodeEditor drives it so edits round-trip through React.
function Host({
  initial,
  readOnly = false,
  addToast = () => {},
  onState,
}: {
  initial: WorkflowFieldDefinition[];
  readOnly?: boolean;
  addToast?: (m: string, t?: "success" | "error" | "info" | "warning") => void;
  onState?: (f: WorkflowFieldDefinition[]) => void;
}) {
  const [fields, setFields] = useState<WorkflowFieldDefinition[]>(initial);
  return (
    <WorkflowFieldsPanel
      fields={fields}
      readOnly={readOnly}
      addToast={addToast}
      onChange={(next) => {
        setFields(next);
        onState?.(next);
      }}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkflowFieldsPanel — standalone", () => {
  it("renders an empty state and adds a default string field", () => {
    let latest: WorkflowFieldDefinition[] = [];
    render(<Host initial={[]} onState={(f) => (latest = f)} />);
    expect(screen.getByText(/No custom fields yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Add field").closest("button")!);
    expect(latest).toHaveLength(1);
    expect(latest[0].type).toBe("string");
    expect(latest[0].name).toBe("New field");
  });

  it("changes a field to each supported type", () => {
    let latest: WorkflowFieldDefinition[] = [];
    render(
      <Host
        initial={[{ id: "f1", name: "F1", type: "string" }]}
        onState={(f) => (latest = f)}
      />,
    );
    const typeSelect = within(screen.getByTestId("wf-field-f1")).getByDisplayValue("string");
    for (const ty of ["text", "number", "boolean", "enum", "multi-enum", "date", "url"]) {
      fireEvent.change(typeSelect, { target: { value: ty } });
      expect(latest[0].type).toBe(ty);
    }
  });

  it("seeds options when switching to enum and edits option value/label/color", () => {
    let latest: WorkflowFieldDefinition[] = [];
    render(
      <Host
        initial={[{ id: "sev", name: "Severity", type: "string" }]}
        onState={(f) => (latest = f)}
      />,
    );
    const row = screen.getByTestId("wf-field-sev");
    fireEvent.change(within(row).getByDisplayValue("string"), { target: { value: "enum" } });
    // Options editor appears with a seeded option.
    const opts = screen.getByTestId("wf-field-options-sev");
    expect(latest[0].options).toHaveLength(1);

    // Edit value + label.
    fireEvent.change(within(opts).getByLabelText("Option value"), { target: { value: "high" } });
    expect(latest[0].options![0].value).toBe("high");
    fireEvent.change(within(opts).getByLabelText("Option label"), { target: { value: "High" } });
    expect(latest[0].options![0].label).toBe("High");

    // Pick a color via the swatch palette.
    const swatches = within(opts).getByRole("group", { name: "Option color" });
    const firstSwatch = within(swatches).getAllByRole("button")[0];
    fireEvent.click(firstSwatch);
    expect(latest[0].options![0].color).toBeTruthy();
  });

  it("adds and removes enum options (CRUD)", () => {
    let latest: WorkflowFieldDefinition[] = [];
    render(
      <Host
        initial={[
          { id: "tag", name: "Tag", type: "enum", options: [{ value: "a", label: "A" }] },
        ]}
        onState={(f) => (latest = f)}
      />,
    );
    fireEvent.click(screen.getByText("Add option").closest("button")!);
    expect(latest[0].options).toHaveLength(2);
    fireEvent.click(screen.getAllByLabelText("Remove option")[0]);
    expect(latest[0].options).toHaveLength(1);
  });

  it("edits render placement and widget controls", () => {
    let latest: WorkflowFieldDefinition[] = [];
    render(
      <Host
        initial={[{ id: "k", name: "K", type: "enum", options: [{ value: "x", label: "X" }] }]}
        onState={(f) => (latest = f)}
      />,
    );
    const row = screen.getByTestId("wf-field-k");
    // Placement → card.
    fireEvent.change(within(row).getByText("Placement").parentElement!.querySelector("select")!, {
      target: { value: "card" },
    });
    expect(latest[0].render?.placement).toBe("card");
    // Widget → radio (valid for enum).
    fireEvent.change(within(row).getByText("Widget").parentElement!.querySelector("select")!, {
      target: { value: "radio" },
    });
    expect(latest[0].render?.widget).toBe("radio");
  });

  it("toggles required and edits a typed default", () => {
    let latest: WorkflowFieldDefinition[] = [];
    render(
      <Host
        initial={[{ id: "n", name: "N", type: "number" }]}
        onState={(f) => (latest = f)}
      />,
    );
    fireEvent.click(screen.getByLabelText("Required", { selector: "input" }) ?? screen.getByText("Required").previousSibling as Element);
    expect(latest[0].required).toBe(true);
    const defInput = screen.getByLabelText("Default value");
    fireEvent.change(defInput, { target: { value: "7" } });
    fireEvent.blur(defInput);
    expect(latest[0].default).toBe(7);
  });

  it("renders a live card badge preview for card-placed enum fields", () => {
    render(
      <Host
        initial={[
          {
            id: "p",
            name: "Priority",
            type: "enum",
            options: [{ value: "hi", label: "High", color: "#ef4444" }],
            render: { placement: "card" },
          },
        ]}
      />,
    );
    const preview = screen.getByTestId("wf-field-preview-p");
    // Reuses the TaskCard badge class so the chip matches the board.
    const badge = preview.querySelector(".card-field-badge");
    expect(badge).toBeTruthy();
    expect(badge!.textContent).toBe("High");
  });

  it("removes a field", () => {
    let latest: WorkflowFieldDefinition[] = [];
    render(
      <Host
        initial={[{ id: "gone", name: "Gone", type: "string" }]}
        onState={(f) => (latest = f)}
      />,
    );
    fireEvent.click(screen.getByLabelText("Remove field"));
    expect(latest).toHaveLength(0);
  });

  it("warns and blocks a duplicate id when editing the id", () => {
    const addToast = vi.fn();
    let latest: WorkflowFieldDefinition[] = [];
    render(
      <Host
        initial={[
          { id: "alpha", name: "Alpha", type: "string" },
          { id: "beta", name: "Beta", type: "string" },
        ]}
        addToast={addToast}
        onState={(f) => (latest = f)}
      />,
    );
    // Reveal the id editor for beta and try to rename it to alpha.
    const betaRow = screen.getByTestId("wf-field-beta");
    fireEvent.click(within(betaRow).getByText("Edit id"));
    const idInput = within(screen.getByTestId("wf-field-beta")).getByLabelText("Field id");
    fireEvent.change(idInput, { target: { value: "alpha" } });
    fireEvent.blur(idInput);
    expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/already exists/i), "error");
    // No re-key happened: the blocked change never fired onChange, so the row
    // still carries its original id (the panel re-renders the static id chip).
    expect(latest).toHaveLength(0);
    expect(screen.getByTestId("wf-field-beta")).toBeInTheDocument();
  });

  it("is fully read-only for built-in workflows", () => {
    render(
      <Host initial={[{ id: "f", name: "F", type: "string" }]} readOnly />,
    );
    expect((screen.getByText("Add field").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Field name") as HTMLInputElement).disabled).toBe(true);
  });
});

// ── Round-trip through the editor's save flow ────────────────────────────────
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchWorkflows: vi.fn(),
    createWorkflow: vi.fn(),
    updateWorkflow: vi.fn(),
    deleteWorkflow: vi.fn(),
    compileWorkflow: vi.fn(),
    fetchTraits: vi.fn(),
    fetchModels: vi.fn(),
    fetchAgents: vi.fn(),
    fetchDiscoveredSkills: vi.fn(),
  };
});

import { fetchWorkflows, fetchTraits, updateWorkflow, compileWorkflow, fetchModels } from "../../api";
import { WorkflowNodeEditor } from "../WorkflowNodeEditor";

function v2DefWithField(): WorkflowDefinition {
  return {
    id: "WF-100",
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
      fields: [
        {
          id: "severity",
          name: "Severity",
          type: "enum",
          options: [{ value: "low", label: "Low" }],
          render: { placement: "card" },
        },
      ],
    } as WorkflowDefinition["ir"],
    layout: { start: { x: 0, y: 20 }, step: { x: 120, y: 60 }, end: { x: 360, y: 240 } },
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}

describe("WorkflowFieldsPanel — editor round-trip", () => {
  beforeEach(() => {
    // FNXC:WorkflowSimpleView 2026-07-12: commit bcbd97cc1 made the workflow editor default to the "simple" graphical
    // view, which hides the Advanced-view sidebar panels (including WorkflowFieldsPanel, rendered only when
    // !simpleViewEnabled — see WorkflowNodeEditor.tsx ~L2926). Force "advanced" so the Fields panel mounts and the
    // round-trip assertion can reach it. Key mirrors viewModeStorageKey in WorkflowNodeEditor.tsx.
    localStorage.setItem("fusion:wf-editor-view-mode", "advanced");
    vi.mocked(fetchTraits).mockResolvedValue([
      { id: "intake", name: "Intake", builtin: true, flags: { intake: true } },
      { id: "complete", name: "Complete", builtin: true, flags: { complete: true } },
    ]);
    vi.mocked(fetchModels).mockResolvedValue([]);
  });

  it("mounts the Fields panel and round-trips an added field into the saved IR", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2DefWithField()]);
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({
      ...v2DefWithField(),
      ...(updates as object),
    }));
    vi.mocked(compileWorkflow).mockResolvedValue({ steps: [] });

    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    await screen.findByText("Save");

    // The panel mounts and shows the workflow's existing field.
    const panel = await screen.findByTestId("wf-fields-panel");
    expect(within(panel).getByDisplayValue("Severity")).toBeInTheDocument();

    // Add a second field, then save and assert the IR carries both fields.
    fireEvent.click(within(panel).getByText("Add field").closest("button")!);
    fireEvent.click(screen.getByText("Save").closest("button")!);
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());

    const [, updates] = vi.mocked(updateWorkflow).mock.calls[0];
    const ir = (updates as { ir: { version: string; fields?: WorkflowFieldDefinition[] } }).ir;
    expect(ir.version).toBe("v2");
    expect(ir.fields).toBeTruthy();
    expect(ir.fields!.length).toBe(2);
    expect(ir.fields!.some((f) => f.id === "severity")).toBe(true);
  });

  it("surfaces a core validation error at save (enum without options)", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([v2DefWithField()]);
    // Simulate the server rejecting the IR (parseWorkflowIr: options-required).
    vi.mocked(updateWorkflow).mockRejectedValue(
      new Error("Workflow field 'severity' of type 'enum' must declare non-empty options"),
    );
    const addToast = vi.fn();
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={addToast} />);
    await screen.findByText("Save");

    fireEvent.click(screen.getByText("Save").closest("button")!);
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(
        expect.stringMatching(/must declare non-empty options/i),
        "error",
      ),
    );
  });
});
