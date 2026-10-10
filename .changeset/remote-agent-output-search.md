---
"@runfusion/fusion": minor
---

summary: Search the collected output of remote agent sessions by word, phrase or exclusion.
category: feature
dev: Migration 0089 adds a GIN expression index over turn prompts and responses. ExternalSessionTurnSearch uses websearch_to_tsquery with the 'english' configuration, which the index must keep matching exactly. Snippets from ts_headline are rendered as React elements, never as HTML.
