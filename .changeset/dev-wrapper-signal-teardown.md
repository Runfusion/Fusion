---
"@runfusion/fusion": patch
---

summary: Stopping `pnpm dev` now also stops its dev server and tunnel instead of orphaning them.
category: fix
dev: `scripts/dev-with-memory.mjs` installed no signal handlers; teardown lived only in the child's `close` handler. Signalling the wrapper directly (`kill <pid>`, or any supervisor-style stop) killed it and left the dev server and its `cloudflared` running — observed twice while debugging, four surviving processes each time, including a live public trycloudflare URL still serving the dev server after it was believed down. Interactive Ctrl-C masked this because the terminal signals the whole process group. SIGINT/SIGTERM/SIGHUP now stop the tunnel, forward the signal to the child, and exit on its close with a 10s cap so a wedged child cannot pin the terminal.
