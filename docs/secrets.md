# Secrets

[← Docs index](./README.md)

## Overview

Fusion's secrets subsystem provides encrypted-at-rest secret storage with project scope (`.fusion/fusion.db`) and global scope (`~/.fusion/fusion-central.db`).

## Implementation Status

| Surface | Status | Follow-up | Source of truth |
|---|---|---|---|
| AES-256-GCM encryption primitives | Shipped | — | `packages/core/src/secrets-crypto.ts` |
| `SecretsStore` CRUD + `revealSecret` | Shipped | — | `packages/core/src/secrets-store.ts` |
| Per-secret access policy + global fallback resolver | Shipped | — | `packages/core/src/secret-access-policy.ts` |
| `MasterKeyManager` (keychain primary, file fallback) | Shipped | — | `packages/core/src/master-key.ts` |
| `fn_secret_get` pi-extension tool (auto/prompt/deny + missing-key) | Shipped | — | `packages/cli/src/extension.ts` |
| `secret:read` / `secret:approval-requested` / `secret:approval-denied` audit events | Shipped | — | `packages/cli/src/extension.ts` (`emitSecretAudit`) |
| Approval API integration for `prompt` policy (`ApprovalRequestStore` + `POST /api/approvals/:id/decision`) | Shipped | — | `packages/cli/src/extension.ts` |
| `secrets-sync.ts` wrap/unwrap core (scrypt → AES-256-GCM, version 1, typed errors) | Shipped | — | `packages/core/src/secrets-sync.ts` |
| Dashboard `SecretsView` CRUD UI | Shipped | — | `packages/dashboard/app/components/SecretsView.tsx` |
| `secretsEnv.*` settings + worktree `.env` materialization + fingerprint cleanup | Shipped | — | `packages/core/src/types.ts`, `packages/engine/src/secrets-env-writer.ts` |
| `secretsSyncPassphraseConfigured` global read-only probe + reserved secret storage (`__sync_passphrase__`) | Shipped | — | `packages/core/src/types.ts`, `packages/core/src/secrets-sync-passphrase.ts` |
| Cross-node sync REST endpoints (`/api/nodes/:id/secrets/{push,pull}`, `/api/secrets/sync-receive`, `/api/secrets/sync-export`) | Shipped | — | `packages/dashboard/src/routes/register-secrets-sync-routes.ts`, `packages/dashboard/src/routes/register-secrets-sync-inbound-routes.ts` |
| Audit-event registration on `FilesystemMutationType` for `secret:env-*` and `secret:sync-*` | Shipped | — | `packages/engine/src/run-audit.ts` |
| Master-key rotation UX | Pending | — | n/a |
| Per-secret TTL / rotation, KMS/Vault backends, per-node asymmetric sync | Out of scope | — | n/a |

Current shipped behavior in this branch includes:

- AES-256-GCM encryption primitives (`packages/core/src/secrets-crypto.ts`)
- CRUD + reveal APIs via `SecretsStore` (`packages/core/src/secrets-store.ts`)
- Per-secret access policy metadata (`auto` / `prompt` / `deny`)
- Schema-backed read metadata (`last_read_at`, `last_read_by`)

Threat-model baseline:

- Secret plaintext is **not** stored in SQLite.
- Ciphertext + nonce are persisted; plaintext exists only in process memory during create/reveal.
- Secret values must never be logged.

See also: [Storage](./storage.md), [Multi-project](./multi-project.md), [Architecture](./architecture.md), [Settings reference](./settings-reference.md).

## Architecture

Fusion stores secrets in two SQLite tables:

- Project scope: `secrets` in `.fusion/fusion.db`
- Global scope: `secrets_global` in `~/.fusion/fusion-central.db`

Both tables share the same column contract:

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT` | Primary key UUID. |
| `key` | `TEXT` | Unique secret key (`idxSecretsKey` / `idxSecretsGlobalKey`). |
| `value_ciphertext` | `BLOB` | AES-GCM ciphertext payload (includes auth tag). |
| `nonce` | `BLOB` | Per-row random nonce. |
| `description` | `TEXT` | Optional metadata. |
| `access_policy` | `TEXT` | `CHECK` constrained to `auto`, `prompt`, `deny`. |
| `env_exportable` | `INTEGER` | `0/1` flag for env-materialization intent metadata. |
| `env_export_key` | `TEXT` | Optional env variable key metadata. |
| `created_at` | `TEXT` | ISO timestamp. |
| `updated_at` | `TEXT` | ISO timestamp. |
| `last_read_at` | `TEXT` | Last reveal timestamp. |
| `last_read_by` | `TEXT` | Agent/user identifier recorded on reveal. |

For broader database inventory, see [docs/storage.md](./storage.md).

## Encryption

Secret crypto uses AES-256-GCM with:

- 32-byte master key
- 12-byte random nonce per encrypt operation
- 16-byte auth tag appended to ciphertext

Implementation reference: `packages/core/src/secrets-crypto.ts`.

## Master Key Resolution

The current implementation exposes a `MasterKeyProvider` abstraction consumed by `createSecretCipher` / `SecretsStore`.

- Required contract: async provider that returns a **32-byte** key.
- Validation failures return non-sensitive `SecretCryptoError` codes.

Runtime keychain/filesystem resolution is shipped via `MasterKeyManager` (`packages/core/src/master-key.ts`) with keychain-primary lookup and `~/.fusion/master.key` fallback (mode `0600`); rotation UX remains follow-up work.

## Access Policies

Per-secret policy values are:

- `auto`
- `prompt`
- `deny`

Resolution helper (`resolveSecretAccessPolicy`) uses:

1. Row-level secret policy (if set)
2. Global settings default `secretsAccessPolicy` (if set)
3. Fallback: `prompt`

Implementation references:

- `packages/core/src/secret-access-policy.ts`
- `packages/core/src/types.ts` (`GlobalSettings.secretsAccessPolicy`)

Approval integration is active through `fn_secret_get` policy handling (`packages/cli/src/extension.ts:1581-1611`) and approvals lifecycle APIs.

## Dashboard CRUD

Dashboard secrets CRUD is shipped via `SecretsView` (`packages/dashboard/app/components/SecretsView.tsx`), backed by the existing secrets API/store surfaces.

## Agent Access (`fn_secret_get`)

`fn_secret_get` is shipped in `packages/cli/src/extension.ts:1542-1629`.

Tool contract:
- Params: `key` (required), `scope?: "project" | "global"`.
- Resolution: when `scope` is omitted, lookup is project → global; when provided, only that scope is queried. Missing key returns `{ error: "not-found" }`.
- Policy outcomes:
  - `auto` → reveals and returns plaintext value (`secret:read` audit at `extension.ts:1615`).
  - `prompt` → creates `ApprovalRequestStore` request (`secret-read:{scope}:{key}:{agentId}` dedupe key) and returns `{ outcome: "pending_approval", approvalRequestId }` (`extension.ts:1607-1611`).
  - `deny` → immediate refusal and `secret:approval-denied` audit (`extension.ts:1581-1583`).

## `.env` Auto-write into Worktrees

Fusion can materialize env-exportable secrets into each acquired task worktree when project settings enable it (`secretsEnv.enabled=true`).

- Supported settings: `enabled`, `filename` (default `.env`, validated as local filename only), `overwritePolicy` (`skip`/`merge`/`replace`), `keyPrefix`, `requireGitignored` (default `true`).
- Safety guard: when `requireGitignored` is enabled, Fusion runs `git check-ignore -- <filename>` and refuses writes unless the file is ignored.
- Write contract: managed content is canonicalized and written atomically with mode `0o600`; audit metadata includes keys and counts, never values.
- Fingerprint sidecar: successful writes persist `.fusion-secrets-env.fingerprint` containing `<sha256>\n<filename>\n` (mode `0o600`) so teardown can verify file integrity before deletion.
- Teardown cleanup: when a worktree is removed, Fusion deletes the managed env file only when the on-disk fingerprint still matches; edited files are preserved and only the sidecar is removed.

Settings shape is split by scope: project-level secrets settings are limited to `ProjectSettings.secretsEnv`, while cross-node sync passphrase state is stored only as the reserved `__sync_passphrase__` row in `secrets_global` and exposed read-only through `GlobalSettings.secretsSyncPassphraseConfigured` (`packages/core/src/types.ts`). Settings never carry the plaintext passphrase.

### Test locations

The settings contract (`SecretsEnvSettings` shape, defaults, project round-trip) is covered in `@fusion/core`:

- `packages/core/src/__tests__/secrets-env.test.ts` — type contract + defaults
- `packages/core/src/__tests__/store-settings.test.ts` — `secretsEnv` project round-trip
- `packages/core/src/__tests__/store-settings-sync-passphrase-probe.test.ts` — read-only `secretsSyncPassphraseConfigured` derivation + write-strip behavior

The materialization implementation lives in `@fusion/engine` and is covered there:

- `packages/engine/src/secrets-env-writer.ts` — `writeSecretsEnvFile` / `cleanupSecretsEnvFile`
- `packages/engine/src/__tests__/secrets-env-writer.test.ts` — writer/cleanup unit coverage
- `packages/engine/src/__tests__/worktree-acquisition-secrets-env.test.ts` — acquisition-time write
- `packages/engine/src/__tests__/worktree-pool-secrets-env-cleanup.test.ts` — pool prune cleanup
- `packages/engine/src/__tests__/reliability-interactions/secrets-env-materialization.test.ts` — cross-layer backstop

New FN tasks that need to verify env materialization should target the engine-side files; the core-side test only guards the settings contract.

## Cross-node Sync

Fusion now exposes four secrets sync endpoints:

- `POST /api/nodes/:id/secrets/push` — wraps local secrets into a passphrase-protected envelope and sends it to a remote node.
- `POST /api/nodes/:id/secrets/pull` — fetches a remote envelope from `GET /api/secrets/sync-export` and applies it locally.
- `POST /api/secrets/sync-receive` — inbound apply endpoint (Bearer `apiKey` required).
- `GET /api/secrets/sync-export` — inbound export endpoint (Bearer `apiKey` required).

Envelope format is `WrappedSecretsBundle` from `packages/core/src/secrets-sync.ts:33-38`: `{ version, ciphertext, salt, nonce, kdf, kdfParams }` plus transport metadata (`sourceNodeId`, `exportedAt`). Wrapping uses scrypt (`N=32768, r=8, p=1, keyLen=32`, `secrets-sync.ts:17-22`) and AES-256-GCM with base64 `ciphertext`/`salt`/`nonce` (`secrets-sync.ts:68-78`).

Sync passphrase storage is local-only: reserved key `__sync_passphrase__` in `secrets_global` with `access_policy="deny"` and `env_exportable=false`, encrypted under the local master key. The passphrase is never transmitted and never returned by HTTP endpoints.

Dashboard UX now exposes this through SecretsView → **Cross-Node Sync Passphrase**. The panel uses `GET/PUT/DELETE /api/secrets/sync-passphrase`; the GET route returns only `{ configured: boolean }` (no plaintext readback), and the reserved `__sync_passphrase__` row is filtered from the regular `GET /api/secrets` list.

Error mapping:

- `SecretsSyncError` codes (`wrong-passphrase`, `version-mismatch`, `malformed`) return HTTP `400` with `{ "error": <code> }`.
- Missing passphrase returns HTTP `400` with `{ "error": "passphrase-not-configured" }`.
- Bearer auth failures return HTTP `401`.

Inbound auth contract is enforced in route code (`packages/dashboard/src/routes/register-secrets-sync-inbound-routes.ts:99-114`, `:181-196`): missing/invalid Bearer `Authorization` or mismatched local `apiKey` returns 401.

Audit payloads exclude plaintext values, passphrases, and envelope crypto material (`ciphertext`, `salt`, `nonce`).

## Audit Events

Filesystem-domain secret audit taxonomy:

- `secret:read`
- `secret:create`
- `secret:update`
- `secret:delete`
- `secret:approval-requested`
- `secret:approval-granted`
- `secret:approval-denied`
- `secret:sync-push`
- `secret:sync-pull`
- `secret:env-write`
- `secret:env-write-skipped`
- `secret:env-cleanup`
- `secret:env-cleanup-skipped`

All listed events are enumerated in `packages/engine/src/run-audit.ts:261-274` (union at `run-audit.ts:325`). Route/tool emitters include: `secret:sync-push` (`packages/dashboard/src/routes/register-secrets-sync-routes.ts:92`), `secret:sync-pull` (`register-secrets-sync-routes.ts:180`, `register-secrets-sync-inbound-routes.ts:158-164`), `secret:read` + approval events (`packages/cli/src/extension.ts:1581-1615`), env materialization/cleanup (`packages/engine/src/secrets-env-writer.ts:99-217`).

Track follow-up: **FN-5031** (missing `packages/core/src/__tests__/secrets-env.test.ts` contract file).

**Plaintext prohibition:** audit payload metadata must never include plaintext, decrypted values, ciphertext, or nonce fields. Use `assertNoSecretPlaintext(...)` as the canonical enforcement helper before emitting secret audit events.

## Operational Notes

- Backups: preserve both SQLite data and master-key material/provider source used by deployment.
- If master key material is lost, encrypted secret values become unrecoverable.
- Pending advanced capabilities:
  - Master-key rotation UX and key lifecycle tooling
  - TTL/rotation automation, env-set profiles, KMS/Vault backends, per-node asymmetric sync
