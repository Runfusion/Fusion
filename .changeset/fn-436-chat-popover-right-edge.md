---
"@runfusion/fusion": patch
---

summary: Le panneau Chat de la barre du bas s'ouvre désormais collé au bord droit de l'écran.
category: fix
dev: `DashboardToolPopover` accepte une prop `align` ("anchor-end" par défaut, "viewport-end" opt-in) transmise à `resolveToolPopoverGeometry`; seul l'hôte `chat-tool-popover` d'`App.tsx` l'active.
