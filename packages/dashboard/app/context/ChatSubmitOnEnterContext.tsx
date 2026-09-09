import { createContext, useContext, type ReactNode } from "react";
import { useCoarsePointer } from "../hooks/useCoarsePointer";

export type ChatSubmitOnEnterMode = "auto" | "always" | "never";

/*
FNXC:ChatComposer 2026-09-06-01:54:
Le mode automatique utilise `(hover: none) and (pointer: coarse)` plutôt que `isMobileViewport()` : une fenêtre de bureau redimensionnée à 768 px ou moins reste pilotée à la souris et doit conserver l’envoi par Entrée. Le résolveur pur sépare la politique du hook `matchMedia` afin que sa table de vérité reste vérifiable sans simuler le navigateur.

`Shift+Enter` n'envoie jamais, y compris combiné à `Cmd/Ctrl` : `Cmd/Ctrl+Shift+Enter` n'est pas un envoi. Elle insère un saut de ligne, sauf dans le Chat lorsqu'un menu d'autocomplétion est ouvert — les trois menus du Chat (fichiers/tâches, agents, compétences) la consomment alors sans insérer de saut de ligne. Dans le Chat de tâche et le Chat du planificateur, `Shift+Enter` traverse le menu et insère bien un saut de ligne.
`Cmd/Ctrl+Enter` sans `Shift` envoie, indépendamment du réglage `chatSubmitOnEnter` et du type de pointeur.
`Entrée` sans `Cmd/Ctrl` ni `Shift` est gouvernée par `chatSubmitOnEnter` ; `Alt` n'est pas un modificateur d'envoi et ne change rien à cette règle.
Les règles 2 et 3 s'appliquent lorsqu'aucun menu d'autocomplétion n'est ouvert. Un menu ouvert a la priorité et consomme `Entrée` comme `Cmd/Ctrl+Enter` ; `Échap` ferme le menu et rétablit les règles.
Dans le Chat de tâche uniquement, une composition IME en cours (saisie CJK) court-circuite tout, `Cmd/Ctrl+Enter` compris, jusqu'à la validation du candidat.
*/
const ChatSubmitOnEnterContext = createContext<ChatSubmitOnEnterMode>("auto");

export function normalizeChatSubmitOnEnterMode(value: unknown): ChatSubmitOnEnterMode {
  return value === "always" || value === "never" ? value : "auto";
}

export function resolveChatEnterSubmits(
  mode: ChatSubmitOnEnterMode,
  options: { softKeyboard: boolean },
): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return !options.softKeyboard;
}

export function ChatSubmitOnEnterProvider({
  value,
  children,
}: {
  value: ChatSubmitOnEnterMode;
  children: ReactNode;
}) {
  return <ChatSubmitOnEnterContext.Provider value={value}>{children}</ChatSubmitOnEnterContext.Provider>;
}

export function useChatSubmitOnEnterMode(): ChatSubmitOnEnterMode {
  return useContext(ChatSubmitOnEnterContext);
}

export function useChatEnterSubmits(): boolean {
  const mode = useChatSubmitOnEnterMode();
  const softKeyboard = useCoarsePointer();
  return resolveChatEnterSubmits(mode, { softKeyboard });
}
