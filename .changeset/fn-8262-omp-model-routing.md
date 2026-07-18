---
"@runfusion/fusion": patch
---

summary: Oh My Pi (omp) model selections now run via the OMP ACP runtime instead of failing.
category: fix
dev: agent-session-helpers auto-derives runtime hint "omp" for omp-cli primary/fallback selections (mirrors the Grok CLI no-visible-key seam); short-circuits under test mode/mock provider, validates an explicit "omp" hint against runtime availability, and prevents the "not found in the pi model registry" hard-fail. Throws an actionable error when the OMP runtime plugin is unavailable.
