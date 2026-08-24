---
"@runfusion/fusion": patch
---

summary: `pnpm dev --tunnel` now tunnels the dev server's real port instead of another instance on 4040.
category: fix
dev: The tunnel target came from `PORT`/4040, resolved before anything bound. When that port was occupied the dashboard silently rebound to an ephemeral port (`server.listen(0)` on EADDRINUSE), so with a normal Fusion already on 4040 the tunnel published that instance under a dev-looking URL. The dashboard now reports its bound port to the dev supervisor over IPC (`DEV_SERVER_LISTENING_MESSAGE`, a no-op without an IPC channel), the wrapper enables IPC whenever `--tunnel` is set rather than only in watch mode, and the tunnel waits for that report (60s cap, falling back to the configured port with a warning) before starting — which also stops it coming up against a port nothing serves yet. A reported port is treated as the dashboard whatever its number, so the banner still prints the bearer token; an explicit `--tunnel=PORT` never waits and is still compared against the configured dashboard port.
