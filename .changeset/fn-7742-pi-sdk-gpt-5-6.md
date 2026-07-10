---
"@runfusion/fusion": minor
---

summary: Update the pi SDK and add support for GPT-5.6 codex-tier models.
category: feature
dev: Bumps @earendil-works/pi-ai and @earendil-works/pi-coding-agent from ^0.80.3 to ^0.80.5 across packages/cli, packages/dashboard, packages/engine, and packages/pi-claude-cli (packages/droid-cli and packages/pi-llama-cpp's pi-coding-agent stay unpinned at `*` per existing convention). Inspected the installed SDK's generated model catalogs directly and found no `gpt-5.6-codex` id — OpenAI dropped the separate `-codex`-suffixed tier naming starting at the 5.4 generation. Added `openai-codex:gpt-5.6-luna`, `openai-codex:gpt-5.6-sol`, and `openai-codex:gpt-5.6-terra` pricing (the actual GPT-5.6 codenamed variants exposed by the SDK under the `openai-codex` provider) to `model-pricing.ts`, mirroring the existing `gpt-5.3-codex` rate, and bumped `pricingAsOf` to 2026-07-09 so Command Center token cost reports real cost instead of `unavailable` for these models.
