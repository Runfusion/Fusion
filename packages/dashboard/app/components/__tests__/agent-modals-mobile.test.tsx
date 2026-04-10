import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fs from "node:fs";
import path from "node:path";
import { AgentDetailView } from "../AgentDetailView";
import { AgentGenerationModal } from "../AgentGenerationModal";
import { AgentImportModal } from "../AgentImportModal";
import { AgentListModal } from "../AgentListModal";
import * as api from "../../api";

vi.mock("../../api", () => ({
  fetchAgent: vi.fn(),
  updateAgent: vi.fn(),
  updateAgentState: vi.fn(),
  deleteAgent: vi.fn(),
  fetchAgentLogs: vi.fn(),
  fetchAgentRunLogs: vi.fn(),
  fetchAgentRuns: vi.fn(),
  fetchAgentRunDetail: vi.fn(),
  startAgentRun: vi.fn(),
  fetchAgentTasks: vi.fn(),
  fetchChainOfCommand: vi.fn(),
  fetchAgents: vi.fn(),
  createAgent: vi.fn(),
  startAgentGeneration: vi.fn(),
  generateAgentSpec: vi.fn(),
  cancelAgentGeneration: vi.fn(),
  fetchAgentBudgetStatus: vi.fn(),
  resetAgentBudget: vi.fn(),
}));

vi.mock("../AgentLogViewer", () => ({
  AgentLogViewer: ({ entries }: { entries: Array<{ text: string }> }) => (
    <div data-testid="agent-log-viewer">{entries.map((entry, index) => <span key={index}>{entry.text}</span>)}</div>
  ),
}));

const mockFetchAgent = vi.mocked(api.fetchAgent);
const mockUpdateAgent = vi.mocked(api.updateAgent);
const mockUpdateAgentState = vi.mocked(api.updateAgentState);
const mockDeleteAgent = vi.mocked(api.deleteAgent);
const mockFetchAgentLogs = vi.mocked(api.fetchAgentLogs);
const mockFetchAgentRunLogs = vi.mocked(api.fetchAgentRunLogs);
const mockFetchAgentRuns = vi.mocked(api.fetchAgentRuns);
const mockFetchAgentRunDetail = vi.mocked(api.fetchAgentRunDetail);
const mockStartAgentRun = vi.mocked(api.startAgentRun);
const mockFetchAgentTasks = vi.mocked(api.fetchAgentTasks);
const mockFetchChainOfCommand = vi.mocked(api.fetchChainOfCommand);
const mockFetchAgents = vi.mocked(api.fetchAgents);
const mockCreateAgent = vi.mocked(api.createAgent);
const mockStartAgentGeneration = vi.mocked(api.startAgentGeneration);
const mockGenerateAgentSpec = vi.mocked(api.generateAgentSpec);
const mockCancelAgentGeneration = vi.mocked(api.cancelAgentGeneration);
const mockFetchAgentBudgetStatus = vi.mocked(api.fetchAgentBudgetStatus);
const mockResetAgentBudget = vi.mocked(api.resetAgentBudget);

const originalFetch = globalThis.fetch;

const stylesPath = path.join(__dirname, "../../styles.css");

function readStyles(): string {
  return fs.readFileSync(stylesPath, "utf-8");
}

function readRenderedInlineStyles(): string {
  return Array.from(document.querySelectorAll("style"))
    .map((el) => el.textContent ?? "")
    .join("\n");
}

describe("agent modal mobile CSS structure", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const mockAgent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "active",
      taskId: "FN-001",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastHeartbeatAt: "2026-01-01T00:10:00.000Z",
      metadata: {},
      runtimeConfig: {},
      heartbeatHistory: [],
      activeRun: null,
      completedRuns: [],
    };

    mockFetchAgent.mockResolvedValue(mockAgent as any);
    mockUpdateAgent.mockResolvedValue(mockAgent as any);
    mockUpdateAgentState.mockResolvedValue({ ...mockAgent, state: "paused" } as any);
    mockDeleteAgent.mockResolvedValue(undefined as any);
    mockFetchAgentLogs.mockResolvedValue([]);
    mockFetchAgentRunLogs.mockResolvedValue([]);
    mockFetchAgentRuns.mockResolvedValue([]);
    mockFetchAgentRunDetail.mockResolvedValue(undefined as any);
    mockStartAgentRun.mockResolvedValue({ id: "run-001", status: "active" } as any);
    mockFetchAgentTasks.mockResolvedValue([]);
    mockFetchChainOfCommand.mockResolvedValue([mockAgent] as any);

    mockFetchAgents.mockResolvedValue([
      {
        id: "agent-001",
        name: "Test Agent",
        role: "executor",
        state: "idle",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      },
    ] as any);
    mockCreateAgent.mockResolvedValue({
      id: "agent-002",
      name: "New Agent",
      role: "executor",
      state: "idle",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      metadata: {},
    } as any);

    mockStartAgentGeneration.mockResolvedValue({
      sessionId: "session-1",
      roleDescription: "Build a reviewer agent",
    });
    mockGenerateAgentSpec.mockResolvedValue({
      spec: {
        title: "Accessibility Reviewer",
        icon: "♿",
        role: "reviewer",
        description: "Reviews UI accessibility compliance",
        systemPrompt: "You are an accessibility expert.",
        thinkingLevel: "high",
        maxTurns: 8,
      },
    });
    mockCancelAgentGeneration.mockResolvedValue({ success: true });
    mockFetchAgentBudgetStatus.mockResolvedValue({ agentId: "agent-001", currentUsage: 0, budgetLimit: null, usagePercent: null, thresholdPercent: null, isOverBudget: false, isOverThreshold: false, lastResetAt: null, nextResetAt: null });
    mockResetAgentBudget.mockResolvedValue(undefined);

    globalThis.fetch = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          companyName: "Acme AI",
          agents: [{ name: "Reviewer", role: "reviewer", title: "Code Reviewer" }],
          created: ["Reviewer"],
          skipped: [],
          errors: [],
          dryRun: true,
        }),
      }) as Response,
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("AgentDetailView", () => {
    it("overlay and modal have mobile-targetable classes", async () => {
      render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(document.querySelector(".agent-detail-overlay")).toBeTruthy();
        expect(document.querySelector(".agent-detail-modal")).toBeTruthy();
      });
    });

    it("tabs have scrollable container class", async () => {
      render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(document.querySelector(".agent-detail-tabs")).toBeTruthy();
        expect(document.querySelectorAll(".agent-detail-tab").length).toBeGreaterThan(0);
      });
    });

    it("footer has safe-area class", async () => {
      render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(document.querySelector(".agent-detail-footer")).toBeTruthy();
      });
    });

    it("styles.css has mobile full-screen rules for agent-detail modal", () => {
      const styles = readStyles();
      expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.agent-detail-modal[\s\S]*?width:\s*100vw/);
      expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.agent-detail-modal[\s\S]*?height:\s*100dvh/);
      expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.agent-detail-modal[\s\S]*?border-radius:\s*0/);
    });
  });

  describe("AgentGenerationModal", () => {
    it("overlay and dialog classes exist", () => {
      render(<AgentGenerationModal isOpen={true} onClose={vi.fn()} onGenerated={vi.fn()} />);

      expect(document.querySelector(".agent-dialog-overlay")).toBeTruthy();
      expect(document.querySelector(".agent-dialog")).toBeTruthy();
    });

    it("does not hardcode inline width on dialog", () => {
      render(<AgentGenerationModal isOpen={true} onClose={vi.fn()} onGenerated={vi.fn()} />);

      const dialog = document.querySelector(".agent-dialog") as HTMLElement | null;
      expect(dialog).toBeTruthy();
      expect(dialog?.style.width).toBe("");
      expect(dialog?.style.maxWidth).toBe("");
    });

    it("summary rows have targetable classes in preview", async () => {
      render(<AgentGenerationModal isOpen={true} onClose={vi.fn()} onGenerated={vi.fn()} />);

      const user = userEvent.setup();
      await user.type(screen.getByLabelText("Role Description"), "Build an accessibility reviewer");
      await user.click(screen.getByRole("button", { name: "Generate" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Use This" })).toBeInTheDocument();
      });

      expect(document.querySelectorAll(".agent-dialog-summary-row").length).toBeGreaterThan(0);
    });

    it("styles.css has mobile full-screen rules for agent-dialog", () => {
      const styles = readStyles();
      expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.agent-dialog[\s\S]*?width:\s*100vw(?:\s*!important)?/);
      expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.agent-dialog[\s\S]*?border-radius:\s*0/);
    });
  });

  describe("AgentImportModal", () => {
    it("import dialog class exists", () => {
      render(<AgentImportModal isOpen={true} onClose={vi.fn()} onImported={vi.fn()} />);

      expect(document.querySelector(".agent-import-dialog")).toBeTruthy();
    });

    it("file upload area has targetable class", () => {
      render(<AgentImportModal isOpen={true} onClose={vi.fn()} onImported={vi.fn()} />);

      expect(document.querySelector(".agent-import-file-upload")).toBeTruthy();
    });

    it("styles.css has mobile rules for agent-import classes", () => {
      const styles = readStyles();
      expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.agent-import-file-upload[\s\S]*?flex-direction:\s*column/);
    });
  });

  describe("AgentListModal", () => {
    it("renders modal with modal--wide class", async () => {
      render(<AgentListModal isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(document.querySelector(".modal--wide")).toBeTruthy();
      });
    });

    it("inline CSS contains 768px and 640px breakpoints", async () => {
      render(<AgentListModal isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeInTheDocument();
      });

      const css = readRenderedInlineStyles();
      expect(css).toContain("@media (max-width: 768px)");
      expect(css).toContain("@media (max-width: 640px)");
    });

    it("inline CSS has board single-column at 640px", async () => {
      render(<AgentListModal isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeInTheDocument();
      });

      const css = readRenderedInlineStyles();
      expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.agent-board\s*{[\s\S]*?grid-template-columns:\s*1fr/);
    });

    it("inline CSS has controls stacking at 640px", async () => {
      render(<AgentListModal isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeInTheDocument();
      });

      const css = readRenderedInlineStyles();
      expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.agent-controls\s*{[\s\S]*?flex-direction:\s*column/);
    });
  });

  describe("Cross-cutting mobile CSS", () => {
    it("agent-dialog mobile rules include safe-area inset handling", () => {
      const styles = readStyles();
      expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.agent-dialog[\s\S]*?safe-area-inset-bottom/);
    });

    it("agent-dialog mobile rules include 16px field font-size", () => {
      const styles = readStyles();
      expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.agent-dialog-field[\s\S]*?font-size:\s*16px/);
    });
  });
});
