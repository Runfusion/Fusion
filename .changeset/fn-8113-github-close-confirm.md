---
"@runfusion/fusion": patch
---

summary: GitHub import "Close issue" button is now red and asks for confirmation before closing.
category: fix
dev: GitHubImportModal.handleCloseIssue gated behind useConfirm({ danger: true }); button uses btn-danger.
