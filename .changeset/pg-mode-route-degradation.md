---
"@runfusion/fusion": patch
---

summary: Not-yet-ported features (missions, insights, research, goals) degrade cleanly in PG mode instead of erroring.
category: fix
dev: Adds backendMode guards to the dashboard route choke-points that call satellite stores not yet on the AsyncDataLayer (getResearchStore/getInsightStore/getMissionStore/getGoalStore). They now return HTTP 503 "not yet available in PG backend mode" (matching the existing command-center team/productivity/token guards) instead of letting the store getter throw an unhandled 500. The SSE handler also degrades: ResearchStore access is wrapped so the event stream still serves every other event type instead of failing the whole connection when research run-events cannot be subscribed in PG mode. Full PG ports of these stores remain (TodoStore is done); these guards are the correct interim state until each lands.
