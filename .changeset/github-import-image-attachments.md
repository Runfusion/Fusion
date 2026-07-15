---
"@runfusion/fusion": minor
---

summary: Imported GitHub and GitLab issues now carry their screenshots as task attachments, so agents can see them.
category: feature
dev: `importIssueImageAttachments` (packages/dashboard/src/issue-image-attachments.ts) downloads images embedded in an issue's body and comments and stores them via `addAttachment`, wired into `POST /github/issues/import`, `POST /github/issues/batch-import`, and every GitLab import route via `importItem`. Provider differences sit behind an `ImageImportPolicy`: GitHub images are absolute URLs on a fixed host allowlist; GitLab `/uploads/...` are project-relative and restricted to the configured instance origin. GitLab note bodies come from the new read-only `GitLabClient.listNotes`. Extraction runs on the original (untranslated) body; downloads are capped at 10 images / 5MB each with a 15s timeout, authenticated per provider (gh CLI token / PRIVATE-TOKEN), and best-effort so a failed image or comment fetch never fails the import.
