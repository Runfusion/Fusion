---
"@runfusion/fusion": patch
---

summary: Agent chat now investigates the live codebase with tools before answering architecture and code questions.
category: feature
dev: Adds CHAT_CODEBASE_ACCURACY_GUIDANCE and appends it in direct and room chat system-prompt assembly; response-length policy yields to path/symbol evidence on repo questions.
