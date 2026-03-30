---
"@kb/dashboard": minor
---

Add real-time streaming for planning mode with AI thinking display

- Implement SSE infrastructure for planning sessions (`PlanningStreamEvent`, `PlanningStreamManager`)
- Add `/api/planning/start-streaming` endpoint for AI agent-powered planning
- Add `/api/planning/:sessionId/stream` SSE endpoint for real-time updates
- Frontend displays AI thinking output in collapsible panel during planning
- Update API client with `connectPlanningStream` for EventSource management
- Fix infinite spinner issue by ensuring proper state transitions from streaming events
