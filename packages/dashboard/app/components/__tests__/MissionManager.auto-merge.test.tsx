/*
FNXC:MissionAutoMerge 2026-07-18-12:00:
Mission edits need an explicit inherited state: the client must send null rather than
undefined so JSON serialization clears an existing mission auto-merge override.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MissionManager } from "../MissionManager";

const mockFetchMissions = vi.fn();
const mockFetchMission = vi.fn();
const mockFetchMissionsHealth = vi.fn();
const mockFetchAiSessions = vi.fn();
const mockFetchMissionInterviewDrafts = vi.fn();
const mockUpdateMission = vi.fn();
const mockFetchTaskDetail = vi.fn();
const mockGetBranchGroup = vi.fn();

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
    fetchMissions: (...args: unknown[]) => mockFetchMissions(...args),
    fetchMission: (...args: unknown[]) => mockFetchMission(...args),
    fetchMissionsHealth: (...args: unknown[]) => mockFetchMissionsHealth(...args),
    fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    fetchMissionInterviewDrafts: (...args: unknown[]) => mockFetchMissionInterviewDrafts(...args),
    updateMission: (...args: unknown[]) => mockUpdateMission(...args),
    fetchTaskDetail: (...args: unknown[]) => mockFetchTaskDetail(...args),
    apiGetBranchGroup: (...args: unknown[]) => mockGetBranchGroup(...args),
  };
});

const now = "2026-07-18T12:00:00.000Z";

function mission(autoMerge?: boolean) {
  return {
    id: "M-001",
    title: "Single PR Mission",
    description: "",
    status: "planning",
    autoMerge,
    milestones: [],
    createdAt: now,
    updatedAt: now,
  };
}

function setDesktopViewport() {
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

async function openEditForm(autoMerge?: boolean) {
  const detail = mission(autoMerge);
  mockFetchMissions.mockResolvedValue([detail]);
  mockFetchMission.mockResolvedValue(detail);
  render(<MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} projectId="project-1" />);
  fireEvent.click(await screen.findByText("Single PR Mission"));
  const editButtons = await screen.findAllByRole("button", { name: "Edit mission" });
  fireEvent.click(editButtons[0]!);
  return screen.getByLabelText("Mission auto-merge override") as HTMLSelectElement;
}

describe("MissionManager auto-merge override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setDesktopViewport();
    mockFetchMissionsHealth.mockResolvedValue({});
    mockFetchAiSessions.mockResolvedValue([]);
    mockFetchMissionInterviewDrafts.mockResolvedValue([]);
    mockUpdateMission.mockResolvedValue(mission());
    mockFetchTaskDetail.mockResolvedValue({});
    mockGetBranchGroup.mockResolvedValue({ group: null });
  });

  it("renders merge behavior guidance in both mission edit forms", async () => {
    await openEditForm();
    expect(screen.getByText(/Single pull request keeps every feature/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const editButtons = screen.getAllByRole("button", { name: "Edit mission" });
    fireEvent.click(editButtons.at(-1)!);
    expect(screen.getByText(/Single pull request keeps every feature/i)).toBeInTheDocument();
  });

  it.each([
    [undefined, "inherit"],
    [true, "on"],
    [false, "off"],
  ] as const)("reflects a %s mission override as %s", async (autoMerge, expected) => {
    const control = await openEditForm(autoMerge);
    expect(control.value).toBe(expected);
  });

  it("sends null when an existing override is returned to inherited", async () => {
    const control = await openEditForm(false);
    fireEvent.change(control, { target: { value: "inherit" } });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => {
      expect(mockUpdateMission).toHaveBeenCalledWith(
        "M-001",
        expect.objectContaining({ autoMerge: null }),
        "project-1",
      );
    });
  });

  it("rejects a reused branch group owned by a different mission", async () => {
    const first = {
      ...mission(false),
      milestones: [{ id: "MS-001", title: "Milestone", status: "planning", createdAt: now, updatedAt: now, slices: [{ id: "SL-001", title: "Slice", status: "pending", createdAt: now, updatedAt: now, features: [{ id: "F-001", title: "Feature", taskId: "FN-001", status: "triaged", createdAt: now, updatedAt: now }] }] }],
    };
    const second = {
      ...mission(false), id: "M-002", title: "Collision Mission",
      milestones: [{ id: "MS-002", title: "Milestone", status: "planning", createdAt: now, updatedAt: now, slices: [{ id: "SL-002", title: "Slice", status: "pending", createdAt: now, updatedAt: now, features: [{ id: "F-002", title: "Feature", taskId: "FN-002", status: "triaged", createdAt: now, updatedAt: now }] }] }],
    };
    mockFetchMissions.mockResolvedValue([first, second]);
    mockFetchMission.mockImplementation((id: string) => Promise.resolve(id === "M-001" ? first : second));
    mockFetchTaskDetail.mockImplementation((id: string) => Promise.resolve({
      id,
      branchContext: { source: "mission", groupId: "BG-001", assignmentMode: "shared" },
    }));
    mockGetBranchGroup.mockResolvedValue({ group: {
      id: "BG-001", sourceType: "mission", sourceId: "M-001", branchName: "main", autoMerge: false,
      prState: "open", status: "open", createdAt: 0, updatedAt: 0, members: [], completion: { landed: 0, total: 2, complete: false },
    } });

    render(<MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} projectId="project-1" />);
    fireEvent.click(await screen.findByText("Collision Mission"));
    await waitFor(() => expect(mockGetBranchGroup).toHaveBeenCalledWith("BG-001", "project-1"));
    expect(screen.queryByTestId("mission-shared-branch-summary")).toBeNull();
  });

  it("shows the selected mission's owned branch group without an action button", async () => {
    const detail = {
      ...mission(false),
      milestones: [{ id: "MS-001", title: "Milestone", status: "planning", createdAt: now, updatedAt: now, slices: [{ id: "SL-001", title: "Slice", status: "pending", createdAt: now, updatedAt: now, features: [{ id: "F-001", title: "Feature", taskId: "FN-001", status: "triaged", createdAt: now, updatedAt: now }] }] }],
    };
    mockFetchMissions.mockResolvedValue([detail]);
    mockFetchMission.mockResolvedValue(detail);
    mockFetchTaskDetail.mockResolvedValue({ id: "FN-001", branchContext: { source: "mission", groupId: "BG-001", assignmentMode: "shared" } });
    mockGetBranchGroup.mockResolvedValue({ group: {
      id: "BG-001", sourceType: "mission", sourceId: "M-001", branchName: "main", autoMerge: false,
      prState: "open", status: "open", createdAt: 0, updatedAt: 0, members: [], completion: { landed: 0, total: 2, complete: false },
    } });

    render(<MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} projectId="project-1" />);
    fireEvent.click(await screen.findByText("Single PR Mission"));
    const summary = await screen.findByTestId("mission-shared-branch-summary");
    expect(summary).toHaveTextContent("main");
    expect(summary).toHaveTextContent("2 member");
    expect(summary).toHaveTextContent("open");
    expect(summary.querySelector("button")).toBeNull();
  });

  it.each([
    ["on", true],
    ["off", false],
  ] as const)("sends %s as an explicit %s override", async (selection, expected) => {
    const control = await openEditForm();
    fireEvent.change(control, { target: { value: selection } });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => {
      expect(mockUpdateMission).toHaveBeenCalledWith(
        "M-001",
        expect.objectContaining({ autoMerge: expected }),
        "project-1",
      );
    });
  });
});
