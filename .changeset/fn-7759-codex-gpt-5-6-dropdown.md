---
"@runfusion/fusion": patch
---

summary: GPT-5.6 codex models (luna, sol, terra) now actually appear in the codex model picker.
category: fix
dev: Prior fixes (FN-7742/7745/7754) validated the openai-codex supplemental merge only against a mocked ModelRegistry, so gpt-5.6-luna/sol/terra could fail to reach the picker through the real pi-coding-agent registry (getAvailable() auth filtering + registerProvider full-replacement + OAuth provider validation) and/or the /api/models configuredProviders filter. This closes that gap and adds a real-registry regression test.
