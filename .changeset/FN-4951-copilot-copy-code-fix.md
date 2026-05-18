---
"@runfusion/fusion": patch
---

Fix "Copy code" button on the GitHub Copilot device-code panel (Settings and Onboarding) when the dashboard is served from a non-secure origin (e.g. LAN/HTTP `fn serve`). The button now falls back to a `document.execCommand("copy")` path when `navigator.clipboard` is unavailable and surfaces success/failure via a toast instead of silently no-opping. The auto-copy-on-first-show effect uses the same fallback silently.
