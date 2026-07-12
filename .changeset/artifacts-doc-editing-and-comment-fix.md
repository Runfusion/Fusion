---
"@runfusion/fusion": minor
---

summary: Edit task documents and project files in Artifacts, with Markdown previews and working add-comment controls.
category: feature
dev: DocumentsView embeds the shared CodeMirror FileEditor for task-document (PUT /tasks/:id/documents/:key) and project-file (project workspace file API) edits. The Add comment no-op was a CSS bundle-order regression — `.btn:active` out-ordered the equal-specificity trigger rule; the `:active` rules now use `.btn.selection-comment-trigger` (0,3,0) with a test asserting the prefix.
