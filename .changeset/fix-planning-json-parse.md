---
"@gsxdsm/fusion": patch
---

Fix planning mode JSON parse failure on question generation. Planning mode now
robustly extracts JSON from AI responses (handles markdown wrapping, prose,
truncated output) and retries once with a reformat prompt before showing an
actionable error instead of "Unexpected end of JSON input".
