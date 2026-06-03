---
"@runfusion/fusion": minor
---

Add the Compound Engineering bundled plugin: a dedicated dashboard surface for compound-engineering artifacts and interactive `ce-*` sessions, a work→board bridge, and bidirectional board↔pipeline sync. Sessions are fully multi-session: a Sessions panel lists every run with stage/status/last-activity, lets you open and switch between concurrent sessions (each keeps running server-side), resume interrupted ones, and discard settled ones (`DELETE /sessions/:id` disposes the live handle before deleting the row).

This also adds two reusable host capabilities that any plugin benefits from:

- **Interactive agent sessions for plugin routes** (`ctx.createInteractiveAiSession`), with skill-discovery forwarding (`requestedSkillNames` / `additionalSkillPaths`) so a plugin can load a bundled skill into a live session.
- **Real plugin event push over SSE**: a plugin's `ctx.emitEvent` calls are forwarded to connected `/api/events` clients as project-scoped `plugin:custom` events, and dashboard views can consume them via the new `subscribePluginEvents` view-context capability.
