import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import { SWR_CACHE_KEYS } from "../../utils/swrCache";
import { ModelSelectorTab } from "../ModelSelectorTab";

vi.mock("../../api", () => ({
  fetchModels: vi.fn(),
  updateTask: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));

const { fetchModels, updateTask } = await import("../../api");
const mockFetchModels = vi.mocked(fetchModels);
const mockUpdateTask = vi.mocked(updateTask);

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-7398",
    title: "Anthropic model selector",
    description: "Verify Claude CLI model selection",
    column: "todo",
    steps: [],
    dependencies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as TaskDetail;
}

async function selectDropdownOption(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByLabelText(label));
  const listbox = await screen.findByRole("listbox");
  await user.click(within(listbox).getByText(option));
}

describe("ModelSelectorTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem(SWR_CACHE_KEYS.MODELS);
    mockFetchModels.mockResolvedValue({
      models: [
        { provider: "pi-claude-cli", id: "claude-sonnet-5", name: "Claude Sonnet 5 (CLI)", reasoning: true, contextWindow: 1_000_000 },
      ],
      favoriteProviders: [],
      favoriteModels: [],
    });
  });

  it("renders and selects Anthropic Claude CLI rows from the shared model catalog", async () => {
    const user = userEvent.setup();
    const addToast = vi.fn();
    const onTaskUpdated = vi.fn();
    const task = makeTask();
    mockUpdateTask.mockResolvedValueOnce({
      ...task,
      modelProvider: "pi-claude-cli",
      modelId: "claude-sonnet-5",
    });

    render(
      <ModelSelectorTab
        task={task}
        addToast={addToast}
        onTaskUpdated={onTaskUpdated}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText(/No models available/i)).not.toBeInTheDocument();
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Executor Model"));

    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getByText("pi-claude-cli")).toBeInTheDocument();
    await user.click(within(listbox).getByText("Claude Sonnet 5 (CLI)"));

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("FN-7398", {
        modelProvider: "pi-claude-cli",
        modelId: "claude-sonnet-5",
      }, undefined);
      expect(onTaskUpdated).toHaveBeenCalledWith(expect.objectContaining({
        modelProvider: "pi-claude-cli",
        modelId: "claude-sonnet-5",
      }));
    });
  });

  it("passes the scoped project id for executor, reviewer, planning, and thinking saves", async () => {
    const user = userEvent.setup();
    const addToast = vi.fn();
    const onTaskUpdated = vi.fn();
    const task = makeTask({
      modelProvider: "pi-claude-cli",
      modelId: "claude-haiku-5",
      validatorModelProvider: "pi-claude-cli",
      validatorModelId: "claude-haiku-5",
      planningModelProvider: "pi-claude-cli",
      planningModelId: "claude-haiku-5",
      mergerModelProvider: "pi-claude-cli",
      mergerModelId: "claude-haiku-5",
      thinkingLevel: "minimal",
    });

    mockFetchModels.mockResolvedValue({
      models: [
        { provider: "pi-claude-cli", id: "claude-haiku-5", name: "Claude Haiku 5 (CLI)", reasoning: true, contextWindow: 200_000 },
        { provider: "pi-claude-cli", id: "claude-sonnet-5", name: "Claude Sonnet 5 (CLI)", reasoning: true, contextWindow: 1_000_000 },
      ],
      favoriteProviders: [],
      favoriteModels: [],
    });
    mockUpdateTask
      .mockResolvedValueOnce({
        ...task,
        modelProvider: "pi-claude-cli",
        modelId: "claude-sonnet-5",
      })
      .mockResolvedValueOnce({
        ...task,
        validatorModelProvider: "pi-claude-cli",
        validatorModelId: "claude-sonnet-5",
      })
      .mockResolvedValueOnce({
        ...task,
        planningModelProvider: "pi-claude-cli",
        planningModelId: "claude-sonnet-5",
      })
      .mockResolvedValueOnce({
        ...task,
        mergerModelProvider: "pi-claude-cli",
        mergerModelId: "claude-sonnet-5",
      })
      .mockResolvedValueOnce({
        ...task,
        thinkingLevel: "high",
      })
      .mockResolvedValueOnce({
        ...task,
        validatorThinkingLevel: "high",
      })
      .mockResolvedValueOnce({
        ...task,
        planningThinkingLevel: "high",
      })
      .mockResolvedValueOnce({
        ...task,
        mergerThinkingLevel: "high",
      });

    render(
      <ModelSelectorTab
        task={task}
        addToast={addToast}
        onTaskUpdated={onTaskUpdated}
        projectId="project-alpha"
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("Executor Model")).toBeInTheDocument());

    await selectDropdownOption(user, "Executor Model", "Claude Sonnet 5 (CLI)");
    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenNthCalledWith(1, "FN-7398", {
        modelProvider: "pi-claude-cli",
        modelId: "claude-sonnet-5",
      }, "project-alpha");
    });

    await selectDropdownOption(user, "Reviewer Model", "Claude Sonnet 5 (CLI)");
    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenNthCalledWith(2, "FN-7398", {
        validatorModelProvider: "pi-claude-cli",
        validatorModelId: "claude-sonnet-5",
      }, "project-alpha");
    });

    await selectDropdownOption(user, "Planning Model", "Claude Sonnet 5 (CLI)");
    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenNthCalledWith(3, "FN-7398", {
        planningModelProvider: "pi-claude-cli",
        planningModelId: "claude-sonnet-5",
      }, "project-alpha");
    });

    await selectDropdownOption(user, "Merger Model", "Claude Sonnet 5 (CLI)");
    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenNthCalledWith(4, "FN-7398", {
        mergerModelProvider: "pi-claude-cli",
        mergerModelId: "claude-sonnet-5",
      }, "project-alpha");
    });

    await user.click(screen.getByRole("button", { name: /Executor Model/ }));
    await user.selectOptions(await screen.findByTestId("custom-model-dropdown-thinking"), "high");
    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenNthCalledWith(5, "FN-7398", {
        thinkingLevel: "high",
      }, "project-alpha");
    });

    await user.click(screen.getByRole("button", { name: /Reviewer Model/ }));
    await user.selectOptions(await screen.findByTestId("custom-model-dropdown-thinking"), "high");
    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenNthCalledWith(6, "FN-7398", {
        validatorThinkingLevel: "high",
      }, "project-alpha");
    });

    await user.click(screen.getByRole("button", { name: /Planning Model/ }));
    await user.selectOptions(await screen.findByTestId("custom-model-dropdown-thinking"), "high");
    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenNthCalledWith(7, "FN-7398", {
        planningThinkingLevel: "high",
      }, "project-alpha");
    });

    await user.click(screen.getByRole("button", { name: /Merger Model/ }));
    await user.selectOptions(await screen.findByTestId("custom-model-dropdown-thinking"), "high");
    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenNthCalledWith(8, "FN-7398", {
        mergerThinkingLevel: "high",
      }, "project-alpha");
    });
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining("set to"), "success");
  });

  it("clears model overrides with the scoped project id", async () => {
    const user = userEvent.setup();
    const task = makeTask({
      modelProvider: "pi-claude-cli",
      modelId: "claude-sonnet-5",
    });
    mockUpdateTask.mockResolvedValueOnce({
      ...task,
      modelProvider: null,
      modelId: null,
    });

    render(
      <ModelSelectorTab
        task={task}
        addToast={vi.fn()}
        onTaskUpdated={vi.fn()}
        projectId="project-alpha"
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("Executor Model")).toBeInTheDocument());
    await selectDropdownOption(user, "Executor Model", "Use default");

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("FN-7398", {
        modelProvider: null,
        modelId: null,
      }, "project-alpha");
    });
  });

  it("renders reviewer and planning thinking badges with default fallback and concrete overrides", async () => {
    const task = makeTask({
      thinkingLevel: "medium",
      validatorThinkingLevel: "high",
      planningThinkingLevel: undefined,
      mergerThinkingLevel: "low",
    });

    render(
      <ModelSelectorTab
        task={task}
        addToast={vi.fn()}
        settings={{ defaultThinkingLevel: "low" } as any}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("Executor Model")).toBeInTheDocument());

    const badges = screen.getAllByTestId("custom-model-dropdown-thinking-badge");
    expect(badges).toHaveLength(4);
    expect(badges[0]).toHaveTextContent("Medium");
    expect(badges[1]).toHaveTextContent("High");
    expect(badges[2]).toHaveTextContent("Default (low)");
    expect(badges[3]).toHaveTextContent("Low");
  });

  it("updates from a cached empty catalog to populated Claude CLI rows without remounting", async () => {
    localStorage.setItem(
      SWR_CACHE_KEYS.MODELS,
      JSON.stringify({
        savedAt: Date.now(),
        data: { models: [], favoriteProviders: [], favoriteModels: [] },
      }),
    );

    render(<ModelSelectorTab task={makeTask()} addToast={vi.fn()} />);

    expect(screen.getByText(/No models available/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByText(/No models available/i)).not.toBeInTheDocument();
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });
  });
});
