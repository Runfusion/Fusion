---
"@runfusion/fusion": patch
---

summary: Fix the in-dashboard Switch server menu not switching desktop local/remote.
category: fix
dev: The desktop shell's redirect effects in App.tsx read a dead `localServer` field that the preload never populates; extracted `resolveDesktopShellRedirectTarget` in appLifecycle.ts now derives the navigation target from the live `localRuntime`/`activeProfileId` state for both directions, and the unused `localServer` field was removed from `ShellConnectionState`.
