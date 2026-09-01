---
"@runfusion/fusion": patch
---

summary: Stopping or restarting the engine no longer kills remote access, and a stopped engine can be restarted from the UI.
category: fix
dev: TunnelProcessManager moves from ProjectEngine into a process-lifetime per-project registry (`@fusion/engine` remote-tunnel-service); tunnels are stopped only by ProjectEngineManager.stopAll(). `POST /remote/tunnel/start|stop|kill-external` and `GET /remote/status` work with no engine attached (`REMOTE_TUNNEL_ENGINE_UNAVAILABLE` is unreachable on the start path), and `POST /system/engine/restart` now resumes paused projects.
