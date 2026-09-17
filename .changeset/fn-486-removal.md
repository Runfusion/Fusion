---
"@runfusion/fusion": patch
---

summary: List row actions move to right-click and long-press menus across Planning, Notes, Missions and Mailbox.
category: fix
dev: FN-486. Les commandes secondaires PERMANENTES des lignes sont retirées, jamais supprimées du produit : le crayon/corbeille des sessions Planning, le bouton « … » des notes, les blocs `mission-list__item-actions`, `mission-milestone__actions`, `mission-slice__actions`, `mission-feature__actions`, `mission-fix-feature__actions` et le composant `FeatureValidationRepairActions` sont remplacés par le menu contextuel partagé `ListItemContextMenu`, ouvert au clic droit, à la touche Menu/Shift+F10 et à l'appui long. Les conditions métier, confirmations, gardes de révision et rafraîchissements sont inchangés. `useDrawerDismissGesture` accepte désormais une ligne qualifiée `data-drawer-dismiss-row` comme départ de geste, les titres supérieurs de Planning et Missions restent ceux de la vue, et le bouton Retour partage la géométrie mobile canonique du bouton de création.
