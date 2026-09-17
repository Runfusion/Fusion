/*
FNXC:StandardizedMissionLayout 2026-09-16-15:50:
FN-465 retire l'archivage des missions de l'interface opérateur. Contrôle négatif : plus de bascule
« Show archived »/« Hide archived », plus de barre de filtres de liste, une mission archivée n'est
jamais listée, et le statut « Archived » n'est plus une transition proposée dans les formulaires de
mission (il ne reste qu'une option désactivée affichant la valeur courante d'une mission déjà
archivée atteinte par lien profond). Vérifié sur desktop et sur mobile.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MissionManager } from "../MissionManager";

const mockFetchMissions = vi.fn();
const mockFetchMission = vi.fn();
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
    fetchMission: (...args: unknown[]) => mockFetchMission(...args),
    fetchMissionsHealth: (...args: unknown[]) => mockFetchMissionsHealth(...args),
    fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    fetchMissionInterviewDrafts: (...args: unknown[]) => mockFetchMissionInterviewDrafts(...args),
  };
});

const now = "2026-09-16T15:50:00.000Z";

function mission(overrides: Record<string, unknown> = {}) {
  return {
    id: "M-001",
    title: "Active Mission",
    description: "",
    status: "planning",
    milestones: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const archivedMission = mission({ id: "M-002", title: "Archived Mission", status: "archived" });

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

function renderManager(props: Partial<React.ComponentProps<typeof MissionManager>> = {}) {
  return render(<MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} projectId="project-1" {...props} />);
}

/** The mission form card hosts several selects; the status one is identified by its own option set. */
function getStatusSelect(form: HTMLElement): HTMLSelectElement {
  const select = within(form)
    .getAllByRole("combobox")
    .find((candidate) => Array.from((candidate as HTMLSelectElement).options).some((option) => option.value === "complete"));
  if (!select) throw new Error("mission status select not found");
  return select as HTMLSelectElement;
}

function expectNoArchiveAffordance() {
  expect(document.querySelector(".mission-list__filters")).toBeNull();
  expect(screen.queryByRole("button", { name: "Show archived" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Hide archived" })).toBeNull();
  for (const button of screen.queryAllByRole("button", { hidden: true })) {
    const accessibleName = `${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("title") ?? ""} ${button.textContent ?? ""}`;
    expect(accessibleName).not.toMatch(/archiv/i);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockFetchMissionsHealth.mockResolvedValue({});
  mockFetchAiSessions.mockResolvedValue([]);
  mockFetchMissionInterviewDrafts.mockResolvedValue([]);
  mockFetchMission.mockResolvedValue(null);
});

describe("MissionManager archive affordance removal (FN-465)", () => {
  it.each([
    { label: "desktop", width: 1440, mobile: false },
    { label: "mobile", width: 390, mobile: true },
  ])("renders no archive filter and never lists an archived mission on $label", async ({ width, mobile }) => {
    setViewport({ width, mobile });
    mockFetchMissions.mockResolvedValue([mission(), archivedMission]);
    renderManager();

    await screen.findByText("Active Mission");
    expect(screen.queryByText("Archived Mission")).toBeNull();
    expectNoArchiveAffordance();
  });

  it("leaves no archive control behind in the empty list state", async () => {
    setViewport({ width: 1440 });
    mockFetchMissions.mockResolvedValue([]);
    renderManager();

    await screen.findByText("No missions yet");
    expectNoArchiveAffordance();
  });

  it("offers no Archived status transition in the mission edit form", async () => {
    setViewport({ width: 1440 });
    mockFetchMissions.mockResolvedValue([mission()]);
    mockFetchMission.mockResolvedValue(mission());
    renderManager();

    fireEvent.click(await screen.findByText("Active Mission"));
    fireEvent.click((await screen.findAllByLabelText("Edit mission"))[0]);

    const form = await waitFor(() => {
      const card = document.querySelector(".mission-form-card");
      if (!card) throw new Error("mission edit form not rendered");
      return card as HTMLElement;
    });
    const statusSelect = getStatusSelect(form);
    expect(Array.from(statusSelect.options).map((option) => option.value)).toEqual([
      "planning",
      "active",
      "blocked",
      "complete",
    ]);
    expectNoArchiveAffordance();
  });

  it("shows the current status of an already-archived mission as a disabled option", async () => {
    setViewport({ width: 1440 });
    mockFetchMissions.mockResolvedValue([mission()]);
    mockFetchMission.mockResolvedValue(archivedMission);
    renderManager({ targetMissionId: archivedMission.id });

    await screen.findByText("Active Mission");
    // The deep-linked archived mission opens in the detail pane; its own Edit control owns that form.
    const detail = await waitFor(() => {
      const pane = document.querySelector(".mission-manager__detail-pane");
      if (!pane || !within(pane as HTMLElement).queryByLabelText("Edit mission")) throw new Error("mission detail not loaded");
      return pane as HTMLElement;
    });
    fireEvent.click(within(detail).getByLabelText("Edit mission"));

    const form = await waitFor(() => {
      const card = detail.querySelector(".mission-form-card");
      if (!card) throw new Error("mission edit form not rendered");
      return card as HTMLElement;
    });
    const statusSelect = getStatusSelect(form);
    const archivedOption = Array.from(statusSelect.options).find((option) => option.value === "archived");
    expect(archivedOption).toBeDefined();
    expect(archivedOption?.disabled).toBe(true);
    expect(statusSelect.value).toBe("archived");
  });
});
