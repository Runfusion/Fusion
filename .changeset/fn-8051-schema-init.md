---
"@runfusion/fusion": patch
---

summary: Ensure required database schemas always initialize before plugin tables on boot.
category: fix
dev: applySchemaBaseline now runs CREATE SCHEMA IF NOT EXISTS project/central/archive unconditionally before plugin schema-init hooks (FN-8051).
