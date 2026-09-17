---
"@runfusion/fusion": patch
---

summary: The More menu opens only on hovering More, and the window visibility button stays visible.
category: fix
dev: The `.desktop-action-bar__more::before` corridor is now `pointer-events: none` at rest and re-armed only under `.desktop-action-bar__more--open`; pointer opening moved onto the `desktop-nav-more` button. `#dashboard-window-toggle-root` moves to the reserved `calc(var(--fusion-max-z) + 4)` layer above dominant transient surfaces.
