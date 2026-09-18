---
"@runfusion/fusion": patch
---

summary: Long press no longer highlights text, and action menus now paint above their host panel.
category: fix
dev: Global `user-select`/`-webkit-touch-callout` suppression on `[data-drawer-dismiss-row]`, `.list-card`, `.file-node`; the four portaled context menus move from literal/counter layers to `calc(var(--fusion-max-z) + 5|6)`.
