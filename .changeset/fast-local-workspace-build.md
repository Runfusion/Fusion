---
"@runfusion/fusion": patch
---

summary: Make local `pnpm build` skip unchanged packages and use fast CLI packaging by default.
category: performance
dev: Content-hash skip cache now covers non-plugin packages; CLI packaging stages desktop/plugins/DTS only with FUSION_CLI_FULL_PACKAGE=1 or CI (`pnpm build:full`). Added maxConcurrentVerifications (default 1) and tsc incremental builds.
