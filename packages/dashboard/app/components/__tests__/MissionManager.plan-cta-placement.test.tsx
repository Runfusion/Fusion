import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const leftoverShells = ".mission-manager__sidebar-footer, .mission-list__footer, .mission-list__footer-actions, [data-testid='mission-sidebar-footer']";

function mission() {
  return { id: "M-001", title: "Top CTA Mission", description: "", status: "planning", milestones: [], createdAt: now, updatedAt: now };
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

describe("MissionManager Plan New Mission placement", () => {
  it("places the desktop CTA before a populated scrolling sidebar list and opens the interview", async () => {
    setViewport({ width: 1440 });
    mockFetchMissions.mockResolvedValue([mission()]);
    renderManager();

    await screen.findByText("Top CTA Mission");
    const sidebar = screen.getByTestId("mission-sidebar");
    const ctaBar = sidebar.querySelector(".mission-manager__sidebar-cta-bar");
    const list = sidebar.querySelector(".mission-manager__sidebar-list");
    expect(ctaBar?.compareDocumentPosition(list!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(document.querySelector(leftoverShells)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Plan New Mission/i, hidden: true }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  });

  it("places the mobile CTA before populated mission items without footer wrappers", async () => {
    setViewport({ width: 390, mobile: true });
    mockFetchMissions.mockResolvedValue([mission()]);
    renderManager();

    await screen.findByText("Top CTA Mission");
    const list = document.querySelector(".mission-list")!;
    expect(list.firstElementChild).toHaveClass("mission-list__header-actions");
    expect(list.querySelector(".mission-list__header-actions")?.compareDocumentPosition(list.querySelector(".mission-list__item")!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(document.querySelector(leftoverShells)).toBeNull();
  });

  it("renders one desktop empty-state CTA with no duplicate empty-state control", async () => {
    setViewport({ width: 1440 });
    mockFetchMissions.mockResolvedValue([]);
    renderManager();

    await screen.findByText("No missions yet");
    expect(screen.getAllByRole("button", { name: /Plan New Mission/i, hidden: true })).toHaveLength(1);
    expect(document.querySelector(".mission-manager__empty-cta")).toBeNull();
    expect(document.querySelector(leftoverShells)).toBeNull();
  });

  it("renders one mobile empty-state CTA with no duplicate empty-state control", async () => {
    setViewport({ width: 390, mobile: true });
    mockFetchMissions.mockResolvedValue([]);
    renderManager();

    await screen.findByText("No missions yet");
    expect(screen.getAllByRole("button", { name: /Plan New Mission/i, hidden: true })).toHaveLength(1);
    expect(document.querySelector(".mission-manager__empty-cta")).toBeNull();
    expect(document.querySelector(leftoverShells)).toBeNull();
  });

  it("suppresses the mobile CTA header cleanly while creating", async () => {
    setViewport({ width: 390, mobile: true });
    mockFetchMissions.mockResolvedValue([mission()]);
    renderManager();

    await screen.findByText("Top CTA Mission");
    fireEvent.click(document.querySelector<HTMLAnchorElement>(".mission-list__manual-create-link")!);
    await screen.findByLabelText("Mission auto-merge override");
    expect(screen.queryAllByRole("button", { name: /Plan New Mission/i, hidden: true })).toHaveLength(0);
    expect(document.querySelector(".mission-list__header-actions")).toBeNull();
    expect(document.querySelector(leftoverShells)).toBeNull();
  });

  it("suppresses the desktop CTA bar cleanly while creating and retains the list", async () => {
    setViewport({ width: 1440 });
    mockFetchMissions.mockResolvedValue([mission()]);
    renderManager();

    await screen.findByText("Top CTA Mission");
    fireEvent.click(document.querySelector<HTMLAnchorElement>(".mission-list__manual-create-link")!);
    await screen.findByLabelText("Mission auto-merge override");
    expect(screen.queryAllByRole("button", { name: /Plan New Mission/i, hidden: true })).toHaveLength(0);
    expect(document.querySelector(".mission-manager__sidebar-cta-bar")).toBeNull();
    expect(document.querySelector(".mission-manager__sidebar-list")).toBeInTheDocument();
    expect(document.querySelector(leftoverShells)).toBeNull();
  });

});
