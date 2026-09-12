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

export function PoppedOutNoteWindows({ entries, projectId, addToast, onClose, onChanged, registerGuard }: PoppedOutNoteWindowsProps) {
  return entries.filter((entry) => entry.projectId === projectId).map((entry) => (
    <NotesView
      key={`${entry.projectId}:${entry.note.id}`}
      projectId={entry.projectId}
      addToast={addToast}
      dedicatedNoteId={entry.note.id}
      onChanged={onChanged}
      floating={{
        onClose: () => onClose(entry.projectId, entry.note.id),
        raiseToFrontSignal: entry.focusNonce,
        cascadeSlot: entry.cascadeSlot,
        registerGuard: registerGuard ? (guard, onAccepted) => registerGuard(entry.projectId, entry.note.id, guard, onAccepted) : undefined,
      }}
    />
  ));
}
