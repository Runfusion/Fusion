import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadAllAppCss } from "../../test/cssFixture";
import { useState } from "react";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewAgentDialog } from "../NewAgentDialog";
import * as apiModule from "../../api";

// Mock the API module
vi.mock("../../api", () => ({
  createAgent: vi.fn(),
  fetchAgents: vi.fn(),
  fetchModels: vi.fn(),
  fetchPluginRuntimes: vi.fn(),
  updateGlobalSettings: vi.fn(),
  fetchDiscoveredSkills: vi.fn(),
}));

// Mock SkillMultiselect
vi.mock("../SkillMultiselect", () => ({
  SkillMultiselect: ({ value, onChange, id }: { value: string[]; onChange: (v: string[]) => void; id?: string }) => (
    <div data-testid="skill-multiselect">
      <span data-testid="skill-multiselect-value">{JSON.stringify(value)}</span>
      <button data-testid="add-skill-1" onClick={() => onChange([...value, "skill-1"])}>Add Skill 1</button>
      <button data-testid="add-skill-2" onClick={() => onChange([...value, "skill-2"])}>Add Skill 2</button>
      <button data-testid="remove-skill-1" onClick={() => onChange(value.filter(s => s !== "skill-1"))}>Remove Skill 1</button>
    </div>
  ),
}));

// Mock AgentGenerationModal
vi.mock("../ExperimentalAgentOnboardingModal", () => ({
  ExperimentalAgentOnboardingModal: ({ isOpen, onClose, onUseDraft, mode }: { isOpen: boolean; onClose: () => void; onUseDraft: (draft: any) => void; mode?: "create" | "edit" }) => {
    if (!isOpen) return null;
    return (
      <div role="dialog" aria-label="AI Interview">
        <div data-testid="interview-mode">{mode}</div>
        <button onClick={onClose}>Close Interview</button>
        <button
          onClick={() => onUseDraft({
            name: "Interview Draft",
            role: "reviewer",
            title: "Interview Title",
            icon: "🤖",
            reportsTo: "agent-manager-1",
            instructionsText: "Interview instructions",
            soul: "Interview soul",
            memory: "Interview memory",
            skills: ["skill-1"],
            heartbeatProcedurePath: ".fusion/agents/interview/HEARTBEAT.md",
            runtimeHint: "openclaw",
            thinkingLevel: "low",
            maxTurns: 12,
            heartbeatIntervalMs: 45000,
          })}
        >
          Apply Interview Draft
        </button>
      </div>
    );
  },
}));

vi.mock("../AgentGenerationModal", () => ({
  AgentGenerationModal: ({ isOpen, onClose, onGenerated }: { isOpen: boolean; onClose: () => void; onGenerated: (spec: any) => void }) => {
    if (!isOpen) return null;
    return (
      <div data-testid="agent-generation-modal">
        <span data-testid="generation-modal-open">Modal Open</span>
        <button
          data-testid="generation-modal-close"
          onClick={onClose}
        >
          Close Modal
        </button>
        <button
          data-testid="generation-modal-apply"
          onClick={() =>
            onGenerated({
              title: "Generated Agent",
              icon: "🤖",
              role: "reviewer",
              description: "Generated description for testing",
              systemPrompt: "# System prompt\nYou are a helpful agent.",
              thinkingLevel: "medium",
              maxTurns: 25,
            })
          }
        >
          Apply Generated Spec
        </button>
        <button
          data-testid="generation-modal-apply-custom-role"
          onClick={() =>
            onGenerated({
              title: "Custom Role Agent",
              icon: "🔧",
              role: "security-auditor",
              description: "Custom role not in AgentCapability",
              systemPrompt: "# Security auditor prompt",
              thinkingLevel: "high",
              maxTurns: 50,
            })
          }
        >
          Apply Custom Role Spec
        </button>
      </div>
    );
  },
}));

const mockCreateAgent = vi.mocked(apiModule.createAgent);
const mockFetchAgents = vi.mocked(apiModule.fetchAgents);
const mockFetchModels = vi.mocked(apiModule.fetchModels);
const mockFetchPluginRuntimes = vi.mocked(apiModule.fetchPluginRuntimes);
const mockUpdateGlobalSettings = vi.mocked(apiModule.updateGlobalSettings);
const mockFetchDiscoveredSkills = vi.mocked(apiModule.fetchDiscoveredSkills);

const MOCK_MODELS_RESPONSE = {
  models: [
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
  ],
  favoriteProviders: ["anthropic"],
  favoriteModels: ["anthropic/claude-sonnet-4-5"],
};

const MOCK_PLUGIN_RUNTIMES = [
  { pluginId: "fusion-plugin-openclaw-runtime", runtimeId: "openclaw", name: "OpenClaw", description: "OpenClaw plugin runtime", version: "1.0.0" },
  { pluginId: "fusion-plugin-hermes-runtime", runtimeId: "hermes", name: "Hermes", description: "Hermes plugin runtime", version: "1.1.0" },
];

const MOCK_SKILLS_RESPONSE = [
  { id: "skill-1", name: "Skill One", path: "/path/skill-1", relativePath: "skills/skill-1", enabled: true, metadata: { source: "*", scope: "user" as const, origin: "top-level" as const } },
  { id: "skill-2", name: "Skill Two", path: "/path/skill-2", relativePath: "skills/skill-2", enabled: true, metadata: { source: "*", scope: "user" as const, origin: "top-level" as const } },
];

const MOCK_MANAGER_AGENTS = [
  {
    id: "agent-manager-1",
    name: "Manager One",
    role: "executor",
    state: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  },
  {
    id: "agent-manager-2",
    name: "Manager Two",
    role: "reviewer",
    state: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  },
];

async function openModelDropdown(label = "Model") {
  fireEvent.click(screen.getByRole("button", { name: label }));

  await waitFor(() => {
    expect(document.body.querySelector('[data-testid="model-combobox-portal"]')).not.toBeNull();
  });

  return document.body.querySelector('[data-testid="model-combobox-portal"]') as HTMLElement;
}

function clickModelOption(portal: HTMLElement, optionText: RegExp) {
  const option = within(portal)
    .getAllByRole("option")
    .find((candidate) => optionText.test(candidate.textContent ?? ""));
  expect(option).toBeTruthy();
  fireEvent.click(option!);
}

async function openPresetTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: "Preset personas" }));
}

async function openCustomTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: "Custom agent" }));
}

function openCustomTabSync() {
  fireEvent.click(screen.getByRole("tab", { name: "Custom agent" }));
}

function getStepZeroField(label: string | RegExp) {
  openCustomTabSync();
  return screen.getByLabelText(label);
}

function extractMobileMediaBlocks(content: string): string {
  const blocks: string[] = [];
  const regex = /@media\s*\(\s*max-width:\s*768px\s*\)\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const startIdx = match.index + match[0].length;
    let braceCount = 1;
    let endIdx = startIdx;
    while (braceCount > 0 && endIdx < content.length) {
      if (content[endIdx] === "{") braceCount++;
      if (content[endIdx] === "}") braceCount--;
      endIdx++;
    }
    if (braceCount === 0) {
      blocks.push(content.slice(startIdx, endIdx - 1));
    }
  }

  return blocks.join("\n");
}

describe("NewAgentDialog", () => {
  const mockOnClose = vi.fn();
  const mockOnCreated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchModels.mockResolvedValue(MOCK_MODELS_RESPONSE);
    mockFetchAgents.mockResolvedValue(MOCK_MANAGER_AGENTS as any);
    mockCreateAgent.mockResolvedValue({} as any);
    mockFetchPluginRuntimes.mockResolvedValue(MOCK_PLUGIN_RUNTIMES);
    mockUpdateGlobalSettings.mockResolvedValue({} as unknown as import("@fusion/core").Settings);
    mockFetchDiscoveredSkills.mockResolvedValue(MOCK_SKILLS_RESPONSE);
  });

  describe("mobile layout", () => {
    it("removes the preset grid scroll cap inside the mobile media block", () => {
      const mobileCss = extractMobileMediaBlocks(loadAllAppCss());

      expect(mobileCss).toMatch(/\.agent-presets-grid\s*\{[^}]*max-height:\s*none;[^}]*overflow-y:\s*visible;/);
    });
  });

  describe("modal visibility", () => {
    it("renders nothing when isOpen is false", () => {
      const { container } = render(
        <NewAgentDialog isOpen={false} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );
      expect(container.innerHTML).toBe("");
    });

    it("renders the dialog when isOpen is true", async () => {
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });
      expect(screen.getByRole("dialog", { name: "Create new agent" })).toBeTruthy();
    });

    it("renders tabbed step-0 UI with preset tab active by default", async () => {
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });

      const tabList = screen.getByRole("tablist", { name: "Agent setup mode" });
      expect(tabList).toBeInTheDocument();

      const customTab = screen.getByRole("tab", { name: "Custom agent" });
      const presetsTab = screen.getByRole("tab", { name: "Preset personas" });

      expect(presetsTab).toHaveAttribute("aria-selected", "true");
      expect(presetsTab).toHaveAttribute("aria-controls", "agent-dialog-panel-presets");
      expect(customTab).toHaveAttribute("aria-selected", "false");
      expect(customTab).toHaveAttribute("aria-controls", "agent-dialog-panel-custom");

      expect(screen.getByRole("tabpanel", { name: "Preset personas" })).toBeInTheDocument();
      expect(screen.getByTestId("preset-ceo")).toBeInTheDocument();
      expect(screen.queryByText("Identity")).toBeNull();
      expect(screen.queryByLabelText(/Name/)).toBeNull();
    });

    it("switches between tabs and preserves manual values", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      await openCustomTab(user);
      await user.type(screen.getByLabelText(/Name/), "Custom Value");
      await openPresetTab(user);

      expect(screen.getByRole("tabpanel", { name: "Preset personas" })).toBeInTheDocument();
      expect(screen.getByTestId("preset-ceo")).toBeInTheDocument();
      expect(screen.queryByLabelText(/Name/)).toBeNull();

      await openCustomTab(user);

      const nameInput = getStepZeroField(/Name/) as HTMLInputElement;
      expect(nameInput.value).toBe("Custom Value");
    });

    it("shows AI Interview button only when onboarding flag is enabled", async () => {
      const { rerender } = render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} agentOnboardingEnabled={false} />,
      );

      expect(screen.queryByRole("button", { name: "AI Interview" })).toBeNull();

      rerender(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} agentOnboardingEnabled={true} />,
      );

      expect(screen.getByRole("button", { name: "AI Interview" })).toBeInTheDocument();
    });

    it("opens interview modal and applies draft back into the form", async () => {
      const user = userEvent.setup();
      const onPrefillDraft = vi.fn();

      function Harness() {
        const [draft, setDraft] = useState<any>(null);
        return (
          <NewAgentDialog
            isOpen={true}
            onClose={mockOnClose}
            onCreated={mockOnCreated}
            agentOnboardingEnabled={true}
            prefillDraft={draft}
            onPrefillDraft={(nextDraft) => {
              onPrefillDraft(nextDraft);
              setDraft(nextDraft);
            }}
          />
        );
      }

      render(<Harness />);

      await user.click(screen.getByRole("button", { name: "AI Interview" }));
      expect(screen.getByRole("dialog", { name: "AI Interview" })).toBeInTheDocument();
      expect(screen.getByTestId("interview-mode")).toHaveTextContent("create");

      await user.click(screen.getByRole("button", { name: "Apply Interview Draft" }));

      await waitFor(() => {
        expect(onPrefillDraft).toHaveBeenCalledWith(expect.objectContaining({ name: "Interview Draft" }));
        expect(screen.getByLabelText("Runtime")).toBeInTheDocument();
      });

      expect(mockCreateAgent).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Runtime")).toBeInTheDocument();
      expect((screen.getByLabelText("Runtime") as HTMLSelectElement).value).toBe("openclaw");

      await user.click(screen.getByRole("button", { name: "Back" }));
      expect((getStepZeroField(/Name/) as HTMLInputElement).value).toBe("Interview Draft");
      expect((getStepZeroField(/Title/) as HTMLInputElement).value).toBe("Interview Title");
      expect((getStepZeroField(/Icon/) as HTMLInputElement).value).toBe("🤖");
      expect((getStepZeroField(/Reports To/) as HTMLSelectElement).value).toBe("agent-manager-1");
      expect((getStepZeroField(/Soul/) as HTMLTextAreaElement).value).toBe("Interview soul");
      expect((getStepZeroField(/Agent Memory/) as HTMLTextAreaElement).value).toBe("Interview memory");
      expect((getStepZeroField(/Heartbeat Procedure Path/) as HTMLInputElement).value).toBe(".fusion/agents/interview/HEARTBEAT.md");

      await user.click(screen.getByRole("button", { name: "Next" }));
      expect((screen.getByTestId("skill-multiselect-value")).textContent).toContain("skill-1");
      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(mockCreateAgent).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Interview Draft",
          role: "reviewer",
          reportsTo: "agent-manager-1",
          heartbeatProcedurePath: ".fusion/agents/interview/HEARTBEAT.md",
          runtimeConfig: expect.objectContaining({ runtimeHint: "openclaw", thinkingLevel: "low", maxTurns: 12 }),
          metadata: { skills: ["skill-1"] },
        }),
        undefined,
      );
    });

    it("closing interview leaves current form state unchanged and does not create agent", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog
          isOpen={true}
          onClose={mockOnClose}
          onCreated={mockOnCreated}
          agentOnboardingEnabled={true}
        />,
      );

      await openCustomTab(user);
      await user.type(screen.getByLabelText(/Name/), "Manual Name");
      await user.type(screen.getByLabelText(/Title/), "Manual Title");

      await user.click(screen.getByRole("button", { name: "AI Interview" }));
      expect(screen.getByRole("dialog", { name: "AI Interview" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Close Interview" }));

      expect(screen.queryByRole("dialog", { name: "AI Interview" })).toBeNull();
      expect((getStepZeroField(/Name/) as HTMLInputElement).value).toBe("Manual Name");
      expect((getStepZeroField(/Title/) as HTMLInputElement).value).toBe("Manual Title");
      expect(mockCreateAgent).not.toHaveBeenCalled();
    });
  });

  describe("manager dropdown", () => {
    it("fetches manager options on open with projectId", async () => {
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} projectId="proj-123" />,
      );

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenCalledWith(undefined, "proj-123");
      });
    });

    it("renders reports-to as a select with no-manager and fetched manager options", async () => {
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenCalledOnce();
      });

      const reportsToSelect = getStepZeroField(/Reports To/) as HTMLSelectElement;
      expect(reportsToSelect.tagName).toBe("SELECT");
      expect(within(reportsToSelect).getByRole("option", { name: "No manager" })).toBeTruthy();
      expect(within(reportsToSelect).getByRole("option", { name: "Manager One (agent-manager-1)" })).toBeTruthy();
      expect(within(reportsToSelect).getByRole("option", { name: "Manager Two (agent-manager-2)" })).toBeTruthy();
    });

    it("sends selected manager id as reportsTo in createAgent payload", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchAgents).toHaveBeenCalledOnce());

      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Agent With Manager");

      const reportsToSelect = getStepZeroField(/Reports To/);
      await user.selectOptions(reportsToSelect, "agent-manager-1");

      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Next"));

      expect(screen.getByText("Reports To")).toBeTruthy();
      expect(screen.getByText("Manager One (agent-manager-1)")).toBeTruthy();

      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      expect(mockCreateAgent.mock.calls[0][0]).toMatchObject({
        name: "Agent With Manager",
        reportsTo: "agent-manager-1",
      });
    });

    it("omits reportsTo from payload when no manager is selected", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchAgents).toHaveBeenCalledOnce());

      await user.type(getStepZeroField(/Name/), "Agent Without Manager");
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      expect(mockCreateAgent.mock.calls[0][0].reportsTo).toBeUndefined();
    });

    it("keeps dialog functional when manager fetch fails", async () => {
      mockFetchAgents.mockRejectedValueOnce(new Error("manager fetch failed"));
      const user = userEvent.setup();

      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenCalledOnce();
      });

      const reportsToSelect = getStepZeroField(/Reports To/) as HTMLSelectElement;
      expect(within(reportsToSelect).getByRole("option", { name: "No manager" })).toBeTruthy();
      expect(reportsToSelect.options).toHaveLength(1);

      await user.type(getStepZeroField(/Name/), "Agent Works Without Managers");
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      expect(mockCreateAgent.mock.calls[0][0].reportsTo).toBeUndefined();
    });
  });

  describe("model dropdown", () => {
    it("fetches models on mount", async () => {
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });
      expect(mockFetchModels).toHaveBeenCalledOnce();
    });

    it("shows loading state then model dropdown on step 1", async () => {
      // Create a slow promise to see loading state
      let resolveModels: (v: any) => void;
      mockFetchModels.mockReturnValue(new Promise(r => { resolveModels = r; }));

      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      // Navigate to step 1 (model config step) by filling name and clicking Next
      const nameInput = getStepZeroField(/Name/);
      await fireEvent.change(nameInput, { target: { value: "Test Agent" } });
      await fireEvent.click(screen.getByText("Next"));

      // Should show loading
      expect(screen.getByText("Loading models…")).toBeTruthy();

      // Resolve models
      resolveModels!(MOCK_MODELS_RESPONSE);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Model" })).toBeTruthy();
      });
    });

    it("shows model dropdown on step 1 after models load", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      // Wait for models to load
      await waitFor(() => {
        expect(mockFetchModels).toHaveBeenCalledOnce();
      });

      // Navigate to step 1
      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));

      const modelTrigger = screen.getByRole("button", { name: "Model" });
      expect(modelTrigger).toBeTruthy();
      expect(modelTrigger.textContent).toContain("Use default");
    });

    it("selecting a model from dropdown updates state", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      // Wait for models to load
      await waitFor(() => {
        expect(mockFetchModels).toHaveBeenCalledOnce();
      });

      // Navigate to step 1
      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));

      const portal = await openModelDropdown();
      clickModelOption(portal, /Claude Sonnet 4.5/i);

      expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Claude Sonnet 4.5");
    });

    it("deselecting model sets value back to default", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Navigate to step 1
      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));

      // Select a model
      const selectPortal = await openModelDropdown();
      clickModelOption(selectPortal, /Claude Sonnet 4.5/i);
      expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Claude Sonnet 4.5");

      // Deselect (use default)
      const defaultPortal = await openModelDropdown();
      fireEvent.click(within(defaultPortal).getByRole("option", { name: "Use default" }));
      expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Use default");
    });

    it("switching to runtime mode hides model dropdown and shows runtime selector", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Runtime Agent");
      await user.click(screen.getByText("Next"));

      expect(screen.getByRole("button", { name: "Model" })).toBeTruthy();

      await user.click(screen.getByText("Plugin Runtime"));

      expect(screen.queryByRole("button", { name: "Model" })).toBeNull();
      expect(screen.getByLabelText("Runtime")).toBeTruthy();
    });

    it("switching back to model mode clears selected runtime", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Runtime Toggle Agent");
      await user.click(screen.getByText("Next"));

      await user.click(screen.getByText("Plugin Runtime"));
      await user.selectOptions(screen.getByLabelText("Runtime"), "openclaw");
      await user.click(screen.getByText("Built-in Model"));
      await user.click(screen.getByText("Plugin Runtime"));

      expect((screen.getByLabelText("Runtime") as HTMLSelectElement).value).toBe("");
    });
  });

  describe("runtime mode toggle on step 0 custom tab", () => {
    it("shows runtime source toggle on custom tab before advancing to step 1", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      await openCustomTab(user);

      expect(screen.getByRole("radiogroup", { name: "Runtime Source" })).toBeInTheDocument();
      expect(screen.getByText("Built-in Model")).toBeInTheDocument();
      expect(screen.getByText("Plugin Runtime")).toBeInTheDocument();
    });

    it("switching to plugin runtime on step 0 custom tab hides model dropdown and shows runtime selector", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      await openCustomTab(user);
      expect(screen.getByRole("button", { name: "Model" })).toBeInTheDocument();

      await user.click(screen.getByText("Plugin Runtime"));

      expect(screen.queryByRole("button", { name: "Model" })).toBeNull();
      expect(screen.getByLabelText("Runtime")).toBeInTheDocument();
    });

    it("switching back to built-in model on step 0 custom tab restores model dropdown and clears runtime selection", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      await openCustomTab(user);
      await user.click(screen.getByText("Plugin Runtime"));
      await user.selectOptions(screen.getByLabelText("Runtime"), "openclaw");

      await user.click(screen.getByText("Built-in Model"));
      expect(screen.getByRole("button", { name: "Model" })).toBeInTheDocument();

      await user.click(screen.getByText("Plugin Runtime"));
      expect((screen.getByLabelText("Runtime") as HTMLSelectElement).value).toBe("");
    });

    it("preserves model selection from step 0 custom tab when advancing to step 1", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      await openCustomTab(user);
      await user.type(screen.getByLabelText(/Name/), "Preserved Model Agent");

      const portal = await openModelDropdown();
      clickModelOption(portal, /Claude Sonnet 4.5/i);

      await user.click(screen.getByText("Next"));

      expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Claude Sonnet 4.5");
    });

    it("creates custom agent with runtimeHint when plugin runtime is selected on step 0", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      await openCustomTab(user);
      await user.type(screen.getByLabelText(/Name/), "Step Zero Runtime Agent");
      await user.click(screen.getByText("Plugin Runtime"));
      await user.selectOptions(screen.getByLabelText("Runtime"), "openclaw");

      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      expect(mockCreateAgent.mock.calls[0][0].runtimeConfig).toEqual({
        runtimeHint: "openclaw",
      });
    });
  });

  describe("summary display", () => {
    it("renders editable review controls for title and instruction fields", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      await user.type(getStepZeroField(/Name/), "Review Controls Agent");
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Next"));

      expect(screen.getByLabelText("Title")).toBeInTheDocument();
      expect(screen.getByLabelText("Soul")).toBeInTheDocument();
      expect(screen.getByLabelText("Heartbeat Procedure Path")).toBeInTheDocument();
      expect(screen.getByLabelText("Instructions Path")).toBeInTheDocument();
      expect(screen.getByLabelText("Inline Instructions")).toBeInTheDocument();
    });

    it("shows 'default' in summary when no model selected", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Navigate to step 2
      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Next"));

      // Summary should show "default" for model
      const modelRow = screen.getByText("Model").closest(".agent-dialog-summary-row");
      expect(modelRow).toBeTruthy();
      expect(modelRow!.querySelector("em")?.textContent).toBe("default");
    });

    it("shows model name and provider icon in summary when model selected", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Navigate to step 1
      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));

      // Select a model
      const portal = await openModelDropdown();
      clickModelOption(portal, /Claude Sonnet 4.5/i);

      // Navigate to step 2
      await user.click(screen.getByText("Next"));

      // Summary should show model name
      expect(screen.getByTestId("anthropic-icon")).toBeTruthy();
      expect(screen.getByText("Claude Sonnet 4.5")).toBeTruthy();
    });
  });

  describe("agent creation", () => {
    it("creates agent with selected model", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Step 0: Fill name
      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Test Agent");

      // Step 1: Navigate and select model
      await user.click(screen.getByText("Next"));
      const portal = await openModelDropdown();
      clickModelOption(portal, /Claude Sonnet 4.5/i);

      // Step 2: Navigate to summary and create
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      const createCall = mockCreateAgent.mock.calls[0][0];
      expect(createCall.name).toBe("Test Agent");
      expect(createCall.runtimeConfig).toEqual({
        model: "anthropic/claude-sonnet-4-5",
      });
    });

    it("creates agent with selected plugin runtime", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Plugin Runtime Agent");

      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Plugin Runtime"));
      await user.selectOptions(screen.getByLabelText("Runtime"), "openclaw");

      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      expect(mockCreateAgent.mock.calls[0][0].runtimeConfig).toEqual({
        runtimeHint: "openclaw",
      });
    });

    it("creates agent without model when default selected", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Step 0: Fill name
      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Test Agent");

      // Step 1: Leave model as default
      await user.click(screen.getByText("Next"));

      // Step 2: Navigate and create
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      const createCall = mockCreateAgent.mock.calls[0][0];
      expect(createCall.name).toBe("Test Agent");
      // No runtimeConfig when all values are defaults
      expect(createCall.runtimeConfig).toBeUndefined();
    });

    it("creates agent with model and thinking level", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Step 0: Fill name
      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Thinking Agent");

      // Step 1: Select model and thinking level
      await user.click(screen.getByText("Next"));
      const portal = await openModelDropdown();
      clickModelOption(portal, /Claude Sonnet 4.5/i);

      const thinkingSelect = screen.getByLabelText(/Thinking Level/);
      await user.selectOptions(thinkingSelect, "high");

      // Step 2: Create
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      const createCall = mockCreateAgent.mock.calls[0][0];
      expect(createCall.runtimeConfig).toEqual({
        model: "anthropic/claude-sonnet-4-5",
        thinkingLevel: "high",
      });
    });

    it("includes heartbeatProcedurePath in createAgent payload when provided", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      await user.type(getStepZeroField(/Name/), "Heartbeat Agent");
      await user.type(
        getStepZeroField(/Heartbeat Procedure Path/) as HTMLInputElement,
        ".fusion/agents/heartbeat-agent/HEARTBEAT.md",
      );

      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      expect(mockCreateAgent.mock.calls[0][0]).toMatchObject({
        name: "Heartbeat Agent",
        heartbeatProcedurePath: ".fusion/agents/heartbeat-agent/HEARTBEAT.md",
      });
    });

    it("uses review-step edits for title, soul, heartbeat path, and instructions in create payload", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      await user.type(getStepZeroField(/Name/), "Editable Review Agent");
      await user.type(getStepZeroField(/Title/) as HTMLInputElement, "Initial Title");
      await user.type(getStepZeroField(/Soul/) as HTMLTextAreaElement, "Initial soul");
      await user.type(getStepZeroField(/^Heartbeat Procedure Path/) as HTMLInputElement, ".fusion/agents/initial/HEARTBEAT.md");
      await user.type(getStepZeroField(/^Instructions Path/) as HTMLInputElement, ".fusion/agents/initial.md");
      await user.type(getStepZeroField(/^Inline Instructions/) as HTMLTextAreaElement, "Initial instructions");

      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Next"));

      await user.clear(screen.getByLabelText("Title"));
      await user.type(screen.getByLabelText("Title"), "Final Review Title");
      await user.clear(screen.getByLabelText("Soul"));
      await user.type(screen.getByLabelText("Soul"), "Final soul");
      await user.clear(screen.getByLabelText("Heartbeat Procedure Path"));
      await user.type(screen.getByLabelText("Heartbeat Procedure Path"), ".fusion/agents/final/HEARTBEAT.md");
      await user.clear(screen.getByLabelText("Instructions Path"));
      await user.type(screen.getByLabelText("Instructions Path"), ".fusion/agents/final.md");
      await user.clear(screen.getByLabelText("Inline Instructions"));
      await user.type(screen.getByLabelText("Inline Instructions"), "Final instructions");

      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      expect(mockCreateAgent.mock.calls[0][0]).toMatchObject({
        title: "Final Review Title",
        soul: "Final soul",
        heartbeatProcedurePath: ".fusion/agents/final/HEARTBEAT.md",
        instructionsPath: ".fusion/agents/final.md",
        instructionsText: "Final instructions",
      });
    });
  });

  describe("error handling", () => {
    it("handles fetchModels failure gracefully", async () => {
      mockFetchModels.mockRejectedValue(new Error("Network error"));

      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Navigate to step 1 — should still show the dropdown (empty models)
      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));

      // Dropdown should still render (just with empty models)
      expect(screen.getByRole("button", { name: "Model" })).toBeTruthy();
    });
  });

  describe("close and reset", () => {
    it("resets state on close", async () => {
      const user = userEvent.setup();
      const { unmount } = render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Fill in name and heartbeat path
      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Agent Name");
      await user.type(
        getStepZeroField(/Heartbeat Procedure Path/) as HTMLInputElement,
        ".fusion/agents/agent-name/HEARTBEAT.md",
      );

      // Navigate to step 1 and select model
      await user.click(screen.getByText("Next"));
      const portal = await openModelDropdown();
      clickModelOption(portal, /Claude Sonnet 4.5/i);

      // Close the dialog
      await user.click(screen.getByLabelText("Close"));

      expect(mockOnClose).toHaveBeenCalled();

      // Unmount and reopen - state should be reset; wait for the second fetchModels useEffect to settle
      unmount();
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledTimes(2));

      // Name and heartbeat path should be empty
      const newNameInput = getStepZeroField(/Name/) as HTMLInputElement;
      expect(newNameInput.value).toBe("");
      const heartbeatPathInput = getStepZeroField(/Heartbeat Procedure Path/) as HTMLInputElement;
      expect(heartbeatPathInput.value).toBe("");
    });
  });

  describe("AI generation integration", () => {
    it("shows Generate with AI button in step 0", async () => {
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });
      openCustomTabSync();
      expect(screen.getByText("Generate with AI")).toBeTruthy();
    });

    it("opens AgentGenerationModal when Generate with AI is clicked", async () => {
      const user = userEvent.setup();
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });

      // Generation modal should not be open initially
      expect(screen.queryByTestId("agent-generation-modal")).toBeNull();

      // Click the Generate with AI button
      openCustomTabSync();
      await user.click(screen.getByText("Generate with AI"));

      // Generation modal should now be open
      expect(screen.getByTestId("agent-generation-modal")).toBeTruthy();
    });

    it("populates form fields and advances to step 1 when spec is applied", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Open generation modal and apply spec
      openCustomTabSync();
      await user.click(screen.getByText("Generate with AI"));
      await user.click(screen.getByTestId("generation-modal-apply"));

      // Should advance to step 1 (model config)
      expect(screen.getByRole("button", { name: "Model" })).toBeTruthy();

      // Navigate to step 2 to verify the summary
      await user.click(screen.getByText("Next"));

      // Verify name was populated from spec.title
      const summaryText = screen.getByText("Generated Agent");
      expect(summaryText).toBeTruthy();

      // Verify icon is shown
      expect(screen.getByText("🤖")).toBeTruthy();
    });

    it("maps known role to AgentCapability", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Open generation modal and apply spec with role "reviewer"
      openCustomTabSync();
      await user.click(screen.getByText("Generate with AI"));
      await user.click(screen.getByTestId("generation-modal-apply"));

      // After generation, we're on Step 1 — navigate to summary (step 2)
      await user.click(screen.getByText("Next"));

      // Role should be mapped correctly to "Reviewer"
      const roleRow = screen.getByText("Role").closest(".agent-dialog-summary-row");
      expect(roleRow?.textContent).toContain("Reviewer");
    });

    it("maps unknown role to custom", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Open generation modal and apply spec with unknown role "security-auditor"
      openCustomTabSync();
      await user.click(screen.getByText("Generate with AI"));
      await user.click(screen.getByTestId("generation-modal-apply-custom-role"));

      // After generation, we're on Step 1 — navigate to summary (step 2)
      await user.click(screen.getByText("Next"));

      // Role should default to "Custom"
      const roleRow = screen.getByText("Role").closest(".agent-dialog-summary-row");
      expect(roleRow?.textContent).toContain("Custom");
    });

    it("applies runtime config from generated spec", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Open generation modal and apply spec
      openCustomTabSync();
      await user.click(screen.getByText("Generate with AI"));
      await user.click(screen.getByTestId("generation-modal-apply"));

      // Step 1: verify thinking level and max turns were applied
      const thinkingSelect = screen.getByLabelText(/Thinking Level/) as HTMLSelectElement;
      expect(thinkingSelect.value).toBe("medium");

      const maxTurnsInput = screen.getByLabelText(/Max Turns/) as HTMLInputElement;
      expect(maxTurnsInput.value).toBe("25");
    });

    it("closes generation modal without affecting form on cancel", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      // Fill in a name first
      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Manual Name");

      // Open generation modal
      openCustomTabSync();
      await user.click(screen.getByText("Generate with AI"));
      expect(screen.getByTestId("agent-generation-modal")).toBeTruthy();

      // Close the generation modal without applying
      await user.click(screen.getByTestId("generation-modal-close"));

      // Should still be on step 0 with original name
      const nameAfter = getStepZeroField(/Name/) as HTMLInputElement;
      expect(nameAfter.value).toBe("Manual Name");
      expect(screen.queryByTestId("agent-generation-modal")).toBeNull();
    });

    it("creates agent with icon from generated spec", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Open generation modal and apply spec
      openCustomTabSync();
      await user.click(screen.getByText("Generate with AI"));
      await user.click(screen.getByTestId("generation-modal-apply"));

      // After generation, we're on Step 1 — navigate to summary (step 2) and create
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      const createCall = mockCreateAgent.mock.calls[0][0];
      expect(createCall.name).toBe("Generated Agent");
      expect(createCall.icon).toBe("🤖");
      expect(createCall.title).toBe("Generated description for testing");
      expect(createCall.role).toBe("reviewer");
      expect(createCall.runtimeConfig).toEqual({
        thinkingLevel: "medium",
        maxTurns: 25,
      });
    });
  });

  describe("preset selection", () => {
    it("renders all 20 preset cards in the preset tab", async () => {
      const user = userEvent.setup();
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });

      await openPresetTab(user);

      const presetCards = screen.getAllByTestId(/^preset-/);
      expect(presetCards).toHaveLength(20);
    });

    it("shows the preset tab header text", async () => {
      const user = userEvent.setup();
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });

      await openPresetTab(user);

      expect(screen.getByText("Choose a preset persona to prefill role, identity, soul, and instructions")).toBeTruthy();
    });

    it("clicking a preset populates name, title, icon, and role", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Click the "Engineer" preset
      await openPresetTab(user);
      await user.click(screen.getByTestId("preset-engineer"));

      // Should advance to step 1 (model config), go back to verify fields
      await user.click(screen.getByText("Back"));
      await openCustomTab(user);

      // Verify form fields were populated
      const nameInput = getStepZeroField(/Name/) as HTMLInputElement;
      expect(nameInput.value).toBe("Engineer");

      const titleInput = getStepZeroField(/Title/) as HTMLInputElement;
      // Title should be set to the preset's description (not the professional title)
      expect(titleInput.value).toBe("Implements features, fixes bugs, and writes well-tested code across the full application stack.");

      // Verify role was set to engineer
      const roleGrid = document.querySelector(".agent-role-grid");
      const engineerRoleButton = roleGrid?.querySelector(".agent-role-option.selected");
      expect(engineerRoleButton?.textContent).toContain("Engineer");
    });

    it("clicking a preset advances directly to step 1", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Click the "CTO" preset
      await openPresetTab(user);
      await user.click(screen.getByTestId("preset-cto"));

      // Should be on step 1 — model dropdown visible
      expect(screen.getByRole("button", { name: "Model" })).toBeTruthy();
    });

    it("selected preset card has .selected CSS class", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Click the "CEO" preset
      await openPresetTab(user);
      await user.click(screen.getByTestId("preset-ceo"));

      // Go back to step 0 to verify visual feedback
      await user.click(screen.getByText("Back"));

      const ceoCard = screen.getByTestId("preset-ceo");
      expect(ceoCard.classList.contains("selected")).toBe(true);
    });

    it("clicking a different preset updates the selection", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Click CEO preset
      await openPresetTab(user);
      await user.click(screen.getByTestId("preset-ceo"));
      await user.click(screen.getByText("Back"));

      // Click CTO preset
      await openPresetTab(user);
      await user.click(screen.getByTestId("preset-cto"));
      await user.click(screen.getByText("Back"));

      // Only CTO should be selected
      expect(screen.getByTestId("preset-cto").classList.contains("selected")).toBe(true);
      expect(screen.getByTestId("preset-ceo").classList.contains("selected")).toBe(false);

      // Name should be updated
      await openCustomTab(user);
      const nameInput = getStepZeroField(/Name/) as HTMLInputElement;
      expect(nameInput.value).toBe("CTO");
    });

    it("user can override preset values with manual entry after selection", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Select a preset
      await openPresetTab(user);
      await user.click(screen.getByTestId("preset-engineer"));
      await user.click(screen.getByText("Back"));
      await openCustomTab(user);

      // Override the name manually
      const nameInput = getStepZeroField(/Name/) as HTMLInputElement;
      await user.clear(nameInput);
      await user.type(nameInput, "My Custom Engineer");

      expect(nameInput.value).toBe("My Custom Engineer");
    });

    it("dialog reset clears preset selection", async () => {
      const user = userEvent.setup();
      const { unmount } = render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Select a preset
      await openPresetTab(user);
      await user.click(screen.getByTestId("preset-ceo"));

      // Close the dialog
      await user.click(screen.getByLabelText("Close"));
      expect(mockOnClose).toHaveBeenCalled();

      // Re-open — state should be reset; wait for the second fetchModels useEffect to settle
      unmount();
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledTimes(2));

      // Name should be empty (no preset selected)
      const nameInput = getStepZeroField(/Name/) as HTMLInputElement;
      expect(nameInput.value).toBe("");

      // No preset cards should be selected
      await openPresetTab(user);
      const selectedCards = document.querySelectorAll(".agent-preset-card.selected");
      expect(selectedCards).toHaveLength(0);
    });

    it("creates agent with preset fields through the full flow", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Click the "Reviewer" preset (advances to step 1)
      await openPresetTab(user);
      await user.click(screen.getByTestId("preset-reviewer"));

      // Step 1: navigate to summary
      await user.click(screen.getByText("Next"));

      // Step 2: verify summary and create
      // Verify name
      expect(screen.getByText("Reviewer")).toBeTruthy();
      // Verify icon
      expect(screen.getByText("⊙")).toBeTruthy();

      // Create
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      const createCall = mockCreateAgent.mock.calls[0][0];
      expect(createCall.name).toBe("Reviewer");
      expect(createCall.icon).toBe("⊙");
      // Title should be the preset's description
      expect(createCall.title).toBe("Reviews code changes for correctness, security, performance, and adherence to project coding standards.");
      expect(createCall.role).toBe("reviewer");
      // Soul should be populated from preset
      expect(createCall.soul).toBeTruthy();
      expect(typeof createCall.soul).toBe("string");
      // instructionsText should be populated from preset
      expect(createCall.instructionsText).toBeTruthy();
      expect(typeof createCall.instructionsText).toBe("string");
    });

    it("preset card titles show the professional title", async () => {
      const user = userEvent.setup();
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });

      await openPresetTab(user);

      const ceoCard = screen.getByTestId("preset-ceo");
      expect(ceoCard.getAttribute("title")).toBe("Chief Executive Officer");

      const ctoCard = screen.getByTestId("preset-cto");
      expect(ctoCard.getAttribute("title")).toBe("Chief Technology Officer");
    });

    it("renders descriptions in all 20 preset cards", async () => {
      const user = userEvent.setup();
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });

      await openPresetTab(user);

      // Every preset should have a description element rendered
      const descriptionElements = screen.getAllByText(/.\./, {
        selector: ".agent-preset-description",
      });
      expect(descriptionElements).toHaveLength(20);

      // Verify each description is non-empty
      descriptionElements.forEach((el) => {
        expect(el.textContent?.length).toBeGreaterThan(10);
      });
    });

    it("all presets have non-empty description strings", async () => {
      // Import the array directly by checking the rendered cards
      const user = userEvent.setup();
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });

      await openPresetTab(user);

      const presetIds = [
        "ceo", "cto", "cmo", "cfo", "engineer", "backend-engineer",
        "frontend-engineer", "fullstack-engineer", "qa-engineer",
        "devops-engineer", "ci-engineer", "security-engineer",
        "data-engineer", "ml-engineer", "product-manager", "designer",
        "marketing-manager", "technical-writer", "triage", "reviewer",
      ];

      presetIds.forEach((id) => {
        const card = screen.getByTestId(`preset-${id}`);
        const desc = card.querySelector(".agent-preset-description");
        expect(desc).toBeTruthy();
        expect((desc as HTMLElement).textContent?.length).toBeGreaterThan(0);
      });
    });

    it("selecting a preset sets title to the description value", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Click the CEO preset
      await openPresetTab(user);
      await user.click(screen.getByTestId("preset-ceo"));

      // Go back to verify the title field
      await user.click(screen.getByText("Back"));
      await openCustomTab(user);

      const titleInput = getStepZeroField(/Title/) as HTMLInputElement;
      expect(titleInput.value).toBe("Oversees project strategy, sets priorities, and coordinates between departments to ensure alignment with business goals.");
    });

    it("name label shows required indicator when no preset is selected", async () => {
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });

      // On initial render (step 0, no preset), the * required indicator should be visible
      openCustomTabSync();
      const nameLabel = screen.getByText("Name", { selector: "label" });
      const requiredSpan = nameLabel.querySelector(".agent-dialog-required");
      expect(requiredSpan).toBeTruthy();
      expect(requiredSpan?.textContent).toBe("*");
    });

    it("name label does not show required indicator when preset is selected", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Select a preset
      await openPresetTab(user);
      await user.click(screen.getByTestId("preset-engineer"));

      // Preset advances to step 1, go back to step 0
      await user.click(screen.getByText("Back"));
      await openCustomTab(user);

      // The * required indicator should NOT be visible when a preset is selected
      const nameLabel = screen.getByText("Name", { selector: "label" });
      const requiredSpan = nameLabel.querySelector(".agent-dialog-required");
      expect(requiredSpan).toBeNull();
    });

    it("Next button is enabled when preset is selected even if name is empty", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Select a preset (this fills the name and advances to step 1)
      await openPresetTab(user);
      await user.click(screen.getByTestId("preset-ceo"));

      // Go back to step 0
      await user.click(screen.getByText("Back"));
      await openCustomTab(user);

      // Clear the name field
      const nameInput = getStepZeroField(/Name/) as HTMLInputElement;
      await user.clear(nameInput);
      expect(nameInput.value).toBe("");

      // Next button should still be enabled because a preset was selected
      expect(screen.getByText("Next")).not.toBeDisabled();
    });

    it("Next button is disabled when no preset is selected and name is empty", async () => {
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });

      // On initial render (step 0, no preset, empty name), Next should be disabled
      expect(screen.getByText("Next")).toBeDisabled();
    });

    it("selecting a preset sets soul and instructionsText in the create agent call", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Click the QA Engineer preset
      await openPresetTab(user);
      await user.click(screen.getByTestId("preset-qa-engineer"));

      // Navigate to summary and create
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      const createCall = mockCreateAgent.mock.calls[0][0];
      expect(createCall.name).toBe("QA Engineer");
      // Soul should be the QA Engineer preset soul
      expect(createCall.soul).toContain("thorough and methodical QA engineer");
      // instructionsText should contain QA-specific instructions
      expect(createCall.instructionsText).toContain("full test suite");
      expect(createCall.instructionsText).toContain("regression tests");
    });

    it("selecting a preset then overriding instructions manually uses the manual value", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Select a preset (advances to step 1)
      await openPresetTab(user);
      await user.click(screen.getByTestId("preset-engineer"));

      // Go back to step 0 to override instructions
      await user.click(screen.getByText("Back"));
      await openCustomTab(user);

      // Override the instructionsText manually
      const instructionsTextarea = getStepZeroField(/Inline Instructions/) as HTMLTextAreaElement;
      await user.clear(instructionsTextarea);
      await user.type(instructionsTextarea, "My custom instructions");

      // Navigate through and create
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      const createCall = mockCreateAgent.mock.calls[0][0];
      // The manually entered instructions should be used, not the preset's
      expect(createCall.instructionsText).toBe("My custom instructions");
      // Soul should still be from the preset
      expect(createCall.soul).toContain("reliable and versatile engineer");
    });

    it("clicking a preset populates soul and instructionsText fields", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Click the CTO preset
      await openPresetTab(user);
      await user.click(screen.getByTestId("preset-cto"));

      // Go back to step 0 to verify fields
      await user.click(screen.getByText("Back"));
      await openCustomTab(user);

      // Verify soul was populated
      const soulTextarea = getStepZeroField(/Soul/) as HTMLTextAreaElement;
      expect(soulTextarea.value).toContain("pragmatic technologist");

      // Verify instructionsText was populated
      const instructionsTextarea = getStepZeroField(/Inline Instructions/) as HTMLTextAreaElement;
      expect(instructionsTextarea.value).toContain("Evaluate technology choices");
    });

    it("selecting a different preset updates soul and instructionsText", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Select CEO preset
      await openPresetTab(user);
      await user.click(screen.getByTestId("preset-ceo"));
      await user.click(screen.getByText("Back"));

      // Verify CEO soul is set
      await openCustomTab(user);
      let soulTextarea = getStepZeroField(/Soul/) as HTMLTextAreaElement;
      expect(soulTextarea.value).toContain("strategic leader");

      // Select a different preset (DevOps Engineer)
      await openPresetTab(user);
      await user.click(screen.getByTestId("preset-devops-engineer"));
      await user.click(screen.getByText("Back"));
      await openCustomTab(user);

      // Verify soul updated to DevOps
      soulTextarea = getStepZeroField(/Soul/) as HTMLTextAreaElement;
      expect(soulTextarea.value).toContain("infrastructure-minded engineer");

      // Verify instructions updated
      const instructionsTextarea = getStepZeroField(/Inline Instructions/) as HTMLTextAreaElement;
      expect(instructionsTextarea.value).toContain("rollback plan");
    });

    it("dialog reset clears soul and instructionsText from preset", async () => {
      const user = userEvent.setup();
      const { unmount } = render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Select a preset
      await openPresetTab(user);
      await user.click(screen.getByTestId("preset-cto"));

      // Close the dialog — wait for the state updates to flush before unmounting
      await user.click(screen.getByLabelText("Close"));
      expect(mockOnClose).toHaveBeenCalled();

      // Re-open — wait for the fetchModels useEffect to settle after remount
      unmount();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledTimes(2));

      // Soul and instructionsText should be empty
      const soulTextarea = getStepZeroField(/Soul/) as HTMLTextAreaElement;
      expect(soulTextarea.value).toBe("");

      const instructionsTextarea = getStepZeroField(/Inline Instructions/) as HTMLTextAreaElement;
      expect(instructionsTextarea.value).toBe("");
    });
  });

  describe("model favorites persistence", () => {
    it("persists provider favorite toggle via updateGlobalSettings", async () => {
      mockFetchModels.mockResolvedValue({
        models: MOCK_MODELS_RESPONSE.models,
        favoriteProviders: ["anthropic"],
        favoriteModels: [],
      });

      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      const user = userEvent.setup();
      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));

      const portal = await openModelDropdown();
      fireEvent.click(within(portal).getByRole("button", { name: "Remove anthropic from favorites" }));

      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({
        favoriteProviders: [],
        favoriteModels: expect.any(Array),
      });
    });

    it("rolls back local favorite state when updateGlobalSettings fails", async () => {
      // Provider rollback should use provider favorites only; if all models are favorited,
      // provider rows may be hidden in the dropdown.
      mockFetchModels.mockResolvedValue({
        models: MOCK_MODELS_RESPONSE.models,
        favoriteProviders: ["anthropic"],
        favoriteModels: [],
      });
      mockUpdateGlobalSettings.mockRejectedValueOnce(new Error("Network error"));

      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => {
        expect(mockFetchModels).toHaveBeenCalledOnce();
      });

      const user = userEvent.setup();
      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));

      const portal = await openModelDropdown();
      const removeButton = within(portal).getByRole("button", { name: "Remove anthropic from favorites" });
      fireEvent.click(removeButton);

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      });

      await waitFor(() => {
        const portalAfterRollback = document.body.querySelector('[data-testid="model-combobox-portal"]') as HTMLElement | null;
        expect(portalAfterRollback).toBeTruthy();
        expect(within(portalAfterRollback as HTMLElement).getByRole("button", { name: "Remove anthropic from favorites" })).toBeTruthy();
      });
    });
  });

  describe("skill selection", () => {
    it("renders SkillMultiselect in Step 1", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Navigate to step 1
      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));

      // SkillMultiselect should be visible in step 1
      expect(screen.getByTestId("skill-multiselect")).toBeTruthy();
    });

    it("shows selected skills in summary on step 2", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Navigate to step 1 and add a skill
      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));

      // Add a skill using the mocked button
      await user.click(screen.getByTestId("add-skill-1"));

      // Navigate to step 2
      await user.click(screen.getByText("Next"));

      // Summary should show skill count
      expect(screen.getByText(/1 skill/)).toBeTruthy();
    });

    it("includes metadata.skills in createAgent call when skills are selected", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Navigate to step 1
      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));

      // Add skills
      await user.click(screen.getByTestId("add-skill-1"));
      await user.click(screen.getByTestId("add-skill-2"));

      // Navigate to step 2 and create
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      const createCall = mockCreateAgent.mock.calls[0][0];
      expect(createCall.metadata).toEqual({ skills: ["skill-1", "skill-2"] });
    });

    it("does not include metadata when no skills are selected", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Navigate through steps without adding skills
      const nameInput = getStepZeroField(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      const createCall = mockCreateAgent.mock.calls[0][0];
      expect(createCall.metadata).toBeUndefined();
    });

    it("prefills rich onboarding draft fields", async () => {
      render(
        <NewAgentDialog
          isOpen={true}
          onClose={mockOnClose}
          onCreated={mockOnCreated}
          prefillDraft={{
            name: "Draft Agent",
            role: "reviewer",
            instructionsText: "Review with care",
            thinkingLevel: "medium",
            maxTurns: 25,
            title: "Draft title",
            icon: "🧪",
            reportsTo: "agent-manager-1",
            soul: "Patient",
            memory: "Remember docs style",
            skills: ["docs", "review"],
            heartbeatProcedurePath: ".fusion/agents/draft-agent/HEARTBEAT.md",
            modelHint: "anthropic/claude-sonnet-4-5",
            runtimeHint: "openclaw",
            heartbeatIntervalMs: 60000,
            heartbeatEnabled: true,
          }}
        />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalled());
      expect((screen.getByLabelText("Runtime") as HTMLSelectElement).value).toBe("openclaw");
      fireEvent.click(screen.getByText("Back"));

      expect((getStepZeroField(/Name/) as HTMLInputElement).value).toBe("Draft Agent");
      expect((getStepZeroField(/Title/) as HTMLInputElement).value).toBe("Draft title");
      expect((getStepZeroField(/Icon/) as HTMLInputElement).value).toBe("🧪");
      expect((getStepZeroField(/Reports To/) as HTMLSelectElement).value).toBe("agent-manager-1");
      expect((getStepZeroField(/Soul/) as HTMLTextAreaElement).value).toBe("Patient");
      expect((getStepZeroField(/Agent Memory/) as HTMLTextAreaElement).value).toBe("Remember docs style");
      expect((getStepZeroField(/Heartbeat Procedure Path/) as HTMLInputElement).value).toBe(".fusion/agents/draft-agent/HEARTBEAT.md");
      expect((getStepZeroField(/^Inline Instructions/) as HTMLTextAreaElement).value).toContain("Review with care");

      fireEvent.click(screen.getByText("Next"));
      expect(screen.getByTestId("skill-multiselect-value")).toHaveTextContent('["docs","review"]');
    });
  });
});
