---
"@runfusion/fusion": minor
---

summary: Git et Fichiers ont leur page, Activité/Notes/Chat leurs panneaux, et la sidebar droite devient optionnelle.
category: feature
dev: New project setting `rightSidebarEnabled` (default false) in Settings → Appearance. New `files` and `git-manager` dashboard views; `pull-requests` resolves to the Git Manager PR section and `secrets` to Settings → project Secrets via `app/utils/toolSurfaceRouting.ts`. Activity and Notes render in `DashboardToolPopover` from the Header; the bottom bar hosts the Chat conversation list. When re-enabled, the right dock exposes only Files/Chat/List/Notes.
