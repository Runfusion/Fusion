import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PlanningQuestion } from "@fusion/core";
import { MissionInterviewModal } from "../MissionInterviewModal";
import * as api from "../../api";
import * as modalPersistence from "../../hooks/modalPersistence";

vi.mock("../../api", () => ({
  startMissionInterview: vi.fn(),
  respondToMissionInterview: vi.fn(),
  cancelMissionInterview: vi.fn(),
  createMissionFromInterview: vi.fn(),
  connectMissionInterviewStream: vi.fn(),
  fetchAiSession: vi.fn(),
  parseConversationHistory: vi.fn(),
  acquireSessionLock: vi.fn(),
  releaseSessionLock: vi.fn(),
  forceAcquireSessionLock: vi.fn(),
}));

vi.mock("../../hooks/modalPersistence", () => ({
  saveMissionGoal: vi.fn(),
  getMissionGoal: vi.fn(() => ""),
  clearMissionGoal: vi.fn(),
}));

const mockStartMissionInterview = vi.mocked(api.startMissionInterview);
const mockRespondToMissionInterview = vi.mocked(api.respondToMissionInterview);
const mockCancelMissionInterview = vi.mocked(api.cancelMissionInterview);
const mockCreateMissionFromInterview = vi.mocked(api.createMissionFromInterview);
const mockConnectMissionInterviewStream = vi.mocked(api.connectMissionInterviewStream);
const mockFetchAiSession = vi.mocked(api.fetchAiSession);
const mockParseConversationHistory = vi.mocked(api.parseConversationHistory);
const mockAcquireSessionLock = vi.mocked(api.acquireSessionLock);
const mockReleaseSessionLock = vi.mocked(api.releaseSessionLock);
const mockForceAcquireSessionLock = vi.mocked(api.forceAcquireSessionLock);
const mockGetMissionGoal = vi.mocked(modalPersistence.getMissionGoal);

const sampleQuestionSingle: PlanningQuestion = {
  id: "scope",
  type: "single_select",
  question: "What is the target scope?",
  description: "Pick a scope",
  options: [
    { id: "mvp", label: "MVP" },
    { id: "full", label: "Full" },
  ],
};

const sampleSummary = {
  missionTitle: "Mission: Collaboration Platform",
  missionDescription: "Build a collaboration platform with milestones",
  milestones: [
    {
      title: "Foundation",
      description: "Set up project baseline",
      verification: "Core services healthy",
      slices: [
        {
          title: "Auth Slice",
          description: "Add login flow",
          verification: "Users can authenticate",
          features: [
            {
              title: "Email login",
              description: "Users can sign in with email",
              acceptanceCriteria: "Successful login redirects to dashboard",
            },
          ],
        },
      ],
    },
  ],
};

describe("MissionInterviewModal", () => {
  let streamHandlers: Parameters<typeof api.connectMissionInterviewStream>[2] | undefined;
  let closeStream: ReturnType<typeof vi.fn>;
  const onClose = vi.fn();
  const onMissionCreated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    closeStream = vi.fn();
    streamHandlers = undefined;

    vi.spyOn(window, "confirm").mockReturnValue(true);

    mockStartMissionInterview.mockResolvedValue({ sessionId: "mission-session-1" });
    mockRespondToMissionInterview.mockResolvedValue({ type: "question", data: sampleQuestionSingle });
    mockCancelMissionInterview.mockResolvedValue(undefined);
    mockCreateMissionFromInterview.mockResolvedValue({ id: "MS-001", title: "Created mission" } as any);
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
    mockGetMissionGoal.mockReturnValue("");
    mockAcquireSessionLock.mockResolvedValue({ acquired: true, currentHolder: null });
    mockReleaseSessionLock.mockResolvedValue(undefined);
    mockForceAcquireSessionLock.mockResolvedValue({ acquired: true, currentHolder: null });

    mockConnectMissionInterviewStream.mockImplementation((_sessionId, _projectId, handlers) => {
      streamHandlers = handlers;
      return {
        close: closeStream,
        isConnected: vi.fn().mockReturnValue(true),
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderModal(props?: Partial<React.ComponentProps<typeof MissionInterviewModal>>) {
    return render(
      <MissionInterviewModal
        isOpen={true}
        onClose={onClose}
        onMissionCreated={onMissionCreated}
        {...props}
      />,
    );
  }

  async function startInterview(goal = "Build mission interview workflow") {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("What do you want to build?"), goal);
    await user.click(screen.getByRole("button", { name: "Start Interview" }));

    await waitFor(() => {
      expect(mockStartMissionInterview).toHaveBeenCalledWith(goal, undefined);
      expect(streamHandlers).toBeDefined();
    });
  }

  it("returns null when isOpen=false", () => {
    render(
      <MissionInterviewModal
        isOpen={false}
        onClose={onClose}
        onMissionCreated={onMissionCreated}
      />,
    );

    expect(screen.queryByText("Plan Mission with AI")).not.toBeInTheDocument();
  });

  it("renders modal header and initial mission goal textarea when open", () => {
    renderModal();

    expect(screen.getByText("Plan Mission with AI")).toBeInTheDocument();
    expect(screen.getByLabelText("What do you want to build?")).toBeInTheDocument();
  });

  it("Start Interview button is disabled when mission goal is empty", () => {
    renderModal();

    expect(screen.getByRole("button", { name: "Start Interview" })).toBeDisabled();
  });

  it("Start Interview calls API and shows loading spinner while awaiting stream events", async () => {
    renderModal();

    await startInterview("Build planning engine");

    expect(screen.getByText("Preparing next question...")).toBeInTheDocument();
    expect(document.querySelector(".planning-loading .spin")).toBeTruthy();
  });

  it("stream onQuestion transitions to question view", async () => {
    renderModal();
    await startInterview();

    act(() => {
      streamHandlers?.onQuestion?.(sampleQuestionSingle);
    });

    expect(await screen.findByText("What is the target scope?")).toBeInTheDocument();
  });

  it("question view renders text/single_select/multi_select/confirm types", async () => {
    renderModal();
    await startInterview();

    act(() => {
      streamHandlers?.onQuestion?.({
        id: "q-text",
        type: "text",
        question: "Describe your goal",
      });
    });
    expect(await screen.findByPlaceholderText("Type your answer here...")).toBeInTheDocument();

    act(() => {
      streamHandlers?.onQuestion?.(sampleQuestionSingle);
    });
    expect(await screen.findByText("MVP")).toBeInTheDocument();

    act(() => {
      streamHandlers?.onQuestion?.({
        id: "q-multi",
        type: "multi_select",
        question: "Which capabilities?",
        options: [
          { id: "chat", label: "Chat" },
          { id: "docs", label: "Docs" },
        ],
      });
    });
    expect(await screen.findByText("Chat")).toBeInTheDocument();

    act(() => {
      streamHandlers?.onQuestion?.({
        id: "q-confirm",
        type: "confirm",
        question: "Ship MVP first?",
      });
    });
    expect(await screen.findByRole("button", { name: "Yes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "No" })).toBeInTheDocument();
  });

  it("submit response calls respondToMissionInterview with answers", async () => {
    renderModal();
    await startInterview();

    act(() => {
      streamHandlers?.onQuestion?.(sampleQuestionSingle);
    });

    const user = userEvent.setup();
    await user.click(await screen.findByText("MVP"));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(mockRespondToMissionInterview).toHaveBeenCalledWith(
        "mission-session-1",
        { scope: "mvp" },
        undefined,
        expect.any(String),
      );
    });
  });

  it("stream onSummary transitions to summary view with editable fields and hierarchy", async () => {
    renderModal();
    await startInterview();

    act(() => {
      streamHandlers?.onSummary?.(sampleSummary as any);
    });

    expect(await screen.findByText("Mission Plan Ready")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Mission: Collaboration Platform")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Build a collaboration platform with milestones")).toBeInTheDocument();

    // Hierarchy fields
    expect(screen.getByDisplayValue("Foundation")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Auth Slice")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Email login")).toBeInTheDocument();
  });

  it("summary hierarchy is expandable/collapsible", async () => {
    renderModal();
    await startInterview();

    act(() => {
      streamHandlers?.onSummary?.(sampleSummary as any);
    });

    await screen.findByText("Mission Plan Ready");
    const milestoneInput = screen.getByDisplayValue("Foundation");

    // Click row to collapse then expand
    fireEvent.click(milestoneInput.closest("div")!);
    expect(screen.queryByDisplayValue("Auth Slice")).not.toBeInTheDocument();

    fireEvent.click(milestoneInput.closest("div")!);
    expect(screen.getByDisplayValue("Auth Slice")).toBeInTheDocument();
  });

  it("Approve Plan calls createMissionFromInterview and onMissionCreated", async () => {
    renderModal();
    await startInterview();

    act(() => {
      streamHandlers?.onSummary?.(sampleSummary as any);
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Approve Plan" }));

    await waitFor(() => {
      expect(mockCreateMissionFromInterview).toHaveBeenCalledWith(
        "mission-session-1",
        expect.objectContaining({ missionTitle: "Mission: Collaboration Platform" }),
        undefined,
      );
      expect(onMissionCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "MS-001" }));
    });
  });

  it("Start Over resets to initial view", async () => {
    renderModal();
    await startInterview();

    act(() => {
      streamHandlers?.onSummary?.(sampleSummary as any);
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Start Over" }));

    expect(screen.getByLabelText("What do you want to build?")).toBeInTheDocument();
    expect(screen.queryByText("Mission Plan Ready")).not.toBeInTheDocument();
  });

  it("handles start interview API error and returns to initial view", async () => {
    mockStartMissionInterview.mockRejectedValueOnce(new Error("Failed to start"));

    renderModal();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("What do you want to build?"), "Bad start");
    await user.click(screen.getByRole("button", { name: "Start Interview" }));

    await waitFor(() => {
      expect(screen.getByText("Failed to start")).toBeInTheDocument();
      expect(screen.getByLabelText("What do you want to build?")).toBeInTheDocument();
    });
  });

  it("Escape key with progress asks for confirmation", async () => {
    renderModal();
    await startInterview();

    act(() => {
      streamHandlers?.onQuestion?.(sampleQuestionSingle);
    });

    fireEvent.keyDown(document, { key: "Escape" });

    expect(window.confirm).toHaveBeenCalledWith(
      "Are you sure you want to close? Your interview progress will be lost.",
    );
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("Escape key without progress closes directly", () => {
    renderModal();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(window.confirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("calls cancelMissionInterview on close when session is active", async () => {
    renderModal();
    await startInterview();

    act(() => {
      streamHandlers?.onQuestion?.(sampleQuestionSingle);
    });

    const user = userEvent.setup();
    await user.click(await screen.findByLabelText("Close"));

    await waitFor(() => {
      expect(mockCancelMissionInterview).toHaveBeenCalledWith("mission-session-1", undefined, expect.any(String));
    });
  });

  it("initialGoal prop auto-starts interview", async () => {
    renderModal({ initialGoal: "Auto-start goal" });

    await waitFor(() => {
      expect(mockStartMissionInterview).toHaveBeenCalledWith("Auto-start goal", undefined);
    });
  });

  it("resumeSessionId fetches AI session and restores question state", async () => {
    mockFetchAiSession.mockResolvedValueOnce({
      id: "resume-1",
      status: "awaiting_input",
      currentQuestion: JSON.stringify(sampleQuestionSingle),
      result: null,
      thinkingOutput: "",
      error: null,
    } as any);

    renderModal({ resumeSessionId: "resume-1" });

    await waitFor(() => {
      expect(mockFetchAiSession).toHaveBeenCalledWith("resume-1");
      expect(screen.getByText("What is the target scope?")).toBeInTheDocument();
    });
  });

  it("unmount cleanup closes active stream connection", async () => {
    const { unmount } = renderModal();
    await startInterview();

    unmount();

    expect(closeStream).toHaveBeenCalled();
  });
});
