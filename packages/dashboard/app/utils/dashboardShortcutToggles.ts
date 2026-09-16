/*
FNXC:DashboardShortcuts 2026-07-16-00:00:
FN-8069 requires view-backed dashboard shortcuts to remove the exact navigation-history callback that opened their view, then restore the captured prior view. Retain a callback stack per view so repeated Settings/Command Center entries each preserve their own history; keep this identity-sensitive lifecycle outside App's render body for live navigation-history regression coverage (Runfusion/Fusion#2118).
*/
export function retainViewNavRevert<TView>(
  view: TView,
  previousView: TView,
  reverts: Map<TView, (() => void)[]>,
  restoreView: (view: TView) => void,
): () => void {
  const revert = () => {
    const viewReverts = reverts.get(view);
    if (viewReverts) {
      const index = viewReverts.lastIndexOf(revert);
      if (index !== -1) viewReverts.splice(index, 1);
      if (viewReverts.length === 0) reverts.delete(view);
    }
    restoreView(previousView);
  };
  const viewReverts = reverts.get(view) ?? [];
  viewReverts.push(revert);
  reverts.set(view, viewReverts);
  return revert;
}

/*
FNXC:DashboardShortcuts 2026-09-16-02:27:
FN-441 : la liste des chats a DEUX hôtes déjà existants (tiroir plein écran sur téléphone, popover du pied de
page sur tablette/ordinateur) et aucun nouvel hôte n'est créé. Le choix reste un seam PUR pour deux raisons :
il doit être prouvable sans monter tout le shell dashboard, et il doit suivre le point de rupture MESURÉ
(`useViewportMode`) plutôt qu'une supposition CSS. Sans projet courant, aucun hôte n'existe : l'action est inerte.
*/
export type ChatListShortcutTarget = "none" | "drawer" | "popover";

export function resolveChatListShortcutTarget(options: { hasProject: boolean; isMobile: boolean }): ChatListShortcutTarget {
  if (!options.hasProject) return "none";
  return options.isMobile ? "drawer" : "popover";
}

/*
FNXC:DashboardShortcuts 2026-09-16-02:27:
Le clavier doit ancrer la popover sur le MÊME élément que le clic pointeur (`desktop-nav-chat-panel`), sans
faire traverser une ref à travers DesktopActionBar. Une ancre absente (footer large inactif, montage tardif)
renvoie `null`, que la géométrie de la popover tolère déjà — jamais une exception.
*/
export function readShortcutAnchorRect(testId: string): DOMRect | null {
  if (typeof document === "undefined") return null;
  const element = document.querySelector(`[data-testid="${testId}"]`);
  if (!element) return null;
  return element.getBoundingClientRect();
}

export function closeViewShortcut<TView>(
  view: TView,
  reverts: Map<TView, (() => void)[]>,
  removeNav: (revert: () => void) => void,
  onMissingRevert: () => void,
): boolean {
  const viewReverts = reverts.get(view);
  const revert = viewReverts?.at(-1);
  if (!revert) {
    onMissingRevert();
    return false;
  }
  removeNav(revert);
  revert();
  return true;
}
