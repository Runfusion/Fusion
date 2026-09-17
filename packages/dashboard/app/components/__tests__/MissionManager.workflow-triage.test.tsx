/*
FNXC:MissionWorkflows 2026-06-25-00:00:
MissionManager must include the active Missions header workflow in every UI triage entry point: preview-confirm, preview fallback, slice bulk triage, and no-selection omission.
*/

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MissionManager } from "../MissionManager";

const mockFetchMissions = vi.fn();
const mockFetchMission = vi.fn();
const mockFetchMissionsHealth = vi.fn();
const mockFetchAiSessions = vi.fn();
const mockFetchMissionInterviewDrafts = vi.fn();
const mockTriageFeature = vi.fn();
const mockTriageAllSliceFeatures = vi.fn();
const mockPreviewEnrichedDescription = vi.fn();
const mockApi = vi.fn();

vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    api: (...args: unknown[]) => mockApi(...args),
    fetchMissions: (...args: unknown[]) => mockFetchMissions(...args),
    fetchMission: (...args: unknown[]) => mockFetchMission(...args),
    fetchMissionsHealth: (...args: unknown[]) => mockFetchMissionsHealth(...args),
    fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    fetchMissionInterviewDrafts: (...args: unknown[]) => mockFetchMissionInterviewDrafts(...args),
    triageFeature: (...args: unknown[]) => mockTriageFeature(...args),
    triageAllSliceFeatures: (...args: unknown[]) => mockTriageAllSliceFeatures(...args),
    previewEnrichedDescription: (...args: unknown[]) => mockPreviewEnrichedDescription(...args),
  };
});

vi.mock("lucide-react", () => ({
  X: () => <span>X</span>,
  Plus: () => <span>+</span>,
  Pencil: () => <span>Pencil</span>,
  Trash2: () => <span>Trash</span>,
  ChevronRight: () => <span>ChevronRight</span>,
  ChevronDown: () => <span>ChevronDown</span>,
  ChevronLeft: () => <span>ChevronLeft</span>,
  Target: () => <span>Target</span>,
  Layers: () => <span>Layers</span>,
  Package: () => <span>Package</span>,
  Box: () => <span>Box</span>,
  Check: () => <span>Check</span>,
  Loader2: () => <span>Loader</span>,
  Link: () => <span>Link</span>,
  Unlink: () => <span>Unlink</span>,
  Play: () => <span>Play</span>,
  Square: () => <span>Square</span>,
  Sparkles: () => <span>Sparkles</span>,
  Zap: () => <span>Zap</span>,
  Activity: () => <span>Activity</span>,
  FileText: () => <span>FileText</span>,
  RefreshCw: () => <span>Refresh</span>,
}));

const now = "2026-06-25T00:00:00.000Z";

function missionDetail() {
  return {
    id: "M-001",
    title: "Mission One",
    description: "",
    status: "active",
    baseBranch: "main",
    linkedGoals: [],
    milestones: [
      {
        id: "MS-001",
        missionId: "M-001",
        title: "Milestone One",
        description: "",
        status: "active",
        slices: [
          {
            id: "SL-001",
            milestoneId: "MS-001",
            title: "Slice One",
            description: "",
            status: "active",
            features: [
              {
                id: "F-001",
                sliceId: "SL-001",
                title: "Feature One",
                description: "",
                status: "defined",
                createdAt: now,
                updatedAt: now,
              },
            ],
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

async function openMission(workflowId?: string | null) {
  render(<MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} projectId="project-a" workflowId={workflowId} />);
  fireEvent.click(await screen.findByText("Mission One"));
  await screen.findByText("Feature One");
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockFetchMissions.mockResolvedValue([
    { id: "M-001", title: "Mission One", description: "", status: "active", summary: { linkedGoalCount: 0 }, milestones: [] },
  ]);
  mockFetchMission.mockResolvedValue(missionDetail());
  mockFetchMissionsHealth.mockResolvedValue({});
  mockFetchAiSessions.mockResolvedValue([]);
  mockFetchMissionInterviewDrafts.mockResolvedValue([]);
  mockPreviewEnrichedDescription.mockResolvedValue({ description: "Enriched mission description" });
  mockTriageFeature.mockResolvedValue({ id: "F-001", taskId: "FN-001", status: "triaged" });
  mockTriageAllSliceFeatures.mockResolvedValue({ triaged: [{ id: "F-001", taskId: "FN-001" }], count: 1 });
});

/*
FNXC:MissionRowActions 2026-09-17-03:18:
FN-486 : le triage d'une feature et le triage groupé d'une slice s'ouvrent depuis le menu contextuel de leur
ligne. Le flux de prévisualisation, le repli direct et le passage de `workflowId` sont inchangés.
*/
function selectRowAction(rowSelector: string, index: number, testId: string) {
  const row = document.querySelectorAll(rowSelector)[index] as HTMLElement;
  fireEvent.contextMenu(row, { clientX: 12, clientY: 12 });
  fireEvent.click(within(screen.getByTestId("mission-row-context-menu")).getByTestId(testId));
}

describe("MissionManager workflow triage", () => {
  it("passes the selected workflow to preview-confirm feature triage", async () => {
    await openMission("wf-missions");

    selectRowAction(".mission-feature__header", 0, "feature-menu-triage-F-001");
    fireEvent.click(await screen.findByText("Create Task"));

    await waitFor(() => {
      expect(mockTriageFeature).toHaveBeenCalledWith("F-001", undefined, undefined, "project-a", {
        branchSelection: { mode: "project-default", baseBranch: "main" },
        workflowId: "wf-missions",
      });
    });
  });

  it("passes the selected workflow to direct fallback feature triage", async () => {
    mockPreviewEnrichedDescription.mockRejectedValueOnce(new Error("preview unavailable"));
    await openMission("wf-missions");

    selectRowAction(".mission-feature__header", 0, "feature-menu-triage-F-001");

    await waitFor(() => {
      expect(mockTriageFeature).toHaveBeenCalledWith("F-001", undefined, undefined, "project-a", {
        branchSelection: { mode: "project-default", baseBranch: "main" },
        workflowId: "wf-missions",
      });
    });
  });

  it("passes the selected workflow to slice bulk triage", async () => {
    await openMission("wf-missions");

    selectRowAction(".mission-slice__header", 0, "slice-menu-triage-all-SL-001");

    await waitFor(() => {
      expect(mockTriageAllSliceFeatures).toHaveBeenCalledWith("SL-001", "project-a", {
        branchSelection: { mode: "project-default", baseBranch: "main" },
        workflowId: "wf-missions",
      });
    });
  });

  it("omits workflowId from mission triage calls when no workflow is selected", async () => {
    await openMission(null);

    selectRowAction(".mission-slice__header", 0, "slice-menu-triage-all-SL-001");

    await waitFor(() => {
      expect(mockTriageAllSliceFeatures).toHaveBeenCalledWith("SL-001", "project-a", {
        branchSelection: { mode: "project-default", baseBranch: "main" },
      });
    });
  });
});
