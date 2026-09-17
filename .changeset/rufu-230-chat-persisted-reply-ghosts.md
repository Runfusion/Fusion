---
"@runfusion/fusion": patch
---

summary: Chat no longer persists ghost assistant slices that doubled a reply's opening words after a Stop or provider error.
category: fix
dev: The done-handler authoritative-reply join now excludes assistant slices with stopReason "error"/"aborted" and strict-prefix retry ghosts, and cancelled-turn prefixes are recorded in the reopened pi transcript with stopReason "aborted" instead of "stop".
