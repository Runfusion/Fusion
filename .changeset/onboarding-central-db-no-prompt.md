---
"@runfusion/fusion": patch
---

summary: Onboarding no longer asks whether to create the central database — it always creates it.
category: fix
dev: `runOnboard` gated central-DB creation behind `runSkippableStep(prompts, "Central DB", ...)`. Declining produced an install Fusion cannot run on, acknowledged only by a "database was not created or initialized" line, so the negative answer had no useful outcome. It also blocked non-interactive startups: a `pnpm dev --tunnel` stopped on `Run central db now? (Y/n)` never reached listening, so nothing was served. The step now runs unconditionally when the database is absent; the "already exists" path is unchanged. Scripted prompt sequences in `onboard.test.ts` lost their leading central-DB answer accordingly, and the skip-everything case now asserts the database is still created.
