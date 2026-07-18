---
"@runfusion/fusion": patch
---

summary: Foreign-language GitHub/GitLab issues authored via issue forms now auto-translate and offer the Translate button.
category: fix
dev: detectContentLanguage now strips issue-form scaffolding line-by-line (headers, standalone bold field-label lines, checkboxes, `_No response_`, HTML comments) and strips only the leading `>` blockquote marker while retaining quoted content, before script/stopword scoring, so form bodies are no longer scored as English and skipped by both the server auto-translate eligibility (isTranslatable) and the client offer path. Stripping is line-scoped so inline bold/list/quote content in ordinary prose (triage/ai-summary inputs) is preserved.
