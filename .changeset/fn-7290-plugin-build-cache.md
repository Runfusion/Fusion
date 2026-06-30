---
"@runfusion/fusion": patch
---

summary: Skip unchanged plugin builds during workspace builds.
category: performance
dev: Root pnpm build now uses a git content-hash plugin build cache that includes local workspace dependency and root build config/tooling inputs.
