---
"@runfusion/fusion": patch
---

summary: Les accès déjà offerts par le header ne sont plus répétés dans la barre du bas ni dans « More ».
category: fix
dev: `resolveHeaderNavigationOwnership` (packages/dashboard/app/utils/headerNavigationOwnership.ts) dérive les destinations réellement rendues par le Header ; App les transmet à `MobileNavBar` via `headerOwnedItems`, filtrées avant la rangée directe, la promotion dynamique et le menu. Aucune destination n'est supprimée et le réglage `mobileNavPrimaryItems` n'est ni lu autrement ni réécrit. Le slot workflow du Header revient à la position ordinateur sur tablette ; seul le téléphone conserve la disposition compacte.
