---
"@runfusion/fusion": patch
---

summary: Fix the phone Files page so the file list scrolls all the way to its last entry.
category: fix
dev: MainContentDrawer derives contentOwnsScroll from MOBILE_DRAWER_CONTENT_SCROLL_VIEWS (files only); the drawer-hosted Files fill chain is restated in physical min-height so .file-browser-list is the single bounded scroll owner.
