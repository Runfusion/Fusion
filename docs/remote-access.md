# Remote Access Runbook

[← Docs index](./README.md)

This runbook is the canonical operator reference for Fusion Remote Access across:

- Dashboard (`fn dashboard`)
- Interactive TUI (`fn dashboard` in TTY mode)
- Headless node mode (`fn serve`)

It documents only behavior implemented in the current codebase:

- Project-scoped `remoteAccess` settings in `.fusion/config.json`
- API endpoints under `/api/remote/*` and `/api/remote-access/auth/login-url`
- Public login handoff route `GET /remote-login?rt=...`
- Engine tunnel lifecycle and safe restore diagnostics

---

## 1) Prerequisites

## 1.1 General requirements

- Remote Access is **project-scoped** (`ProjectSettings.remoteAccess` in `packages/core/src/types.ts`).
- Configure it in dashboard settings (Remote tab) or via `PUT /api/settings`.
- A provider must be selected (`remoteAccess.activeProvider`) before tunnel start.
- Start/stop is always manual through `/api/remote/tunnel/start` and `/api/remote/tunnel/stop`.

## 1.2 Tailscale Serve prerequisites

Tailscale provider startup gates:

- `remoteAccess.providers.tailscale.enabled = true`
- `remoteAccess.providers.tailscale.hostname` is non-empty
- `remoteAccess.providers.tailscale.targetPort` is a positive number
- `tailscale` executable is available on `PATH`

Runtime command used by engine:

- `tailscale funnel <targetPort>`

Operational notes:

- Fusion validates executable availability (`which tailscale` / `where tailscale`) before start.
- If prerequisites are missing, start returns a prerequisite/config error (HTTP 409 from API start route).

## 1.3 Cloudflare named tunnel prerequisites

Cloudflare **named tunnel** startup gates (`quickTunnel = false`):

- `remoteAccess.providers.cloudflare.enabled = true`
- `remoteAccess.providers.cloudflare.quickTunnel = false` (default)
- `remoteAccess.providers.cloudflare.tunnelName` is non-empty
- `remoteAccess.providers.cloudflare.ingressUrl` is non-empty (must parse as `http://` or `https://` for login URL generation)
- `remoteAccess.providers.cloudflare.tunnelToken` is non-empty
- `cloudflared` executable is available on `PATH`

Runtime command used by engine:

- `cloudflared tunnel --no-autoupdate run <tunnelName>`
- Token is passed via env (`TUNNEL_TOKEN`), not as a plain CLI argument.

## 1.4 Cloudflare Quick Tunnel prerequisites

Cloudflare **Quick Tunnel** startup gates (`quickTunnel = true`):

- `remoteAccess.providers.cloudflare.enabled = true`
- `remoteAccess.providers.cloudflare.quickTunnel = true`
- `cloudflared` executable is available on `PATH`

No Cloudflare account, tunnel token, named tunnel, or pre-created ingress URL is required.

Dashboard note: in Settings → Remote Access, selecting Cloudflare now performs a proactive `cloudflared` CLI detection check and shows a one-click **Install cloudflared** action (with manual command fallback) if the binary is missing.

Runtime command used by engine:

- `cloudflared tunnel --url http://localhost:<dashboardPort>`

Operational notes:

- `trycloudflare.com` URLs are ephemeral and typically change every tunnel restart.
- Login URL generation for quick tunnel mode uses the **live runtime URL** reported by the running tunnel.
- If the tunnel is not started yet, login URL generation cannot resolve a remote base URL.

---

## 2) Configuration and provider operations

## 2.1 Configure both providers (recommended)

You can persist both provider configs and switch between them without rewriting settings.

Minimal `remoteAccess` shape (redacted placeholders):

```json
{
  "remoteAccess": {
    "enabled": true,
    "activeProvider": "tailscale",
    "providers": {
      "tailscale": {
        "enabled": true,
        "hostname": "<host>",
        "targetPort": 4040,
        "acceptRoutes": false
      },
      "cloudflare": {
        "enabled": true,
        "quickTunnel": false,
        "tunnelName": "<tunnel-name>",
        "tunnelToken": "<token>",
        "ingressUrl": "https://<host>"
      }
    },
    "tokenStrategy": {
      "persistent": {
        "enabled": true,
        "token": null
      },
      "shortLived": {
        "enabled": true,
        "ttlMs": 900000,
        "maxTtlMs": 86400000
      }
    },
    "lifecycle": {
      "rememberLastRunning": false,
      "wasRunningOnShutdown": false,
      "lastRunningProvider": null
    }
  }
}
```

## 2.2 Switch active provider

Switch provider (settings-level):

- `POST /api/remote/provider/activate` with `{ "provider": "tailscale" | "cloudflare" }`

Important behavior:

- Provider activation updates selected provider only.
- Activation does **not** start the tunnel by itself.

## 2.3 Start and stop tunnel manually

- Start: `POST /api/remote/tunnel/start`
- Stop: `POST /api/remote/tunnel/stop`
- Kill external funnel bindings: `POST /api/remote/tunnel/kill-external`
- Status: `GET /api/remote/status`

Returned status fields include:

- `state`: `stopped | starting | running | stopping | failed`
- `provider`, `url`, `lastError`, `lastErrorCode`
- `externalTunnel` (nullable): detected externally-running tunnel metadata (`provider`, `url`) when Fusion-managed tunnel is stopped
- `restore` diagnostics block (`outcome`, `reason`, `at`, `provider`, optional `message`)

---

## 3) Restore-on-restart semantics (remember last running)

Fusion attempts restore during engine startup only when all gates pass:

1. `remoteAccess.enabled = true`
2. `remoteAccess.lifecycle.rememberLastRunning = true`
3. `remoteAccess.lifecycle.wasRunningOnShutdown = true`
4. A valid provider is available (`lastRunningProvider` or `activeProvider`)
5. Provider config is complete and runtime prerequisites (binary on `PATH`) are satisfied

If any gate fails, startup continues and restore is skipped safely.

## 3.1 Restore outcomes

`GET /api/remote/status` includes restore diagnostics:

- `outcome: "applied" | "skipped" | "failed"`
- `reason` code (examples):
  - `not_attempted`
  - `remote_access_disabled`
  - `remember_last_running_disabled`
  - `no_prior_running_marker`
  - `provider_missing`
  - `provider_not_enabled`
  - `provider_not_configured`
  - `runtime_prerequisite_missing`
  - `restore_started`
  - `restore_start_failed`

## 3.2 Marker behavior and safety

- Explicit manual stop clears restart intent markers:
  - `wasRunningOnShutdown = false`
  - `lastRunningProvider = null`
- Failed/skipped restore clears stale running markers to avoid retry loops.
- Restore failure is non-fatal to engine startup.

---

## 4) Operation paths: Dashboard vs TUI vs headless

## 4.1 Dashboard (`fn dashboard`)

Path: **Settings → Remote Access**

Supported actions:

- Save Remote settings (provider config + token strategy)
- Activate provider
- Start/Stop tunnel
- Detect externally-running Tailscale funnel sessions when opening Remote Access settings
- Use Existing (adopt existing tunnel) or Start Fresh (kill external funnel bindings then start a managed tunnel)
- Regenerate persistent token
- Generate short-lived token
- Show authenticated URL
- Generate QR payload (SVG preview + raw details)

## 4.2 TUI (`fn dashboard` in TTY mode)

Path: **Interactive → Settings**

Remote hotkeys:

- `C` activate selected provider
- `V` start tunnel
- `X` stop tunnel
- `P` regenerate persistent token
- `L` enter TTL flow + generate short-lived token
- `U` fetch authenticated URL
- `K` fetch QR payload
- `R` refresh remote status

## 4.3 Headless API (`fn serve`)

`fn serve` runs with `headless: true` and exposes the same remote endpoints:

- `/api/remote/*` status/control
- `/api/remote-access/auth/login-url`
- `/remote-login?rt=...` public login handoff route

Parity expectations:

- Remote control/status contracts are the same in dashboard and headless runtime.
- Root SPA route is not served in headless mode (API operation only).

---

## 5) API quick reference

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/remote/settings` | Return summarized remote settings (masked persistent token) |
| `GET` | `/api/remote/status` | Return tunnel status + restore diagnostics |
| `POST` | `/api/remote/provider/activate` | Set active provider |
| `POST` | `/api/remote/tunnel/start` | Start active provider tunnel |
| `POST` | `/api/remote/tunnel/stop` | Stop current tunnel |
| `POST` | `/api/remote/token/persistent/regenerate` | Generate and persist new persistent token |
| `POST` | `/api/remote/token/short-lived/generate` | Generate short-lived token (`ttlMs` optional in body) |
| `POST` | `/api/remote-access/auth/login-url` | Build login URL (`mode: persistent | short-lived`) |
| `GET` | `/api/remote/url` | Build login URL payload (`tokenType` query) |
| `GET` | `/api/remote/qr` | Build QR payload (`tokenType`, optional `format=image/svg`) |
| `GET` | `/remote-login?rt=<token>` | Validate remote token and 302 redirect to `/` or `/?token=...` |

---

## 6) Security caveats for login URLs and QR flow

> ⚠️ **Critical:** Remote auth links and QR payloads contain the full authenticated login URL, including `rt` token data in the query string.
>
> Example shape (redacted): `https://<host>/remote-login?rt=<token>`

Treat these links as secrets.

- Do **not** post them in chat, tickets, screenshots, screen recordings, or logs.
- Do **not** paste them into shared documents.
- Assume any copied URL can be replayed until token expiry/rotation.

## 6.1 Hybrid token model

Fusion supports two token modes for remote login handoff:

1. **Persistent token** (`remoteAccess.tokenStrategy.persistent`)
   - Stored in project settings.
   - Reused across generated links until regenerated.
   - `GET /api/remote/settings` returns a **masked** representation only.

2. **Short-lived token** (`remoteAccess.tokenStrategy.shortLived`)
   - Issued in-memory by dashboard server runtime.
   - Expires by TTL and is removed when expired.
   - Registry is process-local and is cleared on server restart.

Recommended usage by risk level:

- **Low-risk/internal lab:** persistent links may be acceptable for convenience.
- **Shared environments / ad-hoc phone login:** prefer short-lived links.
- **High-risk or uncertain channel hygiene:** use short-lived links with minimal TTL and regenerate/rotate frequently.

## 6.2 Token hygiene and rotation practices

- Prefer short-lived mode for one-time phone scans.
- If exposure is suspected, regenerate persistent token immediately (`POST /api/remote/token/persistent/regenerate`).
- Keep short-lived TTL as small as practical for the operator workflow.
- Avoid storing tokenized URLs in shell history where possible.
- Redact secrets in examples and runbooks (`<host>`, `<token>`, `<expiresAt>`).

---

## 7) Troubleshooting matrix

| Symptom | Likely cause | What to check | Remediation |
|---|---|---|---|
| `POST /api/remote/tunnel/start` returns 409 with prerequisite/config message | Provider config incomplete or runtime binary missing | Verify active provider, required provider fields, and executable presence on `PATH` (`tailscale` or `cloudflared`) | Fix provider config (`PUT /api/settings`) and install/repair missing binary, then retry start |
| Tunnel remains `stopped` after provider switch | Provider was activated but tunnel start was never requested | `GET /api/remote/status` and confirm no start request was made | Run explicit start (`POST /api/remote/tunnel/start`) after activation |
| `GET /remote-login?rt=<token>` returns `401` `remote_token_missing` | Missing `rt` query token | Validate URL structure includes `?rt=<token>` | Regenerate/fetch URL via `/api/remote-access/auth/login-url`, `/api/remote/url`, or `/api/remote/qr` |
| `GET /remote-login?rt=<token>` returns `401` `remote_token_expired` | Short-lived token expired | Check `expiresAt` from generation response and local clock drift | Generate a new short-lived token/login URL and retry |
| `GET /remote-login?rt=<token>` returns `401` `remote_token_invalid` | Wrong/rotated token or disabled token strategy | Confirm token mode and whether persistent token was regenerated | Re-fetch a current URL; if needed re-enable token strategy and rotate token |
| Restart does not restore prior running tunnel even with remember enabled | Restore gates failed or stale marker reconciled | Inspect `/api/remote/status.restore` (`outcome`, `reason`, optional `message`) | Resolve reported reason (`provider_not_configured`, `runtime_prerequisite_missing`, etc.), then start manually |
| Dashboard and headless behavior appear different | Different runtime/auth context (project selection, bearer token, host) | Confirm same project config and same endpoint calls in both modes | Use `/api/remote/status` and `/api/remote/settings` to compare canonical state; align auth/token/project context |

### 7.1 Mode-specific checks

- **Dashboard/TUI:** Ensure you saved remote settings before lifecycle operations.
- **Headless (`fn serve`):** Ensure API auth context is valid for protected `/api/*` calls.
- **All modes:** `GET /remote-login` remains a public handoff route by design, but only accepts valid remote token material.
