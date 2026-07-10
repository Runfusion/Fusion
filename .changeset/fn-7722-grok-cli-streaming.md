---
"@runfusion/fusion": minor
---

summary: Grok can now run through the Grok CLI's NDJSON stream, so CLI-authenticated setups need no Fusion-visible API key.
category: feature
dev: GrokRuntimeAdapter.promptWithFallback now spawns `grok --prompt --format json`, parses the NDJSON event stream (new src/stream-parser.ts, fixture-tested), and drives onText/onThinking — replacing the FN-7715 no-op. Direct xAI OpenAI-compatible path (FN-7711/FN-7714) is unchanged and remains the default; end-to-end runtimeHint="grok" routing is a follow-up. Contract captured in docs/grok-cli-contract.md.
