---
"@runfusion/fusion": minor
---

summary: Grok CLI runtime now bridges tool execution events (name/args/result) from the NDJSON stream, not just text.
category: feature
dev: GrokRuntimeAdapter.promptWithFallback now bridges tool_use NDJSON events into onToolStart/onToolEnd; tool name/args/result pass through unchanged (no Grok→pi name mapping — the verified docs/grok-cli-contract.md schema does not pin a tool-name vocabulary). step_finish/error remain non-terminal per-step events and are not bridged to a callback; only subprocess close/error finalizes, unchanged from FN-7722. Fixture-tested (no live binary). End-to-end runtimeHint="grok" routing remains FN-7725's scope; the direct xAI path (FN-7711/7714) is unchanged.
