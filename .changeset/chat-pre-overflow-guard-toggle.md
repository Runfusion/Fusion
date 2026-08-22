---
"@runfusion/fusion": minor
---

summary: Make the chat pre-overflow compaction guard an opt-out project setting (on by default).
category: feature
dev: New project key `chatPreOverflowCompactionEnabled` (default true); `false` bypasses the RUFU-118 pre-overflow compaction gate entirely for that project. Also indexes the LCM per-turn recall settings in the settings search.
