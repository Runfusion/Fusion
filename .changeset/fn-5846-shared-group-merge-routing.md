---
"@runfusion/fusion": patch
---

Fix shared-branch-group member finalization so routed members land on the group's shared branch instead of being auto-finalized against the project default branch. Also harden already-landed commit attribution so the recovery detector never claims a commit that merely mentions a task ID in prose (2026-05-23 lost-work regression): the `git log --grep` ancestry fallback is now ownership-anchored on a Fusion trailer or a task-scoped conventional-commit subject.
