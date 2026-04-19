import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissionInterviewModal } from "./MissionInterviewModal";

const mockStartMissionInterview = vi.fn();
const mockRespondToMissionInterview = vi.fn();
const mockRetryMissionInterviewSession = vi.fn();
const mockCancelMissionInterview = vi.fn();
const mockCreateMissionFromInterview = vi.fn();
const mockConnectMissionInterviewStream = vi.fn();
const mockFetchAiSession = vi.fn();
const mockParseConversationHistory = vi.fn();
const mockAcquireSessionLock = vi.fn();
const mockReleaseSessionLock = vi.fn();
const mockForceAcquireSessionLock = vi.fn();
const mockFetchModels = vi.fn();

vi.mock("../api", () => ({
  startMissionInterview: (...args: any[]) => mockStartMissionInterview(...args),
  respondToMissionInterview: (...args: any[]) => mockRespondToMissionInterview(...args),
  retryMissionInterviewSession: (...args: any[]) => mockRetryMissionInterviewSession(...args),
  cancelMissionInterview: (...args: any[]) => mockCancelMissionInterview(...args),
  createMissionFromInterview: (...args: any[]) => mockCreateMissionFromInterview(...args),
  connectMissionInterviewStream: (...args: any[]) => mockConnectMissionInterviewStream(...args),
  fetchAiSession: (...args: any[]) => mockFetchAiSession(...args),
  parseConversationHistory: (...args: any[]) => mockParseConversationHistory(...args),
  acquireSessionLock: (...args: any[]) => mockAcquireSessionLock(...args),
  releaseSessionLock: (...args: any[]) => mockReleaseSessionLock(...args),
  forceAcquireSessionLock: (...args: any[]) => mockForceAcquireSessionLock(...args),
  fetchModels: (...args: any[]) => mockFetchModels(...args),
}));

vi.mock("../hooks/modalPersistence", () => ({
  saveMissionGoal: vi.fn(),
  getMissionGoal: vi.fn(() => ""),
  clearMissionGoal: vi.fn(),
}));

const SAMPLE_QUESTION = {
  id: "scope",
  type: "single_select" as const,
  question: "What is the target scope?",
  description: "Pick the size for this mission.",
  options: [
    { id: "mvp", label: "MVP" },
    { id: "full", label: "Full" },
  ],
};

describe("MissionInterviewModal", () => {
  let streamHandlers: any;

  beforeEach(() => {
    vi.clearAllMocks();
    streamHandlers = undefined;

    mockStartMissionInterview.mockResolvedValue({ sessionId: "mission-session-1" });
    mockRetryMissionInterviewSession.mockResolvedValue({ success: true, sessionId: "mission-session-1" });
    mockFetchAiSession.mockResolvedValue(null);
    mockParseConversationHistory.mockImplementation((raw: string) => {
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    });
    mockConnectMissionInterviewStream.mockImplementation((_sessionId, _projectId, handlers) => {
      streamHandlers = handlers;
      return {
        close: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      };
    });
    mockAcquireSessionLock.mockResolvedValue({ acquired: true, currentHolder: null });
    mockReleaseSessionLock.mockResolvedValue(undefined);
    mockForceAcquireSessionLock.mockResolvedValue({ acquired: true, currentHolder: null });
    mockFetchModels.mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] });
  });

  function renderModal() {
    return render(
      <MissionInterviewModal
        isOpen={true}
        onClose={vi.fn()}
        onMissionCreated={vi.fn()}
      />,
    );
  }

  it("shows lock overlay and allows take-control", async () => {
    window.sessionStorage.setItem("fusion-tab-id", "tab-self");
    mockAcquireSessionLock.mockResolvedValueOnce({ acquired: false, currentHolder: "tab-other" });

    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(screen.getByTestId("session-lock-overlay")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Take Control"));

    await waitFor(() => {
      expect(mockForceAcquireSessionLock).toHaveBeenCalledWith("mission-session-1", "tab-self");
    });

    await waitFor(() => {
      expect(screen.queryByTestId("session-lock-overlay")).not.toBeInTheDocument();
    });
  });

  it("shows reconnecting indicator without clearing current question", async () => {
    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(mockStartMissionInterview).toHaveBeenCalledWith("Build a mission planning workflow", undefined, undefined);
      expect(streamHandlers).toBeDefined();
    });

    act(() => {
      streamHandlers.onQuestion?.(SAMPLE_QUESTION);
    });

    expect(await screen.findByText("What is the target scope?")).toBeInTheDocument();

    act(() => {
      streamHandlers.onConnectionStateChange?.("reconnecting");
    });

    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
    expect(screen.getByText("What is the target scope?")).toBeInTheDocument();

    act(() => {
      streamHandlers.onConnectionStateChange?.("connected");
    });

    await waitFor(() => {
      expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
    });
    expect(screen.getByText("What is the target scope?")).toBeInTheDocument();
  });

  it("preserves streaming thinking output while reconnecting", async () => {
    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    act(() => {
      streamHandlers.onThinking?.("Analyzing mission goals...");
    });

    expect(await screen.findByText("Analyzing mission goals...")).toBeInTheDocument();

    act(() => {
      streamHandlers.onConnectionStateChange?.("reconnecting");
    });

    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
    expect(screen.getByText("Analyzing mission goals...")).toBeInTheDocument();
  });

  it("shows error panel with retry action when stream fails", async () => {
    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    act(() => {
      streamHandlers.onError?.("Temporary outage");
    });

    expect(await screen.findByText("Temporary outage")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("retries interview session from error view", async () => {
    let attempt = 0;
    mockConnectMissionInterviewStream.mockImplementation((_sessionId, _projectId, handlers) => {
      streamHandlers = handlers;
      attempt += 1;
      if (attempt === 1) {
        setTimeout(() => handlers.onError?.("Try again"), 10);
      } else {
        setTimeout(() => handlers.onQuestion?.(SAMPLE_QUESTION), 10);
      }
      return {
        close: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      };
    });

    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(screen.getByText("Try again")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(mockRetryMissionInterviewSession).toHaveBeenCalledWith("mission-session-1", undefined, expect.any(String));
    });
    await waitFor(() => {
      expect(screen.getByText("What is the target scope?")).toBeInTheDocument();
    });
    expect(mockConnectMissionInterviewStream).toHaveBeenCalledTimes(2);
  });

  it("recovers retry from connection-loss when interview session is still generating", async () => {
    let attempt = 0;
    mockConnectMissionInterviewStream.mockImplementation((_sessionId, _projectId, handlers) => {
      streamHandlers = handlers;
      attempt += 1;
      if (attempt === 1) {
        setTimeout(() => handlers.onError?.("Connection lost"), 10);
      }
      return {
        close: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      };
    });

    mockRetryMissionInterviewSession.mockRejectedValueOnce(
      new Error("Mission interview session mission-session-1 is not in an error state"),
    );
    mockFetchAiSession.mockResolvedValueOnce({
      id: "mission-session-1",
      type: "mission_interview",
      status: "generating",
      title: "Build a mission planning workflow",
      inputPayload: JSON.stringify({ goal: "Build a mission planning workflow" }),
      conversationHistory: "[]",
      currentQuestion: null,
      result: null,
      thinkingOutput: "Continuing...",
      error: null,
      projectId: null,
      lockedByTab: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lockedAt: null,
    });

    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(screen.getByText("Connection lost")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(mockRetryMissionInterviewSession).toHaveBeenCalledWith("mission-session-1", undefined, expect.any(String));
      expect(mockFetchAiSession).toHaveBeenCalledWith("mission-session-1");
    });

    expect(await screen.findByText("AI is thinking...")).toBeInTheDocument();
    expect(screen.getByText("Continuing...")).toBeInTheDocument();
    expect(mockConnectMissionInterviewStream).toHaveBeenCalledTimes(2);
  });
});
