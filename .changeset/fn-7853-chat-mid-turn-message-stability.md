---
"@runfusion/fusion": patch
---

summary: Keep chat history stable while an agent is mid-turn so prior user and agent messages no longer flicker away.
category: fix
dev: useChat mid-turn message stability — intermediate chat:session:updated / tool-call / streaming events no longer blank or reflow the rendered `messages` thread (FN-7853, sibling of FN-6496/FN-6599 reattach fixes).
