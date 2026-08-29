# FN-4886 — Secrets Sync API auth parity verification

## 1) Summary
Auth/ownership parity between settings-sync and secrets-sync routes is **implemented for shipped endpoints** (`POST /api/nodes/:id/secrets/push`, `POST /api/nodes/:id/secrets/pull`, `POST /api/secrets/sync-receive`, `GET /api/secrets/sync-export`). Outbound routes enforce remote-node `apiKey` presence and send `Authorization: Bearer <node.apiKey>` via the shared `fetchFromRemoteNode` helper; inbound routes implement the same 401 cascade as settings-sync baseline. Passphrase/envelope failures are correctly mapped to 400-class functional errors (not auth). Gaps are primarily **coverage/documentation parity** (missing explicit auth tests for sync-export and missing explicit outbound missing-apiKey test in secrets suite; stale planned text in settings-reference docs).

## 2) Parity Matrix

| Endpoint | Settings-sync baseline | Secrets-sync implementation | Parity |
|---|---|---|---|
| `POST /api/nodes/:id/secrets/push` (outbound) | Outbound routes call `fetchFromRemoteNode(...)`; helper requires `node.apiKey` and sends `Authorization: Bearer ${node.apiKey}` (`packages/dashboard/src/routes/register-settings-sync-helpers.ts:96-121`). Settings push uses helper (`.../register-settings-sync-routes.ts:118-125`). | Secrets push explicitly rejects missing/blank `node.apiKey` (`.../register-secrets-sync-routes.ts:68-70`) and calls same helper for remote POST (`.../register-secrets-sync-routes.ts:83-90`). | ✅ |
| `POST /api/nodes/:id/secrets/pull` (outbound) | Same helper contract (`.../register-settings-sync-helpers.ts:96-121`); settings pull uses helper (`.../register-settings-sync-routes.ts:181-184`). | Secrets pull rejects missing/blank `node.apiKey` (`.../register-secrets-sync-routes.ts:126-128`) and calls same helper for GET export (`.../register-secrets-sync-routes.ts:137`). | ✅ |
| `POST /api/secrets/sync-receive` (inbound) | 401 cascade baseline in settings inbound: missing/invalid Bearer header → 401, missing local node → 401, empty token → 401, missing local apiKey → 401, mismatch → 401 (`.../register-settings-sync-inbound-routes.ts:27-50`). | Secrets sync-receive uses identical cascade (`.../register-secrets-sync-inbound-routes.ts:99-118`). | ✅ |
| `GET /api/secrets/sync-export` (inbound, shipped) | Same settings inbound auth-export cascade (`.../register-settings-sync-inbound-routes.ts:215-239`). | Secrets sync-export uses identical cascade (`.../register-secrets-sync-inbound-routes.ts:181-200`). | ✅ |

### Passphrase/envelope error mapping separation (auth vs functional)
- `passphrase-not-configured` returns 400 on receive/export/push/pull paths (`register-secrets-sync-inbound-routes.ts:137-139,204-206`; `register-secrets-sync-routes.ts:74-76,132-134`).
- `version-mismatch` returns 400 before unwrap on inbound receive (`register-secrets-sync-inbound-routes.ts:130-133`).
- `wrong-passphrase` / `malformed` originate from `SecretsSyncError` codes in unwrap logic (`packages/core/src/secrets-sync.ts:40-45,81-111`) and are surfaced as 400 (`register-secrets-sync-inbound-routes.ts:146-148`; `register-secrets-sync-routes.ts:142-144`).

## 3) Test Evidence

### Secrets test coverage present
- Inbound `sync-receive` 401 variants (missing/malformed/mismatched Bearer and empty local apiKey) in a single case loop (`packages/dashboard/src/__tests__/routes-secrets-sync.test.ts:131-142`).
- Inbound functional 400 mapping for `version-mismatch`, `passphrase-not-configured`, `wrong-passphrase`, `malformed` (`.../routes-secrets-sync.test.ts:144-170`).
- Outbound pull functional wrong-passphrase mapping (`.../routes-secrets-sync.test.ts:123-129`).
- Outbound push/pull happy-paths and envelope shape assertions (`.../routes-secrets-sync.test.ts:71-92,106-121`).

### Settings analog shape
- Settings suite uses direct `global.fetch` mocking to validate outbound bearer/header behavior (`packages/dashboard/src/__tests__/routes-nodes-sync.test.ts:201-204,235-241,311-316`). This matches `fetchFromRemoteNode` being a thin wrapper around `fetch` (`packages/dashboard/src/routes/register-settings-sync-helpers.ts:139-154`).

### Test-coverage gaps
- Missing explicit secrets outbound test for remote node missing `apiKey` on `/api/nodes/:id/secrets/push` and `/api/nodes/:id/secrets/pull` (route guards exist at `register-secrets-sync-routes.ts:68-70,126-128`).
- Missing explicit secrets inbound auth-cascade test coverage for `GET /api/secrets/sync-export` (route guard exists at `register-secrets-sync-inbound-routes.ts:181-200`; current test only validates happy path + no passphrase, `routes-secrets-sync.test.ts:184-195`).

## 4) Multi-node Behavior
- Shared passphrase requirement is implementation-enforced via local reserved secret lookup (`getSyncPassphrase`) and unwrap failure semantics (`packages/core/src/secrets-sync-passphrase.ts:9-24`, `packages/core/src/secrets-sync.ts:107-110`). Docs state both nodes must share passphrase (`docs/secrets.md:115-121`).
- Planning expected a writable settings key, but shipped implementation stores the passphrase only in reserved secret `__sync_passphrase__` and now exposes state through read-only `GlobalSettings.secretsSyncPassphraseConfigured` (`packages/core/src/secrets-sync-passphrase.ts:1-24`).
- No dedicated dashboard passphrase UX surfaced in routes/components reviewed; configuration remains implicit through secret storage primitives, so multi-node setup discoverability is partial.
- Pull path handles remote envelope version mismatch because `unwrapSecretsBundle` throws `version-mismatch` on non-v1 (`packages/core/src/secrets-sync.ts:82-84`) and route maps `SecretsSyncError.code` to 400 (`register-secrets-sync-routes.ts:139-144`).
- Audit payload hygiene: push logs only `{ nodeId, recordCount }` (`register-secrets-sync-routes.ts:92`); pull logs `{ nodeId, key, scope }` (`register-secrets-sync-routes.ts:180`); inbound receive logs `{ nodeId, key, scope }` (`register-secrets-sync-inbound-routes.ts:155-159`). No plaintext/ciphertext/passphrase fields are emitted.
- Sync passphrase material does not cross wire in route payload construction: outbound push sends envelope + `sourceNodeId`/`exportedAt` only (`register-secrets-sync-routes.ts:83-89`); inbound export returns envelope + metadata (`register-secrets-sync-inbound-routes.ts:209-213`). Passphrase material is only used locally in wrap/unwrap calls.

## 5) Gaps & Follow-ups
- [FN-4981] Add secrets-sync tests for outbound missing-remote-apiKey failure paths for push/pull. ✅ Landed (routes-secrets-sync now covers undefined/""/null apiKey plus guard-ordering invariant).
- [FN-4980] Add secrets-sync tests for full inbound auth-cascade on `GET /api/secrets/sync-export`.
- [FN-4982/FN-5035] Reconciled settings-reference docs with implementation: read-only global probe (`secretsSyncPassphraseConfigured`) + reserved-secret storage model.
- [FN-4984] Add/clarify dashboard UX for configuring the shared sync passphrase (or equivalent guided setup).

## 6) References
- `packages/dashboard/src/routes/register-settings-sync-inbound-routes.ts:27-50,215-239`
- `packages/dashboard/src/routes/register-settings-sync-routes.ts:118-125,181-184`
- `packages/dashboard/src/routes/register-settings-sync-helpers.ts:96-121,139-154`
- `packages/dashboard/src/routes/register-secrets-sync-routes.ts:68-70,83-90,126-128,137,139-144,180`
- `packages/dashboard/src/routes/register-secrets-sync-inbound-routes.ts:99-118,130-133,137-139,146-148,181-200,204-206,209-213`
- `packages/dashboard/src/__tests__/routes-secrets-sync.test.ts:71-92,106-142,144-170,184-195`
- `packages/dashboard/src/__tests__/routes-nodes-sync.test.ts:201-204,235-241,311-316,1542-1570`
- `packages/core/src/secrets-sync.ts:40-45,81-111`
- `packages/core/src/secrets-sync-passphrase.ts:9-24`
- `docs/secrets.md:108-121`
- `docs/settings-reference.md:91,198`
