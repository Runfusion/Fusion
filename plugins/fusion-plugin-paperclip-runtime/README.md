# Paperclip Runtime Plugin

`fusion-plugin-paperclip-runtime` provides the `paperclip` runtime for Fusion agents by calling a running **Paperclip REST API** instance.

> This plugin no longer delegates to Fusion's internal `@fusion/engine` pi runtime.

## Runtime Identity

- **Plugin ID:** `fusion-plugin-paperclip-runtime`
- **Runtime ID:** `paperclip`
- **Runtime Name:** `Paperclip Runtime`

## Prerequisites

1. Paperclip is installed and running (default URL: `http://localhost:3100`)
2. Fusion plugin installed:

```bash
fn plugin install ./plugins/fusion-plugin-paperclip-runtime
```

## Configuration

The runtime resolves configuration in this priority order:

1. Plugin settings (`ctx.settings`)
2. Environment variables
3. Defaults

| Setting | Env Var | Required | Default |
|---|---|---:|---|
| `apiUrl` | `PAPERCLIP_API_URL` | No | `http://localhost:3100` |
| `apiKey` | `PAPERCLIP_API_KEY` | No | `undefined` |
| `agentId` | `PAPERCLIP_AGENT_ID` | Yes (for session create) | `undefined` |
| `companyId` | `PAPERCLIP_COMPANY_ID` | Yes (for session create) | `undefined` |

### Authentication Modes

- **Bearer token mode:** set `apiKey` / `PAPERCLIP_API_KEY` and requests include `Authorization: Bearer <token>`
- **Local trusted mode:** leave `apiKey` unset; plugin probes `/api/health` without auth and proceeds when allowed by Paperclip deployment mode

## How Runtime Execution Works

For each prompt, the runtime adapter performs:

1. `POST /api/companies/{companyId}/issues` (creates issue in `backlog`, assigned to `agentId`)
2. `POST /api/issues/{issueId}/checkout` (atomic claim; 409 conflicts are logged and execution continues)
3. `POST /api/agents/{agentId}/heartbeat/invoke` (async agent execution)
4. Polls `GET /api/issues/{issueId}` with exponential backoff (2s → 4s → 8s → 10s cap, 120s timeout)
5. Reads output from `GET /api/issues/{issueId}/comments`
6. Emits text/thinking/tool callbacks back to Fusion runtime consumers

The runtime uses Paperclip as the orchestration engine; Fusion receives summarized output via issue comments.

## Runtime Selection in Fusion

Configure an agent with runtime hint `paperclip`:

```json
{
  "runtimeConfig": {
    "runtimeHint": "paperclip"
  }
}
```

Fusion runtime resolution still falls back to default `pi` runtime if plugin runtime resolution fails.

## Development

```bash
cd plugins/fusion-plugin-paperclip-runtime
pnpm test
pnpm build
```
