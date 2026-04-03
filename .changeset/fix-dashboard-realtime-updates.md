---
"@gsxdsm/fusion": patch
---

Fix dashboard real-time updates not reaching the browser. SSE event pipeline now handles write errors gracefully, cleans up zombie connections, and reconnects automatically when the connection silently dies.
