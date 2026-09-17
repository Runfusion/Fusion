// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectModelsSection, type ProjectModelsSectionModelProps } from "../ProjectModelsSection";
import type { ModelLane, SettingsFormState } from "../context";
import { splitSettingsSave } from "../../save-split";

expect.extend(jestDomMatchers);
const originalInnerWidth = window.innerWidth;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

vi.mock("../../../CustomModelDropdown", () => ({
  CustomModelDropdown: ({ id, label, value, onChange, showThinkingLevel, thinkingLevel, onThinkingLevelChange, credentialInstanceId, onCredentialInstanceChange }: {
    id: string;
    label: string;
    value?: string;
    onChange: (value: string) => void;
    showThinkingLevel?: boolean;
    thinkingLevel?: string;
    onThinkingLevelChange?: (value: string) => void;
    credentialInstanceId?: string;
    onCredentialInstanceChange?: (value: string) => void;
  }) => (
    <div data-testid={`dropdown-${id}`} data-value={value ?? ""}>
      <button type="button" onClick={() => onChange("anthropic/claude-sonnet")}>{label}</button>
      {showThinkingLevel && <button type="button" data-testid={`thinking-${id}`} onClick={() => onThinkingLevelChange?.("high")}>thinking:{thinkingLevel || "inherit"}</button>}
      {onCredentialInstanceChange && <button type="button" data-testid={`credential-${id}`} onClick={() => onCredentialInstanceChange("credential-2")}>credential:{credentialInstanceId || "default"}</button>}
    </div>
  ),
}));

vi.mock("../../../../hooks/useAgentsMapCache", () => ({
  useAgentsMapCache: () => ({ agents: [], loading: false, agentsMap: new Map() }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.innerWidth = originalInnerWidth;
});

const roleSpecs = [
  ["planning", "Planner"],
  ["execution", "Executor"],
  ["validator", "Reviewer"],
  ["merger", "Merger"],
] as const;

function lane(laneId: string, label: string): ModelLane {
  const prefix = laneId;
  return {
    laneId,
    label: `${label} Model`,
    globalProviderKey: `${prefix}GlobalProvider` as ModelLane["globalProviderKey"],
    globalModelKey: `${prefix}GlobalModelId` as ModelLane["globalModelKey"],
    projectProviderKey: `${prefix}Provider` as ModelLane["projectProviderKey"],
    projectModelKey: `${prefix}ModelId` as ModelLane["projectModelKey"],
    projectThinkingKey: `${prefix}ThinkingLevel` as ModelLane["projectThinkingKey"],
    projectFallbackProviderKey: `${prefix}FallbackProvider` as ModelLane["projectFallbackProviderKey"],
    projectFallbackModelKey: `${prefix}FallbackModelId` as ModelLane["projectFallbackModelKey"],
    projectFallbackThinkingKey: `${prefix}FallbackThinkingLevel` as ModelLane["projectFallbackThinkingKey"],
    helperText: `${label} help`,
    fallbackOrder: "Project → Global → Default",
  };
}

const roleLanes = roleSpecs.map(([id, label]) => lane(id, label));
const defaultLane: ModelLane = {
  laneId: "default",
  label: "Default Model",
  globalProviderKey: "defaultProvider",
  globalModelKey: "defaultModelId",
  projectProviderKey: "defaultProviderOverride",
  projectModelKey: "defaultModelIdOverride",
  projectThinkingKey: "defaultThinkingLevelOverride",
  helperText: "Default help",
  fallbackOrder: "Global default",
};

function createModels(): ProjectModelsSectionModelProps {
  return {
    modelLanes: [defaultLane, ...roleLanes],
    getLaneStatus: () => "inherited",
    getLaneValue: () => "",
    updateLaneValue: vi.fn(),
    resetLaneValue: vi.fn(),
    getLaneThinkingValue: () => "",
    updateLaneThinkingValue: vi.fn(),
    resetLaneThinkingValue: vi.fn(),
    availableModels: [{ provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" }],
    modelsLoading: false,
    favoriteProviders: [],
    favoriteModels: [],
    onToggleFavorite: vi.fn(),
    onToggleModelFavorite: vi.fn(),
    editingPresetId: null,
    setEditingPresetId: vi.fn(),
    presetDraft: null,
    setPresetDraft: vi.fn(),
    onSavePresetDraft: vi.fn(),
    confirmDelete: vi.fn(async () => true),
  };
}

function renderProjectModels(width: number) {
  window.innerWidth = width;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, width, 700));
  let current = { tokenCap: 4096 } as SettingsFormState;
  const models = createModels();
  function Host() {
    const [form, setForm] = useState(current);
    current = form;
    return <ProjectModelsSection form={form} setForm={setForm} models={models} projectId="project-real" addToast={vi.fn()} />;
  }
  render(<Host />);
  return { getForm: () => current, models };
}

function displayedRoleLabels(): string[] {
  const host = screen.getByTestId("project-models-project-lanes");
  return within(host)
    .getAllByRole("button")
    .map((button) => button.textContent ?? "")
    .filter((text) => /^(Default|Planner|Executor|Reviewer|Merger)( Fallback)? Model$/.test(text));
}

/*
FNXC:ProjectModels 2026-09-14-19:24:
Project Settings must present the project-wide Default first, then Planner, Executor, Reviewer, and Merger with each retry model immediately beneath its primary at both desktop and mobile widths. Every role pair carries thinking and credential controls, and Token Cap remains an editable project value.
*/
describe.each([1200, 600])("ProjectModelsSection role lanes at %ipx", (width) => {
  it("keeps the role order and fallback adjacency without a workflow-lane surface", () => {
    renderProjectModels(width);
    expect(displayedRoleLabels()).toEqual([
      "Default Model",
      "Planner Model", "Planner Fallback Model",
      "Executor Model", "Executor Fallback Model",
      "Reviewer Model", "Reviewer Fallback Model",
      "Merger Model", "Merger Fallback Model",
    ]);
    expect(screen.queryByText("Workflow lanes")).not.toBeInTheDocument();
    expect(screen.queryByText("Workflow Model Overrides")).not.toBeInTheDocument();
  });
});

describe("ProjectModelsSection role controls", () => {
  it("exposes thinking and credential selection for every primary and fallback role", () => {
    const { getForm, models } = renderProjectModels(1200);
    for (const [id] of roleSpecs) {
      expect(screen.getByTestId(`thinking-${id}Model`)).toBeInTheDocument();
      expect(screen.getByTestId(`credential-${id}Model`)).toBeInTheDocument();
      expect(screen.getByTestId(`thinking-${id}FallbackModel`)).toBeInTheDocument();
      expect(screen.getByTestId(`credential-${id}FallbackModel`)).toBeInTheDocument();

      fireEvent.click(screen.getByTestId(`thinking-${id}Model`));
      fireEvent.click(screen.getByTestId(`credential-${id}Model`));
      fireEvent.click(screen.getByTestId(`thinking-${id}FallbackModel`));
      fireEvent.click(screen.getByTestId(`credential-${id}FallbackModel`));
    }
    expect(models.updateLaneThinkingValue).toHaveBeenCalledTimes(4);
    expect(getForm()).toMatchObject({
      planningCredentialInstanceId: "credential-2",
      executionCredentialInstanceId: "credential-2",
      validatorCredentialInstanceId: "credential-2",
      mergerCredentialInstanceId: "credential-2",
      planningFallbackThinkingLevel: "high",
      planningFallbackCredentialInstanceId: "credential-2",
      executionFallbackThinkingLevel: "high",
      executionFallbackCredentialInstanceId: "credential-2",
      validatorFallbackThinkingLevel: "high",
      validatorFallbackCredentialInstanceId: "credential-2",
      mergerFallbackThinkingLevel: "high",
      mergerFallbackCredentialInstanceId: "credential-2",
    });
  });

  it("keeps Token Cap editable and routes role edits through the project settings patch", () => {
    const { getForm } = renderProjectModels(1200);
    const tokenCap = screen.getByLabelText("Token Cap");
    expect(tokenCap).toHaveValue(4096);
    fireEvent.change(tokenCap, { target: { value: "8192" } });
    fireEvent.click(within(screen.getByTestId("project-model-lane-planning-fallback")).getByRole("button", { name: "Planner Fallback Model" }));

    const form = getForm();
    expect(form.tokenCap).toBe(8192);
    const { projectPatch, globalPatch } = splitSettingsSave({
      payload: form as unknown as Record<string, unknown>,
      initialValues: null,
      initialScopedValues: { global: {}, project: {} },
      activeSection: "project-models",
    });
    expect(projectPatch).toMatchObject({
      tokenCap: 8192,
      planningFallbackProvider: "anthropic",
      planningFallbackModelId: "claude-sonnet",
    });
    expect(globalPatch).not.toHaveProperty("planningFallbackProvider");
  });
});
