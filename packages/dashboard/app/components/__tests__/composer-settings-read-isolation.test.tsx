import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TaskForm } from "../TaskForm";
import { QuickEntryBox } from "../QuickEntryBox";
import { TaskComments } from "../TaskComments";
import { fetchSettings } from "../../api";
import { __resetVoiceAvailabilityCache } from "../../hooks/useVoiceAvailability";
import type { Task } from "@fusion/core";

vi.mock("../../api", () => ({
  fetchModels: vi.fn().mockResolvedValue({
    models: [{ provider: "anthropic", id: "model", name: "Model", reasoning: false, contextWindow: 128_000 }],
    favoriteProviders: [],
    favoriteModels: [],
  }),
  fetchSettings: vi.fn(),
  fetchWorkflows: vi.fn().mockResolvedValue([]),
  fetchWorkflowOptionalSteps: vi.fn().mockResolvedValue([]),
  fetchGlobalSettings: vi.fn().mockResolvedValue({}),
  refineText: vi.fn().mockResolvedValue(""),
  getRefineErrorMessage: vi.fn(() => "Failed to refine text."),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
  fetchGitBranches: vi.fn().mockResolvedValue([]),
  checkDuplicateTasks: vi.fn().mockResolvedValue([]),
  fetchAgents: vi.fn().mockResolvedValue([]),
  uploadAttachment: vi.fn().mockResolvedValue({}),
  addSteeringComment: vi.fn(),
  updateTaskComment: vi.fn(),
  deleteTaskComment: vi.fn(),
}));

const PROJECT_ID = "voice-settings-project";
const ORIGINAL_INNER_WIDTH = Object.getOwnPropertyDescriptor(window, "innerWidth");
const ORIGINAL_MATCH_MEDIA = Object.getOwnPropertyDescriptor(window, "matchMedia");

function renderTaskForm() {
  return render(
    <TaskForm
      mode="create"
      description=""
      onDescriptionChange={vi.fn()}
      dependencies={[]}
      onDependenciesChange={vi.fn()}
      executorModel=""
      onExecutorModelChange={vi.fn()}
      validatorModel=""
      onValidatorModelChange={vi.fn()}
      presetMode="default"
      onPresetModeChange={vi.fn()}
      selectedPresetId=""
      onSelectedPresetIdChange={vi.fn()}
      pendingImages={[]}
      onImagesChange={vi.fn()}
      tasks={[]}
      addToast={vi.fn()}
      isActive
      reviewLevel={undefined}
      onReviewLevelChange={vi.fn()}
      projectId={PROJECT_ID}
    />,
  );
}

function renderQuickEntryBox() {
  return render(
    <QuickEntryBox
      onCreate={vi.fn().mockResolvedValue(undefined)}
      addToast={vi.fn()}
      tasks={[]}
      availableModels={[]}
      projectId={PROJECT_ID}
    />,
  );
}

function setMobileViewport() {
  Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes("max-width") || query.includes("768"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function restoreViewport() {
  if (ORIGINAL_INNER_WIDTH) Object.defineProperty(window, "innerWidth", ORIGINAL_INNER_WIDTH);
  if (ORIGINAL_MATCH_MEDIA) Object.defineProperty(window, "matchMedia", ORIGINAL_MATCH_MEDIA);
}

const commentTask: Task = {
  id: "FN-8580",
  title: "Voice comments",
  description: "",
  column: "todo",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  comments: [{ id: "comment-1", author: "user", text: "Editable comment", createdAt: "2026-07-25T00:00:00.000Z" }],
  createdAt: "2026-07-25T00:00:00.000Z",
  updatedAt: "2026-07-25T00:00:00.000Z",
};

describe("composer settings-read isolation", () => {
  beforeEach(() => {
    restoreViewport();
    __resetVoiceAvailabilityCache();
    vi.mocked(fetchSettings).mockReset();
    vi.mocked(fetchSettings).mockResolvedValue({} as never);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      enabled: true,
      runtime: { status: "available" },
      model: { status: "installed" },
    }))));
  });

  it("keeps TaskForm's one configured settings response for its real preset picker", async () => {
    vi.mocked(fetchSettings).mockResolvedValueOnce({
      modelPresets: [{ id: "saved", name: "Saved preset", executorProvider: "anthropic", executorModelId: "model" }],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
    } as never);

    renderTaskForm();
    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));

    const preset = await screen.findByLabelText("Preset") as HTMLSelectElement;
    await waitFor(() => expect(Array.from(preset.options).some((option) => option.value === "saved")).toBe(true));
    expect(fetchSettings).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/voice/status?projectId=voice-settings-project");
  });

  it("keeps QuickEntryBox's one configured settings response for the desktop GitHub default", async () => {
    vi.mocked(fetchSettings).mockResolvedValueOnce({ githubTrackingEnabledByDefault: true } as never);

    renderQuickEntryBox();

    await waitFor(() => expect(screen.getByTestId("quick-entry-github-toggle")).toHaveAttribute("aria-pressed", "true"));
    expect(fetchSettings).toHaveBeenCalledTimes(1);
  });

  it("preserves QuickEntryBox's configured GitHub default on the mobile touch layout", async () => {
    setMobileViewport();
    vi.mocked(fetchSettings).mockResolvedValueOnce({ githubTrackingEnabledByDefault: true } as never);

    renderQuickEntryBox();

    const toggle = await screen.findByTestId("quick-entry-github-toggle");
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    fireEvent.pointerDown(toggle, { pointerType: "touch" });
    expect(toggle).toBeInTheDocument();
    expect(fetchSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps TaskComments' two real dictation consumers free of settings reads", async () => {
    render(<TaskComments task={commentTask} addToast={vi.fn()} currentAuthor="user" projectId={PROJECT_ID} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetchSettings).not.toHaveBeenCalled();
  });
});
