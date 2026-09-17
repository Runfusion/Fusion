import type { TFunction } from "i18next";
import type { Message } from "@fusion/core";
import type { ListItemMenuAction } from "./ListItemContextMenu";

/*
FNXC:MailboxRowActions 2026-09-17-03:18:
FN-486 : modèle de commandes PARTAGÉ par les trois producteurs de lignes de mail (`MailboxView`,
`MailboxModal`, `AgentDetailView.MailTab`), afin qu'une même ligne offre les mêmes actions dans chaque hôte.

Deux limites sont structurantes :
- Il n'existe AUCUNE commande « Modifier » : un message envoyé ne s'édite pas, et en inventer une créerait une
  capacité qui n'existe nulle part dans le produit.
- « Répondre » n'apparaît que chez un propriétaire qui dispose DÉJÀ d'un composeur, et selon sa condition
  actuelle (une réponse s'adresse à un agent). Un hôte sans composeur ne fournit simplement pas le callback.

Archiver / Restaurer suivent l'état du message ; Supprimer reste destructif et exige la confirmation de son
propriétaire, jamais l'ouverture du message pour atteindre la confirmation de son détail.
*/
export interface MailboxMessageActionHandlers {
  onArchive?: (message: Message) => void;
  onRestore?: (message: Message) => void;
  onDelete?: (message: Message) => void;
  onReply?: (message: Message) => void;
}

export const MAILBOX_ROW_MENU_KEY_PREFIX = "message:";

export function mailboxRowMenuKey(messageId: string): string {
  return `${MAILBOX_ROW_MENU_KEY_PREFIX}${messageId}`;
}

export function mailboxRowMenuMessageId(key: string | null | undefined): string | null {
  return key?.startsWith(MAILBOX_ROW_MENU_KEY_PREFIX) ? key.slice(MAILBOX_ROW_MENU_KEY_PREFIX.length) : null;
}

export function buildMailboxMessageActions(
  message: Message,
  t: TFunction<"app">,
  handlers: MailboxMessageActionHandlers,
): ListItemMenuAction[] {
  const actions: ListItemMenuAction[] = [];
  if (handlers.onReply && message.fromType === "agent") {
    actions.push({ id: "reply", label: t("mailbox.reply", "Reply"), testId: `mailbox-menu-reply-${message.id}`, onSelect: () => handlers.onReply?.(message) });
  }
  if (message.archived) {
    if (handlers.onRestore) actions.push({ id: "restore", label: t("mailbox.restore", "Restore"), testId: `mailbox-menu-restore-${message.id}`, onSelect: () => handlers.onRestore?.(message) });
  } else if (handlers.onArchive) {
    actions.push({ id: "archive", label: t("mailbox.archive", "Archive"), testId: `mailbox-menu-archive-${message.id}`, onSelect: () => handlers.onArchive?.(message) });
  }
  if (handlers.onDelete) {
    actions.push({ id: "delete", label: t("mailbox.delete", "Delete"), tone: "danger", testId: `mailbox-menu-delete-${message.id}`, onSelect: () => handlers.onDelete?.(message) });
  }
  return actions;
}
