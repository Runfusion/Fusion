---
"@runfusion/fusion": patch
---

summary: Accept root-level File Scope files with extensions such as global.json and solution files.
category: fix
dev: isValidFileScopeEntry no longer requires a slash; letter-leading final extensions share create/update validation with classification. Regression coverage tracks GitHub #2389.
