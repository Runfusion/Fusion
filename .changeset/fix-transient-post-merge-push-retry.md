---
"@runfusion/fusion": patch
---

summary: Retry post-merge pushes after temporary Git network failures.
category: fix
dev: Adds two cancellation-aware retries with bounded backoff on transient transport failures across both post-merge push paths; configuration, authentication, and ref-rejection errors still fail immediately.
