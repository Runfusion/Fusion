import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { loadAllAppCss } from "../../test/cssFixture";
import type { AgentHeartbeatRun } from "../../api";
import type { AgentLogEntry } from "@fusion/core";
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from "../../utils/heartbeatIntervals";
import {
  MOCK_SKILLS,
  createMockAgent,
  mockConfirm,
  mockDeleteAgent,
  mockFetchAgent,
  mockFetchAgentBudgetStatus,
  mockFetchAgentChildren,
  mockFetchAgentLogsWithMeta,
  mockFetchAgentMailbox,
  mockFetchAgentMemoryFile,
  mockFetchAgentMemoryFiles,
  mockFetchAgentRunDetail,
  mockFetchAgentRunLogs,
  mockFetchAgentRuns,
  mockFetchAgentTasks,
  mockFetchAgents,
  mockFetchChainOfCommand,
  mockFetchCompanies,
  mockFetchDiscoveredSkills,
  mockFetchModels,
  mockFetchPluginRuntimes,
  mockFetchSkillContent,
  mockFetchWorkspaceFileContent,
  mockMarkMessageRead,
  mockResetAgentBudget,
  mockSaveAgentMemoryFile,
  mockSaveWorkspaceFileContent,
  mockStartAgentRun,
  mockSubscribeSse,
  mockUpdateAgent,
  mockUpdateAgentInstructions,
  mockUpdateAgentMemory,
  mockUpdateAgentSoul,
  mockUpdateAgentState,
  mockUpdateGlobalSettings,
  mockUpgradeAgentHeartbeatProcedure,
  setupAgentDetailMocks,
} from "./AgentDetailView.test-helpers";
import { AgentDetailView } from "../AgentDetailView";

describe("AgentDetailView — editors", () => {
  beforeEach(() => {
    setupAgentDetailMocks();
  });

describe("Instructions Tab", () => {
  const navigateToInstructions = async (user: ReturnType<typeof userEvent.setup>) => {
    await waitFor(() => {
      expect(screen.getByText("Instructions")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Instructions"));
  };

  it("renders Instructions tab with inline instructions and path fields", async () => {
    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await navigateToInstructions(user);

    await waitFor(() => {
      expect(screen.getByLabelText("Inline Instructions")).toBeInTheDocument();
      expect(screen.getByLabelText("Instructions File Path")).toBeInTheDocument();
    });
  });

  it("does not show file editor when instructions path is empty", async () => {
    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await navigateToInstructions(user);

    await waitFor(() => {
      expect(screen.queryByLabelText("File Content")).not.toBeInTheDocument();
    });
  });

  it("shows file editor when instructions path is set", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      instructionsPath: ".fusion/agents/test-agent.md",
    }));

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await navigateToInstructions(user);

    await waitFor(() => {
      expect(screen.getByLabelText("File Content")).toBeInTheDocument();
    });
  });

  it("calls fetchWorkspaceFileContent when instructions path is set", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      instructionsPath: ".fusion/agents/test-agent.md",
    }));

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await navigateToInstructions(user);

    await waitFor(() => {
      expect(mockFetchWorkspaceFileContent).toHaveBeenCalledWith("project", ".fusion/agents/test-agent.md");
    });
  });

  it("shows file content when fetchWorkspaceFileContent succeeds", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      instructionsPath: ".fusion/agents/test-agent.md",
    }));
    mockFetchWorkspaceFileContent.mockResolvedValue({
      content: "# Test Agent Instructions\n\nThese are the agent instructions.",
      mtime: "2024-01-01T00:00:00.000Z",
      size: 60,
    });

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await navigateToInstructions(user);

    await waitFor(() => {
      expect(screen.getByLabelText("File Content")).toHaveValue("# Test Agent Instructions\n\nThese are the agent instructions.");
    });
  });

  it("shows error toast when fetchWorkspaceFileContent fails with non-ENOENT error", async () => {
    const addToast = vi.fn();
    mockFetchAgent.mockResolvedValue(createMockAgent({
      instructionsPath: ".fusion/agents/test-agent.md",
    }));
    mockFetchWorkspaceFileContent.mockRejectedValue(new Error("Permission denied"));

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={addToast}
      />
    );

    await navigateToInstructions(user);

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load instructions file"),
        "error",
      );
    });
  });

  it("treats ENOENT as empty file (new file state)", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      instructionsPath: ".fusion/agents/new-agent.md",
    }));
    mockFetchWorkspaceFileContent.mockRejectedValue(new Error("ENOENT: file not found"));

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await navigateToInstructions(user);

    await waitFor(() => {
      // Should show empty content (new file state), not show error toast
      const fileContent = screen.getByLabelText("File Content") as HTMLTextAreaElement;
      expect(fileContent.value).toBe("");
    });
  });

  it("calls updateAgentInstructions with expected payload when saving inline instructions", async () => {
    const addToast = vi.fn();
    mockUpdateAgentInstructions.mockResolvedValue({} as any);

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={addToast}
      />
    );

    await navigateToInstructions(user);

    const instructionsTextarea = await screen.findByLabelText("Inline Instructions");
    await user.clear(instructionsTextarea);
    await user.type(instructionsTextarea, "Custom instructions for the agent");

    const pathInput = await screen.findByLabelText("Instructions File Path");
    await user.clear(pathInput);
    await user.type(pathInput, ".fusion/agents/test.md");

    await user.click(screen.getByText("Save Instructions"));

    await waitFor(() => {
      expect(mockUpdateAgentInstructions).toHaveBeenCalledWith(
        "agent-001",
        {
          instructionsText: "Custom instructions for the agent",
          instructionsPath: ".fusion/agents/test.md",
        },
        undefined,
      );
    });
    expect(addToast).toHaveBeenCalledWith("Instructions saved", "success");
  });

  it("calls saveWorkspaceFileContent when saving file content", async () => {
    const addToast = vi.fn();
    const onMutationSuccess = vi.fn();
    mockFetchAgent.mockResolvedValue(createMockAgent({
      instructionsPath: ".fusion/agents/test.md",
    }));
    mockFetchWorkspaceFileContent.mockResolvedValue({
      content: "Original content",
      mtime: "2024-01-01T00:00:00.000Z",
      size: 16,
    });

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={addToast}
        onMutationSuccess={onMutationSuccess}
      />
    );

    await navigateToInstructions(user);

    // Wait for file content to load
    await waitFor(() => {
      expect(screen.getByLabelText("File Content")).toHaveValue("Original content");
    });

    // Modify file content
    const fileContent = screen.getByLabelText("File Content");
    await user.clear(fileContent);
    await user.type(fileContent, "Updated content");

    // Save file
    await user.click(screen.getByText("Save File"));

    await waitFor(() => {
      expect(mockSaveWorkspaceFileContent).toHaveBeenCalledWith(
        "project",
        ".fusion/agents/test.md",
        "Updated content",
      );
      expect(onMutationSuccess).toHaveBeenCalledWith({ agentId: "agent-001", deleted: false });
    });
    expect(addToast).toHaveBeenCalledWith("Instructions file saved", "success");
  });

  it("disables Save Instructions button when no changes", async () => {
    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await navigateToInstructions(user);

    await waitFor(() => {
      expect(screen.getByText("Save Instructions")).toBeDisabled();
    });
  });

  it("disables Save File button when file content is not dirty", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      instructionsPath: ".fusion/agents/test.md",
    }));
    mockFetchWorkspaceFileContent.mockResolvedValue({
      content: "Original content",
      mtime: "2024-01-01T00:00:00.000Z",
      size: 16,
    });

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await navigateToInstructions(user);

    await waitFor(() => {
      expect(screen.getByText("Save File")).toBeDisabled();
    });
  });

  it("shows Unsaved changes indicator when file content is dirty", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      instructionsPath: ".fusion/agents/test.md",
    }));
    mockFetchWorkspaceFileContent.mockResolvedValue({
      content: "Original content",
      mtime: "2024-01-01T00:00:00.000Z",
      size: 16,
    });

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await navigateToInstructions(user);

    // Wait for file content to load
    await waitFor(() => {
      expect(screen.getByLabelText("File Content")).toHaveValue("Original content");
    });

    // Modify file content
    const fileContent = screen.getByLabelText("File Content");
    await user.clear(fileContent);
    await user.type(fileContent, "Modified content");

    await waitFor(() => {
      expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    });
  });

  it("forwards projectId to updateAgentInstructions", async () => {
    const addToast = vi.fn();

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        projectId="proj_456"
        onClose={vi.fn()}
        addToast={addToast}
      />
    );

    await navigateToInstructions(user);

    const instructionsTextarea = await screen.findByLabelText("Inline Instructions");
    await user.clear(instructionsTextarea);
    await user.type(instructionsTextarea, "Custom instructions");

    await user.click(screen.getByText("Save Instructions"));

    await waitFor(() => {
      expect(mockUpdateAgentInstructions).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          instructionsText: "Custom instructions",
        }),
        "proj_456",
      );
    });
  });

  it("toggles between edit and preview mode for inline instructions", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      instructionsText: "# Test\n\nThis is a test.",
    }));

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await navigateToInstructions(user);

    // Default: edit mode should be active - verify textarea is present
    await waitFor(() => {
      expect(screen.getByLabelText("Inline Instructions")).toBeInTheDocument();
    });

    // Find and verify the toggle buttons exist
    const previewBtn = screen.getByTestId("instructions-preview-toggle");
    expect(previewBtn).toBeInTheDocument();

    // Click Preview button
    await user.click(previewBtn);

    // After clicking, the textarea should be gone and preview should appear
    await waitFor(() => {
      expect(screen.queryByLabelText("Inline Instructions")).not.toBeInTheDocument();
    });

    // Check for markdown preview
    const preview = document.querySelector(".markdown-body");
    expect(preview).toBeInTheDocument();

    // Click Edit button to go back
    const editBtn = screen.getByTestId("instructions-edit-toggle");
    await user.click(editBtn);

    // Should be back in edit mode
    await waitFor(() => {
      expect(screen.getByLabelText("Inline Instructions")).toBeInTheDocument();
    });
  });

  it("renders markdown content in preview mode for inline instructions", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      instructionsText: "# Test Instructions\n\nThis is **bold** and this is _italic_.",
    }));

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await navigateToInstructions(user);

    // Click Preview button
    await user.click(screen.getByTestId("instructions-preview-toggle"));

    await waitFor(() => {
      // Should render markdown elements
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Test Instructions");
      expect(document.querySelector(".markdown-body")).toBeInTheDocument();
    });
  });

  it("shows placeholder when inline instructions are empty in preview mode", async () => {
    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await navigateToInstructions(user);

    // Click Preview button when instructions are empty
    await user.click(screen.getByTestId("instructions-preview-toggle"));

    await waitFor(() => {
      expect(screen.getByText("No inline instructions defined yet. Switch to Edit mode to add instructions.")).toBeInTheDocument();
    });
  });

  it("hides save button when in preview mode for inline instructions", async () => {
    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await navigateToInstructions(user);

    // Save button should be visible in edit mode
    await waitFor(() => {
      expect(screen.getByText("Save Instructions")).toBeInTheDocument();
    });

    // Click Preview button
    await user.click(screen.getByTestId("instructions-preview-toggle"));

    // Save button should be hidden
    await waitFor(() => {
      expect(screen.queryByText("Save Instructions")).not.toBeInTheDocument();
    });
  });

  it("does not affect file path section when toggling inline instructions preview", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      instructionsPath: ".fusion/agents/test-agent.md",
    }));

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await navigateToInstructions(user);

    // File path section should be visible
    await waitFor(() => {
      expect(screen.getByLabelText("Instructions File Path")).toBeInTheDocument();
    });

    // Toggle to preview mode
    await user.click(screen.getByTestId("instructions-preview-toggle"));

    // File path should still be visible
    await waitFor(() => {
      expect(screen.getByLabelText("Instructions File Path")).toBeInTheDocument();
    });

    // Toggle back to edit mode
    await user.click(screen.getByTestId("instructions-edit-toggle"));

    // File path should still be visible
    await waitFor(() => {
      expect(screen.getByLabelText("Instructions File Path")).toBeInTheDocument();
    });
  });
});

// ── Soul Tab ────────────────────────────────────────────────────────────────

describe("Soul Tab", () => {
  const navigateToSoul = async (user: ReturnType<typeof userEvent.setup>) => {
    await waitFor(() => {
      expect(screen.getByText("Soul")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Soul"));
  };

  it("renders Soul tab with textarea by default", async () => {
    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await navigateToSoul(user);

    await waitFor(() => {
      expect(screen.getByLabelText("Agent Soul")).toBeInTheDocument();
      expect(screen.getByText("Edit")).toBeInTheDocument();
      expect(screen.getByText("Preview")).toBeInTheDocument();
    });
  });

  it("toggles between edit and preview mode", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      soul: "# Agent Soul\n\nThis agent is **helpful** and _creative_.",
    }));

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await navigateToSoul(user);

    // Default: edit mode
    await waitFor(() => {
      expect(screen.getByLabelText("Agent Soul")).toBeInTheDocument();
    });

    // Click Preview
    await user.click(screen.getByText("Preview"));

    await waitFor(() => {
      expect(screen.queryByLabelText("Agent Soul")).not.toBeInTheDocument();
      expect(document.querySelector(".markdown-body")).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Agent Soul");
    });

    // Click Edit
    await user.click(screen.getByText("Edit"));

    await waitFor(() => {
      expect(screen.getByLabelText("Agent Soul")).toBeInTheDocument();
    });
  });

  it("shows placeholder when soul is empty in preview mode", async () => {
    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await navigateToSoul(user);

    await user.click(screen.getByText("Preview"));

    await waitFor(() => {
      expect(screen.getByText("No soul defined yet. Switch to Edit mode to define the agent's personality.")).toBeInTheDocument();
    });
  });

  it("hides save button when in preview mode", async () => {
    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await navigateToSoul(user);

    await waitFor(() => {
      expect(screen.getByText("Save Soul")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Preview"));

    await waitFor(() => {
      expect(screen.queryByText("Save Soul")).not.toBeInTheDocument();
    });
  });

  it("calls updateAgentSoul when saving soul", async () => {
    const addToast = vi.fn();
    mockUpdateAgentSoul.mockResolvedValue({} as any);

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={addToast}
      />
    );

    await navigateToSoul(user);

    const textarea = await screen.findByLabelText("Agent Soul");
    await user.clear(textarea);
    await user.type(textarea, "This is the agent's new soul");

    await user.click(screen.getByText("Save Soul"));

    await waitFor(() => {
      expect(mockUpdateAgentSoul).toHaveBeenCalledWith("agent-001", "This is the agent's new soul", undefined);
      expect(addToast).toHaveBeenCalledWith("Soul saved", "success");
    });
  });
});

// ── Memory Tab ─────────────────────────────────────────────────────────────

describe("Memory Tab", () => {
  const navigateToMemory = async (user: ReturnType<typeof userEvent.setup>) => {
    await waitFor(() => {
      expect(screen.getByText("Agent Memory")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Agent Memory"));
  };

  it("renders Memory tab with textarea by default", async () => {
    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await navigateToMemory(user);
    await waitFor(() => {
      expect(screen.getByLabelText("Agent Memory")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Inline memory edit mode" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Inline memory preview mode" })).toBeInTheDocument();
    });
  });

  it("toggles between edit and preview mode", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({ memory: "# Agent Memory\n\n- Item 1\n- Item 2" }));
    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await navigateToMemory(user);
    await user.click(screen.getByRole("button", { name: "Inline memory preview mode" }));
    await waitFor(() => {
      expect(screen.queryByLabelText("Agent Memory")).not.toBeInTheDocument();
      expect(document.querySelector(".markdown-body")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Inline memory edit mode" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Agent Memory")).toBeInTheDocument();
    });
  });

  it("shows placeholder when memory is empty in preview mode", async () => {
    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await navigateToMemory(user);
    await user.click(screen.getByRole("button", { name: "Inline memory preview mode" }));
    await waitFor(() => {
      expect(screen.getByText("No agent memory defined yet. Switch to Edit mode to add memory content.")).toBeInTheDocument();
    });
  });

  it("hides save button when in preview mode", async () => {
    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await navigateToMemory(user);
    expect(screen.getByText("Save Memory")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Inline memory preview mode" }));
    await waitFor(() => expect(screen.queryByText("Save Memory")).not.toBeInTheDocument());
  });

  it("hides inline Edit button when agent is running", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({ state: "running", memory: "This agent has memory." }));
    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await navigateToMemory(user);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Inline memory preview mode" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Inline memory edit mode" })).not.toBeInTheDocument();
    });
  });

  it("can switch inline memory to preview mode when agent is running", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({ state: "running", memory: "Agent memory content" }));
    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await navigateToMemory(user);
    await user.click(screen.getByRole("button", { name: "Inline memory preview mode" }));
    await waitFor(() => expect(document.querySelector(".markdown-body")).toBeInTheDocument());
  });

  it("renders the memory file in the shared FileEditor and toggles preview", async () => {
    mockFetchAgentMemoryFile.mockResolvedValue({ path: ".fusion/agent-memory/agent-001/MEMORY.md", content: "# Heading\n\n- entry" } as any);
    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await navigateToMemory(user);
    /*
    FNXC:AgentMemory 2026-07-11-00:20:
    The memory-file editor is the shared FileEditor (CodeMirror + Edit/Preview/Wrap toolbar);
    the FileEditor toolbar owns the unqualified "Edit mode"/"Preview mode" labels while the
    inline-memory toggle uses "Inline memory ..." labels.
    */
    await user.click(await screen.findByRole("button", { name: "Preview mode" }));
    await waitFor(() => {
      expect(screen.getByText("Heading")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit mode" }));
    await waitFor(() => {
      expect(document.querySelector(".agent-memory-file-editor .file-editor-codemirror")).toBeInTheDocument();
    });
  });

  it("keeps the Save Memory File action visible and enabled only when the file is dirty", async () => {
    mockFetchAgentMemoryFile.mockResolvedValue({ path: ".fusion/agent-memory/agent-001/MEMORY.md", content: "content" } as any);
    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await navigateToMemory(user);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save Memory File" })).toBeDisabled();
    });
  });

  it("hides all edit buttons and disables save for running agents", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({ state: "running" }));
    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await navigateToMemory(user);
    await waitFor(() => {
      // FileEditor is readOnly (forced preview, its Edit button hidden) and the inline Edit toggle is hidden.
      expect(screen.queryByRole("button", { name: "Edit mode" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Inline memory edit mode" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save Memory File" })).toBeDisabled();
    });
  });

  it("calls updateAgentMemory when saving memory", async () => {
    const addToast = vi.fn();
    mockUpdateAgentMemory.mockResolvedValue({} as any);
    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={addToast} />);
    await navigateToMemory(user);
    const textarea = await screen.findByLabelText("Agent Memory");
    await user.clear(textarea);
    await user.type(textarea, "This is the agent's new memory");
    await user.click(screen.getByText("Save Memory"));
    await waitFor(() => {
      expect(mockUpdateAgentMemory).toHaveBeenCalledWith("agent-001", "This is the agent's new memory", undefined);
      expect(addToast).toHaveBeenCalledWith("Memory saved", "success");
    });
  });
});

// ── Skills ─────────────────────────────────────────────────────────────────


});
