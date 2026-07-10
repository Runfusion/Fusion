---
"@runfusion/fusion": patch
---

summary: Task cards no longer wrap the header when a task was created by an agent — the agent badge moved to a bottom row.
category: fix
dev: Moved `.card-agent-created-badge` out of `.card-meta-badges` into a new `.card-agent-badge-row` in TaskCard; updated the `hasCardMetaBadges` guard.
