---
"@runfusion/fusion": minor
---

summary: Chat search now matches message content, with a "Search in title only" toggle.
category: feature
dev: ChatStore.searchSessionsByMessageContent (parameterized LIKE ... ESCAPE); GET /chat/sessions gains q/titleOnly params; useChat exposes searchInTitleOnly.
