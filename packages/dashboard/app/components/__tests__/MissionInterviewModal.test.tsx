import type React from "react";
import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissionInterviewModal } from "../MissionInterviewModal";

const missionInterviewCss = readFileSync("app/components/MissionInterviewModal.css", "utf8");

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

vi.mock("../../api", () => ({
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

const mockGetMissionGoal = vi.fn(() => "");
const mockSaveMissionGoal = vi.fn();

vi.mock("../../hooks/modalPersistence", () => ({
  saveMissionGoal: (...args: any[]) => mockSaveMissionGoal(...args),
  getMissionGoal: (...args: any[]) => mockGetMissionGoal(...args),
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

const SECOND_QUESTION = {
  id: "platform",
  type: "text" as const,
  question: "Which platforms should this mission cover?",
  description: "List the product surfaces that need support.",
};

const SAMPLE_SUMMARY = {
  missionTitle: "Resilient mission planning",
  missionDescription: "Recover mission AI planning after transient stream interruptions.",
  milestones: [
    {
      title: "Recovery milestone",
      description: "Keep the interview usable after reconnecting.",
      slices: [
        {
          title: "Stream recovery",
          description: "Reconnect recoverable mission interviews.",
          features: [
            {
              title: "Continue interview",
              description: "The modal resumes from the next streamed state.",
            },
          ],
        },
      ],
    },
  ],
};

function buildMissionSession(overrides: Record<string, unknown> = {}) {
  return {
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("MissionInterviewModal", () => {
  let streamHandlers: any;

  beforeEach(() => {
    vi.clearAllMocks();
    streamHandlers = undefined;

    mockStartMissionInterview.mockResolvedValue({ sessionId: "mission-session-1" });
    mockRetryMissionInterviewSession.mockResolvedValue({ success: true, sessionId: "mission-session-1" });
    mockFetchAiSession.mockResolvedValue(null);
    mockSaveMissionGoal.mockReset();
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
    localStorage.removeItem("floating-window:mission-interview");
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  });

  function renderModal(props: Partial<React.ComponentProps<typeof MissionInterviewModal>> = {}) {
    const onClose = props.onClose ?? vi.fn();

    return {
      onClose,
      ...render(
        <MissionInterviewModal
          isOpen={true}
          onClose={onClose}
          onMissionCreated={vi.fn()}
          {...props}
        />,
      ),
    };
  }

  function setViewport(width: number, height: number) {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  }

  function stubPointerCapture(element: HTMLElement) {
    Object.defineProperty(element, "setPointerCapture", { configurable: true, value: vi.fn() });
    Object.defineProperty(element, "releasePointerCapture", { configurable: true, value: vi.fn() });
  }

  it("renders mission interview inside a floating desktop workspace", () => {
    setViewport(1200, 900);

    renderModal();

    const panel = screen.getByTestId("floating-window-mission-interview");
    expect(panel).toHaveClass("floating-window--mission-interview");
    expect(panel).toHaveClass("floating-window--headerless");
    expect(panel.style.width).toBe("760px");
    expect(panel.style.height).toBe("680px");
    expect(screen.queryByTestId("floating-window-drag-handle-mission-interview")).toBeNull();
    expect(screen.getByText("Plan Mission with AI").closest(".mission-interview-modal__drag-handle")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
  });

  it("drags and resizes the desktop mission floating window while clamping geometry", async () => {
    setViewport(1200, 1000);

    renderModal();

    const panel = screen.getByTestId("floating-window-mission-interview");
    const header = screen.getByText("Plan Mission with AI").closest(".mission-interview-modal__drag-handle") as HTMLElement;
    stubPointerCapture(panel);

    const initialLeft = Number.parseFloat(panel.style.left);
    const initialTop = Number.parseFloat(panel.style.top);

    act(() => {
      fireEvent.pointerDown(header, { pointerId: 7, clientX: 120, clientY: 80 });
      fireEvent.pointerMove(panel, { pointerId: 7, clientX: 220, clientY: 140 });
      fireEvent.pointerUp(panel, { pointerId: 7, clientX: 220, clientY: 140 });
    });

    await waitFor(() => {
      expect(Number.parseFloat(panel.style.left)).toBeGreaterThan(initialLeft);
      expect(Number.parseFloat(panel.style.top)).toBeGreaterThan(initialTop);
    });

    const resizeHandle = screen.getByTestId("floating-window-resize-se") as HTMLElement;
    stubPointerCapture(resizeHandle);

    act(() => {
      fireEvent.pointerDown(resizeHandle, { pointerId: 8, clientX: 700, clientY: 600 });
      fireEvent.pointerMove(resizeHandle, { pointerId: 8, clientX: 3000, clientY: 3000 });
      fireEvent.pointerUp(resizeHandle, { pointerId: 8, clientX: 3000, clientY: 3000 });
    });

    expect(Number.parseFloat(panel.style.width)).toBeLessThanOrEqual(1200);
    expect(Number.parseFloat(panel.style.height)).toBeLessThanOrEqual(1000);
    expect(Number.parseFloat(panel.style.width)).toBeGreaterThanOrEqual(560);
    expect(Number.parseFloat(panel.style.height)).toBeGreaterThanOrEqual(420);
  });

  it("keeps mobile mission planning full-screen and hides resize handles by CSS contract", () => {
    const mobileBlock = missionInterviewCss.match(/@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\.floating-window--mission-interview \.mission-interview-modal\s*\{[\s\S]*?\n\}/)?.[0];

    expect(mobileBlock).toContain(".floating-window--mission-interview");
    expect(mobileBlock).toContain("width: 100vw !important;");
    expect(mobileBlock).toContain("height: 100dvh !important;");
    expect(mobileBlock).toContain(".floating-window--mission-interview .floating-window__resize-handle");
    expect(mobileBlock).toContain("display: none;");
  });

  /*
  FNXC:PlanningMultiTab 2026-07-14-00:00:
  Mission interviews are multi-tab: this tab must never acquire a lock, never render a lock
  overlay or "active in another tab" banner, and must stay interactive even when another tab
  is using the same session.
  */
  it("never acquires a tab lock and renders no lock overlay", async () => {
    // A rejecting lock API would surface an overlay if any legacy lock path survived.
    mockAcquireSessionLock.mockResolvedValue({ acquired: false, currentHolder: "tab-other" });

    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(mockStartMissionInterview).toHaveBeenCalled();
    });

    expect(screen.queryByTestId("session-lock-overlay")).not.toBeInTheDocument();
    expect(screen.queryByTestId("session-active-another-tab-banner")).not.toBeInTheDocument();
    expect(screen.queryByText("Take Control")).not.toBeInTheDocument();
    expect(mockAcquireSessionLock).not.toHaveBeenCalled();
    expect(mockForceAcquireSessionLock).not.toHaveBeenCalled();
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

  it("recovers a generating mission interview after a transient Stream error", async () => {
    mockFetchAiSession.mockResolvedValueOnce(buildMissionSession({ status: "generating" }));

    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    await act(async () => {
      streamHandlers.onError?.("Stream error");
    });

    expect(await screen.findByText("Reconnecting…")).toBeInTheDocument();
    expect(screen.queryByText("Stream error")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(mockFetchAiSession).toHaveBeenCalledWith("mission-session-1");
      expect(mockConnectMissionInterviewStream).toHaveBeenCalledTimes(2);
    });

    act(() => {
      streamHandlers.onQuestion?.(SECOND_QUESTION);
    });

    expect(await screen.findByText("Which platforms should this mission cover?")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
    });
    expect(screen.queryByText("Stream error")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("preserves an awaiting-input question while recovering a transient Stream error", async () => {
    mockFetchAiSession.mockResolvedValueOnce(
      buildMissionSession({
        status: "awaiting_input",
        currentQuestion: JSON.stringify(SAMPLE_QUESTION),
        thinkingOutput: "",
      }),
    );

    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    act(() => {
      streamHandlers.onQuestion?.(SAMPLE_QUESTION);
    });

    expect(await screen.findByText("What is the target scope?")).toBeInTheDocument();

    await act(async () => {
      streamHandlers.onError?.("Stream error");
    });

    expect(await screen.findByText("Reconnecting…")).toBeInTheDocument();
    expect(screen.getByText("What is the target scope?")).toBeInTheDocument();
    expect(screen.queryByText("Stream error")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(mockFetchAiSession).toHaveBeenCalledWith("mission-session-1");
      expect(mockConnectMissionInterviewStream).toHaveBeenCalledTimes(2);
    });

    act(() => {
      streamHandlers.onSummary?.(SAMPLE_SUMMARY);
    });

    expect(await screen.findByDisplayValue("Resilient mission planning")).toBeInTheDocument();
    expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
    expect(screen.queryByText("Stream error")).not.toBeInTheDocument();
  });

  it("renders a completed mission summary instead of Stream error after recovery finds completion", async () => {
    mockFetchAiSession.mockResolvedValueOnce(
      buildMissionSession({
        status: "complete",
        result: JSON.stringify(SAMPLE_SUMMARY),
        thinkingOutput: "",
      }),
    );

    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    await act(async () => {
      streamHandlers.onError?.("Stream error");
    });

    expect(await screen.findByDisplayValue("Resilient mission planning")).toBeInTheDocument();
    expect(screen.queryByText("Stream error")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("shows error panel with retry action when stream recovery cannot refresh the session", async () => {
    mockFetchAiSession.mockRejectedValueOnce(new Error("refresh failed"));

    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    await act(async () => {
      streamHandlers.onError?.("Temporary outage");
    });

    expect(await screen.findByText("Temporary outage")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("renders normalized generic stream failures as a recoverable retry state", async () => {
    mockFetchAiSession.mockRejectedValueOnce(new Error("refresh failed"));

    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    await act(async () => {
      streamHandlers.onError?.("The mission interview stream was interrupted. Please retry the session.");
    });

    expect(await screen.findByText("The mission interview stream was interrupted. Please retry the session.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
    expect(screen.queryByText("AI is thinking...")).not.toBeInTheDocument();
  });

  it("shows persisted mission interview errors after stream recovery refreshes the session", async () => {
    mockFetchAiSession.mockResolvedValueOnce(
      buildMissionSession({
        status: "error",
        error: "The mission interview failed permanently.",
        thinkingOutput: "",
      }),
    );

    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    await act(async () => {
      streamHandlers.onError?.("Stream error");
    });

    expect(await screen.findByText("The mission interview failed permanently.")).toBeInTheDocument();
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
      expect(mockRetryMissionInterviewSession).toHaveBeenCalledWith("mission-session-1", undefined);
    });
    await waitFor(() => {
      expect(screen.getByText("What is the target scope?")).toBeInTheDocument();
    });
    expect(mockConnectMissionInterviewStream).toHaveBeenCalledTimes(2);
  });

  it("recovers connection-loss directly when interview session is still generating", async () => {
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

    mockFetchAiSession.mockResolvedValueOnce(buildMissionSession({ status: "generating" }));

    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(mockFetchAiSession).toHaveBeenCalledWith("mission-session-1");
      expect(mockConnectMissionInterviewStream).toHaveBeenCalledTimes(2);
    });

    expect(await screen.findByText("AI is thinking...")).toBeInTheDocument();
    expect(screen.getByText("Continuing...")).toBeInTheDocument();
    expect(screen.queryByText("Connection lost")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(mockRetryMissionInterviewSession).not.toHaveBeenCalled();
  });

  it("shows comment textarea and submits _comment for non-text questions", async () => {
    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    act(() => {
      streamHandlers.onQuestion?.(SAMPLE_QUESTION);
    });

    fireEvent.click(await screen.findByText("MVP"));
    fireEvent.change(screen.getByPlaceholderText("Add any extra context or direction..."), {
      target: { value: "Optimize for launch speed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(mockRespondToMissionInterview).toHaveBeenCalledWith(
        "mission-session-1",
        expect.objectContaining({ scope: "mvp", _comment: "Optimize for launch speed" }),
        undefined,
      );
    });
  });

  it("submits trimmed Other-only answers for single-select mission questions", async () => {
    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    act(() => {
      streamHandlers.onQuestion?.(SAMPLE_QUESTION);
    });

    const continueButton = await screen.findByRole("button", { name: "Continue" });
    fireEvent.click(screen.getByTestId("planning-option-other"));
    expect(continueButton).toBeDisabled();

    fireEvent.change(screen.getByTestId("planning-other-input"), {
      target: { value: "  Start with discovery instead  " },
    });
    expect(continueButton).toBeEnabled();
    fireEvent.click(continueButton);

    await waitFor(() => {
      expect(mockRespondToMissionInterview).toHaveBeenCalledWith(
        "mission-session-1",
        { _other: "Start with discovery instead" },
        undefined,
      );
    });
  });

  it("renders Other for single-select mission questions with no provided options", async () => {
    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    act(() => {
      streamHandlers.onQuestion?.({
        id: "open_scope",
        type: "single_select",
        question: "What scope should we use?",
      });
    });

    const continueButton = await screen.findByRole("button", { name: "Continue" });
    expect(screen.getByTestId("planning-option-other")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("planning-option-other"));
    expect(continueButton).toBeDisabled();

    fireEvent.change(screen.getByTestId("planning-other-input"), {
      target: { value: "  Define a custom scope  " },
    });
    expect(continueButton).toBeEnabled();
    fireEvent.click(continueButton);

    await waitFor(() => {
      expect(mockRespondToMissionInterview).toHaveBeenCalledWith(
        "mission-session-1",
        { _other: "Define a custom scope" },
        undefined,
      );
    });
  });

  it("clears stale Other text when switching back to a provided mission option", async () => {
    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    act(() => {
      streamHandlers.onQuestion?.(SAMPLE_QUESTION);
    });

    const continueButton = await screen.findByRole("button", { name: "Continue" });
    fireEvent.click(screen.getByTestId("planning-option-other"));
    fireEvent.change(screen.getByTestId("planning-other-input"), { target: { value: "   " } });
    expect(continueButton).toBeDisabled();
    fireEvent.change(screen.getByTestId("planning-other-input"), {
      target: { value: "Plan a discovery mission" },
    });
    expect(continueButton).toBeEnabled();

    fireEvent.click(screen.getByText("MVP"));
    expect(screen.queryByTestId("planning-other-input")).toBeNull();
    fireEvent.click(continueButton);

    await waitFor(() => {
      expect(mockRespondToMissionInterview).toHaveBeenCalledWith(
        "mission-session-1",
        { scope: "mvp" },
        undefined,
      );
    });
  });

  it("submits Other-only answers for multi-select mission questions", async () => {
    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    act(() => {
      streamHandlers.onQuestion?.({
        id: "priorities",
        type: "multi_select",
        question: "Which priorities matter?",
        options: [
          { id: "speed", label: "Speed" },
          { id: "quality", label: "Quality" },
        ],
      });
    });

    const continueButton = await screen.findByRole("button", { name: "Continue" });
    fireEvent.click(screen.getByTestId("planning-option-other"));
    expect(continueButton).toBeDisabled();

    fireEvent.change(screen.getByTestId("planning-other-input"), {
      target: { value: "  Add field research first  " },
    });
    expect(continueButton).toBeEnabled();
    fireEvent.click(continueButton);

    await waitFor(() => {
      expect(mockRespondToMissionInterview).toHaveBeenCalledWith(
        "mission-session-1",
        { _other: "Add field research first" },
        undefined,
      );
    });
  });

  it("renders Other for multi-select mission questions with no provided options", async () => {
    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    act(() => {
      streamHandlers.onQuestion?.({
        id: "open_priorities",
        type: "multi_select",
        question: "Which priorities matter?",
      });
    });

    const continueButton = await screen.findByRole("button", { name: "Continue" });
    expect(screen.getByTestId("planning-option-other")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("planning-option-other"));
    expect(continueButton).toBeDisabled();

    fireEvent.change(screen.getByTestId("planning-other-input"), {
      target: { value: "  Ask customers first  " },
    });
    expect(continueButton).toBeEnabled();
    fireEvent.click(continueButton);

    await waitFor(() => {
      expect(mockRespondToMissionInterview).toHaveBeenCalledWith(
        "mission-session-1",
        { _other: "Ask customers first" },
        undefined,
      );
    });
  });

  it("combines provided options with Other text for multi-select mission questions", async () => {
    renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    act(() => {
      streamHandlers.onQuestion?.({
        id: "priorities",
        type: "multi_select",
        question: "Which priorities matter?",
        options: [
          { id: "speed", label: "Speed" },
          { id: "quality", label: "Quality" },
        ],
      });
    });

    const continueButton = await screen.findByRole("button", { name: "Continue" });
    fireEvent.click(screen.getByText("Speed"));
    fireEvent.click(screen.getByTestId("planning-option-other"));
    fireEvent.change(screen.getByTestId("planning-other-input"), {
      target: { value: "  Preserve operator review  " },
    });
    expect(continueButton).toBeEnabled();
    fireEvent.click(continueButton);

    await waitFor(() => {
      expect(mockRespondToMissionInterview).toHaveBeenCalledWith(
        "mission-session-1",
        { priorities: ["speed"], _other: "Preserve operator review" },
        undefined,
      );
    });
  });

  it("restores persisted goal from localStorage on open", () => {
    mockGetMissionGoal.mockReturnValue("Previous mission goal");

    renderModal();

    const textarea = screen.getByLabelText("What do you want to build?");
    expect(textarea).toHaveValue("Previous mission goal");
  });

  it("closes without cancelling an in-progress interview and renders only one close button", async () => {
    const { onClose } = renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    act(() => {
      streamHandlers.onQuestion?.(SAMPLE_QUESTION);
    });

    const closeButtons = screen.getAllByRole("button", { name: "Close" });
    expect(closeButtons).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Send to background" })).not.toBeInTheDocument();

    fireEvent.click(closeButtons[0]);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockCancelMissionInterview).not.toHaveBeenCalled();
  });

  it("persists the draft goal and closes from the initial view", () => {
    const { onClose } = renderModal({ projectId: "proj-1" });

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Draft mission goal" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(mockSaveMissionGoal).toHaveBeenCalledWith("Draft mission goal", "proj-1");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockCancelMissionInterview).not.toHaveBeenCalled();
  });

  it("closes without cancelling when pressing Escape", async () => {
    const { onClose } = renderModal();

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a mission planning workflow" },
    });
    fireEvent.click(screen.getByText("Start Interview"));

    await waitFor(() => {
      expect(streamHandlers).toBeDefined();
    });

    act(() => {
      streamHandlers.onQuestion?.(SAMPLE_QUESTION);
    });

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockCancelMissionInterview).not.toHaveBeenCalled();
  });

  it("does not render a blocking backdrop click target around the floating workspace", () => {
    const { onClose } = renderModal();
    const overlay = screen.getByRole("dialog");

    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);

    expect(onClose).not.toHaveBeenCalled();
    expect(mockCancelMissionInterview).not.toHaveBeenCalled();
  });

  it("allows typing in textarea without resetting to stale persisted goal", async () => {
    // Simulate a stale persisted goal from a previous session
    mockGetMissionGoal.mockReturnValue("Old stale goal");

    renderModal();

    const textarea = screen.getByLabelText("What do you want to build?");
    expect(textarea).toHaveValue("Old stale goal");

    // User starts typing a new goal
    fireEvent.change(textarea, { target: { value: "New mission" } });
    expect(textarea).toHaveValue("New mission");

    // Type more characters — the stale value should NOT overwrite
    fireEvent.change(textarea, { target: { value: "New mission idea" } });
    expect(textarea).toHaveValue("New mission idea");

    // Even after a re-render cycle, user input should persist
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(textarea).toHaveValue("New mission idea");
  });
});
