---
"@runfusion/fusion": minor
---

summary: Agents save screenshots, videos, HTML mockups, and PDFs as artifacts, shown in a new category gallery with doc editing.
category: feature
dev: fn_artifact_register gains a `path` payload source (file copied into managed storage, MIME inference, image/video/PDF signature validation) and is now always exposed to executor sessions (previously missing in ephemeral mode) with worktree-relative path resolution and executing-task default taskId; executor/planning prompts instruct agents to register visual/media deliverables (images, videos, HTML mockups, PDFs); the media route serves HTTP byte ranges for video/audio seeking; video attachments (100MB cap) bridge into the registry like images; HTML docs render as live sandboxed previews; new `GET`/`PATCH /api/artifacts/:id` routes plus `TaskStore.updateArtifact` and the `artifact:updated` SSE event power in-place doc editing in the new ArtifactsGallery (Images/Docs/PDFs/Videos/Audio/Other sections with per-category viewers, mobile-responsive); viewers open in draggable/resizable FloatingWindows, Artifacts is the first/landing tab of the view, and mobile tab buttons render at the uniform 44px control height.
