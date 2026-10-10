---
"@runfusion/fusion": minor
---

summary: Measure per-turn cost and context for Codex sessions, not only Claude.
category: feature
dev: Codex token_usage_record and turn_context both carry turn_id, so usage attaches by stated identity rather than by position. Verified on a real 81-turn rollout: 81 turn_contexts, 81 usage records, 81 distinct turn_ids, zero unmatched on either side.
