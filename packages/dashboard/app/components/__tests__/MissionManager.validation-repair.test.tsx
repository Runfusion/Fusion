import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissionManager } from "../MissionManager";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";

const fetchMissions = vi.fn(); const fetchMission = vi.fn(); const fetchMissionsHealth = vi.fn();
const fetchMissionEvents = vi.fn(); const fetchAssertions = vi.fn(); const fetchMilestoneValidation = vi.fn();
const fetchMilestoneValidationTelemetry = vi.fn(); const fetchValidationLoopState = vi.fn(); const fetchValidationRuns = vi.fn();
const fetchAiSessions = vi.fn(); const fetchAiSession = vi.fn(); const fetchMissionInterviewDrafts = vi.fn(); const repairFeatureValidation = vi.fn();
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
  fetchMissionInterviewDrafts: (...args: unknown[]) => fetchMissionInterviewDrafts(...args), repairFeatureValidation: (...args: unknown[]) => repairFeatureValidation(...args), fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
}));

const baseFeature = { id: "F-1", title: "Blocked feature", status: "in-progress", loopState: "blocked", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
const baseFixFeature = { ...baseFeature, id: "F-fix", title: "Blocked fix", sourceFeatureId: "F-1", runId: "VR-1", failedAssertionIds: [] };
let feature = baseFeature;
let fixFeature = baseFixFeature;
const currentMission = () => ({ id: "M-1", title: "Mission", description: "", status: "active", interviewState: "completed", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", milestones: [{ id: "MS-1", missionId: "M-1", title: "Milestone", status: "active", interviewState: "completed", orderIndex: 0, dependencies: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", slices: [{ id: "SL-1", milestoneId: "MS-1", title: "Slice", status: "active", orderIndex: 0, dependencies: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", features: [feature] }] }] });

/*
FNXC:MissionValidationRepair 2026-08-11-02:10:
Exercise the actual desktop and narrow-viewport render paths, then change the backing feature
snapshots after Clear. This prevents stale badges or empty action shells from surviving either
feature presentation after the store emits its update.
*/
describe("MissionManager validation repair controls", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks(); feature = { ...baseFeature }; fixFeature = { ...baseFixFeature };
    fetchMissions.mockResolvedValue([{ ...currentMission(), milestones: [] }]); fetchMission.mockImplementation(async () => currentMission());
    fetchMissionsHealth.mockResolvedValue({}); fetchMissionEvents.mockResolvedValue([]); fetchAssertions.mockResolvedValue([]); fetchMilestoneValidation.mockResolvedValue(null);
    fetchMilestoneValidationTelemetry.mockImplementation(async () => ({ rollup: { milestoneId: "MS-1", state: "not_started" }, validationTelemetry: { validationRounds: [], totalRuns: 0 }, validationContract: null, fixFeatures: [fixFeature] }));
    fetchValidationLoopState.mockResolvedValue(null); fetchValidationRuns.mockResolvedValue([]); fetchAiSessions.mockResolvedValue([]); fetchAiSession.mockResolvedValue(null); fetchMissionInterviewDrafts.mockResolvedValue([]);
    repairFeatureValidation.mockImplementation(async (id: string) => {
      if (id === feature.id) feature = { ...feature, loopState: "idle" };
      if (id === fixFeature.id) fixFeature = { ...fixFeature, loopState: "idle" };
      return id === feature.id ? feature : fixFeature;
    });
  });

  it.each([1280, 640])("renders both repair surfaces and removes their chrome after clear at %ipx", async (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
    const { container } = render(<ConfirmDialogProvider><MissionManager isInline isOpen onClose={() => {}} addToast={vi.fn()} projectId="p1" targetMissionId="M-1" /></ConfirmDialogProvider>);
    await screen.findByText("Blocked feature");
    await waitFor(() => expect(fetchMilestoneValidationTelemetry).toHaveBeenCalledWith("MS-1", "p1"));
    await waitFor(() => expect(container.querySelector(".mission-fix-feature__header")).not.toBeNull());

    const featureRow = container.querySelector('[data-mission-feature-id="F-1"]')!;
    const fixHeader = container.querySelector(".mission-fix-feature__header")!;
    expect(featureRow.querySelectorAll('[aria-label="Clear validation badge"]')).toHaveLength(1);
    expect(featureRow.querySelectorAll('[aria-label="Re-run validation"]')).toHaveLength(1);
    expect(fixHeader.querySelectorAll('[aria-label="Clear validation badge"]')).toHaveLength(1);
    expect(fixHeader.querySelectorAll('[aria-label="Re-run validation"]')).toHaveLength(1);

    fireEvent.click(featureRow.querySelector('[aria-label="Clear validation badge"]')!);
    await waitFor(() => expect(repairFeatureValidation).toHaveBeenCalledWith("F-1", "clear", undefined, "p1"));
    await waitFor(() => expect(container.querySelector('[data-mission-feature-id="F-1"] [aria-label="Clear validation badge"]')).toBeNull());
    expect(container.querySelector('[data-mission-feature-id="F-1"] [aria-label="Re-run validation"]')).toBeNull();

    fireEvent.click(fixHeader.querySelector('[aria-label="Clear validation badge"]')!);
    await waitFor(() => expect(repairFeatureValidation).toHaveBeenCalledWith("F-fix", "clear", undefined, "p1"));
    await waitFor(() => expect(container.querySelector(".mission-fix-feature__header [aria-label=\"Clear validation badge\"]")).toBeNull());
    expect(container.querySelector(".mission-fix-feature__header [aria-label=\"Re-run validation\"]")).toBeNull();
    expect(container.querySelector(".mission-fix-feature__actions")).toBeNull();
  });

  it("does not render repair controls for healthy or live validation states", async () => {
    feature = { ...baseFeature, loopState: "validating" }; fixFeature = { ...baseFixFeature, loopState: "passed" };
    const { container } = render(<ConfirmDialogProvider><MissionManager isInline isOpen onClose={() => {}} addToast={vi.fn()} projectId="p1" targetMissionId="M-1" /></ConfirmDialogProvider>);
    await screen.findByText("Blocked feature"); await waitFor(() => expect(fetchMilestoneValidationTelemetry).toHaveBeenCalled());
    expect(container.querySelectorAll('[aria-label="Re-run validation"]')).toHaveLength(0);
  });
});
