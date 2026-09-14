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
export function usePoppedOutNotes() {
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

  const close = useCallback((projectId: string, noteId: string) => {
    setEntries((current) => current.filter((entry) => entry.projectId !== projectId || entry.note.id !== noteId));
  }, []);
  const closeAll = useCallback(() => setEntries([]), []);

  return { entries, popOut, close, closeAll };
}
