---
"@runfusion/fusion": patch
---

summary: Contain planning parse failures as retryable session errors and add `--supervise` dashboard restart mode.
category: fix
dev: Planning sessions that receive non-JSON AI output now persist as retryable error state instead of unpersisting the session. The `/api/health` endpoint remains available during session errors. A new `--supervise` flag on `fn dashboard` runs the dashboard under foreground process supervision with bounded restart attempts and exponential backoff, preventing Tailscale Serve 502s from unexpected dashboard exits.
