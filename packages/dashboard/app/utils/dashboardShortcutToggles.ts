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
