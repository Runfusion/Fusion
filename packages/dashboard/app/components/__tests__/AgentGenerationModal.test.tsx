import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fs from "node:fs";
import path from "node:path";
import { AgentGenerationModal } from "../AgentGenerationModal";
import * as api from "../../api";
import type { AgentGenerationSpec } from "../../api";

vi.mock("../../api", () => ({
  startAgentGeneration: vi.fn(),
  generateAgentSpec: vi.fn(),
  cancelAgentGeneration: vi.fn(),
}));

const mockStartAgentGeneration = vi.mocked(api.startAgentGeneration);
const mockGenerateAgentSpec = vi.mocked(api.generateAgentSpec);
const mockCancelAgentGeneration = vi.mocked(api.cancelAgentGeneration);

const stylesPath = path.join(__dirname, "../../styles.css");
const readStyles = () => fs.readFileSync(stylesPath, "utf-8");

const generatedSpec: AgentGenerationSpec = {
  title: "Accessibility Reviewer",
  icon: "♿",
  role: "reviewer",
  description: "Reviews React code for accessibility compliance",
  systemPrompt: "You are an expert accessibility reviewer...",
  thinkingLevel: "high",
  maxTurns: 12,
};

describe("AgentGenerationModal", () => {
  const onClose = vi.fn();
  const onGenerated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockStartAgentGeneration.mockResolvedValue({
      sessionId: "session-1",
      roleDescription: "review accessibility",
    });
    mockGenerateAgentSpec.mockResolvedValue({
      spec: generatedSpec,
    });
    mockCancelAgentGeneration.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderModal(isOpen = true) {
    return render(
      <AgentGenerationModal
        isOpen={isOpen}
        onClose={onClose}
        onGenerated={onGenerated}
      />,
    );
  }

  async function startGeneration(description = "Build an accessibility-focused reviewer") {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Role Description"), description);
    await user.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Use This" })).toBeInTheDocument();
    });
  }

  it("returns null when isOpen=false", () => {
    renderModal(false);
    expect(screen.queryByText("Generate Agent")).not.toBeInTheDocument();
  });

  it("renders title and role description textarea when open", () => {
    renderModal(true);

    expect(screen.getByText("Generate Agent")).toBeInTheDocument();
    expect(screen.getByLabelText("Role Description")).toBeInTheDocument();
  });

  it("uses token-based agent dialog styles in styles.css", () => {
    const styles = readStyles();

    expect(styles).toContain('.agent-dialog-overlay');
    expect(styles).toContain('background: color-mix(in srgb, var(--bg) 60%, transparent);');
    expect(styles).toContain('.btn--ai-generate');
    expect(styles).toContain('background: var(--cta-bg, var(--todo));');
    expect(styles).toContain('.agent-dialog-field label');
    expect(styles).toContain('margin-bottom: calc(var(--space-sm) - var(--space-xs) * 0.5);');
  });

  it("focuses role description textarea on open", () => {
    renderModal(true);

    expect(screen.getByLabelText("Role Description")).toHaveFocus();
  });

  it("disables Generate when description has fewer than 3 chars and enables at 3+", async () => {
    renderModal(true);

    const user = userEvent.setup();
    const generateButton = screen.getByRole("button", { name: "Generate" });

    expect(generateButton).toBeDisabled();

    await user.type(screen.getByLabelText("Role Description"), "ab");
    expect(generateButton).toBeDisabled();

    await user.type(screen.getByLabelText("Role Description"), "c");
    expect(generateButton).toBeEnabled();
  });

  it("shows character counter for role description", async () => {
    renderModal(true);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Role Description"), "abcd");

    expect(screen.getByText("4/1000")).toBeInTheDocument();
  });

  it("handleGenerate calls startAgentGeneration then generateAgentSpec and transitions to preview", async () => {
    renderModal(true);

    await startGeneration();

    expect(mockStartAgentGeneration).toHaveBeenCalledWith(
      "Build an accessibility-focused reviewer",
      undefined,
    );
    expect(mockGenerateAgentSpec).toHaveBeenCalledWith("session-1", undefined);
  });

  it("supports Enter key shortcut to generate when valid", async () => {
    renderModal(true);

    const textarea = screen.getByLabelText("Role Description");
    fireEvent.change(textarea, { target: { value: "Generate with enter" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(mockStartAgentGeneration).toHaveBeenCalledWith("Generate with enter", undefined);
    });
  });

  it("preview shows title/icon/role/description/thinking/maxTurns with system prompt collapsed", async () => {
    renderModal(true);

    await startGeneration();

    expect(screen.getByText(/Accessibility Reviewer/)).toBeInTheDocument();
    expect(screen.getByText("reviewer")).toBeInTheDocument();
    expect(screen.getByText("Reviews React code for accessibility compliance")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("System Prompt")).toBeInTheDocument();
    expect(screen.getByText("Expand")).toBeInTheDocument();
  });

  it("Use This calls onGenerated with spec and closes modal", async () => {
    renderModal(true);

    await startGeneration();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Use This" }));

    expect(onGenerated).toHaveBeenCalledWith(generatedSpec);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Regenerate cancels existing session and re-runs generation", async () => {
    mockStartAgentGeneration
      .mockResolvedValueOnce({ sessionId: "session-1", roleDescription: "first" })
      .mockResolvedValueOnce({ sessionId: "session-2", roleDescription: "first" });
    mockGenerateAgentSpec
      .mockResolvedValueOnce({ spec: generatedSpec })
      .mockResolvedValueOnce({ spec: { ...generatedSpec, title: "Second Spec" } });

    renderModal(true);

    await startGeneration();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Regenerate" }));

    await waitFor(() => {
      expect(mockCancelAgentGeneration).toHaveBeenCalledWith("session-1", undefined);
      expect(screen.getByText(/Second Spec/)).toBeInTheDocument();
    });
  });

  it("Cancel button calls onClose and cancels active session", async () => {
    renderModal(true);

    await startGeneration();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mockCancelAgentGeneration).toHaveBeenCalledWith("session-1", undefined);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape key triggers cancel", async () => {
    renderModal(true);

    await startGeneration();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(mockCancelAgentGeneration).toHaveBeenCalledWith("session-1", undefined);
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("shows error and returns to input when startAgentGeneration fails", async () => {
    mockStartAgentGeneration.mockRejectedValueOnce(new Error("start failed"));

    renderModal(true);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Role Description"), "some role");
    await user.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => {
      expect(screen.getByText("start failed")).toBeInTheDocument();
      expect(screen.getByLabelText("Role Description")).toBeInTheDocument();
    });
  });

  it("shows friendly message for 429/rate-limit errors", async () => {
    mockStartAgentGeneration.mockRejectedValueOnce(new Error("429 Too Many Requests"));

    renderModal(true);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Role Description"), "rate limit role");
    await user.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => {
      expect(screen.getByText("Too many requests. Please wait a moment and try again.")).toBeInTheDocument();
    });
  });

  it("cancels active session when modal closes via prop change", async () => {
    const { rerender } = render(
      <AgentGenerationModal isOpen={true} onClose={onClose} onGenerated={onGenerated} />,
    );

    await startGeneration();

    rerender(<AgentGenerationModal isOpen={false} onClose={onClose} onGenerated={onGenerated} />);

    await waitFor(() => {
      expect(mockCancelAgentGeneration).toHaveBeenCalledWith("session-1", undefined);
    });
  });
});
