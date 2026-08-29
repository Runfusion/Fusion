# Paperclip Runtime Plugin

Drives a [Paperclip](https://paperclip.ing/) agent (an "employee" in a Paperclip company) via the wakeup + heartbeat-run API. Each Fusion prompt becomes a Paperclip *task*, not a chat completion.

## Mental model — read this first

Paperclip is a **control plane** for AI labor. Agents are long-lived employees with budgets, chains of command, and approval gates; *Paperclip itself does not run models* — it dispatches work to adapters (claude_local, codex_local, openclaw, http, …) which run the actual LLM call inside their own heartbeat.

This plugin proxies a Fusion conversation through one of those Paperclip agents:

1. (Optionally) creates a Paperclip *issue* with the prompt as its body, assigned to your chosen agent.
2. Calls `POST /api/agents/{id}/wakeup` with `payload: { prompt, fusionSessionId, issueId }` and an idempotency key.
3. Streams `GET /api/heartbeat-runs/{runId}/events`, forwarding `heartbeat.run.log` chunks to the chat UI.
4. On terminal status (`succeeded | failed | cancelled | timed_out`), reads the issue's final state and the agent's closing comment.

**Implications:**
- **Latency is task-shaped** (seconds to minutes), not chat-shaped.
- **Governance applies**: budget caps, approval requirements, audit log all come from Paperclip.
- **A single Paperclip agent can be proxied from many Fusion sessions concurrently.**

## Prerequisites

A running Paperclip server you can reach. For local development:

```bash
npm install -g paperclipai
paperclipai onboard      # interactive setup
paperclipai run          # starts the server (default: http://localhost:3100)
```

Verify the server is up:

```bash
curl http://localhost:3100/api/health
```

## Connection modes

The dashboard settings card lets you pick **API** or **CLI** mode:

### API mode (default)

Paste an `apiUrl` and an *agent* `apiKey`. Get a key from the Paperclip UI's agent detail page → "Create API Key" (the full value is shown once). For local-trusted deployments, the key may be omitted.

### CLI mode

Auto-derive the apiUrl from the local `paperclipai` install. The plugin reads `~/.paperclip/instances/default/config.json` and uses that host:port as the apiUrl. No token needs to be pasted into Fusion. For non-local-trusted deployments, you can still set an override `apiKey`.

#### CLI key bootstrap

For authenticated Paperclip deployments (e.g. `paperclip-dev` or any non-`local_trusted` instance), a bearer token is required. The dashboard offers a one-click "✨ Mint API key via paperclipai" button that appears in CLI mode when:

- A connection has been attempted but `available === false` (typically "API key rejected"), AND
- The user has already selected an agent in the agent picker.

The button calls `POST /api/providers/paperclip/cli-mint-key` on the Fusion backend, which spawns:

```
paperclipai agent local-cli <agentRef> --json --no-install-skills --key-name fusion-runtime
```

On success the returned `apiKey` is written into the API key field and a save-prompt toast is shown. On failure (e.g. CLI not authenticated) the toast shows the error and instructs the user to run `paperclipai onboard`.

**Requirement:** The local `paperclipai` CLI must be authenticated (`~/.paperclip/context.json` must have a valid profile). Run `paperclipai onboard` to authenticate if the mint fails.

## Conversation modes

Independent of transport, the `mode` setting controls how prompts map to Paperclip issues:

| Mode | Behavior |
|---|---|
| `rolling-issue` (default) | Creates one Paperclip issue per Fusion session; subsequent prompts add comments. Closest to chat. |
| `issue-per-prompt` | Each prompt creates a new top-level issue. Maximally explicit; clutters the board. |
| `wakeup-only` | No issue side-effects; the prompt is delivered via the wakeup payload only. Requires the agent's prompt template to handle payload-driven wakes. |

## Settings

| Key | Env var | Default | Notes |
|---|---|---|---|
| `transport` | `PAPERCLIP_TRANSPORT` | `api` | `api` or `cli`. |
| `apiUrl` | `PAPERCLIP_API_URL` | `http://localhost:3100` | API mode only. |
| `apiKey` | `PAPERCLIP_API_KEY` | (none) | API mode (and as a CLI-mode override). |
| `cliBinaryPath` | `PAPERCLIPAI_BIN` | `paperclipai` | CLI mode only. |
| `cliConfigPath` | `PAPERCLIP_CLI_CONFIG` | `~/.paperclip/instances/default/config.json` | CLI mode only. |
| `agentId` | `PAPERCLIP_AGENT_ID` | auto-derived from `/api/agents/me` | The Paperclip agent this Fusion runtime proxies. |
| `companyId` | `PAPERCLIP_COMPANY_ID` | auto-derived from `/api/agents/me` | The Paperclip company. |
| `mode` | `PAPERCLIP_RUNTIME_MODE` | `rolling-issue` | One of the conversation modes above. |
| `parentIssueId` | `PAPERCLIP_PARENT_ISSUE_ID` | (none) | Optional issue scoping. |
| `projectId` | `PAPERCLIP_PROJECT_ID` | (none) | Optional. |
| `goalId` | `PAPERCLIP_GOAL_ID` | (none) | Optional. |
| `runTimeoutMs` | `PAPERCLIP_RUN_TIMEOUT_MS` | `600000` | Local cap before Fusion stops polling. The run continues server-side. |
| `pollIntervalMs` | `PAPERCLIP_POLL_INTERVAL_MS` | `500` | Initial poll interval. |
| `pollIntervalMaxMs` | `PAPERCLIP_POLL_INTERVAL_MAX_MS` | `2000` | Max poll interval after exponential backoff. |

Settings precedence: plugin settings → env var → default.

## Public API

```ts
import {
  PaperclipRuntimeAdapter,
  // REST helpers
  agentsMe,
  listCompanies,
  listCompanyAgents,
  // Probes
  probePaperclipConnection,
  discoverPaperclipCliConfig,
  // CLI key minting
  mintAgentApiKeyViaCli,
  // Types
  type PaperclipAgentSummary,
  type PaperclipCompanySummary,
  type PaperclipConnectionStatus,
  type PaperclipCliDiscoveryResult,
  type MintCliKeyOptions,
  type MintedApiKey,
} from "@fusion-plugin-examples/paperclip-runtime";
```

- `probePaperclipConnection({ apiUrl, apiKey?, timeoutMs? })` → `{ available, identity?, reason? }`. Powers the dashboard's "✓ Connected as <agent>" badge.
- `listCompanyAgents(apiUrl, apiKey, companyId)` → list of agents in a company. Drives the agent picker.
- `discoverPaperclipCliConfig({ configPath? })` → `{ ok, apiUrl, deploymentMode? }` from the local `paperclipai` config. Drives CLI-mode auth discovery.
- `mintAgentApiKeyViaCli(opts: MintCliKeyOptions)` → `Promise<MintedApiKey>`. Spawns `paperclipai agent local-cli <agentRef> --json --no-install-skills` to mint a fresh agent API key. Throws on ENOENT, non-zero exit, or malformed JSON; includes a hint to run `paperclipai onboard` on auth failures.

## Endpoints used (Paperclip side)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/agents/me` | Identity + auto-derive agentId/companyId. |
| `GET` | `/api/companies` | Company list (board access). |
| `GET` | `/api/companies/{companyId}/agents` | Agent list (agent-key sees its own company). |
| `POST` | `/api/companies/{companyId}/issues` | Issue creation (issue-per-prompt / rolling-issue modes). |
| `POST` | `/api/agents/{agentId}/wakeup` | Trigger a heartbeat run with the Fusion prompt as payload. |
| `GET` | `/api/heartbeat-runs/{runId}/events` | Streaming run log + status. |
| `GET` | `/api/issues/{issueId}` | Final issue state. |
| `GET` | `/api/issues/{issueId}/comments` | Final comment fallback. |

The adapter does **not** call `/api/issues/{id}/checkout` — checkout is the agent's job during its own heartbeat. The adapter does **not** call the legacy `/api/agents/{id}/heartbeat/invoke`.

## Limitations

- **Latency.** Heartbeat runs can take minutes; not a chat-completion drop-in.
- **Single-agent identity per connection.** A Paperclip *agent* API key is scoped to one agent in one company. To proxy several agents, configure several Fusion connections.
- **Run-events schema is partially inferred.** The events endpoint payload shape is documented but not formally schema'd; the client accepts both bare-array and `{ events: [...] }` envelopes defensively.

## Metadata

- **Plugin ID:** `fusion-plugin-paperclip-runtime`
- **Runtime ID:** `paperclip`
- **Package:** `@fusion-plugin-examples/paperclip-runtime`

## Development

```bash
pnpm --filter @fusion-plugin-examples/paperclip-runtime test    # 46 tests
pnpm --filter @fusion-plugin-examples/paperclip-runtime build
```
