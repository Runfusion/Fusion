import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __test_clearBoardWorkflowSelectionListeners,
  getBoardWorkflowSelectionScope,
  notifyBoardWorkflowSelectionChanged,
  subscribeBoardWorkflowSelection,
} from "../boardWorkflowSelectionEvents";

/*
FNXC:BoardWorkflowSelection 2026-09-16-23:24:
FN-483 : la notification locale du choix de workflow doit rester scopée par projet, idempotente, et incapable de
retenir un abonné démonté. Ces cas pinnent le contrat que `useBoardWorkflows` suppose.
*/
describe("boardWorkflowSelectionEvents", () => {
  beforeEach(() => {
    __test_clearBoardWorkflowSelectionListeners();
  });

  it("diffuse un choix à tous les abonnés du même projet", () => {
    const first = vi.fn();
    const second = vi.fn();
    subscribeBoardWorkflowSelection("p1", first);
    subscribeBoardWorkflowSelection("p1", second);

    notifyBoardWorkflowSelectionChanged("p1", "wf-b");

    expect(first).toHaveBeenCalledWith("wf-b");
    expect(second).toHaveBeenCalledWith("wf-b");
  });

  it("isole les projets distincts et le contexte sans projet", () => {
    const projectListener = vi.fn();
    const otherProjectListener = vi.fn();
    const noProjectListener = vi.fn();
    subscribeBoardWorkflowSelection("p1", projectListener);
    subscribeBoardWorkflowSelection("q1", otherProjectListener);
    subscribeBoardWorkflowSelection(undefined, noProjectListener);

    notifyBoardWorkflowSelectionChanged("p1", "wf-b");
    expect(otherProjectListener).not.toHaveBeenCalled();
    expect(noProjectListener).not.toHaveBeenCalled();

    notifyBoardWorkflowSelectionChanged(undefined, "wf-c");
    expect(noProjectListener).toHaveBeenCalledWith("wf-c");
    expect(projectListener).toHaveBeenCalledTimes(1);
    expect(getBoardWorkflowSelectionScope(undefined)).not.toBe(getBoardWorkflowSelectionScope("p1"));
  });

  it("répète un événement identique sans effet de bord supplémentaire", () => {
    const listener = vi.fn();
    subscribeBoardWorkflowSelection("p1", listener);

    notifyBoardWorkflowSelectionChanged("p1", "wf-b");
    notifyBoardWorkflowSelectionChanged("p1", "wf-b");

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, "wf-b");
    expect(listener).toHaveBeenNthCalledWith(2, "wf-b");
  });

  it("retire réellement un abonné désinscrit", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBoardWorkflowSelection("p1", listener);
    unsubscribe();
    unsubscribe();

    notifyBoardWorkflowSelectionChanged("p1", "wf-b");

    expect(listener).not.toHaveBeenCalled();
  });

  it("diffuse la sélection vide et le sentinel agrégé tels quels", () => {
    const listener = vi.fn();
    subscribeBoardWorkflowSelection("p1", listener);

    notifyBoardWorkflowSelectionChanged("p1", null);
    notifyBoardWorkflowSelectionChanged("p1", "__all_workflows__");

    expect(listener).toHaveBeenNthCalledWith(1, null);
    expect(listener).toHaveBeenNthCalledWith(2, "__all_workflows__");
  });

  it("continue de servir les autres abonnés quand l'un d'eux lève", () => {
    const failing = vi.fn(() => { throw new Error("subscriber boom"); });
    const healthy = vi.fn();
    subscribeBoardWorkflowSelection("p1", failing);
    subscribeBoardWorkflowSelection("p1", healthy);

    expect(() => notifyBoardWorkflowSelectionChanged("p1", "wf-b")).not.toThrow();
    expect(healthy).toHaveBeenCalledWith("wf-b");
  });

  it("ne fait rien quand aucun abonné n'existe pour ce projet", () => {
    expect(() => notifyBoardWorkflowSelectionChanged("p-inconnu", "wf-b")).not.toThrow();
  });
});
