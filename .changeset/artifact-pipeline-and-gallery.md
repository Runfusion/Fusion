---
"@runfusion/fusion": minor
---

summary: Agents now save screenshots/wireframes/mocks as artifacts, shown in a redesigned category gallery with doc editing.
category: feature
dev: fn_artifact_register gains a `path` payload source (file copied into managed storage, MIME inference, image signature validation) and is now always exposed to executor sessions (previously missing in ephemeral mode) with worktree-relative path resolution and executing-task default taskId; executor/planning prompts instruct agents to register visual deliverables; new `GET`/`PATCH /api/artifacts/:id` routes plus `TaskStore.updateArtifact` and the `artifact:updated` SSE event power in-place doc editing in the new ArtifactsGallery (Images/Docs/PDFs/Videos/Audio/Other sections with per-category viewers, mobile-responsive).
