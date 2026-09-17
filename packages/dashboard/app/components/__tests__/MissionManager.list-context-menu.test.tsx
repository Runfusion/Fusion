import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MissionManager } from "../MissionManager";
import { LIST_ITEM_LONG_PRESS_DELAY_MS, LIST_ITEM_ROW_ATTRIBUTE } from "../../utils/listItemGesture";

/*
FNXC:MissionRowActions 2026-09-17-03:18:
FN-486 : les commandes de la collection principale Missions (Démarrer, Arrêter, Reprendre, Effacer le badge
bloqué, accès aux échecs, Modifier, Supprimer) et celles des brouillons d'entretien (Reprendre/Réessayer/Revoir,
Abandonner) sont servies par le menu contextuel de LEUR ligne. Ces cas prouvent les conditions par état, la
désactivation conservée, l'identité de la cible (jamais la sélection courante) et l'absence d'effet du seul geste.
*/

const fetchMissions = vi.fn();
const fetchMission = vi.fn();
const fetchMissionsHealth = vi.fn();
const fetchMissionInterviewDrafts = vi.fn();
const startMission = vi.fn();
const stopMission = vi.fn();
const resumeMission = vi.fn();
const clearMissionBlockedStatus = vi.fn();

vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../hooks/useNavigationHistory")>(),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => {}) }));
vi.mock("../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api")>(),
  fetchMissions: (...args: unknown[]) => fetchMissions(...args),
  fetchMission: (...args: unknown[]) => fetchMission(...args),
  fetchMissionsHealth: (...args: unknown[]) => fetchMissionsHealth(...args),
  fetchMissionInterviewDrafts: (...args: unknown[]) => fetchMissionInterviewDrafts(...args),
  startMission: (...args: unknown[]) => startMission(...args),
  stopMission: (...args: unknown[]) => stopMission(...args),
  resumeMission: (...args: unknown[]) => resumeMission(...args),
  clearMissionBlockedStatus: (...args: unknown[]) => clearMissionBlockedStatus(...args),
}));

const base = {
  description: "", interviewState: "completed", autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive",
  createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z", milestones: [],
  summary: { totalMilestones: 0, totalFeatures: 0, completedMilestones: 0, completedFeatures: 0, progressPercent: 0 },
};

function mission(id: string, title: string, status: string) {
  return { ...base, id, title, status };
}

function draft(id: string, title: string, status: string) {
  return { id, title, status, projectId: "P-1", updatedAt: "2026-09-17T00:00:00.000Z" };
}

function renderMissions() {
  return render(<MissionManager isOpen isInline onClose={() => {}} addToast={() => {}} projectId="P-1" />);
}

async function rowFor(title: string): Promise<HTMLElement> {
  const label = await screen.findByText(title);
  return label.closest(".mission-list__item") as HTMLElement;
}

function openMenu(row: HTMLElement): HTMLElement {
  fireEvent.contextMenu(row, { clientX: 20, clientY: 20 });
  return screen.getByTestId("mission-row-context-menu");
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  fetchMissions.mockResolvedValue([
    mission("M-plan", "Planning mission", "planning"),
    mission("M-active", "Active mission", "active"),
    mission("M-blocked", "Blocked mission", "blocked"),
    mission("M-complete", "Complete mission", "complete"),
  ]);
  fetchMission.mockImplementation((id: string) => Promise.resolve(mission(id, id, "planning")));
  fetchMissionsHealth.mockResolvedValue({ "M-active": { missionId: "M-active", totalTasks: 4, tasksCompleted: 1, tasksFailed: 2, tasksInFlight: 1, estimatedCompletionPercent: 25 } });
  fetchMissionInterviewDrafts.mockResolvedValue([
    draft("D-awaiting", "Awaiting draft", "awaiting_input"),
    draft("D-generating", "Generating draft", "generating"),
    draft("D-error", "Error draft", "error"),
    draft("D-complete", "Complete draft", "complete"),
  ]);
});

describe("MissionManager — menu contextuel de la collection principale", () => {
  it("qualifie chaque ligne pour le geste de fermeture et ne laisse aucune commande permanente", async () => {
    renderMissions();
    const row = await rowFor("Active mission");
    expect(row.getAttribute(LIST_ITEM_ROW_ATTRIBUTE)).toBe("true");
    expect(row.getAttribute("aria-haspopup")).toBe("menu");
    expect(within(row).queryByRole("button", { name: "Edit mission" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Delete mission" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Stop mission" })).toBeNull();
    expect(document.querySelector(".mission-manager__sidebar .mission-list__item-actions")).toBeNull();
  });

  it.each([
    ["Planning mission", "M-plan", ["start", "edit", "delete"], ["stop", "resume", "clear-blocked", "failures"]],
    ["Active mission", "M-active", ["stop", "failures", "edit", "delete"], ["start", "resume"]],
    ["Blocked mission", "M-blocked", ["resume", "clear-blocked", "edit", "delete"], ["start", "stop"]],
    ["Complete mission", "M-complete", ["edit", "delete"], ["start", "stop", "resume", "clear-blocked", "failures"]],
  ])("offre exactement les commandes admissibles pour %s", async (title, id, present, absent) => {
    renderMissions();
    await screen.findByTestId("mission-failed-M-active");
    const menu = openMenu(await rowFor(title));
    for (const action of present) expect(within(menu).getByTestId(`mission-menu-${action}-${id}`)).toBeInTheDocument();
    for (const action of absent) expect(within(menu).queryByTestId(`mission-menu-${action}-${id}`)).toBeNull();
  });

  it("agit sur la mission de la LIGNE même lorsqu'une autre mission est sélectionnée", async () => {
    renderMissions();
    fireEvent.click(await rowFor("Planning mission"));
    await waitFor(() => expect(fetchMission).toHaveBeenCalledWith("M-plan", "P-1"));

    fireEvent.click(within(openMenu(await rowFor("Active mission"))).getByTestId("mission-menu-stop-M-active"));
    await waitFor(() => expect(stopMission).toHaveBeenCalledWith("M-active", "P-1"));
    expect(stopMission).toHaveBeenCalledTimes(1);
  });

  it("démarre et reprend par le menu, sans toucher aux autres lignes", async () => {
    renderMissions();
    fireEvent.click(within(openMenu(await rowFor("Planning mission"))).getByTestId("mission-menu-start-M-plan"));
    await waitFor(() => expect(startMission).toHaveBeenCalledWith("M-plan", "P-1"));
    fireEvent.click(within(openMenu(await rowFor("Blocked mission"))).getByTestId("mission-menu-resume-M-blocked"));
    await waitFor(() => expect(resumeMission).toHaveBeenCalledWith("M-blocked", "P-1"));
    expect(stopMission).not.toHaveBeenCalled();
  });

  it("n'exécute rien au simple geste d'ouverture, ni lecture de mission ni mutation", async () => {
    renderMissions();
    const row = await rowFor("Active mission");
    openMenu(row);
    expect(fetchMission).not.toHaveBeenCalled();
    expect(startMission).not.toHaveBeenCalled();
    expect(stopMission).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(row);
    await waitFor(() => expect(fetchMission).toHaveBeenCalledWith("M-active", "P-1"));
  });

  it("ouvre le menu par appui long et annule le candidat quand le doigt se déplace", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderMissions();
      const row = await rowFor("Active mission");
      fireEvent.pointerDown(row, { pointerType: "touch", pointerId: 1, isPrimary: true, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(row, { pointerType: "touch", pointerId: 1, clientX: 10, clientY: 90 });
      act(() => { vi.advanceTimersByTime(LIST_ITEM_LONG_PRESS_DELAY_MS * 2); });
      expect(screen.queryByTestId("mission-row-context-menu")).toBeNull();

      fireEvent.pointerDown(row, { pointerType: "touch", pointerId: 2, isPrimary: true, clientX: 10, clientY: 10 });
      act(() => { vi.advanceTimersByTime(LIST_ITEM_LONG_PRESS_DELAY_MS); });
      expect(screen.getByTestId("mission-row-context-menu")).toBeInTheDocument();
      expect(fetchMission).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  /*
  FNXC:MissionRowActions 2026-09-17-04:36:
  FN-486 : les boutons secondaires de ligne ayant été retirés, le menu doit rester atteignable AU CLAVIER.
  Ces cas prouvent que la touche Menu et Shift+F10 ouvrent le menu de la ligne focalisée et qu'une action s'y
  exécute, sans qu'Entrée/Espace perde son ouverture de mission ou de brouillon.
  */
  it("ouvre le menu d'une mission à la touche Menu et y exécute une commande", async () => {
    renderMissions();
    const row = await rowFor("Active mission");
    row.focus();
    fireEvent.keyDown(row, { key: "ContextMenu" });
    const menu = screen.getByTestId("mission-row-context-menu");
    expect(fetchMission).not.toHaveBeenCalled();
    fireEvent.click(within(menu).getByTestId("mission-menu-stop-M-active"));
    await waitFor(() => expect(stopMission).toHaveBeenCalledWith("M-active", "P-1"));
  });

  it("ouvre le menu d'un brouillon à Shift+F10 sans déclencher la reprise", async () => {
    renderMissions();
    const row = await rowFor("Awaiting draft");
    row.focus();
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    expect(within(screen.getByTestId("mission-row-context-menu")).getByTestId("mission-draft-menu-discard-D-awaiting")).toBeInTheDocument();
  });

  it("conserve l'activation Entrée et Espace des lignes", async () => {
    renderMissions();
    const missionRow = await rowFor("Active mission");
    missionRow.focus();
    fireEvent.keyDown(missionRow, { key: "Enter" });
    await waitFor(() => expect(fetchMission).toHaveBeenCalledWith("M-active", "P-1"));

    const draftRow = await rowFor("Awaiting draft");
    draftRow.focus();
    fireEvent.keyDown(draftRow, { key: " " });
    expect(screen.queryByTestId("mission-row-context-menu")).toBeNull();
  });

  it.each([
    ["Awaiting draft", "D-awaiting", "Resume interview", false],
    ["Error draft", "D-error", "Retry interview", false],
    ["Complete draft", "D-complete", "Review plan", false],
    ["Generating draft", "D-generating", "Generating plan", true],
  ])("offre la bonne commande de reprise pour le brouillon %s", async (title, id, label, disabled) => {
    renderMissions();
    const menu = openMenu(await rowFor(title));
    const resume = within(menu).getByTestId(`mission-draft-menu-resume-${id}`);
    expect(resume).toHaveTextContent(label);
    expect((resume as HTMLButtonElement).disabled).toBe(disabled);
    expect(within(menu).getByTestId(`mission-draft-menu-discard-${id}`)).toBeInTheDocument();
    expect(within(menu).queryByText("Edit mission")).toBeNull();
  });
});
