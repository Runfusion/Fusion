---
"@runfusion/fusion": patch
---

summary: The dev tunnel URL is now visible in the dashboard TUI instead of being painted over.
category: fix
dev: `pnpm dev --tunnel` prints its banner to stdout, but a TTY run hands the screen to `DashboardTUI`, which repaints over it — so the public URL, the entire output of the flag, could not be read. The wrapper now forwards the URL to the dev child over the existing IPC channel (`DEV_TUNNEL_READY_MESSAGE`) and the dashboard renders it as a `Tunnel` row in the system panel beside URL and Token. Capture is order-independent: the URL is stored on arrival at run scope and applied whenever the TUI exists, because cloudflared can publish before or after the TUI is constructed and an IPC message with no listener attached is lost. Watch-mode restarts re-announce the existing tunnel to the new child, which would otherwise show no tunnel row after the first reload.
