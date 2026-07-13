---
"@runfusion/fusion": patch
---

summary: Fix pinned terminal rendering underneath the status footer.
category: fix
dev: `.terminal-below-host` now reserves `--executor-footer-height` via a new `footerVisible` prop + `.terminal-below-host--with-footer` CSS modifier (matching `.project-content--with-footer`/`.left-sidebar-nav--with-footer`/`.right-dock--with-footer`), so the pinned/below terminal panel no longer sits underneath the fixed `ExecutorStatusBar`.
