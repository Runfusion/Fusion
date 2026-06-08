// @vitest-environment jsdom
/**
 * WorkflowSettingsPanel (U6, R5) — declaration authoring + per-project value
 * editing. Mirrors the WorkflowFieldsPanel test harness: a small stateful host
 * drives the controlled `settings`/`onChange` declaration props the way
 * WorkflowNodeEditor does. The value-endpoint api functions are mocked so the
 * Values tab can be exercised without a server (the panel never talks to the
 * store directly — only through `fetchWorkflowSettingValues` /
 * `updateWorkflowSettingValues`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { useState } from "react";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";

expect.extend(jestDomMatchers);

// Keep the real module (type re-exports, ApiRequestError, every other helper)
// and override only the two value-endpoint functions.
vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    fetchWorkflowSettingValues: vi.fn(),
    updateWorkflowSettingValues: vi.fn(),
  };
});

import * as apiModule from "../../api";
import type { WorkflowSettingDefinition, WorkflowSettingValuesPayload } from "../../api";
import { ApiRequestError } from "../../api";
import { WorkflowSettingsPanel } from "../WorkflowSettingsPanel";

const mockFetchValues = vi.mocked(apiModule.fetchWorkflowSettingValues);
const mockUpdateValues = vi.mocked(apiModule.updateWorkflowSettingValues);

function payload(over: Partial<WorkflowSettingValuesPayload> = {}): WorkflowSettingValuesPayload {
  return { stored: {}, effective: {}, orphaned: [], ...over };
}

function Host({
  initial,
  workflowId = "wf-1",
  readOnly = false,
  projectId = "proj-1",
  onState,
}: {
  initial: WorkflowSettingDefinition[];
  workflowId?: string;
  readOnly?: boolean;
  projectId?: string;
  onState?: (s: WorkflowSettingDefinition[]) => void;
}) {
  const [settings, setSettings] = useState<WorkflowSettingDefinition[]>(initial);
  return (
    <WorkflowSettingsPanel
      workflowId={workflowId}
      settings={settings}
      readOnly={readOnly}
      projectId={projectId}
      addToast={() => {}}
      onChange={(next) => {
        setSettings(next);
        onState?.(next);
      }}
    />
  );
}

const openValues = () => fireEvent.click(screen.getByTestId("wf-settings-tab-values"));
const openDefinitions = () => fireEvent.click(screen.getByTestId("wf-settings-tab-definitions"));

beforeEach(() => {
  mockFetchValues.mockResolvedValue(payload());
  mockUpdateValues.mockResolvedValue(payload());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkflowSettingsPanel — Definitions tab", () => {
  it("renders the empty state and adds a default string setting", () => {
    let latest: WorkflowSettingDefinition[] = [];
    render(<Host initial={[]} onState={(s) => (latest = s)} />);
    expect(screen.getByText(/No settings declared yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Add setting").closest("button")!);
    expect(latest).toHaveLength(1);
    expect(latest[0].type).toBe("string");
    expect(latest[0].name).toBe("New setting");
  });

  it("declares a setting of each supported type", () => {
    let latest: WorkflowSettingDefinition[] = [];
    render(<Host initial={[{ id: "s1", name: "S1", type: "string" }]} onState={(s) => (latest = s)} />);
    openDefinitions();
    const typeSelect = within(screen.getByTestId("wf-setting-s1")).getByDisplayValue("string");
    for (const ty of ["text", "number", "boolean", "enum", "multi-enum"]) {
      fireEvent.change(typeSelect, { target: { value: ty } });
      expect(latest[0].type).toBe(ty);
    }
  });

  it("seeds options when switching to enum", () => {
    let latest: WorkflowSettingDefinition[] = [];
    render(<Host initial={[{ id: "s1", name: "S1", type: "string" }]} onState={(s) => (latest = s)} />);
    openDefinitions();
    const typeSelect = within(screen.getByTestId("wf-setting-s1")).getByDisplayValue("string");
    fireEvent.change(typeSelect, { target: { value: "enum" } });
    expect(latest[0].options).toHaveLength(1);
    expect(screen.getByTestId("wf-setting-options-s1")).toBeInTheDocument();
  });

  it("surfaces a duplicate-id error via the toast (remove+add id edit)", () => {
    const addToast = vi.fn();
    function H() {
      const [settings, setSettings] = useState<WorkflowSettingDefinition[]>([
        { id: "alpha", name: "A", type: "string" },
        { id: "beta", name: "B", type: "string" },
      ]);
      return (
        <WorkflowSettingsPanel
          workflowId="wf-1"
          settings={settings}
          readOnly={false}
          projectId="proj-1"
          addToast={addToast}
          onChange={setSettings}
        />
      );
    }
    render(<H />);
    openDefinitions();
    const betaItem = screen.getByTestId("wf-setting-beta");
    fireEvent.click(within(betaItem).getByText("Edit id"));
    const idInput = within(betaItem).getByLabelText("Setting id");
    fireEvent.change(idInput, { target: { value: "alpha" } });
    fireEvent.blur(idInput);
    expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/already exists/i), "error");
  });

  it("built-in workflows render declarations read-only", () => {
    render(<Host initial={[{ id: "s1", name: "S1", type: "string" }]} readOnly />);
    expect(screen.getByTestId("wf-settings-tab-values")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByTestId("wf-settings-tab-definitions"));
    expect(screen.getByText(/declarations are read-only/i)).toBeInTheDocument();
    const nameInput = within(screen.getByTestId("wf-setting-s1")).getByLabelText("Setting name");
    expect(nameInput).toBeDisabled();
    // The "Add setting" button is disabled for built-ins.
    expect(screen.getByText("Add setting").closest("button")).toBeDisabled();
  });
});

describe("WorkflowSettingsPanel — Values tab", () => {
  const decls: WorkflowSettingDefinition[] = [
    { id: "timeout-ms", name: "Timeout", type: "number", default: 1000 },
    { id: "new-sessions", name: "New sessions", type: "boolean", default: false },
    { id: "label", name: "Label", type: "string" },
  ];

  it("loads values on open and shows the customized indicator for stored keys", async () => {
    mockFetchValues.mockResolvedValue(
      payload({ stored: { "timeout-ms": 5000 }, effective: { "timeout-ms": 5000, "new-sessions": false } }),
    );
    render(<Host initial={decls} />);
    openValues();
    await waitFor(() => expect(mockFetchValues).toHaveBeenCalledWith("wf-1", "proj-1"));
    await waitFor(() => expect(screen.getByTestId("wf-settings-customized-timeout-ms")).toBeInTheDocument());
    // A non-stored key shows no customized indicator.
    expect(screen.queryByTestId("wf-settings-customized-new-sessions")).not.toBeInTheDocument();
  });

  it("groups built-in workflow settings under visible category headings", async () => {
    mockFetchValues.mockResolvedValue(payload({ effective: { planningProvider: "openai", planningModelId: "gpt-5" } }));
    render(
      <Host
        readOnly
        initial={[
          { id: "planningProvider", name: "Planning provider", type: "string" },
          { id: "planningModelId", name: "Planning model", type: "string" },
          { id: "validatorProvider", name: "Validator provider", type: "string" },
          { id: "requirePlanApproval", name: "Require plan approval", type: "boolean" },
          { id: "workflowStepTimeoutMs", name: "Step timeout", type: "number" },
          { id: "customThing", name: "Custom thing", type: "string" },
        ]}
      />,
    );

    await waitFor(() => expect(mockFetchValues).toHaveBeenCalledWith("wf-1", "proj-1"));
    expect(within(screen.getByTestId("wf-settings-group-models")).getByText("Models")).toBeInTheDocument();
    expect(within(screen.getByTestId("wf-settings-group-review")).getByText("Review & Approval")).toBeInTheDocument();
    expect(within(screen.getByTestId("wf-settings-group-steps")).getByText("Step Execution")).toBeInTheDocument();
    expect(within(screen.getByTestId("wf-settings-group-advanced")).getByText("Advanced")).toBeInTheDocument();
    expect(screen.getByLabelText("Plan/Triage provider")).toBeInTheDocument();
    expect(screen.getByLabelText("Reviewer provider")).toBeInTheDocument();
  });

  it("batches three field edits into exactly ONE patch on Save values", async () => {
    mockFetchValues.mockResolvedValue(payload({ effective: { "timeout-ms": 1000, "new-sessions": false } }));
    render(<Host initial={decls} />);
    openValues();
    await waitFor(() => expect(mockFetchValues).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Timeout"), { target: { value: "5000" } });
    fireEvent.click(screen.getByLabelText("New sessions"));
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "hello" } });

    fireEvent.click(screen.getByTestId("wf-settings-save-values"));
    await waitFor(() => expect(mockUpdateValues).toHaveBeenCalledTimes(1));
    expect(mockUpdateValues).toHaveBeenCalledWith(
      "wf-1",
      { "timeout-ms": 5000, "new-sessions": true, label: "hello" },
      "proj-1",
    );
  });

  it("renders a per-field rejection on the matching row and keeps other edits applied", async () => {
    mockFetchValues.mockResolvedValue(payload({ effective: { "timeout-ms": 1000, "new-sessions": false } }));
    mockUpdateValues.mockRejectedValueOnce(
      new ApiRequestError("rejected", 400, {
        rejections: [{ code: "type-mismatch", settingId: "timeout-ms", message: "expects a number" }],
      }),
    );
    render(<Host initial={decls} />);
    openValues();
    await waitFor(() => expect(mockFetchValues).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Timeout"), { target: { value: "5000" } });
    fireEvent.click(screen.getByLabelText("New sessions"));
    fireEvent.click(screen.getByTestId ? screen.getByTestId("wf-settings-save-values") : screen.getByText("Save values"));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/expects a number/i));
    // The other edited field keeps its value (write-boundary: nothing persisted,
    // all pending edits stay applied so the user can fix + resave).
    expect((screen.getByLabelText("New sessions") as HTMLInputElement).checked).toBe(true);
  });

  it("no active project → requires-project state with no write path", () => {
    render(
      <WorkflowSettingsPanel
        workflowId="wf-1"
        settings={decls}
        readOnly={false}
        projectId={undefined}
        addToast={() => {}}
        onChange={() => {}}
      />,
    );
    openValues();
    expect(screen.getByText(/Open a project to view and edit/i)).toBeInTheDocument();
    expect(screen.queryByTestId("wf-settings-save-values")).not.toBeInTheDocument();
    expect(mockFetchValues).not.toHaveBeenCalled();
  });

  it("shows a stale-context notice when the active project changes after open", async () => {
    function H() {
      const [pid, setPid] = useState<string | undefined>("proj-1");
      return (
        <>
          <button onClick={() => setPid("proj-2")}>switch</button>
          <WorkflowSettingsPanel
            workflowId="wf-1"
            settings={decls}
            readOnly={false}
            projectId={pid}
            addToast={() => {}}
            onChange={() => {}}
          />
        </>
      );
    }
    render(<H />);
    openValues();
    await waitFor(() => expect(mockFetchValues).toHaveBeenCalledWith("wf-1", "proj-1"));
    expect(screen.queryByTestId("wf-settings-stale-notice")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("switch"));
    await waitFor(() => expect(screen.getByTestId("wf-settings-stale-notice")).toBeInTheDocument());
    // Save is disabled under stale context (no writes to the new project).
    expect(screen.getByTestId("wf-settings-save-values")).toBeDisabled();
  });

  it("renders orphaned values in a disclosure and deletes via a null patch", async () => {
    mockFetchValues.mockResolvedValue(
      payload({ stored: { "old-key": "stale" }, effective: {}, orphaned: [{ id: "old-key", value: "stale" }] }),
    );
    render(<Host initial={decls} />);
    openValues();
    await waitFor(() => expect(screen.getByTestId("wf-settings-orphaned")).toBeInTheDocument());

    // Expand the disclosure.
    fireEvent.click(within(screen.getByTestId("wf-settings-orphaned")).getByRole("button"));
    const orphanRow = await screen.findByTestId("wf-settings-orphan-old-key");
    expect(orphanRow).toHaveTextContent("old-key");
    expect(orphanRow).toHaveTextContent("stale");

    fireEvent.click(within(orphanRow).getByLabelText("Delete orphaned value"));
    await waitFor(() => expect(mockUpdateValues).toHaveBeenCalledWith("wf-1", { "old-key": null }, "proj-1"));
  });

  it("clear-to-default emits a null patch for a customized value", async () => {
    mockFetchValues.mockResolvedValue(payload({ stored: { "timeout-ms": 5000 }, effective: { "timeout-ms": 5000 } }));
    render(<Host initial={decls} />);
    openValues();
    await waitFor(() => expect(screen.getByTestId("wf-settings-customized-timeout-ms")).toBeInTheDocument());

    // The clear/reset affordance lives on the row (SettingsFieldRow onClear).
    const row = screen.getByTestId("wf-settings-value-timeout-ms");
    const clearBtn = within(row).getByRole("button");
    fireEvent.click(clearBtn);
    fireEvent.click(screen.getByTestId("wf-settings-save-values"));
    await waitFor(() => expect(mockUpdateValues).toHaveBeenCalledWith("wf-1", { "timeout-ms": null }, "proj-1"));
  });
});
