# Dev Server Module Boundary Audit

_Last audited: 2026-04-21 (FN-2213)_

## Why this exists

`packages/dashboard/src` currently has two parallel module families with near-identical intent:

- `dev-server-*` (hyphenated)
- `devserver-*` (non-hyphenated)

This overlap was introduced during FN-2183 and creates ambiguity about which stack owns production behavior.

## Boundary / Ownership Inventory

### Canonical runtime stack (currently in use)

The **hyphenated `dev-server-*` stack** is wired into the dashboard API/runtime path and should be treated as the active owner today.

| Area | Owner files |
|---|---|
| API routes and SSE stream (`/api/dev-server/*`) | `dev-server-routes.ts` |
| Process lifecycle (spawn/stop/restart, URL detection) | `dev-server-process.ts` |
| Persistent runtime/config state | `dev-server-store.ts` (`.fusion/dev-server.json`) |
| Script detection for API `detect` endpoint | `dev-server-detect.ts` |
| Server lifecycle shutdown integration | `routes.ts`, `server.ts` import `dev-server-routes.ts` |

### Secondary prototype stack (not wired to runtime)

The **non-hyphenated `devserver-*` stack** is currently isolated to itself plus direct tests.

| Area | Files | Current reachability |
|---|---|---|
| Alternate manager/types/persistence/detection model | `devserver-manager.ts`, `devserver-types.ts`, `devserver-persistence.ts`, `devserver-detect.ts` | Not imported by `routes.ts`, `server.ts`, or active API handlers |
| Persistence format | `.fusion/devserver.json` | Separate from canonical `.fusion/dev-server.json` |
| Coverage | `__tests__/devserver-*.test.ts` | Unit tests only |

## Risk Assessment

1. **Import confusion:** both families expose similarly named concepts (manager, detect, persistence).
2. **Data divergence risk:** two persistence files (`dev-server.json` vs `devserver.json`) can drift if both are used.
3. **Onboarding drag:** contributors must infer ownership from import graph instead of explicit docs.
4. **Refactor tax:** bug fixes can land in the wrong family and miss production paths.

## FN-2212 Prioritization Recommendation

- **Priority:** **P1 (High)**
- **Size:** **M**
- **Reasoning:** The risk is primarily maintainability/correctness drift (not immediate runtime outage), but ambiguity sits on a core dashboard subsystem and should be resolved before additional dev-server features land.

## Recommended FN-2212 Execution Plan

1. **Lock ownership in docs and code comments**
   - Explicitly mark `dev-server-*` as canonical runtime owner.
   - Explicitly mark `devserver-*` as experimental/legacy candidate.
2. **Choose consolidation direction (single owner required)**
   - Preferred: consolidate on `dev-server-*` (already integrated).
   - Alternative: migrate runtime wiring to `devserver-*` only if there is a clear capability gap worth the migration cost.
3. **Remove or migrate the non-owner stack**
   - If consolidating on `dev-server-*`: remove `devserver-*` modules/tests or relocate them behind an explicit experimental namespace.
   - If consolidating on `devserver-*`: complete route/server integration and delete replaced `dev-server-*` modules.
4. **Guard against reintroduction**
   - Add a lightweight lint/test assertion that prevents both naming families from being reintroduced without explicit architecture note/update.

## FN-2212 Definition of Done (proposed)

- There is one clearly documented canonical dev-server module family.
- Runtime/API imports use only the canonical family.
- The non-canonical family is either removed or explicitly isolated as experimental with zero ambiguity.
- Architecture docs and contributor guidance call out the owner modules and persistence file contract.
