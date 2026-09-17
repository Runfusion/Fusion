import type { PoppedOutNoteEntry } from "../hooks/usePoppedOutNotes";
import { NotesView } from "./NotesView";

export interface PoppedOutNoteWindowsProps {
  entries: PoppedOutNoteEntry[];
  projectId: string;
  addToast: (message: string, type?: "success" | "error" | "info" | "warning") => void;
  onClose: (projectId: string, noteId: string) => void;
  onChanged?: () => void;
  registerGuard?: (projectId: string, noteId: string, guard: () => boolean | Promise<boolean>, onAccepted?: () => void) => () => void;
}

/*
FNXC:ProjectNotes 2026-09-15-03:29:
FN-404 : `dedicatedNoteId` reste l’identité de montage et de `windowKey` ; `dedicatedNote` transporte en plus
l’instantané VIVANT tenu à jour par `usePoppedOutNotes.syncNote`. Un renommage externe atteint ainsi la fenêtre en
place, sans la remonter au premier plan et sans écraser un brouillon sale.
*/
export function PoppedOutNoteWindows({ entries, projectId, addToast, onClose, onChanged, registerGuard }: PoppedOutNoteWindowsProps) {
  return entries.filter((entry) => entry.projectId === projectId).map((entry) => (
    <NotesView
      key={`${entry.projectId}:${entry.note.id}`}
      projectId={entry.projectId}
      addToast={addToast}
      dedicatedNoteId={entry.note.id}
      dedicatedNote={entry.note}
      onChanged={onChanged}
      floating={{
        onClose: () => onClose(entry.projectId, entry.note.id),
        raiseToFrontSignal: entry.focusNonce,
        registerGuard: registerGuard ? (guard, onAccepted) => registerGuard(entry.projectId, entry.note.id, guard, onAccepted) : undefined,
      }}
    />
  ));
}
