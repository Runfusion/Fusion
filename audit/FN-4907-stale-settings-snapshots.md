# FN-4907 stale settings snapshot audit

## Scope
- packages/core settings stores (`GlobalSettingsStore`, `TaskStore`, `CentralCore`)
- dashboard settings writers/routes
- engine peer exchange settings payload cache
- direct global settings writers (`daemon-token`, `first-run`)

## Methodology
- Grep patterns used:
  - `getSettings`, `getSettingsFast`, `getSettingsByScope`, `getSettingsByScopeFast`
  - `updateSettings`, `updateGlobalSettings`
  - `cachedSettings`, `invalidateCache`, `invalidateAllGlobalSettingsCaches`
  - `cachedSettingsPayload`, `cachedSharedStatePayload`
- Candidate set: all matches under `packages/core`, `packages/engine`, `packages/dashboard`, `packages/cli` excluding `__tests__`.

## Write-path ↔ cache invariants

| Write site | Cache / snapshot that must refresh | Current invalidation behavior |
|---|---|---|
| `GlobalSettingsStore.updateSettings()` (`packages/core/src/global-settings.ts`) | Same-instance `cachedSettings` | Write-through (`cachedSettings = withDefaults`) on update; no cross-instance fanout |
| `TaskStore.updateGlobalSettings()` (`packages/core/src/store.ts`) | task-store merged settings readers + per-instance global cache | Delegates to `globalSettingsStore.updateSettings()` and emits `settings:updated`; no automatic invalidation of other TaskStore instances |
| `TaskStore.updateSettings()` (`packages/core/src/store.ts`) | project config snapshots / settings listeners | Writes config and emits `settings:updated` |
| `CentralCore.applyRemoteSettings()` project merge path (`packages/core/src/central-core.ts`) | project `TaskStore` caches/listeners for affected projects | Uses `updateProject(...{settings})` directly (no `TaskStore.updateSettings()` event fanout) |
| `settings-export` import (`packages/core/src/settings-export.ts`) | global/project settings caches | Uses `TaskStore.updateGlobalSettings()` / `TaskStore.updateSettings()` (evented path) |
| Dashboard `PUT /settings/global` (`register-settings-memory-routes.ts`) | all cached project stores + active engine store + peer exchange payload | Calls `invalidateAllGlobalSettingsCaches()` and engine task-store cache invalidation after update |
| Dashboard auth toggle routes (`register-auth-routes.ts`) | same as above | Calls `invalidateAllGlobalSettingsCaches()` and engine-store invalidation after each global write |
| Dashboard custom-provider CRUD (`register-custom-provider-routes.ts`) | same as above | **No explicit cache invalidation after `updateGlobalSettings()`** (candidate stale-cache risk) |
| Settings sync inbound `POST /settings/sync-receive` (`register-settings-sync-inbound-routes.ts`) | global settings caches + project store listeners | Calls `central.applyRemoteSettings(...)`; global application handled separately in route; project merge currently bypasses `TaskStore.updateSettings()` |
| `PeerExchangeService.updateGlobalSettings()` (`packages/engine/src/peer-exchange-service.ts`) | `cachedSettingsPayload`, `cachedSharedStatePayload` | Explicitly nulls both caches; effectiveness depends on callers invoking it |
| `DaemonTokenManager.rotateToken*` (`packages/core/src/daemon-token.ts`) | other `GlobalSettingsStore` instances reading `daemonToken` | Writes via its private `GlobalSettingsStore` only; no cross-instance invalidation |
| `FirstRunExperience.completeSetup()` (`packages/core/src/first-run.ts`) | other global settings store instances reading `setupComplete` | Writes via private `GlobalSettingsStore`; no cross-instance invalidation |

## Findings (severity)

| Suspect | Severity | Status | Evidence |
|---|---:|---|---|
| `register-custom-provider-routes.ts` writes global settings but does not fan out invalidation | Medium | **Bug fixed** | Route writes at lines 461/499/530 with no `invalidateAllGlobalSettingsCaches()` call, unlike `/settings/global` and auth toggles.
| `POST /settings/sync-receive` + `CentralCore.applyRemoteSettings()` handling | High | **Bug fixed (global sync path)** + **Not-a-bug (project TaskStore event path)** | Inbound route only calls `central.applyRemoteSettings(payload)` (line 65), and `applyRemoteSettings()` explicitly does not apply global settings (central-core lines 3546-3552). Project settings in `CentralCore` are central-registry sync snapshots, not per-project `TaskStore` config state; bypassing `TaskStore.updateSettings()` here is expected.
| `PeerExchangeService.updateGlobalSettings()` has no wiring | Medium | **Bug fixed** | Method exists and clears cached sync payload (peer-exchange-service lines 102-107), but dashboard/daemon startup paths constructed the service without live refresh wiring.
| `GlobalSettingsStore.cachedSettings` per-instance cache topology | Low | Already-handled with caveat | Cross-store invalidation is done in selected routes via `invalidateAllGlobalSettingsCaches()`; gaps were route-specific.
| Long-lived executor/heartbeat/merger snapshots | Low | Not a bug | Settings are repeatedly fetched (`await store.getSettings()`) in-run; no single startup snapshot reused for model/budget/workflow decisions.
| `getSettingsFast()` / `getSettingsByScopeFast()` missing workflow-steps | Low | Not a bug (contracted behavior) | Store docs explicitly state fast path skips workflow-step hydration (store line 2340+ and 2406+ comments).
| `daemon-token.ts` direct `GlobalSettingsStore.updateSettings` | Low | Not a bug (documented caveat) | Token reads/writes use one manager instance; cross-instance staleness only exists until explicit invalidation/read-through in other instances.
| `first-run.ts` direct `GlobalSettingsStore.updateSettings` | Low | Not a bug (documented caveat) | `setupComplete` is written at end of setup flow and subsequently read in new flows.

## Fixes shipped in FN-4907

1. Added `invalidateAllGlobalSettingsCaches()` after custom-provider create/update/delete writes.
2. Inbound `/api/settings/sync-receive` now applies global fields (when local value is unset) via `store.updateGlobalSettings(...)` and invalidates caches.
3. Dashboard/daemon `PeerExchangeService` now receives initial global settings plus refreshes on `settings:updated` events so cached sync payloads are invalidated.
4. Regression tests added for each fix:
   - `custom-provider-routes.test.ts`
   - `routes-nodes-sync.test.ts`
   - `dashboard.test.ts` mesh lifecycle assertion
   - `daemon.test.ts` compatibility for new wiring

## Follow-ups
- None required; all identified stale-snapshot bugs in this audit were fixed in-task.
