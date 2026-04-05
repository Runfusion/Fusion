---
"@gsxdsm/fusion": patch
---

Fix terminal WebSocket disconnect after tab idle. Server now tolerates 2 consecutive missed pongs (~90s) before terminating, and client heartbeat interval increased to 45s for better resilience against browser throttling.
