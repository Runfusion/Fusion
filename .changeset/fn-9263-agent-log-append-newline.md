---
"@runfusion/fusion": patch
---

summary: Preserve new agent-log entries after an interrupted prior write.
category: fix
dev: `appendAgentLogEntriesSync` separates unterminated tails, and reader corruption warnings are aggregated per read.
