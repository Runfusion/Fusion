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
import { render, screen, fireEvent, waitFor, cleanup, within, act } from "@testing-library/react";
import { useState } from "react";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";

expect.extend(jestDomMatchers);

// Keep the real module (type re-exports, ApiRequestError, every other helper)
// and override only the model/value endpoint functions.
vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    fetchModels: vi.fn(),
    fetchWorkflowSettingValues: vi.fn(),
    updateWorkflowSettingValues: vi.fn(),
  };
});

import * as apiModule from "../../api";
import type { WorkflowSettingDefinition, WorkflowSettingValuesPayload } from "../../api";
import { ApiRequestError } from "../../api";
import { WorkflowSettingsPanel, WORKFLOW_MODEL_LANE_CATALOG } from "../WorkflowSettingsPanel";

const mockFetchModels = vi.mocked(apiModule.fetchModels);
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

const modelResponse = {
  models: [
    { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true, contextWindow: 128000 },
    { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet", reasoning: true, contextWindow: 200000 },
  ],
  favoriteProviders: [],
  favoriteModels: [],
};

beforeEach(() => {
  mockFetchModels.mockResolvedValue(modelResponse);
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
          { id: "planReviewMaxRevisions", name: "Plan Review revision cap", type: "number" },
          { id: "codeReviewMaxRevisions", name: "Code Review revision cap", type: "number" },
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
    expect(screen.getByLabelText("Plan/Triage Model")).toBeInTheDocument();
    expect(screen.getByLabelText("Reviewer provider")).toBeInTheDocument();
    expect(screen.getByLabelText("Plan Review revision cap")).toBeInTheDocument();
    expect(screen.getByText(/Leave empty for unbounded automatic Plan Review\/spec revision/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Code Review revision cap")).toBeInTheDocument();
    expect(screen.getByText(/Leave empty for unbounded automatic Code Review remediation/i)).toBeInTheDocument();
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

  it("preserves mid-flight edits after a successful save and resaves only the new keys", async () => {
    mockFetchValues.mockResolvedValue(payload({ effective: { "timeout-ms": 1000, "new-sessions": false, label: "" } }));
    let resolveSave!: (value: WorkflowSettingValuesPayload) => void;
    mockUpdateValues
      .mockReturnValueOnce(
        new Promise<WorkflowSettingValuesPayload>((resolve) => {
          resolveSave = resolve;
        }),
      )
      .mockResolvedValueOnce(
        payload({
          stored: { "timeout-ms": 5000, label: "mid-flight-edit" },
          effective: { "timeout-ms": 5000, "new-sessions": false, label: "mid-flight-edit" },
        }),
      );

    render(<Host initial={decls} />);
    openValues();
    await waitFor(() => expect(mockFetchValues).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Timeout"), { target: { value: "5000" } });
    fireEvent.click(screen.getByTestId("wf-settings-save-values"));
    await waitFor(() => expect(mockUpdateValues).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "mid-flight-edit" } });
    await act(async () => {
      resolveSave(payload({ stored: { "timeout-ms": 5000 }, effective: { "timeout-ms": 5000, "new-sessions": false } }));
    });

    expect(mockUpdateValues).toHaveBeenNthCalledWith(1, "wf-1", { "timeout-ms": 5000 }, "proj-1");
    expect(screen.getByLabelText("Label")).toHaveValue("mid-flight-edit");
    expect(screen.getByLabelText("Timeout")).toHaveValue(5000);

    await waitFor(() => expect(screen.getByTestId("wf-settings-save-values")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("wf-settings-save-values"));
    await waitFor(() => expect(mockUpdateValues).toHaveBeenCalledTimes(2));
    expect(mockUpdateValues).toHaveBeenNthCalledWith(2, "wf-1", { label: "mid-flight-edit" }, "proj-1");
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

  it("edits, saves, clears, and refetches built-in review revision caps without duplicating definitions", async () => {
    const builtinReviewCaps: WorkflowSettingDefinition[] = [
      { id: "planReviewMaxRevisions", name: "Plan Review revision cap", type: "number" },
      { id: "codeReviewMaxRevisions", name: "Code Review revision cap", type: "number" },
    ];
    mockFetchValues
      .mockResolvedValueOnce(payload({ effective: {} }))
      .mockResolvedValueOnce(payload({ stored: { planReviewMaxRevisions: 2, codeReviewMaxRevisions: 0 }, effective: { planReviewMaxRevisions: 2, codeReviewMaxRevisions: 0 } }));
    mockUpdateValues
      .mockResolvedValueOnce(payload({ stored: { planReviewMaxRevisions: 2, codeReviewMaxRevisions: 0 }, effective: { planReviewMaxRevisions: 2, codeReviewMaxRevisions: 0 } }))
      .mockResolvedValueOnce(payload({ stored: { codeReviewMaxRevisions: 0 }, effective: { codeReviewMaxRevisions: 0 } }));

    const firstRender = render(<Host initial={builtinReviewCaps} readOnly />);
    await waitFor(() => expect(mockFetchValues).toHaveBeenCalledWith("wf-1", "proj-1"));
    expect(screen.getByTestId("wf-settings-tab-values")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/Leave empty for unbounded automatic Plan Review\/spec revision/i)).toBeInTheDocument();
    expect(screen.getByText(/Leave empty for unbounded automatic Code Review remediation/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Plan Review revision cap"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Code Review revision cap"), { target: { value: "0" } });
    fireEvent.click(screen.getByTestId("wf-settings-save-values"));

    await waitFor(() => expect(mockUpdateValues).toHaveBeenCalledWith(
      "wf-1",
      { planReviewMaxRevisions: 2, codeReviewMaxRevisions: 0 },
      "proj-1",
    ));
    expect(screen.getByTestId("wf-settings-customized-planReviewMaxRevisions")).toBeInTheDocument();
    expect(screen.getByTestId("wf-settings-customized-codeReviewMaxRevisions")).toBeInTheDocument();

    firstRender.unmount();
    render(<Host initial={builtinReviewCaps} readOnly />);
    await waitFor(() => expect(mockFetchValues).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Plan Review revision cap")).toHaveValue(2);
    expect(screen.getByLabelText("Code Review revision cap")).toHaveValue(0);

    const planRow = screen.getByTestId("wf-settings-value-planReviewMaxRevisions");
    fireEvent.click(within(planRow).getByRole("button"));
    fireEvent.click(screen.getByTestId("wf-settings-save-values"));
    await waitFor(() => expect(mockUpdateValues).toHaveBeenLastCalledWith(
      "wf-1",
      { planReviewMaxRevisions: null },
      "proj-1",
    ));
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

  const modelDecls: WorkflowSettingDefinition[] = [
    { id: "planningProvider", name: "Planning provider", type: "string" },
    { id: "planningModelId", name: "Planning model", type: "string" },
    { id: "executionProvider", name: "Execution provider", type: "string" },
    { id: "executionModelId", name: "Execution model", type: "string" },
    { id: "validatorProvider", name: "Validator provider", type: "string" },
    { id: "validatorModelId", name: "Validator model", type: "string" },
    { id: "planningFallbackProvider", name: "Planning fallback provider", type: "string" },
    { id: "planningFallbackModelId", name: "Planning fallback model", type: "string" },
    { id: "customModelProvider", name: "Custom model provider", type: "string" },
  ];

  const titleSummarizerDecls: WorkflowSettingDefinition[] = [
    { id: "titleSummarizerProvider", name: "Title summarizer provider", type: "string" },
    { id: "titleSummarizerModelId", name: "Title summarizer model", type: "string" },
    { id: "titleSummarizerFallbackProvider", name: "Title summarizer fallback provider", type: "string" },
    { id: "titleSummarizerFallbackModelId", name: "Title summarizer fallback model", type: "string" },
  ];

  it("does not catalog title summarization as a workflow model lane", async () => {
    expect(WORKFLOW_MODEL_LANE_CATALOG.map((pair) => pair.id)).not.toEqual(
      expect.arrayContaining(["title-summarizer", "title-summarizer-fallback"]),
    );
    expect(WORKFLOW_MODEL_LANE_CATALOG.flatMap((pair) => [pair.providerId, pair.modelId])).not.toEqual(
      expect.arrayContaining([
        "titleSummarizerProvider",
        "titleSummarizerModelId",
        "titleSummarizerFallbackProvider",
        "titleSummarizerFallbackModelId",
      ]),
    );

    render(<Host initial={titleSummarizerDecls} readOnly />);
    await waitFor(() => expect(mockFetchValues).toHaveBeenCalledWith("wf-1", "proj-1"));

    expect(screen.queryByLabelText("Title Summarizer Model")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Title Summarizer Fallback Model")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Title summarizer provider")).toBeInTheDocument();
  });

  async function openPlanningDropdown() {
    const trigger = await screen.findByLabelText("Plan/Triage Model");
    fireEvent.click(trigger);
    return trigger;
  }

  it("renders built-in model lane pairs as dropdowns without raw provider/model text inputs", async () => {
    mockFetchValues.mockResolvedValue(
      payload({
        stored: { planningProvider: "openai", planningModelId: "gpt-5" },
        effective: { planningProvider: "openai", planningModelId: "gpt-5" },
      }),
    );
    render(<Host initial={modelDecls} readOnly />);

    await waitFor(() => expect(mockFetchModels).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Plan/Triage Model")).toHaveTextContent("GPT-5");
    expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    expect(screen.getByLabelText("Reviewer Model")).toBeInTheDocument();
    expect(screen.getByLabelText("Planning Fallback Model")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Plan/Triage provider" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Plan/Triage model" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Custom model provider")).toBeInTheDocument();
    expect(screen.getByTestId("wf-settings-customized-planning")).toBeInTheDocument();
  });

  it("selecting a workflow model writes provider and model id together", async () => {
    render(<Host initial={modelDecls} readOnly />);
    await waitFor(() => expect(mockFetchModels).toHaveBeenCalled());

    await openPlanningDropdown();
    fireEvent.click(await screen.findByRole("option", { name: /Claude Sonnet/i }));
    fireEvent.click(screen.getByTestId("wf-settings-save-values"));

    await waitFor(() => expect(mockUpdateValues).toHaveBeenCalledTimes(1));
    expect(mockUpdateValues).toHaveBeenCalledWith(
      "wf-1",
      { planningProvider: "anthropic", planningModelId: "claude-sonnet" },
      "proj-1",
    );
  });

  it("clearing a workflow model dropdown writes paired null values", async () => {
    mockFetchValues.mockResolvedValue(
      payload({
        stored: { planningProvider: "openai", planningModelId: "gpt-5" },
        effective: { planningProvider: "openai", planningModelId: "gpt-5" },
      }),
    );
    render(<Host initial={modelDecls} readOnly />);
    await waitFor(() => expect(screen.getByTestId("wf-settings-customized-planning")).toBeInTheDocument());

    await openPlanningDropdown();
    fireEvent.click(await screen.findByRole("option", { name: /Use inherited\/default model/i }));
    fireEvent.click(screen.getByTestId("wf-settings-save-values"));

    await waitFor(() => expect(mockUpdateValues).toHaveBeenCalledTimes(1));
    expect(mockUpdateValues).toHaveBeenCalledWith(
      "wf-1",
      { planningProvider: null, planningModelId: null },
      "proj-1",
    );
  });

  it("shows inherited/default dropdown state for undefined values without a customized badge", async () => {
    render(<Host initial={modelDecls} readOnly />);
    await waitFor(() => expect(mockFetchValues).toHaveBeenCalledWith("wf-1", "proj-1"));
    expect(screen.getByLabelText("Plan/Triage Model")).toHaveTextContent("Use inherited/default model");
    expect(screen.queryByTestId("wf-settings-customized-planning")).not.toBeInTheDocument();
  });

  it("keeps known model lanes dropdown-backed when the model registry is empty", async () => {
    mockFetchModels.mockResolvedValueOnce({ ...modelResponse, models: [] });
    render(<Host initial={modelDecls} readOnly />);

    await waitFor(() => expect(mockFetchModels).toHaveBeenCalled());
    const trigger = screen.getByLabelText("Plan/Triage Model");
    expect(trigger).toBeDisabled();
    expect(screen.getAllByText(/No models are available/i).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/^Plan\/Triage provider$/i)).not.toBeInTheDocument();
  });

  it("surfaces paired-key rejections on the combined row while preserving pending selection", async () => {
    mockUpdateValues.mockRejectedValueOnce(
      new ApiRequestError("rejected", 400, {
        rejections: [{ code: "type-mismatch", settingId: "planningModelId", message: "model is invalid" }],
      }),
    );
    render(<Host initial={modelDecls} readOnly />);
    await waitFor(() => expect(mockFetchModels).toHaveBeenCalled());

    await openPlanningDropdown();
    fireEvent.click(await screen.findByRole("option", { name: /Claude Sonnet/i }));
    fireEvent.click(screen.getByTestId("wf-settings-save-values"));

    const row = await screen.findByTestId("wf-settings-value-planning");
    expect(within(row).getByRole("alert")).toHaveTextContent("model is invalid");
    expect(within(row).getByLabelText("Plan/Triage Model")).toHaveTextContent("Claude Sonnet");
    expect(mockUpdateValues).toHaveBeenCalledWith(
      "wf-1",
      { planningProvider: "anthropic", planningModelId: "claude-sonnet" },
      "proj-1",
    );
  });
});
