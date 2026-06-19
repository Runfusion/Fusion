# Upstream sponsorship: ACP MCP passthrough and permission forwarding for `claude-code-cli-acp`

**Submission status:** filed upstream at https://github.com/moabualruz/claude-code-cli-acp/issues/2

**Ready-to-file upstream title:** Forward ACP `session/new.mcpServers` to Claude and gate forwarded MCP tool calls

## Ready-to-file upstream issue / feature request

### Summary

Fusion is evaluating `claude-code-cli-acp@0.1.1` as the Route-A replacement for direct `claude -p` usage. Route A is Fusion's highest-traffic Claude path: chat, executor, validator, reviewer, workflow model nodes, title summarization, reflection, and merger all currently rely on the `pi-claude-cli` provider, which injects Fusion tools through Claude's MCP config.

We need `claude-code-cli-acp` (or the ACP forwarding layer it uses) to support two linked capabilities before Fusion can safely cut Route A over:

1. **MCP passthrough:** forward the ACP `session/new.mcpServers` declaration to the underlying authenticated `claude` session so Claude can see, list, and invoke those MCP tools.
2. **Permission-gate traversal:** route each forwarded MCP tool invocation back to the ACP client as `session/request_permission`, or expose an equivalent MCP-layer permission hook the ACP client can drive. The bridge must not invoke forwarded MCP tools autonomously without a permission round trip.

This is a security-critical request: Fusion's existing ACP client-side handler gates tool use by category. Forwarded MCP tools must remain subject to that gate.

### Why this matters

Fusion's current Claude provider passes tools to Claude with `--mcp-config`. The ACP route instead has to pass tool servers through ACP `session/new.mcpServers`. Direct fallback to `claude -p` is not acceptable for this migration because the feature's success criterion is to remove `-p` from Claude traffic, including the high-volume Route-A provider path.

### Reproduction from Fusion spikes

Environment and package evidence:

- Upstream repo/homepage: https://github.com/moabualruz/claude-code-cli-acp and https://github.com/moabualruz/claude-code-cli-acp#readme
- npm package: https://www.npmjs.com/package/claude-code-cli-acp
- Bridge binary: `claude-code-cli-acp`, wrapping authenticated `claude` (`@anthropic-ai/claude-code`)
- Tested bridge version: `claude-code-cli-acp@0.1.1`
- Lockfile integrity verified in Fusion's `pnpm-lock.yaml`: `sha512-qpfRGOXkOs9mqI7oumsGistWisyXcCC0r7ng7wdLvGMIORdzHjmUUa+94Jftgr/NYAVnAUe6N7kimD8PaO3D5g==`
- Related ACP protocol surface: https://agentclientprotocol.com, especially `session/new.mcpServers` and `session/request_permission`

Fusion's Route-A MCP payload is not a stub. It is the real stdio server shape produced by `packages/pi-claude-cli/src/mcp-config.ts`:

```json
{
  "mcpServers": {
    "custom-tools": {
      "command": "node",
      "args": [
        "packages/pi-claude-cli/src/mcp-schema-server.cjs",
        "<temp schema file>"
      ],
      "env": []
    }
  }
}
```

The `<temp schema file>` in the spike contained 62 captured Fusion custom tools. The spike opened ACP directly against pinned `claude-code-cli-acp@0.1.1` with this non-empty `session/new.mcpServers` payload, bypassing Fusion's current helper that still sends `mcpServers: []`.

Observed result across FN-6466, FN-6467, and FN-6473:

- `initialize` succeeded.
- `session/new` accepted the non-empty `mcpServers` declaration.
- The prompt turn ended with `Not logged in · Please run /login` and `stopReason: "end_turn"` before any forwarded MCP tool could be invoked.
- The instrumented ACP client observed zero tool-call updates.
- The instrumented ACP client observed zero `session/request_permission` callbacks.

This means Fusion could not prove whether the bridge forwards `mcpServers` to Claude, and could not classify forwarded tool execution as GATED vs BYPASSED. Route A remains NOT GO until both answers are proven.

### Expected behavior

Given an authenticated `claude` session and a non-empty ACP `session/new.mcpServers` declaration:

1. `claude-code-cli-acp` should launch/connect the underlying Claude CLI session with those MCP servers available to Claude.
2. Claude should be able to list/invoke a tool from the forwarded server (for example a Fusion `custom-tools` tool).
3. Before the bridge executes the forwarded MCP tool, it should issue an ACP `session/request_permission` callback to the client that includes enough tool-call identity and options for the client to allow, deny, or cancel.
4. If ACP cannot represent the forwarded MCP permission decision directly, the bridge should expose an equivalent MCP-layer permission hook that Fusion can drive with the same allow/deny/cancel semantics.
5. If the client denies or cancels the permission request, the forwarded MCP call must not execute.

### Actual behavior observed

`claude-code-cli-acp@0.1.1` accepts the non-empty `session/new.mcpServers` field at the ACP boundary, but Fusion has not observed a forwarded MCP tool invocation or any permission callback. The authenticated rerun still reached `Not logged in · Please run /login` from the bridge-managed Claude session before tool use, so the bridge's MCP passthrough and permission behavior remain unproven.

### Acceptance criteria

- A client can send `session/new` with a stdio MCP server in `mcpServers` and the bridge makes that server available to the underlying authenticated `claude` session.
- Claude can invoke a tool from that forwarded MCP server through the bridge.
- Each forwarded MCP tool invocation is gated through ACP `session/request_permission`, or through an explicit MCP-layer permission hook that the ACP client controls.
- Denied/cancelled permission decisions prevent MCP tool execution.
- The bridge never autonomously executes forwarded MCP tools without a permission round trip.
- The implementation supports stdio MCP servers with `command`, `args`, and an explicit per-server `env` array/object without inheriting the bridge process environment wholesale.
- Tests or examples cover a non-empty `mcpServers` declaration and the allow/deny permission paths.

### Security constraints Fusion needs preserved

- Fusion defaults ACP ask/bridge turns to `tools: "readonly"` unless a task lane explicitly enables broader categories.
- Fusion's unrestricted ACP permission mode (`acpAllowUnrestricted`) remains default-false.
- Fusion bridge subprocess environments are built from an allow-list only. For the Claude bridge posture, that means `HOME` and `PATH` are allowed so Claude can find the user's `~/.claude` auth session and the `claude` binary; `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are intentionally not forwarded.
- The bridge should keep using the authenticated local Claude CLI session (`~/.claude`), not require API-key forwarding through ACP.
- Any MCP passthrough implementation should preserve ACP's client-controlled permission boundary rather than moving tool authorization fully inside the bridge.

## Technical proposal

One possible bridge implementation shape:

1. Parse and retain `session/new.mcpServers` in the ACP session state.
2. When spawning or controlling the underlying Claude CLI, translate the ACP MCP server declarations into the mechanism Claude CLI expects for MCP registration. For stdio servers, preserve `command`, `args`, and explicit server env; do not merge in `process.env` except for narrowly required bridge/Claude process env that is already configured by the caller.
3. Correlate Claude transcript/tool-use events for forwarded MCP calls with ACP permission requests.
4. Before dispatching the MCP call to the forwarded server, send `session/request_permission` to the ACP client with the tool call metadata. Execute only after an allow outcome; surface deny/cancel back to Claude as a tool error/result without invoking the server.
5. If Claude CLI's MCP stack does not expose a pre-call authorization hook, add a bridge-local MCP proxy layer: Claude connects to bridge-managed proxy servers, the proxy forwards list/call requests to the real configured MCP server, and the proxy performs the ACP permission round trip before forwarding each `tools/call`.
6. Add integration coverage with a small stdio MCP server and an ACP test client that asserts both allow and deny paths. The deny test should prove the real MCP server handler is not called.

A Fusion-authored PR could focus on the proxy approach if Claude's native CLI integration does not expose sufficient permission hooks. The key contract is not the specific implementation; it is that `session/new.mcpServers` becomes effective for Claude and forwarded tool calls remain externally gateable by the ACP client.

## Fusion references

- Fusion OQ1 record: `docs/acp-contract.md` → `### OQ1 — Route A MCP-over-ACP forwarding and permission-gate traversal`
- Fusion route plan: `docs/plans/2026-06-14-001-feat-claude-acp-runtime-plan.md` → Summary (`-p` removal), KTD8, KTD11, U9, U10, and Open Questions OQ1
- Fusion permission handler: `plugins/fusion-plugin-acp-runtime/src/provider.ts` → `createBridgingClientHandler(...).requestPermission(...)`
- Fusion current ACP session helper: `plugins/fusion-plugin-acp-runtime/src/provider.ts` → `newAcpSession(...)` currently defaults to `mcpServers: []` until FN-6460/U10
- Fusion Route-A MCP config builder: `packages/pi-claude-cli/src/mcp-config.ts`

## Internal decision recorded by FN-6475

Fusion is sponsoring this upstream capability rather than shipping a Route-A fallback to `claude -p`. OQ1 remains UNRESOLVED / BLOCKED and Route A remains NOT GO until an authenticated rerun proves both forwarded MCP invocation and permission-gate traversal.

Filed upstream: https://github.com/moabualruz/claude-code-cli-acp/issues/2
