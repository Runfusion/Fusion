// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

expect.extend(jestDomMatchers);
const originalInnerWidth = window.innerWidth;

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    fetchModels: vi.fn(),
    fetchWorkflowSettingValues: vi.fn(),
    updateWorkflowSettingValues: vi.fn(),
  };
});

vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({ id, label, onChange, showThinkingLevel, onThinkingLevelChange, onCredentialInstanceChange }: {
    id: string;
    label: string;
    onChange: (value: string) => void;
    showThinkingLevel?: boolean;
    onThinkingLevelChange?: (value: string) => void;
    onCredentialInstanceChange?: (value: string) => void;
  }) => (
    <div data-testid={`dropdown-${id}`}>
      <button type="button" onClick={() => onChange("anthropic/claude-sonnet")}>{label}</button>
      {showThinkingLevel && <button type="button" data-testid={`thinking-${id}`} onClick={() => onThinkingLevelChange?.("high")}>thinking</button>}
      {onCredentialInstanceChange && <button type="button" data-testid={`credential-${id}`} onClick={() => onCredentialInstanceChange("credential-2")}>credential</button>}
    </div>
  ),
}));

import * as api from "../../api";
import type { WorkflowSettingDefinition } from "../../api";
import { WorkflowSettingsPanel } from "../WorkflowSettingsPanel";

const fetchModels = vi.mocked(api.fetchModels);
const fetchValues = vi.mocked(api.fetchWorkflowSettingValues);
const updateValues = vi.mocked(api.updateWorkflowSettingValues);

const roles = [
  ["planning", "Planner"],
  ["execution", "Executor"],
  ["validator", "Reviewer"],
  ["merger", "Merger"],
] as const;

const declarations: WorkflowSettingDefinition[] = roles.flatMap(([id, label]) => [
  { id: `${id}Provider`, name: `${label} provider`, type: "string" },
  { id: `${id}ModelId`, name: `${label} model`, type: "string" },
  { id: `${id}ThinkingLevel`, name: `${label} thinking`, type: "enum", options: [{ value: "high", label: "High" }] },
  { id: `${id}CredentialInstanceId`, name: `${label} credential`, type: "string" },
  { id: `${id}FallbackProvider`, name: `${label} fallback provider`, type: "string" },
  { id: `${id}FallbackModelId`, name: `${label} fallback model`, type: "string" },
  { id: `${id}FallbackThinkingLevel`, name: `${label} fallback thinking`, type: "enum", options: [{ value: "high", label: "High" }] },
  { id: `${id}FallbackCredentialInstanceId`, name: `${label} fallback credential`, type: "string" },
]);

function renderPanel(width: number) {
  window.innerWidth = width;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, width, 700));
  render(
    <WorkflowSettingsPanel
      workflowId="workflow-real"
      settings={declarations}
      onChange={vi.fn()}
      readOnly
      projectId="project-real"
      addToast={vi.fn()}
      initialTab="values"
    />,
  );
}

beforeEach(() => {
  fetchModels.mockReset();
  fetchValues.mockReset();
  updateValues.mockReset();
  fetchModels.mockResolvedValue({
    models: [{ provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" }],
    favoriteProviders: [],
    favoriteModels: [],
  });
  fetchValues.mockResolvedValue({ stored: {}, effective: {}, orphaned: [] });
  updateValues.mockResolvedValue({ stored: {}, effective: {}, orphaned: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.innerWidth = originalInnerWidth;
});

function workflowRoleLabels(): string[] {
  return within(screen.getByTestId("wf-settings-group-models"))
    .getAllByRole("button")
    .map((button) => button.textContent ?? "")
    .filter((text) => /^(Planner|Executor|Reviewer|Merger)( Fallback)? Model$/.test(text));
}

/*
FNXC:WorkflowSettings 2026-09-14-19:24:
Workflow Values mirrors project role ordering without a Default lane, because Default is project/global policy. Workflow overrides retain primary/fallback thinking and credential companions and save only through the workflow-values route bound to the actual project.
*/
describe.each([1200, 600])("WorkflowSettingsPanel model lanes at %ipx", (width) => {
  it("renders Planner, Executor, Reviewer, and Merger with adjacent fallbacks and no Default", async () => {
    renderPanel(width);
    await waitFor(() => expect(fetchValues).toHaveBeenCalledWith("workflow-real", "project-real"));
    expect(workflowRoleLabels()).toEqual([
      "Planner Model", "Planner Fallback Model",
      "Executor Model", "Executor Fallback Model",
      "Reviewer Model", "Reviewer Fallback Model",
      "Merger Model", "Merger Fallback Model",
    ]);
    expect(screen.queryByRole("button", { name: "Default Model" })).not.toBeInTheDocument();
  });
});

describe("WorkflowSettingsPanel model lane controls", () => {
  it("does not offer undeclared companions for a custom workflow model pair", async () => {
    render(<WorkflowSettingsPanel workflowId="custom" projectId="project-real" settings={declarations.filter((setting) => setting.id === "mergerProvider" || setting.id === "mergerModelId")} onChange={vi.fn()} readOnly={false} addToast={vi.fn()} initialTab="values" />);
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Merger Model" }));
    expect(screen.queryByTestId("thinking-wf-model-lane-merger")).toBeNull();
    expect(screen.queryByTestId("credential-wf-model-lane-merger")).toBeNull();
    fireEvent.click(screen.getByTestId("wf-settings-save-values"));
    await waitFor(() => expect(updateValues).toHaveBeenCalledWith("custom", { mergerProvider: "anthropic", mergerModelId: "claude-sonnet" }, "project-real"));
  });

  it("visibly identifies stored values the engine cannot apply", async () => {
    fetchValues.mockResolvedValue({ stored: { removedModelId: "abandoned" }, effective: {}, orphaned: [{ id: "removedModelId", value: "abandoned", reason: "removed" }] } as never);
    renderPanel(1200);
    const warning = await screen.findByTestId("wf-settings-orphaned");
    fireEvent.click(within(warning).getByRole("button"));
    expect(screen.getByTestId("wf-settings-orphan-removedModelId")).toHaveTextContent("abandoned");
    expect(within(warning).getByRole("note")).toHaveTextContent("ignored by the engine");
  });
  it("gives every primary and fallback role thinking and credential controls", async () => {
    renderPanel(1200);
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());
    for (const [id] of roles) {
      for (const suffix of [id, `${id}-fallback`]) {
        expect(screen.getByTestId(`thinking-wf-model-lane-${suffix}`)).toBeInTheDocument();
        expect(screen.getByTestId(`credential-wf-model-lane-${suffix}`)).toBeInTheDocument();
      }
    }
  });

  it.each(roles)("saves %s companions to the workflow-value authority for the bound project", async (role, label) => {
    renderPanel(1200);
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: `${label} Model` }));
    fireEvent.click(screen.getByTestId(`thinking-wf-model-lane-${role}`));
    fireEvent.click(screen.getByTestId(`credential-wf-model-lane-${role}`));
    fireEvent.click(screen.getByTestId("wf-settings-save-values"));

    await waitFor(() => expect(updateValues).toHaveBeenCalledTimes(1));
    expect(updateValues).toHaveBeenCalledWith(
      "workflow-real",
      {
        [`${role}Provider`]: "anthropic",
        [`${role}ModelId`]: "claude-sonnet",
        [`${role}CredentialInstanceId`]: "credential-2",
        [`${role}ThinkingLevel`]: "high",
      },
      "project-real",
    );
  });
});
