// @vitest-environment jsdom
/**
 * Per-section smoke tests for the extracted SettingsModal sections (U9 / KTD-10).
 *
 * These pin the section-component contract: each section reads from `form` and
 * emits edits via `setForm` (the shell keeps persistence/save-split). We cover
 * three representative sections — an Appearance toggle round-trip, a
 * Notifications field, and an Experimental flag — following the dashboard
 * component-test conventions in settings-primitives.test.tsx.
 */
import { useState } from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act, within } from "@testing-library/react";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";

import { AppearanceSection } from "../components/settings/sections/AppearanceSection";
import { GeneralSection } from "../components/settings/sections/GeneralSection";
import { NotificationsSection } from "../components/settings/sections/NotificationsSection";
import { ExperimentalSection } from "../components/settings/sections/ExperimentalSection";
import { MovedSettingsStub } from "../components/settings/sections/MovedSettingsStub";
import { ProjectModelsSection } from "../components/settings/sections/ProjectModelsSection";
import { GlobalModelsSection } from "../components/settings/sections/GlobalModelsSection";
import { PromptsSection } from "../components/settings/sections/PromptsSection";
import { SecretsSection } from "../components/settings/sections/SecretsSection";
import { WorktreesSection } from "../components/settings/sections/WorktreesSection";
import type { SettingsFormState } from "../components/settings/sections/context";
import { fetchWorkflow, fetchWorkflowSettingValues, updateWorkflowSettingValues } from "../api";
import type { WorkflowSettingValuesPayload } from "../api";

vi.mock("../components/AgentPromptsManager", () => ({
  AgentPromptsManager: () => <div data-testid="agent-prompts-manager" />,
}));
vi.mock("../components/SecretsView", () => ({
  SecretsView: () => <div data-testid="secrets-view" />,
}));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    fetchWorkflows: vi.fn(async () => []),
    fetchWorkflow: vi.fn(async () => ({ id: "builtin:coding", name: "Coding", ir: {} })),
    fetchWorkflowSettingValues: vi.fn(async () => ({ stored: {}, effective: {}, orphaned: [] })),
    fetchProjectDefaultWorkflow: vi.fn(async () => ({ workflowId: null })),
    setProjectDefaultWorkflow: vi.fn(async () => ({ workflowId: null })),
    fetchGlobalSettings: vi.fn(async () => ({})),
    updateWorkflowSettingValues: vi.fn(async () => ({ stored: {}, effective: {}, orphaned: [] })),
  };
});
vi.mock("../components/CustomModelDropdown", () => ({
  CustomModelDropdown: ({ id, label, value, onChange, menuWidth = "trigger", showThinkingLevel = false, thinkingLevel = "", onThinkingLevelChange, defaultThinkingLevel }: { id?: string; label: string; value?: string; onChange?: (value: string) => void; menuWidth?: "trigger" | "readable"; showThinkingLevel?: boolean; thinkingLevel?: string; onThinkingLevelChange?: (value: string) => void; defaultThinkingLevel?: string }) => (
    <div>
      <button
        type="button"
        data-testid={`mock-model-dropdown-${id ?? label}`}
        data-menu-width={menuWidth}
        data-value={value ?? ""}
        data-thinking-visible={showThinkingLevel ? "true" : "false"}
        data-thinking-value={thinkingLevel}
        data-default-thinking={defaultThinkingLevel ?? ""}
        onClick={() => onChange?.("anthropic/claude-sonnet-4-5")}
      >
        {label}
      </button>
      <button type="button" data-testid={`mock-model-clear-${id ?? label}`} onClick={() => onChange?.("")}>
        clear
      </button>
      {showThinkingLevel ? (
        <button type="button" data-testid={`mock-thinking-${id ?? label}`} onClick={() => onThinkingLevelChange?.(thinkingLevel ? "" : "high")}>
          thinking:{thinkingLevel || "inherit"}
        </button>
      ) : null}
    </div>
  ),
}));

expect.extend(jestDomMatchers);
beforeEach(() => {
  vi.mocked(fetchWorkflow).mockReset();
  vi.mocked(fetchWorkflowSettingValues).mockReset();
  vi.mocked(updateWorkflowSettingValues).mockReset();
  vi.mocked(fetchWorkflow).mockResolvedValue({ id: "builtin:coding", name: "Coding", ir: {} } as never);
  vi.mocked(fetchWorkflowSettingValues).mockResolvedValue({ stored: {}, effective: {}, orphaned: [] });
  vi.mocked(updateWorkflowSettingValues).mockResolvedValue({ stored: {}, effective: {}, orphaned: [] });
});
afterEach(() => cleanup());

const emptyForm = {} as SettingsFormState;

describe("AppearanceSection", () => {
  function AppearanceHost() {
    const [hidden, setHidden] = useState(false);
    return (
      <AppearanceSection
        scopeBanner={null}
        form={emptyForm}
        setForm={vi.fn()}
        themeMode="dark"
        colorTheme="default"
        dashboardFontScalePct={100}
        sessionBannersHidden={hidden}
        setSessionBannersHidden={setHidden}
      />
    );
  }

  it("round-trips the session-banner toggle through its setter", () => {
    render(<AppearanceHost />);
    const toggle = screen.getByText("Hide AI session notification banners")
      .closest("label")!
      .querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
  });
});

describe("GeneralSection", () => {
  it("emits the absolute file-browser path toggle via setForm", () => {
    function GeneralHost() {
      const [form, setForm] = useState({ allowAbsoluteFileBrowserPaths: false } as SettingsFormState);
      return (
        <GeneralSection
          scopeBanner={null}
          form={form}
          setForm={setForm}
          addToast={vi.fn()}
          prefixError={null}
          setPrefixError={vi.fn()}
          projectTrackingRepoOptions={[]}
          projectTrackingRepoLoading={false}
          projectTrackingRepoError={null}
        />
      );
    }

    render(<GeneralHost />);

    const checkbox = screen.getByLabelText(/Allow absolute file-browser paths/i) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);

    expect(checkbox.checked).toBe(true);
  });
});

describe("NotificationsSection", () => {
  it("emits the chosen failure-notification mode via setForm", () => {
    const setForm = vi.fn();
    render(
      <NotificationsSection
        scopeBanner={null}
        form={emptyForm}
        setForm={setForm}
        testNotificationLoading={{}}
        testNotificationResult={{}}
        onTestProviderNotification={vi.fn()}
      />,
    );
    const select = screen.getByLabelText("Failure notification mode") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "all" } });
    expect(setForm).toHaveBeenCalledTimes(1);
    const updater = setForm.mock.calls[0][0] as (f: SettingsFormState) => SettingsFormState;
    expect(updater(emptyForm)).toMatchObject({ failureNotificationMode: "all" });
  });

  it("shows the ntfy topic field only when ntfy is enabled", () => {
    const { rerender } = render(
      <NotificationsSection
        scopeBanner={null}
        form={{ ntfyEnabled: false } as SettingsFormState}
        setForm={vi.fn()}
        testNotificationLoading={{}}
        testNotificationResult={{}}
        onTestProviderNotification={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("ntfy Topic")).not.toBeInTheDocument();
    rerender(
      <NotificationsSection
        scopeBanner={null}
        form={{ ntfyEnabled: true } as SettingsFormState}
        setForm={vi.fn()}
        testNotificationLoading={{}}
        testNotificationResult={{}}
        onTestProviderNotification={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("ntfy Topic")).toBeInTheDocument();
  });
});

describe("SecretsSection", () => {
  it("renders the scope banner, title, and the SecretsView card", () => {
    render(
      <SecretsSection scopeBanner={<div data-testid="scope-banner" />} addToast={vi.fn()} />,
    );
    expect(screen.getByTestId("scope-banner")).toBeInTheDocument();
    expect(screen.getByText("Secrets")).toBeInTheDocument();
    expect(screen.getByTestId("secrets-view")).toBeInTheDocument();
  });
});

describe("WorktreesSection", () => {
  const worktrunkInstall = {
    status: "installed",
    version: "1.0.0",
    installPath: "/tmp/worktrunk",
    requesting: false,
    requestInstall: vi.fn(),
  } as never;

  it("renders editable copy-file rows with add, browse, and remove controls", () => {
    const onChange = vi.fn();
    const onBrowse = vi.fn();
    const onRemove = vi.fn();
    const onAdd = vi.fn();
    render(
      <WorktreesSection
        scopeBanner={null}
        form={{ recycleWorktrees: false, worktreeCopyFiles: [".env"] } as SettingsFormState}
        setForm={vi.fn()}
        gitRemotes={[]}
        worktrunkInstall={worktrunkInstall}
        worktrunkInstallVerified={true}
        onOpenWorktreesDirPicker={vi.fn()}
        onWorktreeCopyFileChange={onChange}
        onRemoveWorktreeCopyFile={onRemove}
        onAddWorktreeCopyFile={onAdd}
        onOpenWorktreeCopyFilePicker={onBrowse}
      />,
    );

    expect(screen.getByText("Files to copy into new worktrees")).toBeInTheDocument();
    const input = screen.getByLabelText("File to copy into new worktrees") as HTMLInputElement;
    expect(input.value).toBe(".env");
    fireEvent.change(input, { target: { value: "config/local.env" } });
    expect(onChange).toHaveBeenCalledWith(0, "config/local.env");
    fireEvent.click(screen.getByRole("button", { name: "Browse file to copy into new worktrees" }));
    expect(onBrowse).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByRole("button", { name: "Remove copied worktree file" }));
    expect(onRemove).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByRole("button", { name: "Add file" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("renders and toggles the board worktree grouping checkbox", () => {
    const setForm = vi.fn((updater: SettingsFormState | ((prev: SettingsFormState) => SettingsFormState)) => {
      if (typeof updater === "function") {
        return updater({ recycleWorktrees: false, showWorktreeGrouping: false } as SettingsFormState);
      }
      return updater;
    });

    render(
      <WorktreesSection
        scopeBanner={null}
        form={{ recycleWorktrees: false, showWorktreeGrouping: false, worktreeCopyFiles: [] } as SettingsFormState}
        setForm={setForm}
        gitRemotes={[]}
        worktrunkInstall={worktrunkInstall}
        worktrunkInstallVerified={true}
        onOpenWorktreesDirPicker={vi.fn()}
        onWorktreeCopyFileChange={vi.fn()}
        onRemoveWorktreeCopyFile={vi.fn()}
        onAddWorktreeCopyFile={vi.fn()}
        onOpenWorktreeCopyFilePicker={vi.fn()}
      />,
    );

    const checkbox = screen.getByLabelText(/Show worktree grouping on the board/i) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);

    expect(setForm).toHaveBeenCalledTimes(1);
    expect(setForm.mock.results[0]?.value).toMatchObject({ showWorktreeGrouping: true });
  });

  it("keeps an empty copy-file row reachable when the setting is undefined", () => {
    render(
      <WorktreesSection
        scopeBanner={null}
        form={{ recycleWorktrees: false, worktreeCopyFiles: undefined } as SettingsFormState}
        setForm={vi.fn()}
        gitRemotes={[]}
        worktrunkInstall={worktrunkInstall}
        worktrunkInstallVerified={true}
        onOpenWorktreesDirPicker={vi.fn()}
        onWorktreeCopyFileChange={vi.fn()}
        onRemoveWorktreeCopyFile={vi.fn()}
        onAddWorktreeCopyFile={vi.fn()}
        onOpenWorktreeCopyFilePicker={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("File to copy into new worktrees")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Browse file to copy into new worktrees" })).toBeInTheDocument();
  });
});

describe("GlobalModelsSection", () => {
  it("wires global model lane thinking overrides", () => {
    const updateLaneThinkingValue = vi.fn();
    render(
      <GlobalModelsSection
        scopeBanner={null}
        form={{ defaultThinkingLevel: "low" } as SettingsFormState}
        setForm={vi.fn()}
        availableModels={[{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }]}
        modelsLoading={false}
        globalModelLanes={[{ laneId: "execution", label: "Execution", helperText: "Execution", fallbackOrder: "default", globalProviderKey: "executionGlobalProvider", globalModelKey: "executionGlobalModelId", globalThinkingKey: "executionGlobalThinkingLevel" } as never]}
        getLaneThinkingValue={() => "medium"}
        updateLaneThinkingValue={updateLaneThinkingValue}
        resetLaneThinkingValue={vi.fn()}
        favoriteProviders={[]}
        favoriteModels={[]}
        onToggleFavorite={vi.fn()}
        onToggleModelFavorite={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    expect(screen.getByTestId("mock-model-dropdown-global-execution-model")).toHaveAttribute("data-thinking-visible", "true");
    expect(screen.getByTestId("mock-model-dropdown-global-execution-model")).toHaveAttribute("data-thinking-value", "medium");
    expect(screen.getByTestId("mock-model-dropdown-global-execution-model")).toHaveAttribute("data-default-thinking", "low");
    fireEvent.click(screen.getByTestId("mock-thinking-global-execution-model"));
    expect(updateLaneThinkingValue).toHaveBeenCalledWith(expect.objectContaining({ laneId: "execution" }), "");
  });

  it("wires global fallback thinking value and clears it with the fallback model", () => {
    function GlobalFallbackHost() {
      const [form, setForm] = useState<SettingsFormState>({
        defaultThinkingLevel: "medium",
        fallbackProvider: "anthropic",
        fallbackModelId: "claude-sonnet-4-5",
        fallbackThinkingLevel: "high",
      } as SettingsFormState);
      return (
        <GlobalModelsSection
          scopeBanner={null}
          form={form}
          setForm={setForm}
          availableModels={[{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true }]}
          modelsLoading={false}
          globalModelLanes={[]}
          getLaneThinkingValue={() => ""}
          updateLaneThinkingValue={vi.fn()}
          resetLaneThinkingValue={vi.fn()}
          favoriteProviders={[]}
          favoriteModels={[]}
          onToggleFavorite={vi.fn()}
          onToggleModelFavorite={vi.fn()}
          addToast={vi.fn()}
        />
      );
    }

    render(<GlobalFallbackHost />);

    expect(screen.getByTestId("mock-model-dropdown-fallbackModel")).toHaveAttribute("data-thinking-visible", "true");
    expect(screen.getByTestId("mock-model-dropdown-fallbackModel")).toHaveAttribute("data-thinking-value", "high");
    expect(screen.getByTestId("mock-model-dropdown-fallbackModel")).toHaveAttribute("data-default-thinking", "medium");

    fireEvent.click(screen.getByTestId("mock-thinking-fallbackModel"));
    expect(screen.getByTestId("mock-model-dropdown-fallbackModel")).toHaveAttribute("data-thinking-value", "");

    fireEvent.click(screen.getByTestId("mock-thinking-fallbackModel"));
    expect(screen.getByTestId("mock-model-dropdown-fallbackModel")).toHaveAttribute("data-thinking-value", "high");

    fireEvent.click(screen.getByTestId("mock-model-clear-fallbackModel"));
    expect(screen.getByTestId("mock-model-dropdown-fallbackModel")).toHaveAttribute("data-value", "");
    expect(screen.getByTestId("mock-model-dropdown-fallbackModel")).toHaveAttribute("data-thinking-value", "");
  });
});

describe("ProjectModelsSection", () => {
  const models = {
    modelLanes: [],
    getLaneStatus: () => "inherited" as const,
    getLaneValue: () => "",
    updateLaneValue: vi.fn(),
    resetLaneValue: vi.fn(),
    getLaneThinkingValue: () => "",
    updateLaneThinkingValue: vi.fn(),
    resetLaneThinkingValue: vi.fn(),
    availableModels: [],
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
    confirmDelete: vi.fn(),
  };

  it("opts Project Models lane and preset dropdowns into readable menu width", () => {
    render(
      <ProjectModelsSection
        scopeBanner={null}
        form={{} as SettingsFormState}
        setForm={vi.fn()}
        models={{
          ...models,
          modelLanes: [
            { laneId: "default", label: "Default", helperText: "Default", fallbackOrder: "global" },
            { laneId: "summarization", label: "Summarization", helperText: "Summarization", fallbackOrder: "global" },
          ] as never,
          availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
          presetDraft: { id: "preset", name: "Preset", executorProvider: undefined, executorModelId: undefined, validatorProvider: undefined, validatorModelId: undefined },
        }}
        addToast={vi.fn()}
      />,
    );

    expect(screen.getByTestId("mock-model-dropdown-defaultModel")).toHaveAttribute("data-menu-width", "readable");
    expect(screen.getByTestId("mock-model-dropdown-summarizationModel")).toHaveAttribute("data-menu-width", "readable");
    expect(screen.getByTestId("mock-model-dropdown-preset-executor-model")).toHaveAttribute("data-menu-width", "readable");
    expect(screen.getByTestId("mock-model-dropdown-preset-validator-model")).toHaveAttribute("data-menu-width", "readable");
  });

  it("wires project model lane thinking overrides and reset", () => {
    const updateLaneThinkingValue = vi.fn();
    const resetLaneThinkingValue = vi.fn();
    const resetLaneValue = vi.fn();
    render(
      <ProjectModelsSection
        scopeBanner={null}
        form={{ defaultThinkingLevel: "medium" } as SettingsFormState}
        setForm={vi.fn()}
        models={{
          ...models,
          modelLanes: [
            { laneId: "default", label: "Default", helperText: "Default", fallbackOrder: "global", projectThinkingKey: "defaultThinkingLevelOverride" },
          ] as never,
          getLaneThinkingValue: () => "high",
          updateLaneThinkingValue,
          resetLaneThinkingValue,
          resetLaneValue,
          availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
        }}
        addToast={vi.fn()}
      />,
    );

    expect(screen.getByTestId("mock-model-dropdown-defaultModel")).toHaveAttribute("data-thinking-visible", "true");
    expect(screen.getByTestId("mock-model-dropdown-defaultModel")).toHaveAttribute("data-thinking-value", "high");
    expect(screen.getByTestId("mock-model-dropdown-defaultModel")).toHaveAttribute("data-default-thinking", "medium");

    fireEvent.click(screen.getByTestId("mock-thinking-defaultModel"));
    expect(updateLaneThinkingValue).toHaveBeenCalledWith(expect.objectContaining({ laneId: "default" }), "");

    fireEvent.click(screen.getByText(/Reset/));
    expect(resetLaneValue).toHaveBeenCalledWith(expect.objectContaining({ laneId: "default" }));
    expect(resetLaneThinkingValue).toHaveBeenCalledWith(expect.objectContaining({ laneId: "default" }));
  });

  it("wires project title-summarizer fallback thinking and clears it with reset", () => {
    function ProjectTitleFallbackHost() {
      const [form, setForm] = useState<SettingsFormState>({
        defaultThinkingLevel: "medium",
        titleSummarizerFallbackProvider: "anthropic",
        titleSummarizerFallbackModelId: "claude-sonnet-4-5",
        titleSummarizerFallbackThinkingLevel: "high",
      } as SettingsFormState);
      return (
        <ProjectModelsSection
          scopeBanner={null}
          form={form}
          setForm={setForm}
          models={{
            ...models,
            availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
          }}
          addToast={vi.fn()}
        />
      );
    }

    render(<ProjectTitleFallbackHost />);

    const dropdown = screen.getByTestId("mock-model-dropdown-titleSummarizerFallbackModel");
    expect(dropdown).toHaveAttribute("data-thinking-visible", "true");
    expect(dropdown).toHaveAttribute("data-thinking-value", "high");
    expect(dropdown).toHaveAttribute("data-default-thinking", "medium");

    fireEvent.click(screen.getByTestId("mock-thinking-titleSummarizerFallbackModel"));
    expect(screen.getByTestId("mock-model-dropdown-titleSummarizerFallbackModel")).toHaveAttribute("data-thinking-value", "");

    fireEvent.click(screen.getByTestId("mock-thinking-titleSummarizerFallbackModel"));
    expect(screen.getByTestId("mock-model-dropdown-titleSummarizerFallbackModel")).toHaveAttribute("data-thinking-value", "high");

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByTestId("mock-model-dropdown-titleSummarizerFallbackModel")).toHaveAttribute("data-value", "");
    expect(screen.getByTestId("mock-model-dropdown-titleSummarizerFallbackModel")).toHaveAttribute("data-thinking-value", "");
  });

  it("wires workflow fallback lane thinking render, persist, and reset", async () => {
    let saver: (() => Promise<void>) | null = null;
    vi.mocked(fetchWorkflow).mockResolvedValue({
      id: "builtin:coding",
      name: "Coding",
      ir: {
        settings: [
          { id: "planningFallbackProvider", name: "Planning fallback provider", type: "string" },
          { id: "planningFallbackModelId", name: "Planning fallback model", type: "string" },
          { id: "planningFallbackThinkingLevel", name: "Planning fallback thinking", type: "enum" },
          { id: "validatorFallbackProvider", name: "Reviewer fallback provider", type: "string" },
          { id: "validatorFallbackModelId", name: "Reviewer fallback model", type: "string" },
          { id: "validatorFallbackThinkingLevel", name: "Reviewer fallback thinking", type: "enum" },
        ],
      },
    } as never);
    vi.mocked(fetchWorkflowSettingValues).mockResolvedValueOnce({
      stored: { validatorFallbackProvider: "anthropic", validatorFallbackModelId: "claude-sonnet-4-5", validatorFallbackThinkingLevel: "high" },
      effective: { validatorFallbackProvider: "anthropic", validatorFallbackModelId: "claude-sonnet-4-5", validatorFallbackThinkingLevel: "high" },
      orphaned: [],
    });
    vi.mocked(updateWorkflowSettingValues).mockResolvedValueOnce({
      stored: { validatorFallbackProvider: "anthropic", validatorFallbackModelId: "claude-sonnet-4-5", validatorFallbackThinkingLevel: "high" },
      effective: { validatorFallbackProvider: "anthropic", validatorFallbackModelId: "claude-sonnet-4-5", validatorFallbackThinkingLevel: "high" },
      orphaned: [],
    });

    render(
      <ProjectModelsSection
        scopeBanner={null}
        form={{ defaultWorkflowId: "builtin:coding", defaultThinkingLevel: "medium" } as SettingsFormState}
        setForm={vi.fn()}
        models={{
          ...models,
          availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
        }}
        projectId="project-1"
        addToast={vi.fn()}
        registerWorkflowLaneSaver={(next) => {
          saver = next;
        }}
      />,
    );

    const planning = await screen.findByTestId("mock-model-dropdown-workflow-planning-fallback-model");
    expect(planning).toHaveAttribute("data-thinking-visible", "true");
    expect(planning).toHaveAttribute("data-default-thinking", "medium");
    expect(screen.getByTestId("mock-model-dropdown-workflow-validator-fallback-model")).toHaveAttribute("data-thinking-value", "high");

    fireEvent.click(screen.getByTestId("mock-thinking-workflow-planning-fallback-model"));
    await act(async () => {
      await saver!();
    });
    expect(updateWorkflowSettingValues).toHaveBeenLastCalledWith("builtin:coding", { planningFallbackThinkingLevel: "high" }, "project-1");

    fireEvent.click(within(screen.getByTestId("workflow-model-lane-validator-fallback")).getByRole("button", { name: "Reset" }));
    await act(async () => {
      await saver!();
    });
    expect(updateWorkflowSettingValues).toHaveBeenLastCalledWith("builtin:coding", {
      validatorFallbackProvider: null,
      validatorFallbackModelId: null,
      validatorFallbackThinkingLevel: null,
    }, "project-1");
  });

  it("opts default workflow model lane dropdowns into readable menu width", async () => {
    vi.mocked(fetchWorkflow).mockResolvedValue({
      id: "builtin:coding",
      name: "Coding",
      ir: {
        settings: [
          { id: "planningProvider", name: "Planning Provider", type: "string" },
          { id: "planningModelId", name: "Planning Model", type: "string" },
          { id: "planningThinkingLevel", name: "Planning thinking", type: "enum" },
        ],
      },
    } as never);
    vi.mocked(fetchWorkflowSettingValues).mockResolvedValueOnce({ stored: {}, effective: {}, orphaned: [] });

    render(
      <ProjectModelsSection
        scopeBanner={null}
        form={{ defaultWorkflowId: "builtin:coding" } as SettingsFormState}
        setForm={vi.fn()}
        models={{
          ...models,
          availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
        }}
        projectId="project-1"
        addToast={vi.fn()}
      />,
    );

    expect(await screen.findByTestId("mock-model-dropdown-workflow-planning-model")).toHaveAttribute("data-menu-width", "readable");
  });

  it("preserves workflow lane edits made while the registered saver is in flight", async () => {
    let saver: (() => Promise<void>) | null = null;
    let resolveSave!: (value: WorkflowSettingValuesPayload) => void;
    vi.mocked(fetchWorkflow).mockResolvedValue({
      id: "builtin:coding",
      name: "Coding",
      ir: {
        settings: [
          { id: "planningProvider", name: "Planning Provider", type: "string" },
          { id: "planningModelId", name: "Planning Model", type: "string" },
          { id: "planningThinkingLevel", name: "Planning thinking", type: "enum" },
          { id: "executionProvider", name: "Execution Provider", type: "string" },
          { id: "executionModelId", name: "Execution Model", type: "string" },
          { id: "executionThinkingLevel", name: "Execution thinking", type: "enum" },
        ],
      },
    } as never);
    vi.mocked(fetchWorkflowSettingValues).mockResolvedValueOnce({ stored: {}, effective: {}, orphaned: [] });
    vi.mocked(updateWorkflowSettingValues)
      .mockReturnValueOnce(
        new Promise<WorkflowSettingValuesPayload>((resolve) => {
          resolveSave = resolve;
        }),
      )
      .mockResolvedValueOnce({
        stored: { executionProvider: "anthropic", executionModelId: "claude-sonnet-4-5" },
        effective: { executionProvider: "anthropic", executionModelId: "claude-sonnet-4-5" },
        orphaned: [],
      });

    render(
      <ProjectModelsSection
        scopeBanner={null}
        form={{ defaultWorkflowId: "builtin:coding" } as SettingsFormState}
        setForm={vi.fn()}
        models={{
          ...models,
          availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
        }}
        projectId="project-1"
        addToast={vi.fn()}
        registerWorkflowLaneSaver={(next) => {
          saver = next;
        }}
      />,
    );

    const planning = await screen.findByTestId("mock-model-dropdown-workflow-planning-model");
    const execution = await screen.findByTestId("mock-model-dropdown-workflow-execution-model");
    fireEvent.click(planning);
    await waitFor(() => expect(planning).toHaveAttribute("data-value", "anthropic/claude-sonnet-4-5"));

    const firstSave = saver!();
    await waitFor(() => expect(updateWorkflowSettingValues).toHaveBeenCalledTimes(1));
    expect(updateWorkflowSettingValues).toHaveBeenNthCalledWith(
      1,
      "builtin:coding",
      { planningProvider: "anthropic", planningModelId: "claude-sonnet-4-5" },
      "project-1",
    );

    fireEvent.click(execution);
    await waitFor(() => expect(execution).toHaveAttribute("data-value", "anthropic/claude-sonnet-4-5"));
    await act(async () => {
      resolveSave({
        stored: { planningProvider: "anthropic", planningModelId: "claude-sonnet-4-5" },
        effective: { planningProvider: "anthropic", planningModelId: "claude-sonnet-4-5" },
        orphaned: [],
      });
      await firstSave;
    });

    expect(execution).toHaveAttribute("data-value", "anthropic/claude-sonnet-4-5");
    await act(async () => {
      await saver!();
    });
    await waitFor(() => expect(updateWorkflowSettingValues).toHaveBeenCalledTimes(2));
    expect(updateWorkflowSettingValues).toHaveBeenNthCalledWith(
      2,
      "builtin:coding",
      { executionProvider: "anthropic", executionModelId: "claude-sonnet-4-5" },
      "project-1",
    );
  });

  it("renders PR prompt guidance textareas and emits edits through setForm", () => {
    function ProjectModelsHost() {
      const [form, setFormState] = useState<SettingsFormState>({
        prTitlePromptInstructions: "Keep it short.",
        prDescriptionPromptInstructions: "Mention testing.",
      } as SettingsFormState);
      return (
        <ProjectModelsSection
          scopeBanner={null}
          form={form}
          setForm={setFormState as never}
          models={models}
          addToast={vi.fn()}
        />
      );
    }

    render(<ProjectModelsHost />);

    const titleField = screen.getByLabelText("PR title prompt guidance") as HTMLTextAreaElement;
    const descriptionField = screen.getByLabelText("PR description prompt guidance") as HTMLTextAreaElement;
    expect(titleField.value).toBe("Keep it short.");
    expect(descriptionField.value).toBe("Mention testing.");

    fireEvent.change(titleField, { target: { value: "Use release style." } });
    fireEvent.change(descriptionField, { target: { value: "Group by impact." } });

    expect(titleField.value).toBe("Use release style.");
    expect(descriptionField.value).toBe("Group by impact.");
  });
});

describe("PromptsSection", () => {
  it("renders the title and mounts AgentPromptsManager", () => {
    render(
      <PromptsSection scopeBanner={null} form={emptyForm} setForm={vi.fn()} />,
    );
    expect(screen.getByText("Prompts")).toBeInTheDocument();
    expect(screen.getByTestId("agent-prompts-manager")).toBeInTheDocument();
  });
});

describe("MovedSettingsStub", () => {
  it("renders the message and fires the open-workflow-settings callback", () => {
    const onOpen = vi.fn();
    render(<MovedSettingsStub message="Step execution moved" onOpenWorkflowSettings={onOpen} />);
    expect(screen.getByText("Step execution moved")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open workflow settings" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("disables the action when no handler is wired", () => {
    render(<MovedSettingsStub message="Moved" />);
    expect(screen.getByRole("button", { name: "Open workflow settings" })).toBeDisabled();
  });
});

describe("ExperimentalSection", () => {
  const knownFeatures = { insights: "Insights" };
  const legacyAliases: Record<string, string> = { devServer: "devServerView" };
  const getCanonicalKey = (k: string) => legacyAliases[k] ?? k;
  const isFeatureEnabled = (features: Record<string, boolean>, key: string) => features[key] === true;

  // Stateful host so the controlled checkbox actually toggles between renders
  // (a bare mock setForm never re-renders, so jsdom reports the bound value).
  function ExperimentalHost() {
    const [form, setFormState] = useState<SettingsFormState>(
      { experimentalFeatures: {} } as SettingsFormState,
    );
    return (
      <ExperimentalSection
        scopeBanner={null}
        form={form}
        setForm={setFormState as never}
        knownFeatures={knownFeatures}
        legacyAliases={legacyAliases}
        getCanonicalKey={getCanonicalKey}
        isFeatureEnabled={isFeatureEnabled}
      />
    );
  }

  it("renders a row per known flag and round-trips the canonical key", () => {
    render(<ExperimentalHost />);
    expect(screen.getByText("Insights")).toBeInTheDocument();
    expect(screen.queryByText("Roadmaps")).not.toBeInTheDocument();

    const insightsToggle = document.getElementById("experimental-insights") as HTMLInputElement;
    expect(insightsToggle.checked).toBe(false);
    fireEvent.click(insightsToggle);
    expect(insightsToggle.checked).toBe(true);
    fireEvent.click(insightsToggle);
    expect(insightsToggle.checked).toBe(false);
  });
});
