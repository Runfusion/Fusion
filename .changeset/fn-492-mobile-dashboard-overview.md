---
"@runfusion/fusion": patch
---

summary: Sur téléphone, le Dashboard s'ouvre directement sur Overview au lieu de la liste des sections.
category: fix
dev: `CommandCenter` résout ses états d'ouverture via `useViewportMode()` — téléphone: `activeTab="overview"` + `mobilePane="detail"`; tablette/ordinateur: rubrique persistée + `"list"`. La règle ne s'applique qu'au montage et au changement de projet.
