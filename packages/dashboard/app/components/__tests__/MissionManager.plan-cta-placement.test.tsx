import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MissionManager } from "../MissionManager";

const mockFetchMissions = vi.fn();
const mockFetchMissionsHealth = vi.fn();
const mockFetchAiSessions = vi.fn();
const mockFetchMissionInterviewDrafts = vi.fn();

vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return { ...actual, useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) };
});

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchMissions: (...args: unknown[]) => mockFetchMissions(...args),
    fetchMissionsHealth: (...args: unknown[]) => mockFetchMissionsHealth(...args),
    fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    fetchMissionInterviewDrafts: (...args: unknown[]) => mockFetchMissionInterviewDrafts(...args),
  };
});

const now = "2026-08-16T14:48:00.000Z";
function mission(status: "planning" | "archived" = "planning") {
  return { id: status === "archived" ? "M-002" : "M-001", title: status === "archived" ? "Archived Mission" : "Header CTA Mission", description: "", status, milestones: [], createdAt: now, updatedAt: now };
}

function setViewport({ width, mobile = false }: { width: number; mobile?: boolean }) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: mobile && query.includes("max-width"), media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
}

function renderManager() {
  return render(<MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} projectId="project-1" />);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockFetchMissionsHealth.mockResolvedValue({});
  mockFetchAiSessions.mockResolvedValue([]);
  mockFetchMissionInterviewDrafts.mockResolvedValue([]);
});

describe("MissionManager canonical creation and archive controls", () => {
  it.each([
    { width: 1440, mobile: false },
    { width: 390, mobile: true },
  ])("renders one header-owned Plan New Mission action at $width px and opens the interview", async ({ width, mobile }) => {
    setViewport({ width, mobile });
    mockFetchMissions.mockResolvedValue([mission()]);
    renderManager();

    await screen.findByText("Header CTA Mission");
    const header = screen.getByRole("banner");
    expect(within(header).getAllByRole("button", { name: "Plan New Mission" })).toHaveLength(1);
    expect(within(screen.getByTestId("mission-sidebar")).queryByRole("button", { name: "Plan New Mission" })).toBeNull();

    fireEvent.click(within(header).getByRole("button", { name: "Plan New Mission" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Plan New Mission" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  });

  it("keeps the archive filter in the list and reveals archived missions on demand", async () => {
    setViewport({ width: 1440 });
    mockFetchMissions.mockResolvedValue([mission(), mission("archived")]);
    renderManager();

    await screen.findByText("Header CTA Mission");
    expect(screen.queryByText("Archived Mission")).toBeNull();
    const sidebar = screen.getByTestId("mission-sidebar");
    fireEvent.click(within(sidebar).getByRole("button", { name: "Show archived" }));
    expect(screen.getByText("Archived Mission")).toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: "Hide archived" })).toBeInTheDocument();
  });

  it("keeps a single header action in the empty list state", async () => {
    setViewport({ width: 390, mobile: true });
    mockFetchMissions.mockResolvedValue([]);
    renderManager();

    await screen.findByText("No missions yet");
    expect(screen.getAllByRole("button", { name: "Plan New Mission", hidden: true })).toHaveLength(1);
    expect(screen.getByTestId("mission-sidebar")).toContainElement(screen.getByRole("button", { name: "Show archived" }));
  });
});
