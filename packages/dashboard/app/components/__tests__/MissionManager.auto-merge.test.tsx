/*
FNXC:MissionAutoMerge 2026-07-18-12:00:
Mission edits need an explicit inherited state: the client must send null rather than
undefined so JSON serialization clears an existing mission auto-merge override.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function setViewport({ width, mobile = false }: { width: number; mobile?: boolean }) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: mobile && query.includes("max-width"),
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

function setDesktopViewport() {
  setViewport({ width: 1440 });
}

function setMobileViewport() {
  setViewport({ width: 390, mobile: true });
}

async function openDetailEditForm(autoMerge?: boolean) {
  const detail = mission(autoMerge);
  mockFetchMissions.mockResolvedValue([detail]);
  mockFetchMission.mockResolvedValue(detail);
  render(<MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} projectId="project-1" />);
  fireEvent.click(await screen.findByText("Single PR Mission"));
  const editButtons = await screen.findAllByRole("button", { name: "Edit mission" });
  fireEvent.click(editButtons[0]!);
  return screen.getByLabelText("Mission auto-merge override") as HTMLSelectElement;
}

function expectMergeGuidance(form: HTMLElement) {
  expect(within(form).getByText(/Inherited follows the project setting/i)).toBeInTheDocument();
  expect(within(form).getByText(/Auto-merge lands each feature as it passes/i)).toBeInTheDocument();
  expect(within(form).getByText(/Single pull request keeps every feature on one shared branch/i)).toBeInTheDocument();
}

function getMissionForm(control: HTMLElement) {
  const form = control.closest(".mission-form-card");
  if (!form) throw new Error("Mission merge behavior control must be rendered in its production form card");
  return form;
}

async function findManualMissionCreateLink() {
  return waitFor(() => {
    const link = document.querySelector<HTMLAnchorElement>(".mission-list__manual-create-link");
    if (!link) throw new Error("Production mission list must expose manual creation beside planning");
    return link;
  });
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

  it("renders complete merge guidance in the selected mission detail edit form", async () => {
    const detailControl = await openDetailEditForm();
    expect(detailControl.value).toBe("inherit");
    expectMergeGuidance(getMissionForm(detailControl));
  });

  it.each([
    [undefined, "inherit"],
    [true, "on"],
    [false, "off"],
  ] as const)("renders complete merge guidance in the list edit form for %s", async (autoMerge, expected) => {
    const selected = mission(true);
    const listEdited = { ...mission(autoMerge), id: "M-002", title: "List Edit Mission" };
    mockFetchMissions.mockResolvedValue([selected, listEdited]);
    mockFetchMission.mockImplementation((id: string) => Promise.resolve(id === selected.id ? selected : listEdited));

    render(<MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} projectId="project-1" />);
    fireEvent.click(await screen.findByText("Single PR Mission"));
    const listItem = screen.getByText("List Edit Mission").closest(".mission-list__item");
    if (!listItem) throw new Error("List edit mission row must be rendered");
    fireEvent.click(within(listItem).getByRole("button", { name: "Edit mission" }));

    const listControl = await screen.findByLabelText("Mission auto-merge override") as HTMLSelectElement;
    expect(listControl.value).toBe(expected);
    expectMergeGuidance(getMissionForm(listControl));
  });

  it("renders complete merge guidance in the production list create form", async () => {
    mockFetchMissions.mockResolvedValue([mission()]);

    render(<MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} projectId="project-1" />);

    fireEvent.click(await findManualMissionCreateLink());
    const control = await screen.findByLabelText("Mission auto-merge override") as HTMLSelectElement;
    expect(control.value).toBe("inherit");
    expectMergeGuidance(getMissionForm(control));

    fireEvent.change(control, { target: { value: "on" } });
    expect(control.value).toBe("on");
    expectMergeGuidance(getMissionForm(control));

    fireEvent.change(control, { target: { value: "off" } });
    expect(control.value).toBe("off");
    expectMergeGuidance(getMissionForm(control));
  });

  it("keeps create guidance and the owned shared branch summary visible in the mobile presentation", async () => {
    setMobileViewport();
    const detail = {
      ...mission(false),
      milestones: [{ id: "MS-001", title: "Milestone", status: "planning", createdAt: now, updatedAt: now, slices: [{ id: "SL-001", title: "Slice", status: "pending", createdAt: now, updatedAt: now, features: [{ id: "F-001", title: "Feature", taskId: "FN-001", status: "triaged", createdAt: now, updatedAt: now }] }] }],
    };
    mockFetchMissions.mockResolvedValue([detail]);
    mockFetchMission.mockResolvedValue(detail);
    mockFetchTaskDetail.mockResolvedValue({ id: "FN-001", branchContext: { source: "mission", groupId: "BG-001", assignmentMode: "shared" } });
    mockGetBranchGroup.mockResolvedValue({ group: {
      id: "BG-001", sourceType: "mission", sourceId: "M-001", branchName: "mission/mobile", autoMerge: false,
      prState: "open", status: "open", createdAt: 0, updatedAt: 0, members: [], completion: { landed: 0, total: 2, complete: false },
    } });

    const { unmount } = render(<MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} projectId="project-1" />);
    expect(screen.getByTestId("mission-manager-dialog").querySelector(".mission-manager__body--stacked")).not.toBeNull();
    await screen.findByText("Single PR Mission");
    fireEvent.click(await findManualMissionCreateLink());
    const createControl = await screen.findByLabelText("Mission auto-merge override") as HTMLSelectElement;
    expectMergeGuidance(getMissionForm(createControl));

    unmount();
    render(<MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} projectId="project-1" />);
    fireEvent.click(await screen.findByText("Single PR Mission"));
    const summary = await screen.findByTestId("mission-shared-branch-summary");
    expect(summary).toHaveTextContent("mission/mobile");
    expect(summary).toHaveTextContent("2 member");
    expect(summary).toHaveTextContent("open");
    expect(summary.querySelectorAll("button, a, input, select")).toHaveLength(0);
  });

  it("keeps Plan New Mission CTAs on the AI planning path", async () => {
    mockFetchMissions.mockResolvedValue([mission()]);

    render(<MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} projectId="project-1" />);
    const sidebarCreate = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(".mission-manager__sidebar-cta");
      if (!button) throw new Error("Mission sidebar planning CTA must be rendered");
      return button;
    });
    fireEvent.click(sidebarCreate);

    await waitFor(() => expect(screen.queryByLabelText("Mission auto-merge override")).toBeNull());
  });

  it.each([
    [undefined, "inherit"],
    [true, "on"],
    [false, "off"],
  ] as const)("reflects a %s mission override as %s with complete detail-edit guidance", async (autoMerge, expected) => {
    const control = await openDetailEditForm(autoMerge);
    expect(control.value).toBe(expected);
    expectMergeGuidance(getMissionForm(control));
  });

  it("sends null when an existing override is returned to inherited", async () => {
    const control = await openDetailEditForm(false);
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
    [
      "zero members without a pull request",
      { branchName: "mission/empty", memberCount: 0, prState: "none" },
      ["mission/empty", "0 member", "No PR"],
    ],
    [
      "one member with a merged pull request",
      { branchName: "mission/landed", memberCount: 1, prState: "merged" },
      ["mission/landed", "1 member", "merged"],
    ],
  ] as const)("shows %s in the read-only shared branch summary", async (_label, groupDetails, expectedText) => {
    const detail = {
      ...mission(false),
      milestones: [{ id: "MS-001", title: "Milestone", status: "planning", createdAt: now, updatedAt: now, slices: [{ id: "SL-001", title: "Slice", status: "pending", createdAt: now, updatedAt: now, features: [{ id: "F-001", title: "Feature", taskId: "FN-001", status: "triaged", createdAt: now, updatedAt: now }] }] }],
    };
    mockFetchMissions.mockResolvedValue([detail]);
    mockFetchMission.mockResolvedValue(detail);
    mockFetchTaskDetail.mockResolvedValue({ id: "FN-001", branchContext: { source: "mission", groupId: "BG-001", assignmentMode: "shared" } });
    mockGetBranchGroup.mockResolvedValue({ group: {
      id: "BG-001", sourceType: "mission", sourceId: "M-001", autoMerge: false,
      status: "open", createdAt: 0, updatedAt: 0, members: [], completion: { landed: 0, total: groupDetails.memberCount, complete: false },
      ...groupDetails,
    } });

    render(<MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} projectId="project-1" />);
    fireEvent.click(await screen.findByText("Single PR Mission"));
    const summary = await screen.findByTestId("mission-shared-branch-summary");
    expectedText.forEach((text) => expect(summary).toHaveTextContent(text));
    expect(summary.querySelectorAll("button, a, input, select")).toHaveLength(0);
  });

  it("skips unusable linked tasks and keeps scanning for an owned group", async () => {
    const detail = {
      ...mission(false),
      milestones: [{ id: "MS-001", title: "Milestone", status: "planning", createdAt: now, updatedAt: now, slices: [{ id: "SL-001", title: "Slice", status: "pending", createdAt: now, updatedAt: now, features: [
        { id: "F-001", title: "Missing task", taskId: "FN-missing", status: "triaged", createdAt: now, updatedAt: now },
        { id: "F-002", title: "Live task", taskId: "FN-live", status: "triaged", createdAt: now, updatedAt: now },
      ] }] }],
    };
    mockFetchMissions.mockResolvedValue([detail]);
    mockFetchMission.mockResolvedValue(detail);
    mockFetchTaskDetail.mockImplementation((id: string) => id === "FN-missing"
      ? Promise.reject(new Error("task deleted"))
      : Promise.resolve({ id, branchContext: { source: "mission", groupId: "BG-live", assignmentMode: "shared" } }));
    mockGetBranchGroup.mockResolvedValue({ group: {
      id: "BG-live", sourceType: "mission", sourceId: "M-001", branchName: "mission/live", autoMerge: false,
      prState: "open", status: "open", createdAt: 0, updatedAt: 0, members: [], completion: { landed: 0, total: 2, complete: false },
    } });

    render(<MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} projectId="project-1" />);
    fireEvent.click(await screen.findByText("Single PR Mission"));
    expect(await screen.findByTestId("mission-shared-branch-summary")).toHaveTextContent("mission/live");
    expect(mockGetBranchGroup).toHaveBeenCalledWith("BG-live", "project-1");
  });

  it("does not allow a delayed prior mission detail to overwrite the current detail", async () => {
    const first = mission(false);
    const second = { ...mission(false), id: "M-002", title: "Current Mission" };
    let resolveFirst!: (value: typeof first) => void;
    const delayedFirst = new Promise<typeof first>((resolve) => { resolveFirst = resolve; });
    mockFetchMissions.mockResolvedValue([first, second]);
    mockFetchMission.mockImplementation((id: string) => id === first.id ? delayedFirst : Promise.resolve(second));

    render(<MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} projectId="project-1" />);
    fireEvent.click(await screen.findByText("Single PR Mission"));
    fireEvent.click(await screen.findByText("Current Mission"));
    expect(await screen.findByRole("heading", { name: "Current Mission" })).toBeInTheDocument();

    resolveFirst(first);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Current Mission" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Single PR Mission" })).toBeNull();
  });

  it("does not allow a delayed detail request to reopen a mission after returning to the list", async () => {
    const detail = mission(false);
    let resolveRefresh!: (value: typeof detail) => void;
    const delayedRefresh = new Promise<typeof detail>((resolve) => { resolveRefresh = resolve; });
    mockFetchMissions.mockResolvedValue([detail]);
    mockFetchMission.mockResolvedValueOnce(detail).mockReturnValueOnce(delayedRefresh);

    render(<MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} projectId="project-1" />);
    fireEvent.click(await screen.findByText("Single PR Mission"));
    await screen.findByRole("heading", { name: "Single PR Mission" });
    fireEvent.click(screen.getByRole("button", { name: "Open mission Single PR Mission" }));
    fireEvent.click(screen.getByTestId("mission-back-btn"));

    resolveRefresh(detail);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Single PR Mission" })).toBeNull());
  });

  it("does not allow a delayed prior mission group to overwrite the current detail", async () => {
    const first = {
      ...mission(false),
      milestones: [{ id: "MS-001", title: "Milestone", status: "planning", createdAt: now, updatedAt: now, slices: [{ id: "SL-001", title: "Slice", status: "pending", createdAt: now, updatedAt: now, features: [{ id: "F-001", title: "First feature", taskId: "FN-first", status: "triaged", createdAt: now, updatedAt: now }] }] }],
    };
    const second = {
      ...mission(false), id: "M-002", title: "Current Mission",
      milestones: [{ id: "MS-002", title: "Milestone", status: "planning", createdAt: now, updatedAt: now, slices: [{ id: "SL-002", title: "Slice", status: "pending", createdAt: now, updatedAt: now, features: [{ id: "F-002", title: "Second feature", taskId: "FN-second", status: "triaged", createdAt: now, updatedAt: now }] }] }],
    };
    let resolveOldGroup!: (value: unknown) => void;
    const oldGroup = new Promise((resolve) => { resolveOldGroup = resolve; });
    mockFetchMissions.mockResolvedValue([first, second]);
    mockFetchMission.mockImplementation((id: string) => Promise.resolve(id === "M-001" ? first : second));
    mockFetchTaskDetail.mockImplementation((id: string) => Promise.resolve({
      id,
      branchContext: { source: "mission", groupId: id === "FN-first" ? "BG-first" : "BG-second", assignmentMode: "shared" },
    }));
    mockGetBranchGroup.mockImplementation((groupId: string) => groupId === "BG-first"
      ? oldGroup
      : Promise.resolve({ group: {
        id: "BG-second", sourceType: "mission", sourceId: "M-002", branchName: "mission/current", autoMerge: false,
        prState: "open", status: "open", createdAt: 0, updatedAt: 0, members: [], completion: { landed: 0, total: 1, complete: false },
      } }));

    render(<MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} projectId="project-1" />);
    fireEvent.click(await screen.findByText("Single PR Mission"));
    await waitFor(() => expect(mockGetBranchGroup).toHaveBeenCalledWith("BG-first", "project-1"));
    fireEvent.click(screen.getByText("Current Mission"));
    expect(await screen.findByTestId("mission-shared-branch-summary")).toHaveTextContent("mission/current");

    resolveOldGroup({ group: {
      id: "BG-first", sourceType: "mission", sourceId: "M-001", branchName: "mission/stale", autoMerge: false,
      prState: "closed", status: "closed", createdAt: 0, updatedAt: 0, members: [], completion: { landed: 0, total: 4, complete: false },
    } });
    await waitFor(() => expect(screen.getByTestId("mission-shared-branch-summary")).toHaveTextContent("mission/current"));
    expect(screen.getByTestId("mission-shared-branch-summary")).not.toHaveTextContent("mission/stale");
  });

  it.each([
    ["on", true],
    ["off", false],
  ] as const)("sends %s as an explicit %s override", async (selection, expected) => {
    const control = await openDetailEditForm();
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
