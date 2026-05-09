---
"@runfusion/fusion": patch
---

Fix agent-company imports from companies.sh monorepos by honoring the catalog subdirectory path (for example `paperclipai/companies/gstack`) instead of parsing the alphabetically first sibling package.
