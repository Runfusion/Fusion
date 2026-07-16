// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectModelsSection } from "../ProjectModelsSection";
import type { ProjectModelsSectionModelProps } from "../ProjectModelsSection";
import type { SettingsFormState } from "../context";
import { fetchWorkflow, fetchWorkflowSettingValues, updateWorkflowSettingValues } from "../../../../api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

vi.mock("../../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../api")>();
  return {
    ...actual,
    fetchWorkflow: vi.fn(async () => ({ id: "builtin:coding", name: "Coding", ir: {} })),
    fetchWorkflowSettingValues: vi.fn(async () => ({ stored: {}, effective: {}, orphaned: [] })),
    updateWorkflowSettingValues: vi.fn(async () => ({ stored: {}, effective: {}, orphaned: [] })),
  };
});

vi.mock("../../../CustomModelDropdown", () => ({
  CustomModelDropdown: ({ id, label, value, onChange, showThinkingLevel, thinkingLevel, onThinkingLevelChange, defaultThinkingLevel }: {
    id?: string;
    label: string;
    value?: string;
    onChange?: (value: string) => void;
    showThinkingLevel?: boolean;
    thinkingLevel?: string;
    onThinkingLevelChange?: (value: string) => void;
    defaultThinkingLevel?: string;
  }) => (
    <div data-testid={`mock-model-host-${id ?? label}`} data-value={value ?? ""} data-default-thinking={defaultThinkingLevel ?? ""}>
      <button type="button" data-testid={`mock-model-dropdown-${id ?? label}`} onClick={() => onChange?.("anthropic/claude-sonnet-4-5")}>{label}</button>
      {showThinkingLevel ? <button type="button" data-testid={`mock-thinking-${id ?? label}`} onClick={() => onThinkingLevelChange?.(thinkingLevel ? "" : "high")}>thinking:{thinkingLevel || "inherit"}</button> : null}
    </div>
  ),
}));

vi.mock("../../../../hooks/useAgentsMapCache", () => ({
  useAgentsMapCache: () => ({
    loading: false,
    agents: [
      { id: "agent-alpha", name: "Alpha", role: "engineer" },
      { id: "agent-review", name: "Review", role: "reviewer" },
    ],
    agentsMap: new Map(),
  }),
}));

expect.extend(jestDomMatchers);

afterEach(() => cleanup());

beforeEach(() => {
  vi.mocked(fetchWorkflow).mockResolvedValue({ id: "builtin:coding", name: "Coding", ir: {} } as never);
  vi.mocked(fetchWorkflowSettingValues).mockResolvedValue({ stored: {}, effective: {}, orphaned: [] });
  vi.mocked(updateWorkflowSettingValues).mockResolvedValue({ stored: {}, effective: {}, orphaned: [] });
});

const models: ProjectModelsSectionModelProps = {
  modelLanes: [],
  getLaneStatus: () => "inherited",
  getLaneValue: () => "",
  updateLaneValue: vi.fn(),
  resetLaneValue: vi.fn(),
  getLaneThinkingValue: () => "",
  updateLaneThinkingValue: vi.fn(),
  resetLaneThinkingValue: vi.fn(),
  availableModels: [{ id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet" }],
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

function renderSection(initialForm: SettingsFormState = { defaultThinkingLevel: "medium" } as SettingsFormState) {
  let latestForm = initialForm;
  function Host() {
    const [form, setForm] = useState(initialForm);
    latestForm = form;
    return (
      <ProjectModelsSection
        form={form}
        setForm={setForm}
        models={models}
        projectId="project-1"
        addToast={vi.fn()}
      />
    );
  }
  render(<Host />);
  return { getForm: () => latestForm };
}

describe("ProjectModelsSection Chat default settings", () => {
  it("renders the Chat subsection with prompt mode and model controls by default", () => {
    renderSection();

    expect(screen.getByRole("heading", { name: "Chat" })).toBeInTheDocument();
    expect(screen.getByLabelText("New Chat behavior")).toHaveValue("prompt");
    expect(screen.getByTestId("project-models-chat-model")).toBeInTheDocument();
    expect(screen.getByTestId("mock-model-host-chatDefaultModel")).toHaveAttribute("data-default-thinking", "medium");
  });

  it("swaps between model and agent controls", () => {
    renderSection();

    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(screen.getByTestId("project-models-chat-agent")).toBeInTheDocument();
    expect(screen.getByLabelText("Chat Default Agent")).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByTestId("project-models-chat-model")).toBeInTheDocument();
  });

  it("selecting a model writes provider/model and clears the agent", () => {
    const { getForm } = renderSection({ chatDefaultKind: "agent", chatDefaultAgentId: "agent-alpha" } as SettingsFormState);

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(screen.getByTestId("mock-model-dropdown-chatDefaultModel"));

    expect(getForm()).toMatchObject({
      chatDefaultKind: "model",
      chatDefaultModelProvider: "anthropic",
      chatDefaultModelId: "claude-sonnet-4-5",
      chatDefaultAgentId: undefined,
    });
  });

  it("selecting an agent writes the agent id and clears model fields", () => {
    const { getForm } = renderSection({
      chatDefaultKind: "model",
      chatDefaultModelProvider: "anthropic",
      chatDefaultModelId: "claude-sonnet-4-5",
      chatDefaultThinkingLevel: "high",
    } as SettingsFormState);

    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    fireEvent.change(screen.getByLabelText("Chat Default Agent"), { target: { value: "agent-review" } });

    expect(getForm()).toMatchObject({
      chatDefaultKind: "agent",
      chatDefaultAgentId: "agent-review",
      chatDefaultModelProvider: undefined,
      chatDefaultModelId: undefined,
      chatDefaultThinkingLevel: undefined,
    });
  });

  it("setting the mode writes chatNewSessionMode", () => {
    const { getForm } = renderSection();

    fireEvent.change(screen.getByLabelText("New Chat behavior"), { target: { value: "always-default" } });

    expect(getForm().chatNewSessionMode).toBe("always-default");
  });

  it("Reset clears all chat default fields", () => {
    const { getForm } = renderSection({
      chatNewSessionMode: "always-default",
      chatDefaultKind: "model",
      chatDefaultModelProvider: "anthropic",
      chatDefaultModelId: "claude-sonnet-4-5",
      chatDefaultThinkingLevel: "high",
      chatDefaultAgentId: "agent-alpha",
    } as SettingsFormState);

    fireEvent.click(screen.getByTitle("Reset Chat default"));

    expect(getForm()).toMatchObject({
      chatNewSessionMode: undefined,
      chatDefaultKind: undefined,
      chatDefaultAgentId: undefined,
      chatDefaultModelProvider: undefined,
      chatDefaultModelId: undefined,
      chatDefaultThinkingLevel: undefined,
    });
  });
});
