---
"@gsxdsm/fusion": minor
---

Add real-time steering comment injection during task execution

Steering comments added during task execution are now dynamically injected into the running agent session. Previously, steering comments were only included at execution start. Now, when a user adds a steering comment while a task is in-progress, it is delivered to the agent via the `session.steer()` API, allowing the AI to adjust its approach in real-time.

Key behaviors:
- New steering comments are detected via `task:updated` events
- Comments are injected using the pi-coding-agent `steer()` method
- Each comment is only injected once (tracked by ID to prevent duplicates)
- Failed injections are logged but not retried (to avoid spamming the agent)
- Injection success is logged to the task for visibility
