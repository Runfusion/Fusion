---
"@runfusion/fusion": patch
---

summary: Daemon exits non-zero on signal termination so Restart=on-failure restarts it after a memory-pressure kill.
category: fix
dev: `fn daemon` and `fn serve` (packages/cli/src/commands/daemon.ts, serve.ts) now exit with the POSIX 128+signal code (SIGTERM=143, SIGINT=130) on signal-initiated graceful shutdown instead of 0. Previously a memory-pressure SIGTERM produced exit 0, which `Restart=on-failure` treated as a clean stop, leaving the daemon dead. A deliberate `systemctl stop` still won't restart (systemd honors the requested inactive state regardless of exit code); a non-signal shutdown still exits 0. The interactive TUI launcher (`fn dashboard`) is intentionally unchanged — it has its own signal-name-keyed restart supervisor.
