---
"@runfusion/fusion": patch
---

summary: Cursor CLI model-picker rows now surface reasoning/context-window metadata when the Cursor CLI reports it.
category: feature
dev: Threads optional reasoning/contextWindow from cursor-agent model discovery (structured JSON entries only) through discoverCursorProviderModels into cursorDiscoveryToModels, replacing the hardcoded false/0 defaults. Text-only CLI output (today's real behavior) still yields false/0, so the change is behavior-preserving against the current CLI and forward-compatible. Metadata is pass-through only — never fabricated or parsed from free text. Parallels the deferred Hermes enrichment gap (FN-7696/FN-7636).
