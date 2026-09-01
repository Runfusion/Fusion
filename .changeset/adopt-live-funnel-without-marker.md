---
"@runfusion/fusion": patch
---

summary: Remote access no longer reports "stopped" while the tunnel is serving traffic.
category: fix
dev: `restoreIfNeeded` gated funnel adoption behind the `wasRunningOnShutdown` marker, so one restart that lost track of the tunnel made `state:"stopped"` permanent — a service that believes it is stopped never writes a marker to recover from, and every later restart re-skipped with `no_prior_running_marker` while the public URL served 200. Adoption now runs before the marker gate and depends on what tailscaled can prove is serving the configured port; a funnel on a different port is still refused rather than clobbered.
