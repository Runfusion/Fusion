---
"@runfusion/fusion": patch
---

summary: Fix Artifacts, Documents, and Evals dashboard views returning 500 in PostgreSQL mode.
category: fix
dev: listArtifactsImpl/getAllDocumentsImpl now branch on store.backendMode and delegate to AsyncDataLayer helpers (listArtifacts/getAllDocuments in async-comments-attachments.ts); getEvalStore() returns a new AsyncEvalStore (async-eval-store.ts) in backend mode. evals-routes await the store calls; eval-automation/eval-followups handle the EvalStore | AsyncEvalStore union (instanceof guard / await).
