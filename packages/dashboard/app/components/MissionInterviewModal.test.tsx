import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissionInterviewModal } from "./MissionInterviewModal";

const mockStartMissionInterview = vi.fn();
const mockRespondToMissionInterview = vi.fn();
const mockCancelMissionInterview = vi.fn();
const mockCreateMissionFromInterview = vi.fn();
const mockConnectMissionInterviewStream = vi.fn();
const mockFetchAiSession = vi.fn();

vi.mock("../api", () => ({
  startMissionInterview: (...args: any[]) => mockStartMissionInterview(...args),
  respondToMissionInterview: (...args: any[]) => mockRespondToMissionInterview(...args),
  cancelMissionInterview: (...args: any[]) => mockCancelMissionInterview(...args),
  createMissionFromInterview: (...args: any[]) => mockCreateMissionFromInterview(...args),
  connectMissionInterviewStream: (...args: any[]) => mockConnectMissionInterviewStream(...args),
  fetchAiSession: (...args: any[]) => mockFetchAiSession(...args),
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
    mockFetchAiSession.mockResolvedValue(null);
    mockConnectMissionInterviewStream.mockImplementation((_sessionId, _projectId, handlers) => {
      streamHandlers = handlers;
      return {
        close: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      };
    });
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

  it("shows reconnecting indicator without clearing current question", async () => {
    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(mockStartMissionInterview).toHaveBeenCalledWith("Build a mission planning workflow", undefined);
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
});
