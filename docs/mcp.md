# MCP (Model Context Protocol)

[← Back to docs index](./README.md)

MCP (Model Context Protocol) is a standard way to attach external tool servers to AI runtimes. Fusion stores trusted MCP server definitions in settings, resolves the effective global/project configuration, materializes any referenced secrets only at use time, and forwards enabled servers to MCP-capable AI lanes so those lanes can use the same operator-approved tools.

<!--
FNXC:McpDocs 2026-06-26-00:00:
This page is the canonical MCP operator guide. Keep CLI flags, settings keys, validation statuses, and dashboard section names aligned with the shipped MCP code so secret-reference behavior is documented once without duplicating full procedures across adjacent docs.
-->

## Overview

MCP support lets Fusion operators configure external stdio, SSE, or streamable HTTP MCP servers once and make them available to AI sessions that support MCP. Enabled servers are treated as **trusted once configured**: after an operator saves a server definition, Fusion may forward it to supported AI lanes without asking again for each session.

MCP configuration lives in the `mcpServers` settings key at both scopes:

- **Global settings** hold shared MCP declarations.
- **Project settings** hold project-specific declarations.
- Effective resolution is project-over-global by server `name`: global servers load first, same-named project servers replace them, and same-named project servers with `enabled:false` disable the inherited global server.
- The project-level `mcpServers.enabled` flag overrides the global flag when it is set. If the effective flag is false, no MCP servers are active.

Expected outcome: when `mcpServers.enabled` resolves to true and at least one enabled server definition is valid, supported AI runtimes receive the effective server set for new sessions.

## Server definitions and transports

Every server has a unique `name`, an optional per-server `enabled` flag, and exactly one transport:

| Transport | Required fields | Optional sensitive fields | Notes |
|---|---|---|---|
| `stdio` | `command` | `env` | `args` may provide command arguments. |
| `sse` | `url` | `headers` | Uses an SSE endpoint. |
| `streamable-http` | `url` | `headers` | The CLI also accepts `http` as an alias and stores `streamable-http`. |

Definitions use these shapes:

```json
{ "name": "local-tools", "enabled": true, "transport": "stdio", "command": "node", "args": ["server.js"], "env": { "API_KEY": { "secretRef": "sec_...", "scope": "project" } } }
{ "name": "docs-sse", "transport": "sse", "url": "https://example.test/sse", "headers": { "Authorization": { "secretRef": "sec_...", "scope": "global" } } }
{ "name": "docs-http", "transport": "streamable-http", "url": "https://example.test/mcp", "headers": { "Authorization": { "secretRef": "sec_...", "scope": "project" } } }
```

Expected outcome: settings validation accepts only the required fields for the selected transport, rejects duplicate server names within one stored settings array, and rejects plaintext sensitive values.

## Secret references

Fusion never persists raw MCP environment values, header values, or token-like material in settings. Sensitive maps store only Fusion-managed secret references:

```json
{ "secretRef": "sec_...", "scope": "project" }
```

Use `scope: "project"` for secrets stored in the current project and `scope: "global"` for secrets stored in the global secrets database. The plaintext value lives in the encrypted [Secrets](./secrets.md) store, not in `mcpServers`.

Fusion materializes MCP secret references only at the use seam:

- when creating an AI session for an MCP-capable runtime;
- when running a bounded validation/reachability probe;
- when importing plaintext Claude Desktop env/header values and immediately creating Fusion secrets.

Expected outcome: API responses, CLI output, settings JSON, exports, and structured logs show secret references or counts/status metadata only; they do not include decrypted env/header values.

## Validation and reachability

The dashboard **Test** control calls `POST /api/mcp/validate` for one server. The route accepts a JSON body with either:

- `name` — resolve a configured server by name in the current project context; or
- `server` / `definition` — validate and probe the supplied server definition.

`timeoutMs` is optional, must be positive, and is capped at 30000 milliseconds. The response is:

```json
{ "status": "valid", "message": "..." }
```

`status` is one of:

| Status | Meaning |
|---|---|
| `valid` | The definition resolved, secrets materialized, and the bounded probe reached the server. |
| `unreachable` | The definition resolved, but the probe could not reach the server within the bounded check. |
| `error` | Validation, secret resolution, spawn, fetch, or protocol setup failed. |

Expected outcome: validation returns only `{ status, message? }`; resolved `env` and `headers` values are never returned.

Note: `fn mcp validate` currently validates stored definitions and reports whether they satisfy Fusion's schema. It does not perform the dashboard/API reachability probe.

## Managing servers in the dashboard

1. Open **Settings → Global → MCP Servers** for shared defaults, or **Settings → Project → MCP Servers** for project-specific servers. Expected outcome: the **Global MCP servers** or **Project MCP servers** card appears.
2. Turn on **Enable MCP servers for this scope**. Expected outcome: the current scope's `mcpServers.enabled` draft becomes true; project scope overrides global enablement when saved.
3. Click **Add server**. Choose `stdio`, `SSE`, or `HTTP`, then enter the required `command` or `url`. Expected outcome: the editor only asks for fields used by that transport and saves `HTTP` as `streamable-http`.
4. Add sensitive values under **Environment secret refs** for `stdio` or **Header secret refs** for `sse` / `streamable-http`. Choose an existing secret or create a new secret with **Create secret**. Expected outcome: the settings draft receives only `{ secretRef, scope }`; the plaintext creation value is stored in Secrets, not in settings.
5. Save the server. Expected outcome: the row appears with its transport, state badge, and validation status of **Not tested**.
6. In project settings, review inherited rows from global settings. Use **Override** to replace an inherited server or **Disable** to add a same-named project disabled entry. Expected outcome: state badges identify inherited, overridden, project-local, and disabled-global behavior before you save.
7. Click **Test** on a server row. Expected outcome: the row shows **Testing…** while pending, then `valid`, `unreachable`, or `error` with the returned message.
8. Review **Discovered on this machine**. Expected outcome: Fusion shows read-only MCP servers found in supported third-party config files for this scope, with source labels and a **Configured** badge for same-named servers already present in the current settings draft.
9. Click **Add** for a discovered server you trust. Expected outcome: servers without sensitive fields are copied into the current scope and enable that scope; servers with discovered env/header/token material open the editor so you bind existing Fusion secrets or create new Fusion secrets before saving.
10. Use the **Import** pane to paste JSON or choose **Upload JSON**. Expected outcome: Claude Desktop-style servers are added to the draft, duplicate names are rejected, and plaintext env/header values are converted into newly created Fusion secrets plus secret references.
11. Use **Copy Fusion MCP JSON** and then **Download JSON** when needed. Expected outcome: the export contains Fusion MCP JSON with secret references, and no plaintext secret values.
12. Save the Settings modal. Expected outcome: the selected global or project `mcpServers` settings are persisted and used by subsequent MCP-capable AI sessions.

## Auto-discovering MCP servers

Fusion can scan known on-host MCP configuration files and show inert candidates in **Settings → Global → MCP Servers** and **Settings → Project → MCP Servers**. Discovery is read-only: Fusion does not auto-enable, spawn, validate, connect to, or otherwise execute a discovered server. A discovered server becomes trusted only after an operator clicks **Add**, reviews the definition, binds any required secrets, and saves Settings.

The scanner reads only these well-known paths; missing files are normal and malformed files produce non-fatal notes in the card:

| Tool | Scope | macOS / Linux path | Windows path |
|---|---|---|---|
| Claude Desktop | Global | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Linux: `~/.config/Claude/claude_desktop_config.json` | `%APPDATA%\\Claude\\claude_desktop_config.json` |
| Claude Code | Global | `~/.claude.json` | `%USERPROFILE%\\.claude.json` |
| Cursor | Global | `~/.cursor/mcp.json` | `%USERPROFILE%\\.cursor\\mcp.json` |
| Windsurf | Global | `~/.codeium/windsurf/mcp_config.json` | `%USERPROFILE%\\.codeium\\windsurf\\mcp_config.json` |
| Cursor | Project | `<projectRootDir>/.cursor/mcp.json` | `<projectRootDir>\\.cursor\\mcp.json` |
| VS Code | Project | `<projectRootDir>/.vscode/mcp.json` | `<projectRootDir>\\.vscode\\mcp.json` |

Claude Desktop, Claude Code, Cursor, and Windsurf use the Claude-style `{ "mcpServers": { ... } }` shape. VS Code project config can use `{ "servers": { ... } }`; Fusion normalizes it to the same import parser before rendering candidates.

Sensitive discovery follows the same no-plaintext rule as manual import. If a third-party file contains inline environment values, header values, or token-like values, the API response includes only secret descriptor metadata (`field`, `key`, `suggestedKey`, `scope`) and the candidate definition uses Fusion `McpSecretRef` placeholders. The dashboard **Add** flow opens the server editor so operators choose existing Fusion secrets or create new Fusion-managed secrets; the settings blob stores only `{ secretRef, scope }` references.

The dashboard uses this route:

```http
GET /api/mcp/discovered?scope=global|project
```

Response shape:

```json
{
  "sources": [{ "id": "vscode-project", "tool": "VS Code", "label": "VS Code project", "scope": "project", "path": "/repo/.vscode/mcp.json" }],
  "servers": [
    {
      "source": { "id": "vscode-project", "tool": "VS Code", "label": "VS Code project", "scope": "project", "path": "/repo/.vscode/mcp.json" },
      "definition": { "name": "docs", "transport": "stdio", "command": "node", "env": { "API_KEY": { "secretRef": "mcp.docs.env.API_KEY", "scope": "project" } } },
      "alreadyConfigured": false,
      "hasPlaintextSecrets": true,
      "secretDescriptors": [{ "field": "env", "key": "API_KEY", "suggestedKey": "mcp.docs.env.API_KEY", "scope": "project" }]
    }
  ],
  "errors": []
}
```

Expected outcome: API clients can display candidates, source labels, configured badges, and secret-binding prompts without receiving plaintext secret values.

## Managing servers from the CLI

1. List configured servers:

   ```bash
   fn mcp list [--project <name>] [--json]
   ```

   Expected outcome: Fusion prints global, project, and effective servers with secret summaries such as `project secret`, never decrypted values.

2. Add a stdio server:

   ```bash
   fn mcp add local-tools --scope project --transport stdio --command node --arg server.js --env API_KEY=my-existing-secret --secret-scope project
   ```

   Expected outcome: Fusion resolves `my-existing-secret` by id or key, stores it as `{ secretRef, scope }`, and prints `✓ Added MCP server "local-tools" to project scope`.

3. Add an SSE or streamable HTTP server:

   ```bash
   fn mcp add docs --scope global --transport sse --url https://example.test/sse --header Authorization=docs-token --secret-scope global
   fn mcp add http-docs --scope project --transport http --url https://example.test/mcp --secret-ref docs-token --secret-scope project
   ```

   Expected outcome: `sse` stores an SSE server, `http` is normalized to `streamable-http`, and `--secret-ref` supplies a token-like default secret field when no explicit `--env` or `--header` is present.

4. Create secrets while adding or editing:

   ```bash
   fn mcp add private-docs --scope project --transport streamable-http --url https://example.test/mcp --create-secret-header Authorization=Bearer-token-value
   ```

   Expected outcome: the CLI creates a Fusion secret with a suggested MCP key and persists only the new secret reference in settings.

5. Edit a scoped server:

   ```bash
   fn mcp edit local-tools --scope project --command node --args '["server.js","--verbose"]'
   ```

   Expected outcome: only the selected global or project declaration changes; effective project-over-global behavior is recomputed later by name.

6. Enable or disable a server:

   ```bash
   fn mcp enable local-tools --scope project
   fn mcp disable local-tools --scope project
   ```

   Expected outcome: Fusion flips the selected declaration's `enabled` flag. At project scope, disabling a same-named inherited server masks the global declaration without deleting it.

7. Remove a scoped declaration:

   ```bash
   fn mcp remove local-tools --scope project
   ```

   Expected outcome: the selected declaration is deleted. If you remove a project override, a same-named global server may become effective again.

8. Validate stored definitions:

   ```bash
   fn mcp validate [--scope global|project|effective] [--json]
   ```

   Expected outcome: Fusion reports whether stored definitions satisfy the MCP settings schema. Use the dashboard **Test** control or `POST /api/mcp/validate` for reachability.

## Importing Claude Desktop configuration

1. Prepare a Claude Desktop-style JSON file or paste payload:

   ```json
   {
     "mcpServers": {
       "docs": {
         "command": "node",
         "args": ["server.js"],
         "env": { "API_KEY": "plaintext-from-claude-config" }
       }
     }
   }
   ```

   Expected outcome: Fusion recognizes the `mcpServers` object and maps each entry to a named MCP server.

2. Import from the dashboard by opening **Settings → Global → MCP Servers** or **Settings → Project → MCP Servers**, pasting the JSON into **Import**, or choosing **Upload JSON**, then clicking **Import**. Expected outcome: plaintext env/header values are converted into Fusion secrets with `prompt` access policy and settings receive only secret references.

3. Import from the CLI:

   ```bash
   fn mcp import ./claude_desktop_config.json --scope project --yes
   ```

   Expected outcome: the CLI prints an import summary, creates Fusion secrets for plaintext env/header values, replaces them with secret references, and imports the definitions into the selected scope.

4. Review the imported rows with `fn mcp list` or the dashboard card before saving/applying broader settings changes. Expected outcome: duplicate names are visible, secret fields show as references, and effective project-over-global behavior is clear.

## Exporting Fusion MCP configuration

1. Export from the dashboard by opening the MCP settings card and clicking **Copy Fusion MCP JSON**. Expected outcome: the JSON is copied when clipboard access is available, and the export text appears for manual copy.
2. Click **Download JSON** after generating the dashboard export. Expected outcome: the browser downloads `fusion-mcp-servers.json`.
3. Export from the CLI:

   ```bash
   fn mcp export --scope effective --output fusion-mcp-servers.json
   fn mcp export --scope global --json
   ```

   Expected outcome: `--output` writes the JSON to a file; without `--output`, Fusion prints JSON to stdout. `global`, `project`, and `effective` choose stored global declarations, stored project declarations, or resolved project-over-global output.
4. Inspect the exported secret fields. Expected outcome: env/header values remain `{ secretRef, scope }` references and are not decrypted into plaintext.

## How MCP servers reach AI lanes

When an AI lane starts a session, Fusion resolves the effective `mcpServers` settings, materializes secret references through the scoped secrets store, and passes the resulting in-memory server declarations to runtimes that support MCP. The forwarding path covers chat/planning, executor, reviewer, validator, merger, workflow model nodes, summarization, evaluator, research, cron/automation, mission, and reflection paths.

Runtime support is guarded. Claude/pi/ACP-compatible runtimes receive MCP servers; mock or unsupported runtimes skip forwarding and emit only structured count/provider/runtime metadata. Skipped forwarding is not a settings error: it means the selected runtime does not accept MCP server declarations.

Expected outcome: enabling a server makes it available to subsequent supported AI sessions, while unsupported sessions continue without MCP tools and without logging secret-bearing server definitions.

See [Settings Reference](./settings-reference.md) for the `mcpServers` settings contract and [Agents](./agents.md) for runtime/model lane behavior.
