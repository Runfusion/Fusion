import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SetupWizardModal } from "../SetupWizardModal";
import { AGENT_PRESETS } from "../agent-presets";
import { buildAgentCreatePayload, mapPresetToAgentDraft } from "../agent-presets/agentCreatePayload";

// Mock lucide-react
vi.mock("lucide-react", async () => {
  const actual = await vi.importActual("lucide-react");
  return {
    ...actual,
    X: ({ size, ...props }: any) => <span data-testid="close-icon" {...props}>×</span>,
    Loader2: ({ size, ...props }: any) => <span data-testid="loader" {...props}>⟳</span>,
    Sparkles: ({ size, ...props }: any) => <span data-testid="sparkles-icon" {...props}>✨</span>,
    CheckCircle: ({ size, ...props }: any) => <span data-testid="check-icon" {...props}>✓</span>,
    Folder: ({ size, ...props }: any) => <span {...props}>📁</span>,
    FolderOpen: ({ size, ...props }: any) => <span {...props}>📂</span>,
    ChevronRight: ({ size, ...props }: any) => <span {...props}>→</span>,
    ChevronUp: ({ size, ...props }: any) => <span {...props}>↑</span>,
    Eye: ({ size, ...props }: any) => <span {...props}>👁</span>,
    EyeOff: ({ size, ...props }: any) => <span {...props}>🙈</span>,
    AlertCircle: ({ size, ...props }: any) => <span {...props}>⚠</span>,
  };
});

// Mock useNodes hook
vi.mock("../../hooks/useNodes", () => ({
  useNodes: vi.fn(() => ({
    nodes: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    register: vi.fn(),
    update: vi.fn(),
    unregister: vi.fn(),
    healthCheck: vi.fn(),
  })),
}));

// Mock api module
// FNXC:Onboarding 2026-06-25-13:20:
// SetupWizardModal now probes `detectWorkspace` on existing-directory path entry
// (FNXC:Workspace 2026-06-24-21:00). The mock must export it or the component's
// path-change handler throws an unhandled rejection. Default to a non-workspace
// single-repo result so the legacy submit-payload assertions stay deterministic.
vi.mock("../../api", () => ({
  registerProject: vi.fn(),
  createAgent: vi.fn(),
  detectWorkspace: vi.fn().mockResolvedValue({ repos: [], isWorkspace: false }),
  browseDirectory: vi.fn().mockResolvedValue({
    currentPath: "/home/user",
    parentPath: "/home",
    entries: [],
  }),
}));

vi.mock("../ExperimentalAgentOnboardingModal", () => ({
  ExperimentalAgentOnboardingModal: ({ isOpen, onClose, onUseDraft }: { isOpen: boolean; onClose: () => void; onUseDraft: (draft: any) => void }) => (
    isOpen ? (
      <div data-testid="agent-interview-modal">
        AI Interview Modal
        <button
          type="button"
          onClick={() => {
            onUseDraft({
              name: "Launch Coordinator",
              title: "Launch Planning Agent",
              icon: "◇",
              role: "not-a-real-role",
              instructionsText: "Coordinate launch tasks.",
              soul: "Strategic launch planner.",
              skills: ["planning", "review"],
              runtimeHint: "codex-local",
              maxTurns: 24,
              thinkingLevel: "medium",
            });
            onClose();
          }}
        >
          Use Draft
        </button>
      </div>
    ) : null
  ),
}));

import { createAgent, registerProject, detectWorkspace } from "../../api";
import { useNodes } from "../../hooks/useNodes";

const mockRegisterProject = vi.mocked(registerProject);
const mockCreateAgent = vi.mocked(createAgent);
const mockDetectWorkspace = vi.mocked(detectWorkspace);
const mockUseNodes = vi.mocked(useNodes);

function buildMockProject(overrides = {}) {
  return {
    id: "proj_123",
    name: "test-project",
    path: "/home/user/project",
    status: "active" as const,
    isolationMode: "in-process" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function buildMockAgent(overrides = {}) {
  return {
    id: "agent_123",
    projectId: "proj_123",
    name: "Agent",
    role: "custom",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function registerProjectFromWizard() {
  fireEvent.change(screen.getByPlaceholderText("/path/to/your/project"), {
    target: { value: "/home/user/project" },
  });
  fireEvent.change(screen.getByPlaceholderText("my-project"), {
    target: { value: "test-project" },
  });
  fireEvent.click(screen.getByText("Register Project"));
  return screen.findByText("Create your first agent");
}

describe("SetupWizardModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegisterProject.mockReset();
    mockCreateAgent.mockReset();
    mockDetectWorkspace.mockResolvedValue({ repos: [], isWorkspace: false });
  });

  it("starts on the project form without an auth token step", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Welcome to Fusion")).toBeDefined();
    expect(screen.getByText("Project Name")).toBeDefined();
    expect(screen.getByLabelText("Fusion logo")).toBeDefined();
    expect(screen.getByText("Repository setup")).toBeDefined();
    expect(screen.getByLabelText("Use Existing Directory")).toBeDefined();
    expect(screen.getByLabelText("Initialize New Repository")).toBeDefined();
    expect(screen.getByLabelText("Clone Git Repository")).toBeDefined();
    expect(screen.getByText("Advanced settings")).toBeDefined();
    expect(screen.queryByText("Set Auth Token")).toBeNull();
    expect(screen.queryByText("Set Token & Continue")).toBeNull();
    expect(screen.getByRole("link", { name: "Need help?" })).toHaveAttribute(
      "href",
      "https://discord.gg/ksrfuy7WYR"
    );
  });

  it("has DirectoryPicker for path selection", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    // DirectoryPicker renders an input and a Browse button
    expect(screen.getByPlaceholderText("/path/to/your/project")).toBeDefined();
    expect(screen.getByText("Browse")).toBeDefined();
  });

  it("auto-populates project name from selected directory path", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    // Type a path in the DirectoryPicker input
    const pathInput = screen.getByPlaceholderText("/path/to/your/project");
    fireEvent.change(pathInput, { target: { value: "/home/user/my-awesome-project" } });

    const nameInput = screen.getByPlaceholderText("my-project") as HTMLInputElement;
    expect(nameInput.value).toBe("my-awesome-project");
  });

  it("register button is disabled when required fields are empty", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const registerBtn = screen.getByText("Register Project").closest("button")!;
    expect(registerBtn.disabled).toBe(true);
  });

  it("register button is enabled when path and name are provided", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("/path/to/your/project"), {
      target: { value: "/home/user/project" },
    });
    // Name auto-populates; ensure it's not empty
    const nameInput = screen.getByPlaceholderText("my-project") as HTMLInputElement;
    expect(nameInput.value).toBe("project");

    const registerBtn = screen.getByText("Register Project").closest("button")!;
    expect(registerBtn.disabled).toBe(false);
  });

  it("existing-directory submit payload is unchanged", async () => {
    mockRegisterProject.mockResolvedValueOnce({
      id: "proj_existing",
      name: "existing-project",
      path: "/existing/project",
      status: "active",
      isolationMode: "in-process",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("/path/to/your/project"), {
      target: { value: "/existing/project" },
    });

    fireEvent.click(screen.getByText("Register Project"));

    await waitFor(() => {
      /*
      FNXC:SetupWizard 2026-06-25-16:55:
      Project registration now always sends the operator-visible workspace and task prefix fields, even when the existing-directory path is a single repo.
      Keep this stale-expectation test pinned to the current create-project contract instead of asserting the pre-workspace payload shape.
      */
      expect(mockRegisterProject).toHaveBeenCalledWith({
        name: "project",
        path: "/existing/project",
        isolationMode: "in-process",
        nodeId: undefined,
        gitSetupMode: "existing",
        cloneUrl: undefined,
        workspaceMode: false,
        taskPrefix: "PROJ",
      });
    });
  });

  it("renders first-class repository setup modes without opening advanced settings", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Repository setup")).toBeDefined();
    expect(screen.getByText(/Register a folder that is already a git repository/)).toBeDefined();
    expect(screen.getByText(/let Fusion run git init/)).toBeDefined();
    expect(screen.getByText(/Clone a remote repository/)).toBeDefined();
    expect(screen.queryByLabelText("Repository URL")).toBeNull();

    fireEvent.click(screen.getByLabelText("Clone Git Repository"));

    expect(screen.getByLabelText("Repository URL")).toBeDefined();
    expect(screen.getByPlaceholderText("/path/for/new-clone")).toBeDefined();
    expect(screen.getByText(/destination must be empty or absent/)).toBeDefined();
    expect(screen.getByText(/Fusion will run git clone into the destination directory/)).toBeDefined();
  });

  it("clone mode submit sends cloneUrl payload", async () => {
    const onProjectRegistered = vi.fn();
    mockRegisterProject.mockResolvedValueOnce({
      id: "proj_clone",
      name: "fusion",
      path: "/tmp/fusion",
      status: "active",
      isolationMode: "in-process",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    render(
      <SetupWizardModal
        onProjectRegistered={onProjectRegistered}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByLabelText("Clone Git Repository"));
    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "https://github.com/runfusion/fusion.git" },
    });
    fireEvent.change(screen.getByPlaceholderText("/path/for/new-clone"), {
      target: { value: "/tmp/fusion" },
    });

    fireEvent.click(screen.getByText("Clone and Register Project"));

    await waitFor(() => {
      /*
      FNXC:SetupWizard 2026-06-25-16:55:
      Clone registration uses the same explicit workspace/task-prefix contract as existing-directory registration so downstream project setup receives one complete shape.
      */
      expect(mockRegisterProject).toHaveBeenCalledWith({
        name: "fusion",
        path: "/tmp/fusion",
        isolationMode: "in-process",
        nodeId: undefined,
        gitSetupMode: "clone",
        cloneUrl: "https://github.com/runfusion/fusion.git",
        workspaceMode: false,
        taskPrefix: "FUSI",
      });
    });
    expect(await screen.findByText("Create your first agent")).toBeDefined();
    expect(screen.getByRole("radio", { name: "CEO selected" })).toHaveAttribute("aria-checked", "true");
    expect(onProjectRegistered).not.toHaveBeenCalled();
  });

  it("initialize mode submits an explicit init setup payload without clone or workspace state", async () => {
    mockRegisterProject.mockResolvedValueOnce({
      id: "proj_init",
      name: "new-project",
      path: "/tmp/new-project",
      status: "active",
      isolationMode: "in-process",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByLabelText("Initialize New Repository"));
    expect(screen.getByText(/Fusion will run git init during registration/)).toBeDefined();
    fireEvent.change(screen.getByPlaceholderText("/path/to/new-project"), {
      target: { value: "/tmp/new-project" },
    });

    fireEvent.click(screen.getByText("Initialize and Register Project"));

    await waitFor(() => {
      expect(mockRegisterProject).toHaveBeenCalledWith({
        name: "new-project",
        path: "/tmp/new-project",
        isolationMode: "in-process",
        nodeId: undefined,
        gitSetupMode: "init",
        cloneUrl: undefined,
        workspaceMode: false,
        taskPrefix: "NEWP",
      });
    });
  });

  it("switching setup modes clears stale clone and workspace state", async () => {
    mockDetectWorkspace.mockResolvedValueOnce({ repos: ["api"], isWorkspace: true });
    mockRegisterProject.mockResolvedValueOnce({
      id: "proj_existing",
      name: "workspace",
      path: "/tmp/workspace",
      status: "active",
      isolationMode: "in-process",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("/path/to/your/project"), {
      target: { value: "/tmp/workspace" },
    });
    expect(await screen.findByText(/Found 1 repositories/)).toBeDefined();

    fireEvent.click(screen.getByLabelText("Clone Git Repository"));
    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "https://github.com/runfusion/fusion.git" },
    });
    fireEvent.click(screen.getByLabelText("Initialize New Repository"));
    expect(screen.queryByLabelText("Repository URL")).toBeNull();

    fireEvent.click(screen.getByText("Initialize and Register Project"));

    await waitFor(() => {
      expect(mockRegisterProject).toHaveBeenCalledWith(expect.objectContaining({
        gitSetupMode: "init",
        cloneUrl: undefined,
        workspaceMode: false,
      }));
    });
  });

  it("register button disabled/enabled logic is mode-aware", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const registerBtn = screen.getByText("Register Project").closest("button")!;
    expect(registerBtn.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText("Clone Git Repository"));
    fireEvent.change(screen.getByPlaceholderText("/path/for/new-clone"), {
      target: { value: "/tmp/repo" },
    });
    expect(registerBtn.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "https://github.com/runfusion/fusion.git" },
    });
    expect(registerBtn.disabled).toBe(false);

    fireEvent.click(screen.getByLabelText("Use Existing Directory"));
    expect(registerBtn.disabled).toBe(false);
  });

  it("auto-suggested name updates until manually edited", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByLabelText("Clone Git Repository"));

    const nameInput = screen.getByPlaceholderText("my-project") as HTMLInputElement;
    const destinationInput = screen.getByPlaceholderText("/path/for/new-clone");

    fireEvent.change(destinationInput, { target: { value: "/tmp/fusion" } });
    expect(nameInput.value).toBe("fusion");

    fireEvent.change(destinationInput, { target: { value: "/tmp/fusion-next" } });
    expect(nameInput.value).toBe("fusion-next");

    fireEvent.change(nameInput, { target: { value: "custom-name" } });
    fireEvent.change(destinationInput, { target: { value: "/tmp/fusion-final" } });
    expect(nameInput.value).toBe("custom-name");
  });

  it("shows error state on registration failure", async () => {
    mockRegisterProject.mockRejectedValueOnce(new Error("Path does not exist"));

    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("/path/to/your/project"), {
      target: { value: "/bad/path" },
    });
    fireEvent.change(screen.getByPlaceholderText("my-project"), {
      target: { value: "test-project" },
    });

    fireEvent.click(screen.getByText("Register Project"));

    await waitFor(() => {
      expect(mockRegisterProject).toHaveBeenCalled();
    });
    expect(await screen.findByText("Path does not exist")).toBeDefined();
  });

  it("shows optional first-agent step after successful registration", async () => {
    const mockProject = buildMockProject();
    mockRegisterProject.mockResolvedValueOnce(mockProject);

    const onProjectRegistered = vi.fn();
    render(
      <SetupWizardModal
        onProjectRegistered={onProjectRegistered}
        onClose={vi.fn()}
      />
    );

    await registerProjectFromWizard();

    await waitFor(() => {
      expect(mockRegisterProject).toHaveBeenCalled();
    });
    expect(screen.getByText(/Agents are optional/)).toBeDefined();
    expect(screen.getByRole("radio", { name: "CEO selected" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Create Agent")).toBeDefined();
    expect(screen.getByText("Skip for now")).toBeDefined();
    expect(screen.queryByText("AI Interview")).toBeNull();

    expect(onProjectRegistered).not.toHaveBeenCalled();
  });

  it("can register project only when embedded in brand-new onboarding", async () => {
    const mockProject = buildMockProject();
    mockRegisterProject.mockResolvedValueOnce(mockProject);

    const onProjectRegistered = vi.fn();
    render(
      <SetupWizardModal
        onProjectRegistered={onProjectRegistered}
        onClose={vi.fn()}
        includeAgentStep={false}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("/path/to/your/project"), {
      target: { value: "/home/user/project" },
    });
    fireEvent.change(screen.getByPlaceholderText("my-project"), {
      target: { value: "test-project" },
    });
    fireEvent.click(screen.getByText("Register Project"));

    await waitFor(() => {
      expect(mockRegisterProject).toHaveBeenCalled();
      expect(onProjectRegistered).toHaveBeenCalledWith(mockProject);
    });
    expect(screen.queryByText("Create your first agent")).toBeNull();
  });

  it("can skip first-agent creation and finish setup", async () => {
    const mockProject = buildMockProject();
    mockRegisterProject.mockResolvedValueOnce(mockProject);

    const onProjectRegistered = vi.fn();
    render(
      <SetupWizardModal
        onProjectRegistered={onProjectRegistered}
        onClose={vi.fn()}
      />
    );

    expect(await registerProjectFromWizard()).toBeDefined();

    fireEvent.click(screen.getByText("Skip for now"));
    expect(await screen.findByText("All Set!")).toBeDefined();
    expect(screen.getByText("You can create agents later from the Agents view.")).toBeDefined();
    expect(mockCreateAgent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Get Started"));
    expect(onProjectRegistered).toHaveBeenCalledWith(mockProject);
  });

  it("does not show an ambiguous close button on the first-agent step", async () => {
    const mockProject = buildMockProject();
    mockRegisterProject.mockResolvedValueOnce(mockProject);

    const onProjectRegistered = vi.fn();
    render(
      <SetupWizardModal
        onProjectRegistered={onProjectRegistered}
        onClose={vi.fn()}
      />
    );

    expect(await registerProjectFromWizard()).toBeDefined();

    expect(screen.queryByLabelText("Close wizard")).toBeNull();

    fireEvent.click(screen.getByText("Skip for now"));
    expect(await screen.findByText("All Set!")).toBeDefined();
    expect(screen.getByText("You can create agents later from the Agents view.")).toBeDefined();
    expect(onProjectRegistered).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Get Started"));
    expect(onProjectRegistered).toHaveBeenCalledWith(mockProject);
  });

  it("creates the default CEO agent before finishing setup", async () => {
    const mockProject = buildMockProject();
    mockRegisterProject.mockResolvedValueOnce(mockProject);
    mockCreateAgent.mockResolvedValueOnce(buildMockAgent({
      id: "agent_ceo",
      projectId: mockProject.id,
      name: "CEO",
    }) as any);

    const onProjectRegistered = vi.fn();
    render(
      <SetupWizardModal
        onProjectRegistered={onProjectRegistered}
        onClose={vi.fn()}
      />
    );

    expect(await registerProjectFromWizard()).toBeDefined();

    fireEvent.click(screen.getByText("Create Agent"));

    await waitFor(() => {
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "CEO",
          role: "custom",
          title: "Oversees project strategy, sets priorities, and coordinates between departments to ensure alignment with business goals.",
        }),
        mockProject.id,
      );
    });
    expect(await screen.findByText("Your project is registered and your first agent is ready.")).toBeDefined();

    fireEvent.click(screen.getByText("Get Started"));
    expect(onProjectRegistered).toHaveBeenCalledWith(mockProject);
  });

  it("creates the selected non-CEO preset with the shared payload mapping", async () => {
    const mockProject = buildMockProject();
    const engineerPreset = AGENT_PRESETS.find((preset) => preset.id === "engineer")!;
    mockRegisterProject.mockResolvedValueOnce(mockProject);
    mockCreateAgent.mockResolvedValueOnce(buildMockAgent({
      id: "agent_engineer",
      projectId: mockProject.id,
      name: engineerPreset.name,
      role: engineerPreset.role,
    }) as any);

    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(await registerProjectFromWizard()).toBeDefined();
    fireEvent.click(screen.getByRole("radio", { name: engineerPreset.name }));

    expect(screen.getByRole("radio", { name: `${engineerPreset.name} selected` })).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByText(engineerPreset.description!).length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByText("Create Agent"));

    await waitFor(() => {
      expect(mockCreateAgent).toHaveBeenCalledWith(
        buildAgentCreatePayload(mapPresetToAgentDraft(engineerPreset)),
        mockProject.id,
      );
    });
  });

  it("supports arrow-key navigation in the first-agent template radio group", async () => {
    const mockProject = buildMockProject();
    mockRegisterProject.mockResolvedValueOnce(mockProject);

    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(await registerProjectFromWizard()).toBeDefined();
    const ceoOption = screen.getByRole("radio", { name: "CEO selected" });
    ceoOption.focus();

    fireEvent.keyDown(ceoOption, { key: "ArrowDown" });
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: "CTO selected" })).toHaveAttribute("aria-checked", "true");
    });

    fireEvent.keyDown(screen.getByRole("radio", { name: "CTO selected" }), { key: "End" });
    const lastPreset = AGENT_PRESETS[AGENT_PRESETS.length - 1]!;
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: `${lastPreset.name} selected` })).toHaveAttribute("aria-checked", "true");
    });
  });

  it("keeps first-agent step available when agent creation fails", async () => {
    const mockProject = buildMockProject();
    const onProjectRegistered = vi.fn();
    mockRegisterProject.mockResolvedValueOnce(mockProject);
    mockCreateAgent.mockRejectedValueOnce(new Error("Agent quota reached"));

    render(
      <SetupWizardModal
        onProjectRegistered={onProjectRegistered}
        onClose={vi.fn()}
      />
    );

    expect(await registerProjectFromWizard()).toBeDefined();
    fireEvent.click(screen.getByText("Create Agent"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Agent quota reached");
    expect(document.activeElement).toBe(alert);
    expect(screen.getByText("Create Agent")).toBeDefined();
    expect(screen.getByText("Skip for now")).toBeDefined();
    expect(screen.getByRole("radio", { name: "CEO selected" })).toHaveAttribute("aria-checked", "true");
    expect(onProjectRegistered).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Skip for now"));
    expect(await screen.findByText("You can create agents later from the Agents view.")).toBeDefined();
  });

  it("treats an already-exists agent as success instead of blocking setup", async () => {
    // FNXC:Onboarding 2026-07-03: the default "CEO" can already exist when this step runs — reached via
    // the unified ModelOnboarding agent step or a prior attempt; agent names are unique per store, so a
    // redundant create returns 409 "already exists". That must NOT block first-run: the desired end
    // state (a first agent exists) already holds, so the wizard advances to completion.
    const mockProject = buildMockProject();
    const onProjectRegistered = vi.fn();
    mockRegisterProject.mockResolvedValueOnce(mockProject);
    mockCreateAgent.mockRejectedValueOnce(
      new Error('Agent with name "CEO" already exists (agentId: agent_ceo)'),
    );

    render(
      <SetupWizardModal
        onProjectRegistered={onProjectRegistered}
        onClose={vi.fn()}
      />
    );

    expect(await registerProjectFromWizard()).toBeDefined();
    fireEvent.click(screen.getByText("Create Agent"));

    // Advances to the completion step; no blocking error alert.
    expect(await screen.findByText("Your project is registered and your first agent is ready.")).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByText("Get Started"));
    expect(onProjectRegistered).toHaveBeenCalledWith(mockProject);
  });

  it("applies an AI interview draft and waits for explicit creation", async () => {
    const mockProject = buildMockProject();
    mockRegisterProject.mockResolvedValueOnce(mockProject);
    mockCreateAgent.mockResolvedValueOnce(buildMockAgent({
      id: "agent_launch",
      projectId: mockProject.id,
      name: "Launch Coordinator",
    }) as any);

    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
        agentOnboardingEnabled
      />
    );

    expect(await registerProjectFromWizard()).toBeDefined();
    expect(screen.getByText("AI Interview")).toBeDefined();

    fireEvent.click(screen.getByText("AI Interview"));
    expect(await screen.findByTestId("agent-interview-modal")).toBeDefined();

    fireEvent.click(screen.getByText("Use Draft"));

    expect(await screen.findByText("Launch Coordinator")).toBeDefined();
    expect(screen.getByText("Launch Planning Agent")).toBeDefined();
    const ceoRadio = screen.getByRole("radio", { name: "CEO" });
    expect(ceoRadio).toHaveAttribute("tabIndex", "0");
    expect(ceoRadio).toHaveAttribute("aria-checked", "false");
    expect(mockCreateAgent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Create Agent"));

    await waitFor(() => {
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Launch Coordinator",
          role: "custom",
          title: "Launch Planning Agent",
          instructionsText: "Coordinate launch tasks.",
          soul: "Strategic launch planner.",
          metadata: { skills: ["planning", "review"] },
          runtimeConfig: {
            runtimeHint: "codex-local",
            maxTurns: 24,
            thinkingLevel: "medium",
          },
        }),
        mockProject.id,
      );
    });
  });

  it("close button calls onClose", () => {
    const onClose = vi.fn();
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByLabelText("Close wizard"));
    expect(onClose).toHaveBeenCalled();
  });

  it("reveals advanced settings on demand", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.queryByText("Runtime Node")).toBeNull();
    expect(screen.queryByText("In-Process")).toBeNull();

    fireEvent.click(screen.getByText("Advanced settings"));

    expect(screen.getByText("Runtime Node")).toBeDefined();
    expect(screen.getByText("In-Process")).toBeDefined();
    expect(screen.getByText("Child-Process")).toBeDefined();
    expect(screen.getByText("Recommended")).toBeDefined();
  });

  it("can switch isolation mode", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Advanced settings"));

    // Initially in-process is selected
    const inProcessRadio = screen.getByDisplayValue("in-process") as HTMLInputElement;
    const childProcessRadio = screen.getByDisplayValue("child-process") as HTMLInputElement;

    expect(inProcessRadio.checked).toBe(true);
    expect(childProcessRadio.checked).toBe(false);

    fireEvent.click(childProcessRadio);
    expect(childProcessRadio.checked).toBe(true);
  });

  describe("node selector", () => {
    const localNode = {
      id: "local-1",
      name: "Local Node",
      type: "local" as const,
      status: "online" as const,
      maxConcurrent: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const remoteNode = {
      id: "remote-1",
      name: "Remote Node",
      type: "remote" as const,
      url: "http://localhost:3001",
      status: "online" as const,
      maxConcurrent: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    it("node selector is present when nodes load", () => {
      mockUseNodes.mockImplementation(() => ({
        nodes: [localNode, remoteNode],
        loading: false,
        error: null,
        refresh: vi.fn(),
        register: vi.fn(),
        update: vi.fn(),
        unregister: vi.fn(),
        healthCheck: vi.fn(),
      }));

      render(
        <SetupWizardModal
          onProjectRegistered={vi.fn()}
          onClose={vi.fn()}
        />
      );

      fireEvent.click(screen.getByText("Advanced settings"));

      expect(screen.getByText("Runtime Node")).toBeDefined();
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe("");

      // Check options directly by querying the select's children
      const options = Array.from(select.querySelectorAll("option"));
      const optionValues = options.map((opt) => opt.value);
      const optionLabels = options.map((opt) => opt.label);
      expect(optionValues).toContain("local-1");
      expect(optionValues).toContain("remote-1");
    });

    it("registration includes selected nodeId", async () => {
      mockUseNodes.mockImplementation(() => ({
        nodes: [localNode, remoteNode],
        loading: false,
        error: null,
        refresh: vi.fn(),
        register: vi.fn(),
        update: vi.fn(),
        unregister: vi.fn(),
        healthCheck: vi.fn(),
      }));

      const mockProject = buildMockProject();
      mockRegisterProject.mockResolvedValueOnce(mockProject);

      render(
        <SetupWizardModal
          onProjectRegistered={vi.fn()}
          onClose={vi.fn()}
        />
      );

      fireEvent.click(screen.getByText("Advanced settings"));

      // Select the remote node
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "remote-1" } });

      // Fill path and name
      fireEvent.change(screen.getByPlaceholderText("/path/to/your/project"), {
        target: { value: "/home/user/project" },
      });
      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "test-project" },
      });

      // Register
      fireEvent.click(screen.getByText("Register Project"));

      await waitFor(() => {
        expect(mockRegisterProject).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "test-project",
            path: "/home/user/project",
            isolationMode: "in-process",
            nodeId: "remote-1",
          })
        );
      });
    });

    it("registration includes undefined nodeId when local node selected", async () => {
      mockUseNodes.mockImplementation(() => ({
        nodes: [localNode],
        loading: false,
        error: null,
        refresh: vi.fn(),
        register: vi.fn(),
        update: vi.fn(),
        unregister: vi.fn(),
        healthCheck: vi.fn(),
      }));

      const mockProject = buildMockProject();
      mockRegisterProject.mockResolvedValueOnce(mockProject);

      render(
        <SetupWizardModal
          onProjectRegistered={vi.fn()}
          onClose={vi.fn()}
        />
      );

      fireEvent.click(screen.getByText("Advanced settings"));

      // Local node is selected by default (empty value)
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe("");

      // Fill path and name
      fireEvent.change(screen.getByPlaceholderText("/path/to/your/project"), {
        target: { value: "/home/user/project" },
      });
      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "test-project" },
      });

      // Register
      fireEvent.click(screen.getByText("Register Project"));

      await waitFor(() => {
        expect(mockRegisterProject).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "test-project",
            path: "/home/user/project",
            isolationMode: "in-process",
            nodeId: undefined,
          })
        );
      });
    });
  });
});
