---
"@runfusion/fusion": minor
---

summary: Show each remote agent session's cost on its card and summarize every server's sessions and spend.
category: feature
dev: List responses now carry a `cost` badge from the shared `summarizeSessionCost` helper that also backs `GET /external-sessions/:id/cost`. Host totals are aggregated client-side over loaded sessions and labelled as such. Session and server lists are now real lists with a status region.
