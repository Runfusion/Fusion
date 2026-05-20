---
"@runfusion/fusion": patch
---

Fix Fusion worktree pre-commit identity-guard hook to accept canonical lowercase `fusion/<id>` branches when the on-disk `fusion-task-id` metadata stores an uppercase id, eliminating spurious "refusing commit" rejections that previously required `--no-verify`.
