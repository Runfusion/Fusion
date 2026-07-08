---
"@runfusion/fusion": patch
---

summary: Prevent redundant polling and a re-render loop in agent-card runtime-fallback badges.
category: fix
dev: AgentsView now caches one stable ref callback per viewport key (avoids an infinite re-render loop when IntersectionObserver is unavailable) and evicts it on unmount; the test-only toast-dedupe reset is guarded to a no-op in production builds.
