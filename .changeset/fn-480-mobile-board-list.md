---
"@runfusion/fusion": patch
---

summary: On mobile, the Board quick-access shortcut now opens List, and the duplicate List menu entry is gone.
category: feature
dev: Local re-mapping in `MobileNavBar`'s destination registry only — the `tasks` entry renders `List`/`nav.list`, is active on `view === "list"` and calls `onChangeView("list")` on both surfaces, and the hard-coded `mobile-more-item-list` button is deleted. No data migration: the persisted id `tasks`, `resolveMobileNavPrimaryItems`, Settings labels, and tablet/desktop navigation are unchanged.
