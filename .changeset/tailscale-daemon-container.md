---
"@runfusion/fusion": patch
---

summary: Fix Tailscale remote access failing with "process exited 1" in the Docker image.
category: fix
dev: The image shipped the `tailscale` CLI but never ran `tailscaled`, so the `tailscale funnel <port>` spawn died immediately. A new `scripts/docker-entrypoint.sh` starts the daemon in userspace-networking mode (no NET_ADMIN/tun caps needed) when opted in with a leading `--tailscale` argument or `FUSION_TAILSCALE=1`; the flag is stripped before the CLI runs. `/var/lib/tailscale` symlinks into `/home/node/.tailscale` so login state persists across container recreates. `evaluateRemoteLifecycle` now preflights daemon reachability and backend state via `tailscale status --json` instead of only `which tailscale`, so an unreachable, logged-out, or stopped backend reports an actionable `runtime_prerequisite_missing` reason.
