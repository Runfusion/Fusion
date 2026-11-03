---
"@runfusion/fusion": patch
---

summary: Add Keenable as a research web search provider that works without an API key.
category: feature
dev: Adds the `keenable` WebSearchBackend; uses the public endpoint by default and `/v1/search` when `keenableApiKey` is passed.
