// Shared mocks/fixtures for AgentDetailView.*.test.tsx — see FN-4088
import { createElement } from "react";
import { vi } from "vitest";
import type { AgentCapability, AgentDetail } from "../../api";

type ApiModule = typeof import("../../api");
type SseModule = typeof import("../../sse-bus");

export const mockFetchAgent = vi.fn<ApiModule["fetchAgent"]>();
export const mockFetchAgents = vi.fn<ApiModule["fetchAgents"]>();
export const mockUpdateAgent = vi.fn<ApiModule["updateAgent"]>();
export const mockUpdateAgentState = vi.fn<ApiModule["updateAgentState"]>();
export const mockDeleteAgent = vi.fn<ApiModule["deleteAgent"]>();
export const mockFetchAgentChildren = vi.fn<ApiModule["fetchAgentChildren"]>();
export const mockFetchAgentRunLogs = vi.fn<ApiModule["fetchAgentRunLogs"]>();
export const mockFetchAgentRuns = vi.fn<ApiModule["fetchAgentRuns"]>();
export const mockFetchAgentRunDetail = vi.fn<ApiModule["fetchAgentRunDetail"]>();
export const mockFetchAgentPromptSizes = vi.fn<ApiModule["fetchAgentPromptSizes"]>();
export const mockFetchAgentTasks = vi.fn<ApiModule["fetchAgentTasks"]>();
export const mockFetchChainOfCommand = vi.fn<ApiModule["fetchChainOfCommand"]>();
export const mockFetchAgentBudgetStatus = vi.fn<ApiModule["fetchAgentBudgetStatus"]>();
export const mockResetAgentBudget = vi.fn<ApiModule["resetAgentBudget"]>();
export const mockUpdateAgentInstructions = vi.fn<ApiModule["updateAgentInstructions"]>();
export const mockUpdateAgentSoul = vi.fn<ApiModule["updateAgentSoul"]>();
export const mockUpdateAgentMemory = vi.fn<ApiModule["updateAgentMemory"]>();
export const mockFetchAgentMemoryFiles = vi.fn<ApiModule["fetchAgentMemoryFiles"]>();
export const mockFetchAgentMemoryFile = vi.fn<ApiModule["fetchAgentMemoryFile"]>();
export const mockSaveAgentMemoryFile = vi.fn<ApiModule["saveAgentMemoryFile"]>();
export const mockFetchWorkspaceFileContent = vi.fn<ApiModule["fetchWorkspaceFileContent"]>();
export const mockSaveWorkspaceFileContent = vi.fn<ApiModule["saveWorkspaceFileContent"]>();
export const mockFetchDiscoveredSkills = vi.fn<ApiModule["fetchDiscoveredSkills"]>();
export const mockFetchSkillContent = vi.fn<ApiModule["fetchSkillContent"]>();
export const mockFetchModels = vi.fn<ApiModule["fetchModels"]>();
export const mockFetchPluginRuntimes = vi.fn<ApiModule["fetchPluginRuntimes"]>();
export const mockFetchAgentLogsWithMeta = vi.fn<ApiModule["fetchAgentLogsWithMeta"]>();
export const mockFetchAgentMailbox = vi.fn<ApiModule["fetchAgentMailbox"]>();
export const mockMarkMessageRead = vi.fn<ApiModule["markMessageRead"]>();
export const mockStartAgentRun = vi.fn<ApiModule["startAgentRun"]>();
export const mockUpgradeAgentHeartbeatProcedure = vi.fn<ApiModule["upgradeAgentHeartbeatProcedure"]>();
export const mockUpdateGlobalSettings = vi.fn<ApiModule["updateGlobalSettings"]>();
export const mockFetchCompanies = vi.fn<ApiModule["fetchCompanies"]>();
export const mockFetchSettings = vi.fn<ApiModule["fetchSettings"]>();
export const mockFetchSettingsByScope = vi.fn<ApiModule["fetchSettingsByScope"]>();
export const mockSubscribeSse = vi.fn<SseModule["subscribeSse"]>();
export const mockConfirm = vi.fn();

export const MOCK_SKILLS = [
  { id: "skill-1", name: "Skill One", path: "/path/skill-1", relativePath: "skills/skill-1", enabled: true, metadata: { source: "*", scope: "user" as const, origin: "top-level" as const } },
  { id: "skill-2", name: "Skill Two", path: "/path/skill-2", relativePath: "skills/skill-2", enabled: true, metadata: { source: "*", scope: "user" as const, origin: "top-level" as const } },
];

vi.mock("../../api", () => ({
  fetchAgent: (...args: Parameters<ApiModule["fetchAgent"]>) => mockFetchAgent(...args),
  fetchAgents: (...args: Parameters<ApiModule["fetchAgents"]>) => mockFetchAgents(...args),
  updateAgent: (...args: Parameters<ApiModule["updateAgent"]>) => mockUpdateAgent(...args),
  isAgentHeartbeatEnabled: (agent: { runtimeConfig?: { enabled?: boolean } }) => agent.runtimeConfig?.enabled !== false,
  withAgentHeartbeatEnabled: (agent: { runtimeConfig?: Record<string, unknown> }, enabled: boolean) => ({ ...(agent.runtimeConfig ?? {}), enabled }),
  updateAgentState: (...args: Parameters<ApiModule["updateAgentState"]>) => mockUpdateAgentState(...args),
  deleteAgent: (...args: Parameters<ApiModule["deleteAgent"]>) => mockDeleteAgent(...args),
  fetchAgentLogs: vi.fn(),
  fetchAgentLogsWithMeta: (...args: Parameters<ApiModule["fetchAgentLogsWithMeta"]>) => mockFetchAgentLogsWithMeta(...args),
  fetchAgentMailbox: (...args: Parameters<ApiModule["fetchAgentMailbox"]>) => mockFetchAgentMailbox(...args),
  markMessageRead: (...args: Parameters<ApiModule["markMessageRead"]>) => mockMarkMessageRead(...args),
  fetchAgentRunLogs: (...args: Parameters<ApiModule["fetchAgentRunLogs"]>) => mockFetchAgentRunLogs(...args),
  fetchAgentChildren: (...args: Parameters<ApiModule["fetchAgentChildren"]>) => mockFetchAgentChildren(...args),
  fetchAgentRuns: (...args: Parameters<ApiModule["fetchAgentRuns"]>) => mockFetchAgentRuns(...args),
  fetchAgentRunDetail: (...args: Parameters<ApiModule["fetchAgentRunDetail"]>) => mockFetchAgentRunDetail(...args),
  fetchAgentPromptSizes: (...args: Parameters<ApiModule["fetchAgentPromptSizes"]>) => mockFetchAgentPromptSizes(...args),
  startAgentRun: (...args: Parameters<ApiModule["startAgentRun"]>) => mockStartAgentRun(...args),
  stopAgentRun: vi.fn(),
  updateAgentInstructions: (...args: Parameters<ApiModule["updateAgentInstructions"]>) => mockUpdateAgentInstructions(...args),
  updateAgentSoul: (...args: Parameters<ApiModule["updateAgentSoul"]>) => mockUpdateAgentSoul(...args),
  updateAgentMemory: (...args: Parameters<ApiModule["updateAgentMemory"]>) => mockUpdateAgentMemory(...args),
  fetchAgentMemoryFiles: (...args: Parameters<ApiModule["fetchAgentMemoryFiles"]>) => mockFetchAgentMemoryFiles(...args),
  fetchAgentMemoryFile: (...args: Parameters<ApiModule["fetchAgentMemoryFile"]>) => mockFetchAgentMemoryFile(...args),
  saveAgentMemoryFile: (...args: Parameters<ApiModule["saveAgentMemoryFile"]>) => mockSaveAgentMemoryFile(...args),
  fetchAgentTasks: (...args: Parameters<ApiModule["fetchAgentTasks"]>) => mockFetchAgentTasks(...args),
  fetchChainOfCommand: (...args: Parameters<ApiModule["fetchChainOfCommand"]>) => mockFetchChainOfCommand(...args),
  fetchAgentBudgetStatus: (...args: Parameters<ApiModule["fetchAgentBudgetStatus"]>) => mockFetchAgentBudgetStatus(...args),
  resetAgentBudget: (...args: Parameters<ApiModule["resetAgentBudget"]>) => mockResetAgentBudget(...args),
  fetchWorkspaceFileContent: (...args: Parameters<ApiModule["fetchWorkspaceFileContent"]>) => mockFetchWorkspaceFileContent(...args),
  saveWorkspaceFileContent: (...args: Parameters<ApiModule["saveWorkspaceFileContent"]>) => mockSaveWorkspaceFileContent(...args),
  fetchDiscoveredSkills: (...args: Parameters<ApiModule["fetchDiscoveredSkills"]>) => mockFetchDiscoveredSkills(...args),
  fetchSkillContent: (...args: Parameters<ApiModule["fetchSkillContent"]>) => mockFetchSkillContent(...args),
  fetchModels: (...args: Parameters<ApiModule["fetchModels"]>) => mockFetchModels(...args),
  fetchPluginRuntimes: (...args: Parameters<ApiModule["fetchPluginRuntimes"]>) => mockFetchPluginRuntimes(...args),
  upgradeAgentHeartbeatProcedure: (...args: Parameters<ApiModule["upgradeAgentHeartbeatProcedure"]>) => mockUpgradeAgentHeartbeatProcedure(...args),
  updateGlobalSettings: (...args: Parameters<ApiModule["updateGlobalSettings"]>) => mockUpdateGlobalSettings(...args),
  fetchCompanies: (...args: Parameters<ApiModule["fetchCompanies"]>) => mockFetchCompanies(...args),
  fetchSettings: (...args: Parameters<ApiModule["fetchSettings"]>) => mockFetchSettings(...args),
  fetchSettingsByScope: (...args: Parameters<ApiModule["fetchSettingsByScope"]>) => mockFetchSettingsByScope(...args),
  uploadAgentAvatar: vi.fn(),
  deleteAgentAvatar: vi.fn(),
}));

vi.mock("../AgentLogViewer", () => ({
  AgentLogViewer: ({ entries }: { entries: Array<{ text: string; detail?: string }> }) => createElement(
    "div",
    { "data-testid": "agent-log-viewer" },
    ...entries.map((e, i) => createElement(
      "div",
      { key: i },
      createElement("span", null, e.text),
      e.detail
        ? createElement(
          "button",
          { type: "button", "data-testid": "tool-detail-toggle", "aria-expanded": "false" },
          "Show output",
        )
        : null,
    )),
  ),
}));

vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({ models, value, onChange, disabled, label, placeholder, id, favoriteProviders = [], onToggleFavorite, favoriteModels = [], onToggleModelFavorite, thinkingLevel, onThinkingLevelChange, defaultThinkingLevel }: {
    models: Array<{ provider: string; id: string }>;
    value: string;
    onChange: (v: string) => void;
    disabled?: boolean;
    label: string;
    placeholder?: string;
    id?: string;
    favoriteProviders?: string[];
    onToggleFavorite?: (provider: string) => void;
    favoriteModels?: string[];
    onToggleModelFavorite?: (modelId: string) => void;
    thinkingLevel?: string;
    onThinkingLevelChange?: (level: string) => void;
    defaultThinkingLevel?: string;
  }) => {
    const selectId = id ?? "custom-model-dropdown";
    const thinkingSelectId = `${selectId}-thinking-level`;
    return createElement(
      "div",
      {
        "data-testid": "custom-model-dropdown",
        "data-favorite-providers": favoriteProviders.join(","),
        "data-favorite-models": favoriteModels.join(","),
        "data-default-thinking-level": defaultThinkingLevel ?? "",
      },
      createElement("label", { htmlFor: selectId }, label),
      createElement(
        "select",
        {
          id: selectId,
          "aria-label": label,
          value,
          disabled,
          onChange: (e: Event) => onChange((e.target as HTMLSelectElement).value),
        },
        createElement("option", { value: "" }, placeholder ?? "Use default"),
        ...models.map((model) => {
          const modelValue = `${model.provider}/${model.id}`;
          return createElement("option", { key: modelValue, value: modelValue }, modelValue);
        }),
      ),
      onThinkingLevelChange
        ? createElement(
          "select",
          {
            id: thinkingSelectId,
            "aria-label": `${label} thinking level`,
            value: thinkingLevel ?? "",
            onChange: (e: Event) => onThinkingLevelChange((e.target as HTMLSelectElement).value),
          },
          ...["off", "minimal", "low", "medium", "high", "xhigh"].map((level) => createElement("option", { key: level, value: level }, level)),
        )
        : null,
      ...Array.from(new Set(models.map((model) => model.provider))).map((provider) => createElement(
        "button",
        {
          key: `provider-${provider}`,
          type: "button",
          "data-testid": `toggle-provider-favorite-${provider}`,
          onClick: () => onToggleFavorite?.(provider),
        },
        `toggle provider ${provider}`,
      )),
      ...models.map((model) => {
        const modelValue = `${model.provider}/${model.id}`;
        return createElement(
          "button",
          {
            key: `model-${modelValue}`,
            type: "button",
            "data-testid": `toggle-model-favorite-${modelValue}`,
            onClick: () => onToggleModelFavorite?.(modelValue),
          },
          `toggle model ${modelValue}`,
        );
      }),
    );
  },
}));

vi.mock("../SkillMultiselect", () => ({
  SkillMultiselect: ({ value, onChange, id: _id }: { value: string[]; onChange: (v: string[]) => void; id?: string }) => createElement(
    "div",
    { "data-testid": "skill-multiselect" },
    createElement("span", { "data-testid": "skill-multiselect-value" }, JSON.stringify(value)),
    createElement("button", { "data-testid": "add-skill-test", onClick: () => onChange([...value, "test-skill"]) }, "Add Test Skill"),
    createElement("button", { "data-testid": "remove-skill-test", onClick: () => onChange(value.filter((s) => s !== "test-skill")) }, "Remove Test Skill"),
  ),
}));

vi.mock("../ExperimentalAgentOnboardingModal", () => ({
  ExperimentalAgentOnboardingModal: ({ isOpen, mode, existingAgentConfig, onUseDraft, onClose }: {
    isOpen: boolean;
    mode?: "create" | "edit";
    existingAgentConfig?: Record<string, unknown>;
    onUseDraft: (summary: any) => void;
    onClose: () => void;
  }) => (isOpen
    ? createElement(
      "div",
      { "data-testid": "mock-ai-interview-modal" },
      createElement("span", { "data-testid": "mock-ai-interview-mode" }, mode),
      createElement(
        "button",
        {
          type: "button",
          onClick: () => onUseDraft({
            name: "Interviewed Agent",
            role: "reviewer",
            title: "Draft Title",
            icon: "🧠",
            reportsTo: "agent-002",
            instructionsText: "Updated instructions",
            soul: "Updated soul",
            memory: "Updated memory",
            skills: ["skill-1"],
            thinkingLevel: "high",
            maxTurns: 12,
            model: "openai/gpt-4o",
          }),
        },
        "Apply Draft",
      ),
      createElement("button", { type: "button", onClick: onClose }, "Close Modal"),
      createElement("pre", { "data-testid": "mock-ai-existing-config" }, JSON.stringify(existingAgentConfig ?? {})),
    )
    : null),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: (...args: Parameters<SseModule["subscribeSse"]>) => mockSubscribeSse(...args),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
}));

export const createMockAgent = (overrides: Partial<AgentDetail> = {}): AgentDetail => ({
  id: "agent-001",
  name: "Test Agent",
  role: "executor" as AgentCapability,
  state: "active",
  taskId: "FN-001",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  lastHeartbeatAt: "2024-01-01T00:05:00.000Z",
  metadata: {},
  runtimeConfig: overrides.runtimeConfig,
  heartbeatHistory: [],
  activeRun: {
    id: "run-001",
    agentId: "agent-001",
    startedAt: "2024-01-01T00:00:00.000Z",
    endedAt: null,
    status: "active",
  },
  completedRuns: [
    {
      id: "run-002",
      agentId: "agent-001",
      startedAt: "2023-12-31T00:00:00.000Z",
      endedAt: "2023-12-31T00:05:00.000Z",
      status: "completed",
    },
  ],
  ...overrides,
}) as AgentDetail;

export function setupAgentDetailMocks() {
  vi.clearAllMocks();
  mockConfirm.mockReset();
  mockConfirm.mockResolvedValue(true);
  mockSubscribeSse.mockReset();
  mockSubscribeSse.mockReturnValue(vi.fn());
  const mockAgent = createMockAgent();
  mockFetchAgent.mockResolvedValue(mockAgent);
  mockStartAgentRun.mockResolvedValue({ id: "run-003" } as any);
  mockFetchAgents.mockResolvedValue([
    { id: "agent-001", name: "Test Agent", role: "executor", state: "active", metadata: {} },
    { id: "agent-002", name: "Manager Agent", role: "reviewer", state: "active", metadata: {} },
    { id: "agent-003", name: "Director Agent", role: "triage", state: "active", metadata: {} },
  ] as any);
  mockUpdateAgentState.mockResolvedValue(createMockAgent({ state: "paused" }));
  mockDeleteAgent.mockResolvedValue(undefined);
  mockUpdateAgent.mockResolvedValue(createMockAgent() as any);
  mockFetchAgentRuns.mockResolvedValue([
    ...(mockAgent.activeRun ? [mockAgent.activeRun] : []),
    ...mockAgent.completedRuns,
  ]);
  mockFetchAgentRunLogs.mockResolvedValue([]);
  mockFetchAgentRunDetail.mockResolvedValue(mockAgent.completedRuns[0]);
  mockFetchAgentPromptSizes.mockResolvedValue([]);
  mockFetchAgentChildren.mockResolvedValue([]);
  mockFetchAgentTasks.mockResolvedValue([]);
  mockFetchChainOfCommand.mockResolvedValue([mockAgent]);
  mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: [], total: 0, hasMore: false });
  mockFetchAgentMailbox.mockResolvedValue({
    ownerId: "agent-001",
    ownerType: "agent",
    unreadCount: 0,
    messages: [],
    inbox: [],
    outbox: [],
  });
  mockMarkMessageRead.mockResolvedValue({
    id: "msg-default",
    fromId: "dashboard",
    fromType: "user",
    toId: "agent-001",
    toType: "agent",
    content: "",
    type: "user-to-agent",
    read: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  } as any);
  mockStartAgentRun.mockResolvedValue({ id: "run-003" } as any);
  mockFetchAgentBudgetStatus.mockResolvedValue({
    agentId: "agent-001",
    currentUsage: 0,
    budgetLimit: null,
    usagePercent: null,
    thresholdPercent: null,
    isOverBudget: false,
    isOverThreshold: false,
    lastResetAt: null,
    nextResetAt: null,
  });
  mockResetAgentBudget.mockResolvedValue(undefined);
  mockFetchWorkspaceFileContent.mockResolvedValue({ content: "", mtime: "2024-01-01T00:00:00.000Z", size: 0 });
  mockSaveWorkspaceFileContent.mockResolvedValue({ success: true, mtime: "2024-01-01T00:00:00.000Z", size: 0 });
  mockUpdateAgentInstructions.mockResolvedValue({} as any);
  mockFetchAgentMemoryFiles.mockResolvedValue({
    files: [
      {
        path: ".fusion/agent-memory/agent-001/MEMORY.md",
        label: "MEMORY.md",
        layer: "long-term",
        size: 12,
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ],
  } as any);
  mockFetchAgentMemoryFile.mockResolvedValue({
    path: ".fusion/agent-memory/agent-001/MEMORY.md",
    content: "",
  } as any);
  mockSaveAgentMemoryFile.mockResolvedValue({ success: true } as any);
  mockFetchDiscoveredSkills.mockResolvedValue(MOCK_SKILLS);
  mockFetchSkillContent.mockResolvedValue({ name: "Skill", skillMd: "# Skill", files: [] });
  mockFetchModels.mockResolvedValue({
    models: [
      { provider: "openai", id: "gpt-4o", name: "gpt-4o", reasoning: false, contextWindow: 128000 },
      { provider: "anthropic", id: "claude-3-7-sonnet", name: "claude-3-7-sonnet", reasoning: true, contextWindow: 200000 },
    ],
    favoriteProviders: [],
    favoriteModels: [],
  });
  mockFetchPluginRuntimes.mockResolvedValue([
    { pluginId: "fusion-plugin-openclaw-runtime", runtimeId: "openclaw", name: "OpenClaw", description: "OpenClaw runtime", version: "1.0.0" },
    { pluginId: "fusion-plugin-hermes-runtime", runtimeId: "hermes", name: "Hermes", description: "Hermes runtime", version: "1.1.0" },
  ]);
  mockUpgradeAgentHeartbeatProcedure.mockResolvedValue({
    heartbeatProcedurePath: ".fusion/agents/agent-001/HEARTBEAT.md",
    procedureFileSeeded: true,
  });
  mockUpdateGlobalSettings.mockResolvedValue({} as any);
  mockFetchCompanies.mockResolvedValue({ companies: [] });
  mockFetchSettings.mockResolvedValue({ heartbeatMultiplier: 1 } as any);
  mockFetchSettingsByScope.mockResolvedValue({ global: {}, project: {} } as any);
}
