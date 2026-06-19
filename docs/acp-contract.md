# ACP (Agent Client Protocol) Runtime Contract

Date: 2026-06-03

Launch/readiness contract and failure taxonomy for `fusion-plugin-acp-runtime`,
which drives any external [Agent Client Protocol](https://agentclientprotocol.com)
agent over JSON-RPC/stdio. Mirrors the shape of `docs/cursor-cli-contract.md`.

## Transport

- **Newline-delimited JSON-RPC 2.0 over stdio** (no Content-Length framing).
  Provided by `@agentclientprotocol/sdk` (`ndJsonStream` + `ClientSideConnection`).
- The client (Fusion) launches the agent as a subprocess with piped stdio. The
  agent's stdin is the JSON-RPC *output* stream; its stdout is the *input* stream.
- `stderr` is captured (redacted) for diagnostics, never parsed as protocol.

## Invocation and binary detection

- Unlike a single-vendor CLI, ACP is a protocol — the agent binary + ACP-mode
  flag are user-configured:
  - `acpBinaryPath` — e.g. `gemini`, `npx`, or an absolute path.
  - `acpArgs` — the flag(s) that put the agent in ACP/stdio mode, e.g. `["--acp"]`.
- The subprocess environment is built from the `acpEnvAllowList` allow-list only
  (inherited `process.env` is **not** forwarded — the agent is untrusted).

## Claude bridge ask profile (Route B)

Route-B planning and validator asks use the `acp` runtime with the bundled
`claude-code-cli-acp` bridge instead of `claude -p`:

- `claude-code-cli-acp@0.1.1` is pinned under the ACP runtime plugin and the
  sentinel binary name resolves to this plugin's own `node_modules/.bin` shim,
  not to a PATH-selected substitute.
- The read-only ask posture uses `tools: "readonly"`, `acpArgs: []`, and leaves
  `acpFsRead` / `acpFsWrite` off. Route A's tool-bearing provider path remains
  deferred and is not implied by this profile.
- The Claude bridge env allow-list is intentionally narrow: `HOME` is forwarded
  so the underlying `claude` can read `~/.claude` auth/session state, and `PATH`
  is forwarded for sub-executable resolution. `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, and inherited `process.env` are not forwarded.
- `checkSetup` treats the bridge as installed only when the resolved binary is
  plugin-owned, the ACP handshake succeeds, and no Claude auth hint is returned.
  Auth-needed statuses tell the operator to run `claude` once to authenticate.

## `askAcpOnce` prose → JSON recovery contract

The engine-side `askAcpOnce` runner creates one readonly ACP session, accumulates
all `onText` deltas into `text`, runs one `promptWithFallback` turn, optionally
recovers the trailing JSON object via `extractJsonObjects`, and disposes the
session in `finally`. Its shape is deliberately close to the old one-shot result:

- Success: `{ ok: true, text, parsed?, stopReason? }`.
- Failure: `{ ok: false, reason, message, text?, stopReason? }` for session
  creation errors, turn errors, timeouts, and abnormal stops.
- `promptWithFallback` surfaces ACP `stopReason` to the runner. Planning tolerates
  an absent stop reason, but validation treats abnormal/truncated stops such as
  `max_tokens` and `cancelled` as `error` regardless of any recovered JSON.
- Validator prose fallback is constrained: prose can infer `fail` or `blocked`,
  but never `pass`. A pass requires clean structured JSON (`verdict:"pass"` or
  `passed:true`) from a clean turn.

## Readiness = the `initialize` handshake

There is no `--version` probe. Readiness is the protocol handshake itself:

1. Spawn the agent subprocess.
2. Send `initialize { protocolVersion: 1, clientCapabilities: { fs } }` under a
   timeout (default 30s — research flagged Gemini-on-macOS OAuth and Claude-adapter
   `session/new` stalls).
3. The agent responds with its integer `protocolVersion`, `agentCapabilities`,
   and `authMethods`.
4. The client compares the integer protocol version; an unsupported version is a
   hard failure (do not assume the agent errors first).

`fs` capabilities are advertised **only** when `acpFsRead`/`acpFsWrite` are
enabled (writes default OFF).

## Failure taxonomy (`probe.ts` `AcpProbeReason`)

| Reason | Trigger |
| --- | --- |
| `ok` | Handshake completed (with `authRequired: true` when `authMethods` is non-empty) |
| `missing_binary` | Spawn `ENOENT` (binary not found, code 127) |
| `spawn_error` | Other spawn failure |
| `handshake_timeout` | `initialize` did not complete within the bound (code 124) |
| `incompatible_protocol` | Agent negotiated an unsupported integer protocol version |
| `unauthenticated` | Agent requires an auth method the client cannot satisfy |

## Lifecycle / teardown

- The engine has no `AbortSignal` in the runtime contract; teardown enters via an
  unawaited synchronous `dispose()` plus the process-registry kill. The
  **registry SIGKILL is the authoritative no-orphan / no-deadlock guarantee**; a
  best-effort `session/cancel` + pending-permission drain runs first when timing
  allows but is opportunistic.

## Sources

- https://agentclientprotocol.com (introduction, schema, transports, initialization, tool-calls)
- `@agentclientprotocol/sdk` v0.24.0 — https://www.npmjs.com/package/@agentclientprotocol/sdk
- Validation: the SDK example echo agent (CI) + an in-repo controllable fixture
  (`src/__tests__/fixtures/echo-agent.mjs`); Gemini CLI / Claude-adapter for manual e2e.

## Open Questions

<!--
FNXC:ACPRoute 2026-06-14-21:33:
FN-6459 originally intended to store the Route-A U9/U14 feasibility decision in a task document, but that task-local deliverable was not recoverable after archive. Keep the security-critical OQ1 decision in this committed contract and the route plan so FN-6460 cannot be re-blocked by lost task metadata.

FNXC:ACPRoute 2026-06-14-22:15:
FN-6466 reran U9 against pinned `claude-code-cli-acp` 0.1.1 with a real non-empty Fusion MCP payload, but the bridge surfaced `Not logged in · Please run /login` before any MCP tool call. Record that unauthenticated-bridge blocker here so FN-6460 can distinguish "session/new accepted the forwarded server declaration" from "forwarded tool invocation and permission-gate traversal are still unproven."

FNXC:ACPRoute 2026-06-14-22:43:
FN-6467 reran U9 in this worktree with `claude` 2.1.177 present, the pinned bridge binary resolved under the ACP plugin, and the 62-tool `custom-tools` MCP payload shape from Route A. The bridge still reported `Not logged in · Please run /login`; keep the OQ1 decision in this committed contract so FN-6460's preflight is never re-blocked by lost task metadata or by mistaking binary presence for authenticated bridge readiness.

FNXC:ACPRoute 2026-06-15-00:12:
FN-6473 is the explicit authenticated-environment escalation for Route-A U9, so its OQ1 result must remain in committed docs even when task-local evidence ages out. This worktree had `claude` 2.1.177, the plugin-local pinned bridge 0.1.1, matching lockfile integrity, and the 62-tool `custom-tools` payload, but the bridge still reached an unauthenticated Claude session (`Not logged in · Please run /login`) before any forwarded tool call or permission callback.

FNXC:ACPRoute 2026-06-15-00:45:
FN-6475 captured the upstream sponsorship package in committed docs because Route A stays blocked until the bridge/ACP layer can pass `session/new.mcpServers` to authenticated Claude and route forwarded MCP tool calls through ACP `session/request_permission` or an equivalent MCP-layer hook. Keep this here so FN-6460 preflight and FN-6476 reruns do not reinterpret sponsorship as a GO verdict or fall back to `claude -p`.

FNXC:ACPRoute 2026-06-15-00:17:
FN-6476 was the genuinely-authenticated U9 escalation rerun, but this worktree still proved the bridge session was unauthenticated by driving an actual prompt turn that returned `Not logged in · Please run /login` with stopReason `end_turn`. Keep the blocked verdict in this committed contract, with the pinned bridge 0.1.1, matching lockfile integrity, and 62-tool `custom-tools` payload, so FN-6460's preflight is never unblocked by binary presence or lost task metadata.
-->

### OQ1 — Route A MCP-over-ACP forwarding and permission-gate traversal

**Status:** UNRESOLVED / BLOCKED as of FN-6476 (2026-06-15). **Gate traversal:** UNRESOLVED — no forwarded tool invocation reached the point where it could be classified as GATED or BYPASSED. **Combined Route A verdict: NOT GO** until this OQ records both required U9 answers as GO.

**Recovery status:** NOT-RECOVERED. `fn_task_show FN-6459` retained only archived task metadata plus an archive log entry, `.fusion/tasks/FN-6459/` is absent in the FN-6465 worktree, and `fn_task_document_read(key="research")` returned not found from FN-6465's execution context. No surviving authoritative FN-6459 U9 verdict was available to transcribe.

**U9 answers required before Route A implementation:**

1. Whether `claude-code-cli-acp` can forward the real Fusion MCP server(s) supplied through ACP `session/new.mcpServers` to the underlying interactive `claude`, using the actual `packages/pi-claude-cli/src/mcp-config.ts` stdio shape (`{ command: "node", args: [serverPath, schemaFilePath] }`), not a stub.
2. Whether a forwarded Fusion tool invocation surfaces back to Fusion as ACP `session/request_permission` and therefore traverses the existing permission gate, or whether the bridge lets `claude` invoke the MCP tool autonomously inside the bridge, bypassing the gate.

**FN-6465 result:** these answers remain unproven. Local binaries were present during recovery (`claude` 2.1.177 and pinned `claude-code-cli-acp` 0.1.1), but FN-6465 did not complete an authenticated, instrumented spike against the real Fusion MCP config with ACP permission telemetry. Do not infer a GO from binary presence.

**FN-6466 result (real bridge run, still blocked):** The follow-up spike opened ACP `session/new` **directly** with a non-empty Route-A MCP payload so it did not reuse the plugin helper that still hardcodes `mcpServers: []`. The payload matched the real `mcp-config.ts` stdio shape: one server named `custom-tools`, `command: "node"`, `args: [packages/pi-claude-cli/src/mcp-schema-server.cjs, <temp schema file>]`, `env: []`, and a temp schema file containing **62** captured Fusion custom tools sourced from `packages/cli/src/extension.ts`. The bridge accepted `initialize` and `session/new` with that payload, so the transport did **not** reject the forwarded MCP declaration outright. The first prompt turn explicitly instructed Claude to call `fn_task_list`, but the turn ended with assistant text **`Not logged in · Please run /login`**, **zero** tool-call updates, and **zero** ACP `session/request_permission` callbacks.

**FN-6467 result (second real bridge run, still blocked):** The rerun verified `claude` **2.1.177** on PATH and the pinned `claude-code-cli-acp` **0.1.1** shim under `plugins/fusion-plugin-acp-runtime/node_modules/.bin`; the lockfile records integrity `sha512-qpfRGOXkOs9mqI7oumsGistWisyXcCC0r7ng7wdLvGMIORdzHjmUUa+94Jftgr/NYAVnAUe6N7kimD8PaO3D5g==`. The harness again opened ACP directly with one non-empty stdio MCP server named `custom-tools`, `command: "node"`, `args: [packages/pi-claude-cli/src/mcp-schema-server.cjs, <temp schema file>]`, `env: []`, containing **62** Fusion custom-tool names confirmed from `packages/cli/src/extension.ts` and matching FN-6466's payload source. `initialize` returned `agentInfo.name="claude-code-cli-acp"`, `version="0.1.1"`, and `authMethods=["claude-code-login"]`; `session/new` accepted the non-empty `mcpServers` payload and returned a session. The prompt explicitly instructed Claude to call `fn_task_list`, but the turn ended with assistant text **`Not logged in · Please run /login`**, stopReason `end_turn`, **zero** tool-call updates, and **zero** ACP `session/request_permission` callbacks.

**Recorded OQ1 state after FN-6467:**
1. **Can Claude invoke a real forwarded Fusion tool through the bridge?** **UNPROVEN / BLOCKED.** The bridge accepts the non-empty `mcpServers` declaration, but the underlying `claude` session is still unauthenticated from the bridge's perspective and no forwarded MCP tool was invoked.
2. **Do forwarded tool calls traverse ACP `session/request_permission`?** **UNPROVEN / BLOCKED (neither GATED nor BYPASSED observed).** No forwarded tool call occurred, so the rerun observed no permission callback and cannot classify the security-critical gate path.

**FN-6473 result (escalation rerun, still blocked):** The escalation re-verified the local prerequisites and an actual bridge turn: `claude` **2.1.177** resolved at `/Users/eclipxe/.local/bin/claude`; the plugin-local pinned bridge shim resolved at `plugins/fusion-plugin-acp-runtime/node_modules/.bin/claude-code-cli-acp` and reported **0.1.1**; the lockfile still records integrity `sha512-qpfRGOXkOs9mqI7oumsGistWisyXcCC0r7ng7wdLvGMIORdzHjmUUa+94Jftgr/NYAVnAUe6N7kimD8PaO3D5g==`. The instrumented harness opened ACP directly with one non-empty stdio MCP server named `custom-tools`, `command: "node"`, `args: [packages/pi-claude-cli/src/mcp-schema-server.cjs, <temp schema file>]`, `env: []`, containing **62** Fusion custom-tool names confirmed from `packages/cli/src/extension.ts` and matching `mcp-config.ts`'s `writeMcpConfig` shape. `initialize` returned `agentInfo.name="claude-code-cli-acp"`, `version="0.1.1"`, and `authMethods=["claude-code-login"]`; `session/new` accepted the non-empty `mcpServers` payload and returned a session. The prompt explicitly instructed Claude to invoke `fn_task_list`, but the turn ended with assistant text **`Not logged in · Please run /login`**, stopReason `end_turn`, **zero** tool-call updates, and **zero** ACP `session/request_permission` callbacks.

**Recorded OQ1 state after FN-6473:**
1. **Can Claude invoke a real forwarded Fusion tool through the bridge?** **UNPROVEN / BLOCKED.** The bridge still accepts the non-empty `mcpServers` declaration, but the underlying `claude` session remains unauthenticated from the bridge's perspective and no forwarded MCP tool was invoked.
2. **Do forwarded tool calls traverse ACP `session/request_permission`?** **UNPROVEN / BLOCKED (neither GATED nor BYPASSED observed).** The explicit request-permission instrumentation recorded zero callbacks because no forwarded tool call occurred.

**FN-6476 result (genuinely-authenticated rerun attempt, still blocked):** This rerun first re-verified the local prerequisites: `claude` **2.1.177** resolved at `/Users/eclipxe/.local/bin/claude`; the plugin-local bridge shim resolved at `plugins/fusion-plugin-acp-runtime/node_modules/.bin/claude-code-cli-acp` and reported **0.1.1**; the lockfile still records integrity `sha512-qpfRGOXkOs9mqI7oumsGistWisyXcCC0r7ng7wdLvGMIORdzHjmUUa+94Jftgr/NYAVnAUe6N7kimD8PaO3D5g==`. The payload source was the committed FN-6473/FN-6475 OQ1 record plus a rebuild from the real `mcp-config.ts` shape and `packages/cli/src/extension.ts`: one stdio MCP server named `custom-tools`, `command: "node"`, `args: [packages/pi-claude-cli/src/mcp-schema-server.cjs, <temp schema file>]`, `env: []`, carrying **62** Fusion custom-tool names. The authenticated-readiness proof opened ACP directly against the pinned bridge and drove a no-MCP prompt turn before attempting any forwarded-tool verdict; `initialize` returned `agentInfo.name="claude-code-cli-acp"`, `version="0.1.1"`, `authMethods=["claude-code-login"]`, and the turn returned assistant text **`Not logged in · Please run /login`** with stopReason `end_turn`, **zero** tool-like updates, and **zero** ACP `session/request_permission` callbacks. Because the readiness proof failed, the harness did **not** proceed to the MCP-forwarding prompt; no forwarded Fusion tool was invoked and gate traversal could not be classified as GATED or BYPASSED.

**Recorded OQ1 state after FN-6476:**
1. **Can Claude invoke a real forwarded Fusion tool through the bridge?** **UNPROVEN / BLOCKED.** The bridge binary and real 62-tool payload are present, but this environment still cannot exercise an authenticated bridge session; no forwarded MCP tool was invoked.
2. **Do forwarded tool calls traverse ACP `session/request_permission`?** **UNPROVEN / BLOCKED (neither GATED nor BYPASSED observed).** The explicit client-side `requestPermission` instrumentation recorded zero callbacks because the auth-readiness gate failed before a forwarded tool call.

**Escalation path:** rerun U9 with an environment where the pinned bridge can reach an authenticated `claude`, the same non-empty `session/new.mcpServers` shape, and explicit `session/request_permission` instrumentation. Sponsor the missing bridge/ACP MCP permission-forwarding capability upstream: the bridge/ACP layer must forward `session/new.mcpServers` to the underlying Claude session and surface forwarded tool calls through ACP `session/request_permission` or an MCP-layer permission hook. If an authenticated rerun still ignores `mcpServers`, cannot invoke the forwarded tools, or bypasses the ACP permission gate without an MCP-layer permission hook or sensitive-tool exclusion, Route A remains blocked. A `claude -p` fallback is not an acceptable Route-A completion path.

**FN-6475 sponsorship record (2026-06-15):** upstream sponsorship was authored in [`docs/upstream/claude-code-cli-acp-mcp-permission-forwarding.md`](upstream/claude-code-cli-acp-mcp-permission-forwarding.md) and filed as https://github.com/moabualruz/claude-code-cli-acp/issues/2. This records the requested MCP passthrough plus permission-gate traversal / MCP-layer hook contract only; OQ1 remains **UNRESOLVED / BLOCKED** and the combined Route A verdict remains **NOT GO** until a later authenticated rerun proves both required U9 answers.

**U14 internal mechanisms:** GO for design, subject to U9. Route A should use a second `acp-claude` runtime posture rather than mutating the generic `acp` runtime; inject the ACP bridge client from the engine `registerExtensionProviders` seam into the vendored `@fusion/pi-claude-cli` provider options; and add `AgentRuntimeOptions.mcpServers` to both the engine runtime contract and the ACP plugin-local structural copy, with `newAcpSession` defaulting to `[]` for Route-B compatibility.
## U9 verdict — MCP-over-ACP through the Claude bridge (2026-06-15)

**U9 MECHANICS = GO** (overturns the prior headless NOT-GO chain; see plan OQ1).
Spike: pinned `claude-code-cli-acp` 0.1.1 driven directly over ACP (SDK 0.24.0)
in an **interactive TTY with `claude` logged in**, non-empty `session/new.mcpServers`
= one stdio `custom-tools` server exposing `fn_task_list`.

- **Auth:** bridged `claude` authenticated via the interactive login session — no `/login` wall.
- **(1) MCP forwarding:** PROVEN — Claude invoked `mcp__custom-tools__fn_task_list`;
  the MCP server's `tools/call` executed; result returned via a `tool_call` `session/update`.
- **(2) Permission gate:** GATED — `session/request_permission` (`allow_once`/`allow_always`/`reject`)
  fired *before* execution. The ACP permission floor holds; forwarded MCP calls are NOT bypassed.

**Operational precondition (R17):** auth works only where the bridged `claude` can reach
the login/keychain session. The Fusion daemon/worker context is detached from that session
→ `Not logged in` (this is why FN-6466/6467/6473/6476 failed). Route-A mechanics are
unblocked (U10–U13 buildable); **shipping requires the provider's runtime to host an
authenticated `claude`** (keychain/login access, or file-based creds the daemon can read).

### R17 resolution (2026-06-15): daemon-auth is the HARD ship-gate — creds are Keychain-only

`claude` here stores OAuth creds in the **macOS Keychain** (`genp` / `svce="Claude Code-credentials"`),
NOT in a file: `~/.claude/.credentials.json` is an empty directory. Therefore forwarding `HOME`
to the bridge does **not** give the daemon-hosted `claude` its credentials. A detached Fusion
daemon/worker runs in a different security session with no login-Keychain access → `Not logged in`
(the root cause of the FN-6466/6467/6473/6476 failures).

**Implication:** U9 mechanics are GO, but **Route A cannot ship to the daemon-hosted `pi-claude-cli`
provider until daemon→Keychain auth is solved.** Candidate resolutions (each its own follow-up):
1. Host the provider's bridge in a process with login-Keychain access (run within the user's Aqua
   session, not a detached launchd daemon).
2. Provide the bridge's `claude` a file/API-key credential the daemon CAN read — but the user's auth
   is claude.ai OAuth, and the env allow-list deliberately excludes `ANTHROPIC_API_KEY` from the
   untrusted bridge; changing that is a security-posture decision.
3. Grant the daemon explicit Keychain access (`security unlock-keychain` / ACL) — fragile, security-sensitive.

Until one lands, Route A is mechanically proven but operationally blocked on macOS.

### R17 CLOSED (2026-06-15): confirmed by user — Claude CLI works in the live `fn` daemon today

The user confirmed the existing `pi-claude-cli` (`claude -p`) provider authenticates in their
running Fusion daemon. Since the daemon is launched from their login session, it has macOS
Keychain access; the ACP bridge's `claude` inherits the same session and authenticates identically.
**R17 is satisfied for the supported (login-session) daemon.** Residual (documented, not blocking):
detached/headless launchd daemons would still need a credential-delivery solution — out of scope
for the supported setup. **Route A (U10–U13) is cleared to build.**

### U11 tool-flow verification PASSED (2026-06-15): enablement gate cleared

Live run against pinned `claude-code-cli-acp` 0.1.1 in an authenticated session,
returning `cancelled` to every `session/request_permission` (what `streamViaAcp`
does). Two tests, fresh session each:

- **Forwarded MCP tool (`fn_task_list`):** Claude fired `ToolSearch` first
  (internal, completed), then `mcp__custom-tools__fn_task_list` — a permission
  request fired, we cancelled, the call went to `failed`, and the schema server's
  `tools/call` was NEVER reached (no execution marker). Forwarded tools do not
  execute when cancelled.
- **Native Bash:** permission request fired, we cancelled, `Bash` went to
  `failed`, the side-effect file was never created. Native tools do not execute
  when cancelled.

Conclusion: the bridge gates tool execution BEHIND `session/request_permission`
(no TOCTOU window); `streamViaAcp`'s deny-by-default handler + break-early on
pi-known tools is SAFE. Also validated: the bridged `claude` authenticates only
with the richer env allow-list (HOME/PATH + USER/SHELL/LANG/XDG_*) that
`streamViaAcp` forwards — a thin {HOME,PATH} env fails with "Not logged in".
The Route A enablement gate is CLEARED. Harness: /tmp/acp-toolflow/verify2.mjs.

### Route A architecture notes (2026-06-15, from review)

- **Two parallel MCP-forwarding paths, by design.** U10 wires `mcpServers` through the engine `AgentRuntimeOptions` → ACP plugin adapter `newAcpSession` (for the engine-driven `acp` runtime). U11's `pi-claude-cli` provider does NOT consume that field — `streamViaAcp` drives its OWN inline ACP client and builds `mcpServers` locally via `buildAcpMcpServers` (KTD10: the provider speaks ACP directly via the published bridge path, never through the plugin adapter). The two intersect only at the shared schema-only MCP server shape. Do not "wire U10 into U11" — that would double-forward.
- **Known residual: ACP-path token usage/cost reads zero.** `streamViaAcp` synthesizes pi events via `createEventBridge` from ACP `session/update`s, which carry no token-usage frames, so `output.usage` stays zero on the ACP path. Cost telemetry undercounts when the kill-switch is enabled. The U12 status surface should not treat zero-usage as a bug; wiring usage (if the bridge ever exposes it) is deferred.
