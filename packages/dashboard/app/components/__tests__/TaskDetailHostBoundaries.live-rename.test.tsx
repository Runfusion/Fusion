import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { AppTaskPopoutWindows } from "../TaskDetailHostBoundaries";

/*
FNXC:TaskWindowIdentity 2026-09-15-03:29:
FN-404 : la dérive d'instantané corrigée pour Chat (FN-396) et pour les Notes n'existe pas côté tâches, et ce test la
verrouille. `AppTaskPopoutWindows` refusionne l'instantané d'ouverture avec la ligne vivante à chaque rendu
(`mergeTaskSnapshot`), et la fenêtre n'a pas de titre nominatif : son nom accessible est la chaîne localisée statique
`taskDetail.accessibleName`. Un renommage effectué ailleurs atteint donc le contenu sans nouvel appel `popOut` et sans
avancer `focusNonce`. Le contenu Task Detail est remplacé par un double léger : la surface prouvée ici est la fusion
propriétaire de l'hôte, pas le rendu interne de Task Detail.
*/
vi.mock("../TaskDetailModal", () => ({
  TaskDetailContent: ({ task }: { task: Task }) => <output data-testid="popout-task-title">{task.title}</output>,
  TaskDetailModal: () => null,
}));

const task = (overrides: Partial<Task>): Task => ({
  id: "FN-404",
  title: "Ancien nom",
  description: "",
  column: "todo",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
} as Task);

describe("AppTaskPopoutWindows live rename", () => {
  it("rend le titre vivant sans nouvel appel popOut ni changement de focusNonce", () => {
    const snapshot = task({});
    const entries = [{ task: snapshot, focusNonce: 1 }];
    const renamed = task({ title: "Nouveau nom", updatedAt: "2026-01-02T00:00:00.000Z" });
    const windowProps = { onDeleteTask: vi.fn(), onMergeTask: vi.fn(), onOpenDetail: vi.fn(), addToast: vi.fn() } as never;

    const view = render(<AppTaskPopoutWindows entries={entries} liveTasks={[snapshot]} onCloseTask={vi.fn()} windowProps={windowProps} />);
    expect(screen.getByTestId("popout-task-title")).toHaveTextContent("Ancien nom");

    view.rerender(<AppTaskPopoutWindows entries={entries} liveTasks={[renamed]} onCloseTask={vi.fn()} windowProps={windowProps} />);

    expect(screen.getByTestId("popout-task-title")).toHaveTextContent("Nouveau nom");
    // L'entrée détenue par usePoppedOutTasks est inchangée : ni l'instantané ni le nonce de focus n'ont bougé.
    expect(entries[0]).toEqual({ task: snapshot, focusNonce: 1 });
    expect(entries[0].task.title).toBe("Ancien nom");
  });

  it("garde un nom accessible statique, donc aucun titre nominatif ne peut dériver", () => {
    const snapshot = task({});
    const windowProps = { onDeleteTask: vi.fn(), onMergeTask: vi.fn(), onOpenDetail: vi.fn(), addToast: vi.fn() } as never;
    render(<AppTaskPopoutWindows entries={[{ task: snapshot, focusNonce: 1 }]} liveTasks={[task({ title: "Nouveau nom", updatedAt: "2026-01-02T00:00:00.000Z" })]} onCloseTask={vi.fn()} windowProps={windowProps} />);

    const overlay = screen.getByTestId("floating-window-overlay-task-detail-FN-404");
    expect(overlay).toHaveAttribute("aria-label", "Task detail");
    expect(overlay.getAttribute("aria-label")).not.toContain("nom");
  });
});
