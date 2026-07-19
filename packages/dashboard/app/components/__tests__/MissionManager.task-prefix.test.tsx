/*
FNXC:MissionTaskPrefix 2026-07-14-12:00:
Regression for greptile P1 on PR #1930: clearing a mission taskPrefix on edit must PATCH null so the stored override is removed and triage re-inherits the project prefix.
*/

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissionManager } from "../MissionManager";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";

const mockFetchMissions = vi.fn();
const mockFetchMission = vi.fn();
const mockFetchMissionsHealth = vi.fn();
const mockFetchMissionEvents = vi.fn();
const mockFetchAssertions = vi.fn();
const mockFetchMilestoneValidation = vi.fn();
const mockFetchMilestoneValidationTelemetry = vi.fn();
const mockFetchValidationLoopState = vi.fn();
const mockFetchValidationRuns = vi.fn();
const mockFetchAiSessions = vi.fn();
const mockFetchAiSession = vi.fn();
const mockFetchMissionInterviewDrafts = vi.fn();
const mockUpdateMission = vi.fn();
const mockSubscribeSse = vi.fn(() => vi.fn());

vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  getViewportMode: () => "desktop",
  isMobileViewport: () => false,
  useViewportMode: () => "desktop",
}));

vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});
vi.mock("../../sse-bus", () => ({
  subscribeSse: (...args: unknown[]) => mockSubscribeSse(...args),
}));

vi.mock("../MissionInterviewModal", () => ({
  MissionInterviewModal: () => null,
}));

vi.mock("../MilestoneSliceInterviewModal", () => ({
  MilestoneSliceInterviewModal: () => null,
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchMissions: (...args: unknown[]) => mockFetchMissions(...args),
    fetchMission: (...args: unknown[]) => mockFetchMission(...args),
    fetchMissionsHealth: (...args: unknown[]) => mockFetchMissionsHealth(...args),
    fetchMissionEvents: (...args: unknown[]) => mockFetchMissionEvents(...args),
    fetchAssertions: (...args: unknown[]) => mockFetchAssertions(...args),
    fetchMilestoneValidation: (...args: unknown[]) => mockFetchMilestoneValidation(...args),
    fetchMilestoneValidationTelemetry: (...args: unknown[]) => mockFetchMilestoneValidationTelemetry(...args),
    fetchValidationLoopState: (...args: unknown[]) => mockFetchValidationLoopState(...args),
    fetchValidationRuns: (...args: unknown[]) => mockFetchValidationRuns(...args),
    fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    fetchAiSession: (...args: unknown[]) => mockFetchAiSession(...args),
    fetchMissionInterviewDrafts: (...args: unknown[]) => mockFetchMissionInterviewDrafts(...args),
    updateMission: (...args: unknown[]) => mockUpdateMission(...args),
    fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  };
});

const projectId = "project-1";
const mission = {
  id: "M-001",
  title: "Prefixed Mission",
  description: "Has a mission-level prefix",
  status: "planning",
  interviewState: "not_started",
  taskPrefix: "ERR",
  milestones: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function setupMocks() {
  mockFetchMissions.mockResolvedValue([mission]);
  mockFetchMission.mockResolvedValue(mission);
  mockFetchMissionsHealth.mockResolvedValue({});
  mockFetchMissionEvents.mockResolvedValue([]);
  mockFetchAssertions.mockResolvedValue([]);
  mockFetchMilestoneValidation.mockResolvedValue(null);
  mockFetchMilestoneValidationTelemetry.mockResolvedValue(null);
  mockFetchValidationLoopState.mockResolvedValue(null);
  mockFetchValidationRuns.mockResolvedValue([]);
  mockFetchAiSessions.mockResolvedValue([]);
  mockFetchAiSession.mockResolvedValue(null);
  mockFetchMissionInterviewDrafts.mockResolvedValue([]);
  mockUpdateMission.mockResolvedValue({ ...mission, taskPrefix: undefined });
}

describe("MissionManager taskPrefix clear", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setupMocks();
  });

  it("PATCHes taskPrefix:null when the edit field is cleared", async () => {
    render(
      <ConfirmDialogProvider>
        <MissionManager isInline isOpen onClose={() => {}} addToast={vi.fn()} projectId={projectId} />
      </ConfirmDialogProvider>,
    );

    const listItem = (await screen.findByText("Prefixed Mission")).closest(".mission-list__item");
    expect(listItem).not.toBeNull();
    fireEvent.click(listItem as HTMLElement);

    await waitFor(() => {
      expect(mockFetchMission).toHaveBeenCalledWith("M-001", projectId);
    });

    const editButtons = screen.getAllByRole("button", { name: "Edit mission" });
    fireEvent.click(editButtons[0]);

    const prefixInput = await screen.findByLabelText("Mission task prefix");
    expect(prefixInput).toHaveValue("ERR");
    fireEvent.change(prefixInput, { target: { value: "" } });
    expect(prefixInput).toHaveValue("");

    const formCard = prefixInput.closest(".mission-form-card");
    expect(formCard).not.toBeNull();
    fireEvent.click(within(formCard as HTMLElement).getByRole("button", { name: /Update/i }));

    await waitFor(() => {
      expect(mockUpdateMission).toHaveBeenCalled();
    });
    const [missionId, updates, calledProjectId] = mockUpdateMission.mock.calls[0] as [
      string,
      Record<string, unknown>,
      string?,
    ];
    expect(missionId).toBe("M-001");
    expect(calledProjectId).toBe(projectId);
    expect(updates).toEqual(
      expect.objectContaining({
        taskPrefix: null,
      }),
    );
    // JSON wire format must retain the key; undefined would drop it and skip the clear.
    expect(JSON.stringify(updates)).toContain('"taskPrefix":null');
  });

  it("uppercases valid prefixes and rejects invalid characters before they enter form state", async () => {
    render(
      <ConfirmDialogProvider>
        <MissionManager isInline isOpen onClose={() => {}} addToast={vi.fn()} projectId={projectId} />
      </ConfirmDialogProvider>,
    );

    const listItem = (await screen.findByText("Prefixed Mission")).closest(".mission-list__item");
    fireEvent.click(listItem as HTMLElement);
    await waitFor(() => expect(mockFetchMission).toHaveBeenCalledWith("M-001", projectId));
    fireEvent.click(screen.getAllByRole("button", { name: "Edit mission" })[0]);

    const prefixInput = await screen.findByLabelText("Mission task prefix");
    fireEvent.change(prefixInput, { target: { value: "err2" } });
    expect(prefixInput).toHaveValue("ERR2");

    fireEvent.change(prefixInput, { target: { value: "1ERR" } });
    expect(prefixInput).toHaveValue("ERR2");

    fireEvent.change(prefixInput, { target: { value: "ERR-2" } });
    expect(prefixInput).toHaveValue("ERR2");

    fireEvent.change(prefixInput, { target: { value: "" } });
    expect(prefixInput).toHaveValue("");
  });
});
