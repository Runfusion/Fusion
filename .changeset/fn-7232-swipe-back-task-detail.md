---
"@runfusion/fusion": patch
---

summary: Swiping back on mobile now dismisses the open task detail view.
category: fix
dev: Routes mobile task-detail opens through useNavigationHistory pushNav/removeNav so the native back gesture (popstate) reverts to the originating board/list/dock surface across all detail surfaces.
