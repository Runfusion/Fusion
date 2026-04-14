---
"@gsxdsm/fusion": patch
---

Decouple project execution startup from dashboard page access

Previously, project task execution (triage, scheduling, in-progress transitions) would only start for projects registered after boot if a user navigated to the Projects view in the dashboard UI, which triggered the `onProjectFirstAccessed` lazy-start callback.

This fix adds a background reconciliation loop in `ProjectEngineManager` that periodically checks for newly registered projects and starts their engines without requiring any UI access. Projects registered via `fn project add` after the dashboard or headless node starts will now have their engines started automatically within the next reconciliation interval (30 seconds by default).

The `onProjectFirstAccessed` callback remains wired as a fast-path fallback for potential optimization, but it is no longer required for correctness.
