---
"@dustinbyrne/kb": patch
---

Engine pause now terminates active agent sessions (matching global pause behavior) instead of letting them finish gracefully. Tasks are moved back to todo/cleared for clean resume on unpause.
