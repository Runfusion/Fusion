---
"@runfusion/fusion": patch
---

summary: Fix remote access silently dying after a container restart.
category: fix
dev: The Docker entrypoint gated `tailscaled` startup on the absence of `/var/run/tailscale/tailscaled.sock`. `docker restart` reuses the writable layer, so that socket file survives with no daemon behind it and the guard skipped startup — the dashboard came back healthy while `tailscale` returned `connect: connection refused` and the tunnel was dead. Liveness is now decided by scanning `/proc` for a running `tailscaled`, and a stale socket file is removed before starting.
