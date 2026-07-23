---
"@runfusion/fusion": patch
---

summary: Grok CLI fallback models now engage only when the primary model actually fails, instead of replacing it up front.
category: fix
dev: The FN-7758 no-visible-key seam no longer promotes a grok-cli fallback to primary at session start; only a grok-cli primary auto-routes to the Grok CLI runtime. A fallback-only grok-cli pair without a visible GROK_API_KEY is deferred: the session runs the configured primary, and on the first retryable model failure it swaps onto the Grok CLI runtime with the fallback model (audited as `session:grok-cli-fallback-engaged`). If the Grok runtime plugin is unavailable the pair is dropped with `grokCliFallbackDropped: true`. `session:runtime-resolved` now records the post-transform provider/model pair the session actually runs.
