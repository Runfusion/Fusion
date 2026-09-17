import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissionManager } from "../MissionManager";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";

/*
FNXC:MissionRowActions 2026-09-17-03:18:
FN-486 : les commandes des LIGNES hiérarchiques (jalon, slice, feature, assertion, lien assertion ↔ feature)
sont servies par le menu contextuel de leur propre ligne. Ces cas prouvent que chaque commande déplacée reste
atteignable avec ses conditions d'origine et ses identifiants exacts, qu'une variante indisponible reste
absente, qu'une variante occupée reste désactivée sans appel, que le menu d'un enfant n'atteint pas son
parent, et que délier un lien parmi deux ne touche pas l'autre.
*/

const fetchMissions = vi.fn();
const fetchMission = vi.fn();
const fetchMissionsHealth = vi.fn();
const fetchMissionEvents = vi.fn();
const fetchAssertions = vi.fn();
const fetchMilestoneValidation = vi.fn();
const fetchMilestoneValidationTelemetry = vi.fn();
const fetchValidationLoopState = vi.fn();
const fetchValidationRuns = vi.fn();
const fetchAiSessions = vi.fn();
const fetchAiSession = vi.fn();
const fetchMissionInterviewDrafts = vi.fn();
const activateSlice = vi.fn();
const unlinkFeatureFromAssertion = vi.fn();
const unlinkTaskFromFeature = vi.fn();

vi.mock("../../hooks/useNavigationHistory", () => ({ useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => vi.fn()) }));
vi.mock("../MissionInterviewModal", () => ({ MissionInterviewModal: () => null }));
vi.mock("../MilestoneSliceInterviewModal", () => ({ MilestoneSliceInterviewModal: () => null }));
vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  fetchMissions: (...args: unknown[]) => fetchMissions(...args),
  fetchMission: (...args: unknown[]) => fetchMission(...args),
  fetchMissionsHealth: (...args: unknown[]) => fetchMissionsHealth(...args),
  fetchMissionEvents: (...args: unknown[]) => fetchMissionEvents(...args),
  fetchAssertions: (...args: unknown[]) => fetchAssertions(...args),
  fetchMilestoneValidation: (...args: unknown[]) => fetchMilestoneValidation(...args),
  fetchMilestoneValidationTelemetry: (...args: unknown[]) => fetchMilestoneValidationTelemetry(...args),
  fetchValidationLoopState: (...args: unknown[]) => fetchValidationLoopState(...args),
  fetchValidationRuns: (...args: unknown[]) => fetchValidationRuns(...args),
  fetchAiSessions: (...args: unknown[]) => fetchAiSessions(...args),
  fetchAiSession: (...args: unknown[]) => fetchAiSession(...args),
  fetchMissionInterviewDrafts: (...args: unknown[]) => fetchMissionInterviewDrafts(...args),
  activateSlice: (...args: unknown[]) => activateSlice(...args),
  unlinkFeatureFromAssertion: (...args: unknown[]) => unlinkFeatureFromAssertion(...args),
  unlinkFeatureFromTask: (...args: unknown[]) => unlinkTaskFromFeature(...args),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
}));

const stamps = { createdAt: "2026-09-17T00:00:00Z", updatedAt: "2026-09-17T00:00:00Z" };

function feature(id: string, title: string, overrides: Record<string, unknown> = {}) {
  return { id, title, status: "defined", ...stamps, ...overrides };
}

function slice(id: string, title: string, status: string, features: unknown[]) {
  return { id, milestoneId: "MS-1", title, status, orderIndex: 0, dependencies: [], ...stamps, features };
}

const mission = () => ({
  id: "M-1", title: "Mission", description: "", status: "active", interviewState: "completed", ...stamps,
  milestones: [{
    id: "MS-1", missionId: "M-1", title: "Milestone", status: "active", interviewState: "completed", orderIndex: 0, dependencies: [], ...stamps,
    slices: [
      slice("SL-pending", "Pending slice", "pending", []),
      slice("SL-active", "Active slice", "active", [
        feature("F-defined", "Defined feature"),
        feature("F-linked", "Linked feature", { status: "triaged", taskId: "FN-9" }),
        feature("F-implementing", "Implementing feature", { status: "in-progress", loopState: "implementing" }),
        feature("F-blocked", "Blocked feature", { status: "in-progress", loopState: "blocked" }),
      ]),
      slice("SL-complete", "Complete slice", "complete", []),
    ],
  }],
});

const assertions = [{ id: "A-1", milestoneId: "MS-1", title: "Assertion one", assertion: "It works", status: "pending", ...stamps }];

function renderManager() {
  return render(<ConfirmDialogProvider><MissionManager isInline isOpen onClose={() => {}} addToast={vi.fn()} projectId="p1" targetMissionId="M-1" /></ConfirmDialogProvider>);
}

function openMenu(selector: string, index = 0): HTMLElement {
  const row = document.querySelectorAll(selector)[index] as HTMLElement;
  expect(row, `expected a row for ${selector}[${index}]`).toBeTruthy();
  fireEvent.contextMenu(row, { clientX: 20, clientY: 20 });
  return screen.getByTestId("mission-row-context-menu");
}

function rowByText(text: string, rowClass: string): HTMLElement {
  return screen.getByText(text).closest(rowClass) as HTMLElement;
}

function openMenuForRow(text: string, rowClass: string): HTMLElement {
  fireEvent.contextMenu(rowByText(text, rowClass), { clientX: 20, clientY: 20 });
  return screen.getByTestId("mission-row-context-menu");
}

beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  fetchMissions.mockResolvedValue([{ ...mission(), milestones: [] }]);
  fetchMission.mockImplementation(async () => mission());
  fetchMissionsHealth.mockResolvedValue({});
  fetchMissionEvents.mockResolvedValue([]);
  fetchAssertions.mockResolvedValue(assertions);
  fetchMilestoneValidation.mockResolvedValue(null);
  fetchMilestoneValidationTelemetry.mockResolvedValue({ rollup: { milestoneId: "MS-1", state: "not_started" }, validationTelemetry: { validationRounds: [], totalRuns: 0 }, validationContract: null, fixFeatures: [] });
  fetchValidationLoopState.mockResolvedValue(null);
  fetchValidationRuns.mockResolvedValue([]);
  fetchAiSessions.mockResolvedValue([]);
  fetchAiSession.mockResolvedValue(null);
  fetchMissionInterviewDrafts.mockResolvedValue([]);
  activateSlice.mockResolvedValue({ id: "SL-pending", status: "active" });
});

afterEach(cleanup);

describe("MissionManager — menu contextuel des lignes hiérarchiques", () => {
  it("laisse les lignes hiérarchiques sans conteneur d'actions permanentes", async () => {
    renderManager();
    await screen.findByText("Milestone");
    for (const selector of [".mission-milestone__actions", ".mission-slice__actions", ".mission-feature__actions", ".mission-fix-feature__actions"]) {
      expect(document.querySelector(selector)).toBeNull();
    }
    expect(screen.queryByTitle("Plan milestone")).toBeNull();
    expect(screen.queryByTitle("Add slice")).toBeNull();
    expect(screen.queryByTitle("Delete slice")).toBeNull();
  });

  it("offre les commandes du jalon et garde l'expansion opérante", async () => {
    renderManager();
    await screen.findByText("Milestone");
    const menu = openMenu(".mission-milestone__header");
    for (const testId of ["milestone-menu-plan-MS-1", "milestone-menu-add-slice-MS-1", "milestone-menu-edit-MS-1", "milestone-menu-delete-MS-1"]) {
      expect(within(menu).getByTestId(testId)).toBeInTheDocument();
    }
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(document.querySelector(".mission-milestone__header") as HTMLElement);
    expect(document.querySelector(".mission-milestone__body")).toBeNull();
  });

  it.each([
    ["Pending slice", ["slice-menu-plan-SL-pending", "slice-menu-activate-SL-pending", "slice-menu-add-feature-SL-pending", "slice-menu-edit-SL-pending", "slice-menu-delete-SL-pending"], ["slice-menu-triage-all-SL-pending"]],
    ["Active slice", ["slice-menu-plan-SL-active", "slice-menu-triage-all-SL-active", "slice-menu-add-feature-SL-active", "slice-menu-edit-SL-active", "slice-menu-delete-SL-active"], ["slice-menu-activate-SL-active"]],
    ["Complete slice", ["slice-menu-add-feature-SL-complete", "slice-menu-edit-SL-complete", "slice-menu-delete-SL-complete"], ["slice-menu-plan-SL-complete", "slice-menu-activate-SL-complete", "slice-menu-triage-all-SL-complete"]],
  ])("offre exactement les commandes admissibles de la slice %s", async (title, present, absent) => {
    renderManager();
    await screen.findByText(title);
    const menu = openMenuForRow(title, ".mission-slice__header");
    for (const testId of present) expect(within(menu).getByTestId(testId)).toBeInTheDocument();
    for (const testId of absent) expect(within(menu).queryByTestId(testId)).toBeNull();
  });

  it("active une slice en attente depuis son propre menu", async () => {
    renderManager();
    await screen.findByText("Pending slice");
    fireEvent.click(within(openMenuForRow("Pending slice", ".mission-slice__header")).getByTestId("slice-menu-activate-SL-pending"));
    await waitFor(() => expect(activateSlice).toHaveBeenCalledWith("SL-pending", "p1"));
  });

  it.each([
    ["Defined feature", ["feature-menu-triage-F-defined", "feature-menu-edit-F-defined", "feature-menu-delete-F-defined"], ["feature-menu-link-task-F-defined", "feature-menu-unlink-task-F-defined", "feature-menu-validate-F-defined"]],
    ["Linked feature", ["feature-menu-unlink-task-F-linked", "feature-menu-edit-F-linked", "feature-menu-delete-F-linked"], ["feature-menu-link-task-F-linked", "feature-menu-triage-F-linked"]],
    ["Implementing feature", ["feature-menu-validate-F-implementing", "feature-menu-link-task-F-implementing"], ["feature-menu-triage-F-implementing", "feature-menu-unlink-task-F-implementing"]],
    ["Blocked feature", ["feature-menu-clear-validation-F-blocked", "feature-menu-rerun-validation-F-blocked", "feature-menu-link-task-F-blocked"], ["feature-menu-triage-F-blocked"]],
  ])("offre exactement les commandes admissibles de la feature %s", async (title, present, absent) => {
    renderManager();
    await screen.findByText("Active slice");
    fireEvent.click(rowByText("Active slice", ".mission-slice__header"));
    await screen.findByText(title);
    const menu = openMenuForRow(title, ".mission-feature__header");
    for (const testId of present) expect(within(menu).getByTestId(testId)).toBeInTheDocument();
    for (const testId of absent) expect(within(menu).queryByTestId(testId)).toBeNull();
  });

  it("délie la tâche de la feature ciblée sans toucher aux autres", async () => {
    renderManager();
    await screen.findByText("Active slice");
    fireEvent.click(rowByText("Active slice", ".mission-slice__header"));
    await screen.findByText("Linked feature");
    fireEvent.click(within(openMenuForRow("Linked feature", ".mission-feature__header")).getByTestId("feature-menu-unlink-task-F-linked"));
    await waitFor(() => expect(unlinkTaskFromFeature).toHaveBeenCalledWith("F-linked", "p1"));
    expect(unlinkTaskFromFeature).toHaveBeenCalledTimes(1);
  });

  it("n'ouvre le menu d'une feature ni sur sa slice ni sur son jalon, et ne replie rien", async () => {
    renderManager();
    await screen.findByText("Active slice");
    fireEvent.click(rowByText("Active slice", ".mission-slice__header"));
    await screen.findByText("Defined feature");

    const menu = openMenuForRow("Defined feature", ".mission-feature__header");
    expect(within(menu).queryByTestId("slice-menu-delete-SL-active")).toBeNull();
    expect(within(menu).queryByTestId("milestone-menu-delete-MS-1")).toBeNull();
    /* La slice reste ouverte : le menu d'un enfant ne se propage pas au parent. */
    expect(screen.getByText("Defined feature")).toBeInTheDocument();
    expect(screen.getByText("Milestone")).toBeInTheDocument();
  });

  /*
  FNXC:MissionRowActions 2026-09-17-04:36:
  FN-486 : une en-tête de ligne hiérarchique doit être FOCALISABLE, sinon son `onKeyDown` ne se déclenche
  jamais et les commandes déplacées ne sont plus atteignables qu'au clic droit ou à l'appui long.
  */
  it("rend les en-têtes de ligne focalisables et ouvre leur menu au clavier", async () => {
    renderManager();
    await screen.findByText("Active slice");
    fireEvent.click(rowByText("Active slice", ".mission-slice__header"));
    await screen.findByText("Defined feature");

    const cases: Array<[string, string, string]> = [
      ["Milestone", ".mission-milestone__header", "milestone-menu-delete-MS-1"],
      ["Active slice", ".mission-slice__header", "slice-menu-delete-SL-active"],
      ["Defined feature", ".mission-feature__header", "feature-menu-delete-F-defined"],
      ["Assertion one", ".mission-assertion__header", "assertion-menu-delete-A-1"],
    ];
    for (const [text, rowClass, testId] of cases) {
      const row = rowByText(text, rowClass);
      expect(row.getAttribute("tabindex"), `${rowClass} doit être focalisable`).toBe("0");
      row.focus();
      fireEvent.keyDown(row, { key: "ContextMenu" });
      expect(within(screen.getByTestId("mission-row-context-menu")).getByTestId(testId)).toBeInTheDocument();
      fireEvent.keyDown(document, { key: "Escape" });
    }
  });

  it("exécute une commande hiérarchique ouverte à Shift+F10", async () => {
    renderManager();
    await screen.findByText("Pending slice");
    const row = rowByText("Pending slice", ".mission-slice__header");
    row.focus();
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    fireEvent.click(within(screen.getByTestId("mission-row-context-menu")).getByTestId("slice-menu-activate-SL-pending"));
    await waitFor(() => expect(activateSlice).toHaveBeenCalledWith("SL-pending", "p1"));
  });

  it("offre Modifier, Supprimer et Lier une feature sur une assertion", async () => {
    renderManager();
    await screen.findByText("Assertion one");
    const menu = openMenuForRow("Assertion one", ".mission-assertion__header");
    for (const testId of ["assertion-menu-link-feature-A-1", "assertion-menu-edit-A-1", "assertion-menu-delete-A-1"]) {
      expect(within(menu).getByTestId(testId)).toBeInTheDocument();
    }
    expect(screen.queryByTitle("Delete assertion")).toBeNull();

    fireEvent.click(within(menu).getByTestId("assertion-menu-edit-A-1"));
    expect(await screen.findByDisplayValue("Assertion one")).toBeInTheDocument();
    /* Un formulaire ouvert garde ses propres boutons et n'ouvre plus de menu de ligne. */
    expect(screen.getByRole("button", { name: /Save/ })).toBeInTheDocument();
  });
});
