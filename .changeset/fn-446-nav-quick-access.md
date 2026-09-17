---
"@runfusion/fusion": minor
---

summary: Choose the five quick-access destinations of the navigation bar and their order; Agents moves to More.
category: feature
dev: Reuses the existing project setting `mobileNavPrimaryItems` (no new key, no migration) with a cap of 5 and the default `command-center`, `tasks`, `planning`, `missions`, `mailbox`. `buildDashboardNavigationEntries` now derives `placement` from `quickAccessEntryIds` (resolved via `resolveNavigationQuickAccessEntryIds`) instead of a hardcoded direct row; destinations without a bottom-bar entry are no longer selectable.
