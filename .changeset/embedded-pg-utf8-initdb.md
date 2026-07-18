---
"@runfusion/fusion": patch
---

summary: Embedded PostgreSQL clusters are now always created UTF-8, fixing dashboard crash-loops on non-UTF-8 Windows locales.
category: fix
dev: "GitHub issue #2286: initdb inherited the OS locale encoding (e.g. Turkish WIN1254, English WIN1252), so the UTF-8 schema SQL failed with 'character has no equivalent in encoding'. DEFAULT_EMBEDDED_INITDB_FLAGS now forces --encoding=UTF8 --locale=C on every platform (caller flags appended after, so overridable). Not retroactive: existing non-UTF-8 clusters must delete ~/.fusion/embedded-postgres/default; the schema-apply failure now says exactly that, and boot errors include the full error cause chain instead of dropping it."
