---
"@runfusion/fusion": patch
---

Bootstrap `@fusion/dashboard` dist before running tests so `@fusion/desktop` (which dynamically imports `@fusion/dashboard`) does not fail with "Failed to resolve entry for package @fusion/dashboard" in clean checkouts and merger verification environments.
