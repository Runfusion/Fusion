/*
FNXC:BoardWorkflowSelection 2026-09-16-23:24:
FN-483 : notification LOCALE et LÉGÈRE du choix de workflow de l'opérateur, scopée par projet.

Pourquoi elle existe : une fois qu'un seul sélecteur contextuel subsiste par en-tête (le Board de fond sur téléphone),
les autres consommateurs montés — List conservée, Graph, Planning/Missions, les métadonnées de pied de page d'App —
n'ont plus d'affordance pour suivre ce choix. Ils partagent déjà la préférence durable, mais celle-ci n'est relue qu'au
montage ou au changement de projet, si bien qu'une List déjà visitée restait sur l'ancienne lane.

Ce que ce module n'est PAS : un cache global de workflows ni un fournisseur partagé. Aucun payload n'y transite —
chaque instance de `useBoardWorkflows` garde ses propres fetch, SSE, annulation par séquence et état. Seule la valeur
brute choisie (identifiant réel, sentinel agrégé, ou `null`) est diffusée, exactement comme le fait déjà
`workflowSettingValuesEvents` pour une révision.

Invariants : la publication a lieu APRÈS commit (jamais depuis un updater React) ; les récepteurs ne réémettent rien,
n'écrivent pas le stockage et n'appellent pas le miroir serveur ; deux projets distincts — et le contexte sans
identifiant de projet — sont strictement isolés ; les événements répétés sont idempotents.
*/

export type BoardWorkflowSelectionValue = string | null;

type Listener = (selection: BoardWorkflowSelectionValue) => void;

const NO_PROJECT_SCOPE = "__no_project__";

const listenersByScope = new Map<string, Set<Listener>>();

export function getBoardWorkflowSelectionScope(projectId?: string): string {
  return projectId ?? NO_PROJECT_SCOPE;
}

/**
 * Subscribe to explicit operator workflow choices made for `projectId` by any other mounted consumer.
 * Returns an unsubscribe function; a project change or unmount must call it.
 */
export function subscribeBoardWorkflowSelection(projectId: string | undefined, listener: Listener): () => void {
  const scope = getBoardWorkflowSelectionScope(projectId);
  const listeners = listenersByScope.get(scope) ?? new Set<Listener>();
  listeners.add(listener);
  listenersByScope.set(scope, listeners);
  return () => {
    const current = listenersByScope.get(scope);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listenersByScope.delete(scope);
  };
}

/**
 * Publish an explicit operator workflow choice to the other consumers of the SAME project.
 *
 * Call it after commit only. A listener that throws must not prevent the remaining listeners from
 * observing the choice, and must never surface as a failure of the operator's lane switch.
 */
export function notifyBoardWorkflowSelectionChanged(projectId: string | undefined, selection: BoardWorkflowSelectionValue): void {
  const listeners = listenersByScope.get(getBoardWorkflowSelectionScope(projectId));
  if (!listeners || listeners.size === 0) return;
  for (const listener of [...listeners]) {
    try {
      listener(selection);
    } catch {
      // Best-effort local notification: a broken subscriber cannot break the operator's selection.
    }
  }
}

/** @internal Test helper */
export function __test_clearBoardWorkflowSelectionListeners(): void {
  listenersByScope.clear();
}
