---
"@runfusion/fusion": patch
---

summary: Fix the GitHub/GitLab import preview panel being cut off on tablet-width screens.
category: fix
dev: The embedded Import Tasks view is container-query driven; the viewport `@media (max-width: 860px)` pane rules in GitHubImportModal.css were leaking `max-height: 50%` onto the embedded preview pane and are now scoped to `:not(.github-import-modal--embedded)`.
