---
"@runfusion/fusion": patch
---

Plugin management now separates global installation from project activation: installs/uninstalls are global, while enable/disable and runtime state remain project-scoped. Updated dashboard plugin lifecycle SSE payloads and Plugin Manager/CLI copy to make global vs project scope explicit.
