import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissionManager } from "../MissionManager";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";

const mockViewportMode = vi.fn<() => "mobile" | "desktop">();
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
const mockDeleteMission = vi.fn();
const mockSubscribeSse = vi.fn(() => vi.fn());

vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  getViewportMode: () => mockViewportMode(),
  isMobileViewport: () => mockViewportMode() === "mobile",
  useViewportMode: () => mockViewportMode(),
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
    deleteMission: (...args: unknown[]) => mockDeleteMission(...args),
    fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  };
});

const projectId = "project-1";

const missions = [
  {
    id: "M-001",
    title: "Build Auth System",
    description: "Complete authentication flow",
    status: "planning",
    interviewState: "not_started",
    milestones: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "M-002",
    title: "API Redesign",
    description: "Redesign the REST API",
    status: "active",
    interviewState: "not_started",
    milestones: [],
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
];

const missionDetails = new Map([
  [
    "M-001",
    {
      id: "M-001",
      title: "Build Auth System",
      description: "Complete authentication flow",
      status: "planning",
      milestones: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  [
    "M-002",
    {
      id: "M-002",
      title: "API Redesign",
      description: "Redesign the REST API",
      status: "active",
      milestones: [],
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  ],
]);

function setupMocks() {
  mockFetchMissions.mockResolvedValue(missions);
  mockFetchMission.mockImplementation(async (missionId: string) => missionDetails.get(missionId));
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
  mockDeleteMission.mockResolvedValue(undefined);
}

function renderMissionManager(addToast = vi.fn()) {
  const result = render(
    <ConfirmDialogProvider>
      <MissionManager isInline isOpen onClose={() => {}} addToast={addToast} projectId={projectId} />
    </ConfirmDialogProvider>,
  );
  return { ...result, addToast };
}

async function findMissionListItem(title: string): Promise<HTMLElement> {
  const titleNode = await screen.findByText(title);
  const item = titleNode.closest(".mission-list__item");
  expect(item).not.toBeNull();
  return item as HTMLElement;
}

async function openListDeleteDialog(title: string, container: HTMLElement) {
  const item = await findMissionListItem(title);
  fireEvent.click(within(item).getByRole("button", { name: "Delete mission" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete mission" });
  expect(dialog).toHaveTextContent("Delete this mission? This cannot be undone.");
  expect(container.querySelector(".mission-confirm-panel")).toBeNull();
  return dialog;
}

describe("MissionManager mission delete confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockViewportMode.mockReturnValue("desktop");
    setupMocks();
  });

  it("opens a modal for desktop list deletes and cancel leaves the mission untouched", async () => {
    const { container } = renderMissionManager();

    const dialog = await openListDeleteDialog("API Redesign", container);

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Delete mission" })).not.toBeInTheDocument();
    });
    expect(mockDeleteMission).not.toHaveBeenCalled();
    expect(screen.getByText("API Redesign")).toBeInTheDocument();
  });

  it("confirms desktop selected-detail deletes through the modal and refreshes missions", async () => {
    const addToast = vi.fn();
    renderMissionManager(addToast);

    await waitFor(() => {
      expect(mockFetchMission).toHaveBeenCalledWith("M-001", projectId);
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Delete mission" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "Delete mission" });
    expect(document.querySelector(".mission-confirm-panel")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(mockDeleteMission).toHaveBeenCalledWith("M-001", projectId);
    });
    expect(addToast).toHaveBeenCalledWith("Mission deleted", "success");
    expect(mockFetchMissions).toHaveBeenCalledTimes(2);
  });

  it("confirms mobile stacked detail deletes through the modal", async () => {
    mockViewportMode.mockReturnValue("mobile");
    renderMissionManager();

    const item = await findMissionListItem("Build Auth System");
    fireEvent.click(item);
    await waitFor(() => {
      expect(mockFetchMission).toHaveBeenCalledWith("M-001", projectId);
    });

    await waitFor(() => {
      expect(document.querySelector('button[title="Delete mission"]')).toBeInTheDocument();
    });
    fireEvent.click(document.querySelector('button[title="Delete mission"]') as HTMLButtonElement);
    const dialog = await screen.findByRole("dialog", { name: "Delete mission" });
    expect(document.querySelector(".mission-confirm-panel")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(mockDeleteMission).toHaveBeenCalledWith("M-001", projectId);
    });
  });

  it("keeps the mission visible and emits an error toast when modal-confirmed delete fails", async () => {
    const addToast = vi.fn();
    mockDeleteMission.mockRejectedValueOnce(new Error("delete failed upstream"));
    const { container } = renderMissionManager(addToast);

    const dialog = await openListDeleteDialog("API Redesign", container);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(mockDeleteMission).toHaveBeenCalledWith("M-002", projectId);
    });
    expect(screen.getByText("API Redesign")).toBeInTheDocument();
    expect(addToast).toHaveBeenCalledWith("delete failed upstream", "error");
  });
});
