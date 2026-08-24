---
"@runfusion/fusion": patch
---

summary: Fix a TUI crash when pressing Enter on the System panel, and always show a running tunnel's URL there.
category: fix
dev: Three fixes in the dashboard TUI's System panel. (1) Enter opens the dashboard URL with a detached `spawn`; a missing opener (`xdg-open` on slim Linux containers) is reported asynchronously as an `error` event, not a synchronous throw, so the surrounding try/catch never saw it and Node re-threw it as an unhandled `error`, killing the TUI. An `error` listener is now attached. (2) `SystemInfo.devTunnelUrl` becomes `tunnelUrl` and is fed by both sources — the dev wrapper's IPC hand-off and the engine's `TunnelProcessManager` status subscription — so an operator-started remote tunnel, whose URL previously existed only in the Settings UI and `/remote/status`, is readable from a headless terminal. A dev tunnel wins when both are present; a stopped tunnel clears the row. (3) `estimateSystemContentRows` now measures the tunnel row like URL and Token, since an unmeasured row let a wrapping trycloudflare hostname squeeze itself out of the panel.
