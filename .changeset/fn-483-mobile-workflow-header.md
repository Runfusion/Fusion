---
"@runfusion/fusion": patch
---

summary: Sur téléphone, ouvrir un panneau ne déplace plus le sélecteur de workflow et n'en ajoute plus un second.
category: fix
dev: Le Header reçoit `boardBackgroundActive` (téléphone uniquement) pour garder `#header-workflow-slot` pendant les drawers, et les producteurs secondaires (ListView, Graph, Header/Planning/Missions) reçoivent `showWorkflowControls` pour retirer leur contrôle sans couper leurs effets de sélection. Les choix explicites sont diffusés entre consommateurs du même projet par `app/utils/boardWorkflowSelectionEvents.ts` ; les fetch, SSE et payloads restent locaux à chaque instance de `useBoardWorkflows`, et l'agrégat `__all_workflows__` n'est jamais envoyé au miroir serveur.
