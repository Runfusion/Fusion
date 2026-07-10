---
"@runfusion/fusion": patch
---

summary: The latest OpenAI GPT-5.6 models now appear everywhere, not just the Settings model list.
category: fix
dev: Wires mergeSupplementalOpenAiCodexModels into the engine pi createFnAgent registry-seeding surface (packages/engine/src/pi.ts) alongside the existing mergeSupplementalAnthropicModels call, mirroring register-model-routes.ts. FN-7745 only wired the dashboard /api/models route, so gpt-5.6-luna/sol/terra were absent on the pi surface. Additive, dedupe-safe; adds a pi-create-fn-agent regression test.
