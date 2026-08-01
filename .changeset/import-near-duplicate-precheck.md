---
"@runfusion/fusion": patch
---

summary: GitHub-issue imports are checked for near-duplicates before planning, not after.
category: fix
dev: Five issues auto-filed for one red-main event each burned a planning session before the post-plan FN-5152 backstop could see siblings (and racing concurrently, none did). Imports carry title+body at create, so specifyTask now runs the same comparator pre-planning for github_import tasks and flags against an older canonical for the operator's duplicate decision, releasing the pre-held slot. Fail-open; non-import creates keep the post-plan-only behavior.
