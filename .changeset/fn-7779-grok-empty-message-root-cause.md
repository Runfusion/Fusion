---
"@runfusion/fusion": patch
---

summary: Grok CLI failures now show the actual error instead of an empty chat message.
category: fix
dev: GrokRuntimeAdapter.promptWithFallback now captures stderr, bridges NDJSON `error` events, and inspects the subprocess exit code. Any run that ends with no renderable content (missing/invalid GROK_API_KEY, bad flag, non-zero exit, missing `grok` binary, cold-start/inactivity hang, or a dropped `error` event) surfaces a diagnosable reason via `onText` rather than resolving into a blank bubble. A clean content-less exit (code 0, no stderr) stays silent. Fixes the root cause behind the FN-7779 "No message" placeholder.
