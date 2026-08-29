import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../api/client/client";
import { MissionManager } from "../MissionManager";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";

const fetchMissions = vi.fn(); const fetchMission = vi.fn(); const fetchMissionsHealth = vi.fn();
const fetchMissionEvents = vi.fn(); const fetchAssertions = vi.fn(); const fetchMilestoneValidation = vi.fn();
const fetchMilestoneValidationTelemetry = vi.fn(); const fetchValidationLoopState = vi.fn(); const fetchValidationRuns = vi.fn();
const fetchAiSessions = vi.fn(); const fetchAiSession = vi.fn(); const fetchMissionInterviewDrafts = vi.fn(); const triggerValidation = vi.fn();
vi.mock("../../hooks/useNavigationHistory", () => ({ useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => vi.fn()) }));
vi.mock("../MissionInterviewModal", () => ({ MissionInterviewModal: () => null }));
vi.mock("../MilestoneSliceInterviewModal", () => ({ MilestoneSliceInterviewModal: () => null }));
vi.mock("../../api", async (original) => ({ ...(await original<typeof import("../../api")>()),
  fetchMissions: (...args: unknown[]) => fetchMissions(...args), fetchMission: (...args: unknown[]) => fetchMission(...args),
  fetchMissionsHealth: (...args: unknown[]) => fetchMissionsHealth(...args), fetchMissionEvents: (...args: unknown[]) => fetchMissionEvents(...args),
  fetchAssertions: (...args: unknown[]) => fetchAssertions(...args), fetchMilestoneValidation: (...args: unknown[]) => fetchMilestoneValidation(...args),
  fetchMilestoneValidationTelemetry: (...args: unknown[]) => fetchMilestoneValidationTelemetry(...args), fetchValidationLoopState: (...args: unknown[]) => fetchValidationLoopState(...args),
  fetchValidationRuns: (...args: unknown[]) => fetchValidationRuns(...args), fetchAiSessions: (...args: unknown[]) => fetchAiSessions(...args), fetchAiSession: (...args: unknown[]) => fetchAiSession(...args),
  fetchMissionInterviewDrafts: (...args: unknown[]) => fetchMissionInterviewDrafts(...args), triggerValidation: (...args: unknown[]) => triggerValidation(...args),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
}));

const feature = { id: "F-1", title: "Ready feature", status: "in-progress", loopState: "implementing", taskId: "FN-1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
const currentMission = () => ({ id: "M-1", title: "Mission", description: "", status: "active", interviewState: "completed", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", milestones: [{ id: "MS-1", missionId: "M-1", title: "Milestone", status: "active", interviewState: "completed", orderIndex: 0, dependencies: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", slices: [{ id: "SL-1", milestoneId: "MS-1", title: "Slice", status: "active", orderIndex: 0, dependencies: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", features: [feature] }] }] });

/*
FNXC:MissionValidation 2026-08-11-04:17:
FN-8963 requires the manual validation conflict to preserve the single existing validate affordance
at desktop and mobile widths. A 409 must refresh live state, show an informative message, and release
the spinner rather than leaving an empty or disabled button shell.
*/
describe("MissionManager manual validation in-flight conflict", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMissions.mockResolvedValue([{ ...currentMission(), milestones: [] }]); fetchMission.mockImplementation(async () => currentMission());
    fetchMissionsHealth.mockResolvedValue({}); fetchMissionEvents.mockResolvedValue([]); fetchAssertions.mockResolvedValue([]); fetchMilestoneValidation.mockResolvedValue(null);
    fetchMilestoneValidationTelemetry.mockResolvedValue({ rollup: { milestoneId: "MS-1", state: "not_started" }, validationTelemetry: { validationRounds: [], totalRuns: 0 }, validationContract: null, fixFeatures: [] });
    fetchValidationLoopState.mockResolvedValue(null); fetchValidationRuns.mockResolvedValue([]); fetchAiSessions.mockResolvedValue([]); fetchAiSession.mockResolvedValue(null); fetchMissionInterviewDrafts.mockResolvedValue([]);
    triggerValidation.mockResolvedValue({ runId: "VR-1" });
  });

  function renderManager(addToast = vi.fn()) {
    const rendered = render(<ConfirmDialogProvider><MissionManager isInline isOpen onClose={() => {}} addToast={addToast} projectId="p1" targetMissionId="M-1" /></ConfirmDialogProvider>);
    return { ...rendered, addToast };
  }

  it.each([1280, 640])("shows the specific conflict and restores one enabled validate button at %ipx", async (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
    triggerValidation.mockRejectedValueOnce(new ApiRequestError("Validation is already running for this feature", 409, { code: "VALIDATION_ALREADY_RUNNING" }));
    const { container, addToast } = renderManager();
    await screen.findByText("Ready feature");
    const button = container.querySelector('[title="Validate feature"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    fireEvent.click(button);

    await waitFor(() => expect(addToast).toHaveBeenCalledWith("Validation is already running for this feature", "info"));
    expect(addToast).not.toHaveBeenCalledWith("Failed to trigger validation", "error");
    await waitFor(() => expect((container.querySelector('[title="Validate feature"]') as HTMLButtonElement).disabled).toBe(false));
    expect(container.querySelectorAll('[title="Validate feature"]')).toHaveLength(1);
    expect(fetchValidationLoopState).toHaveBeenCalledWith("F-1", "p1");
  });

  it("preserves successful and generic validation feedback", async () => {
    const { container, addToast } = renderManager();
    await screen.findByText("Ready feature");
    fireEvent.click(container.querySelector('[title="Validate feature"]')!);
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("Validation triggered", "success"));

    triggerValidation.mockRejectedValueOnce(new Error("network unavailable"));
    fireEvent.click(container.querySelector('[title="Validate feature"]')!);
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("network unavailable", "error"));
  });
});
