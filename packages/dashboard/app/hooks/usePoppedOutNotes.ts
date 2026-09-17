import { useCallback, useState } from "react";
import type { ProjectNoteSummary } from "@fusion/core";

export interface PoppedOutNoteEntry {
  projectId: string;
  note: ProjectNoteSummary;
  focusNonce: number;
}

/*
FNXC:ProjectNotes 2026-09-12-04:56:
Les fenêtres Notes sont identifiées par projet + note et réutilisent leur entrée avec un signal de focus croissant. FN-394 (2026-09-14-21:10) a retiré le slot de cascade propre aux Notes : la séparation des ouvertures appartient désormais à la cohorte partagée du gestionnaire de fenêtres, commune à tous les types. Une réactivation replace l’entrée en fin d’ordre d’activation afin qu’Escape ferme la fenêtre réellement au premier plan. Deux notes différentes restent montées dans deux propriétaires d’éditeur indépendants; une note homonyme d’un autre projet ne peut jamais être réutilisée.
*/

/*
FNXC:ProjectNotes 2026-09-15-03:29:
FN-404 : l’instantané capturé à l’ouverture n’est que la REQUÊTE qui a ouvert la fenêtre, jamais l’identité durable de la note. Tant que `popOut` en était l’unique écrivain, renommer une note ailleurs laissait la fenêtre détachée sur l’ancien nom. `syncNote` réécrit cet instantané en place depuis la source vivante, en laissant délibérément `focusNonce` et l’ordre d’activation intacts : avancer l’un remonterait la fenêtre au premier plan et volerait le focus alors que l’opérateur travaille ailleurs.
*/

/** Champs qu’une fenêtre détachée rend ou sur lesquels elle s’aligne ; un écho de ceux-ci n’est pas un changement d’état. */
function sameRenderedIdentity(a: ProjectNoteSummary, b: ProjectNoteSummary): boolean {
  return a.id === b.id && a.title === b.title && a.revision === b.revision && a.updatedAt === b.updatedAt;
}

export interface UsePoppedOutNotesResult {
  entries: PoppedOutNoteEntry[];
  popOut: (projectId: string, note: ProjectNoteSummary) => void;
  syncNote: (projectId: string, note: ProjectNoteSummary) => void;
  close: (projectId: string, noteId: string) => void;
  closeAll: () => void;
}

export function usePoppedOutNotes(): UsePoppedOutNotesResult {
  const [entries, setEntries] = useState<PoppedOutNoteEntry[]>([]);

  const popOut = useCallback((projectId: string, note: ProjectNoteSummary) => {
    setEntries((current) => {
      const index = current.findIndex((entry) => entry.projectId === projectId && entry.note.id === note.id);
      if (index >= 0) {
        const previous = current[index];
        const reactivated = { ...previous, note, focusNonce: previous.focusNonce + 1 };
        return [...current.slice(0, index), ...current.slice(index + 1), reactivated];
      }
      return [...current, { projectId, note, focusNonce: 1 }];
    });
  }, []);

  const syncNote = useCallback((projectId: string, note: ProjectNoteSummary) => {
    setEntries((current) => {
      const index = current.findIndex((entry) => entry.projectId === projectId && entry.note.id === note.id);
      if (index === -1 || sameRenderedIdentity(current[index].note, note)) return current;
      const refreshed = [...current];
      refreshed[index] = { ...refreshed[index], note };
      return refreshed;
    });
  }, []);

  const close = useCallback((projectId: string, noteId: string) => {
    setEntries((current) => current.filter((entry) => entry.projectId !== projectId || entry.note.id !== noteId));
  }, []);
  const closeAll = useCallback(() => setEntries([]), []);

  return { entries, popOut, syncNote, close, closeAll };
}
