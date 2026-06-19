---
title: "ACP bridge returns 'Not logged in' despite a working claude -p: thin spawn env + Keychain session isolation"
date: 2026-06-15
category: integration-issues
module: pi-claude-cli
problem_type: integration_issue
component: tooling
symptoms:
  - "ACP-bridged turns return the literal assistant text 'Not logged in · Please run /login' instead of real answers"
  - "claude -p \"say hi\" works in the same shell while the bridge fails"
  - "A verification harness forwarding only HOME and PATH fails even inside an authenticated terminal"
  - "Reproducible under detached/headless runners (launchd daemon, autonomous task runner) but not interactively"
root_cause: incomplete_setup
resolution_type: code_fix
severity: high
tags: [acp, claude-code, keychain, spawn-env, authentication, macos, pi-claude-cli]
related_components: [authentication, tooling]
---

# ACP bridge returns 'Not logged in' despite a working claude -p: thin spawn env + Keychain session isolation

## Problem

The `claude-code-cli-acp` ACP bridge — driven by Fusion's `pi-claude-cli` provider to replace `claude -p` — returned the assistant text **"Not logged in · Please run /login"** instead of real answers, even though `claude -p "say hi"` succeeded in the same shell. The cause was environmental, not an upstream bridge limitation: a thin spawn env starved `claude` of the variables it needs to locate its auth, and macOS Keychain session isolation blocked headless processes from reading the login Keychain at all.

## Symptoms

- ACP-bridged turns return the literal text `Not logged in · Please run /login` (no tool calls, no real content), while `claude -p "say hi"` works in the same interactive shell.
- A verification harness that forwarded only `{HOME, PATH}` to the bridge failed **even inside an authenticated terminal**, falsely implying the auth itself was broken.
- The failure is reproducible in detached/headless contexts (launchd daemon, autonomous task-runner subprocess) but not in interactive ones — "works when I run it, fails when the daemon runs it."
- `~/.claude/.credentials.json` exists but is an empty **directory**, making file-based credential debugging a dead end.

## What Didn't Work

- **Six autonomous headless task attempts** (FN-6466/6467/6473/6476) re-ran the bridge spike, each hit "Not logged in," concluded **NOT-GO**, and even filed upstream issue `moabualruz/claude-code-cli-acp#2` — misattributing an environmental problem to an upstream bridge gap.
- **A `{HOME, PATH}`-only verification harness** kept failing in an authenticated terminal. Because it failed where auth was known-good, it masked that the *env*, not the *auth state*, was wrong — and reinforced the wrong conclusion across every retry.
- **Re-running `claude` / `claude --print` to "re-auth"** — print mode is non-interactive and cannot perform interactive OAuth login, so this could never repair the session.

## Solution

Two changes, one per root cause.

**1. Forward the full env allow-list when spawning the bridge.** Build the bridge subprocess env from an explicit allow-list (never inherited `process.env`, never API keys), and make that list *complete* — not just `{HOME, PATH}`.

`packages/pi-claude-cli/src/acp-driver.ts`:

```ts
const BRIDGE_ENV_ALLOWLIST = [
  "HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
  "TERM", "TERMINFO", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "COLORTERM",
];

function buildBridgeEnv(supplied?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const source = supplied ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const key of BRIDGE_ENV_ALLOWLIST) {
    const v = source[key];
    if (typeof v === "string") env[key] = v;
  }
  return env;
}
// spawn(options.bridgePath, [], { ..., env: buildBridgeEnv(options.bridgeEnv) })
```

The critical additions over a naive `{HOME, PATH}` env are **`XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `USER`, `SHELL`, `LANG`**. With the full list, auth succeeds immediately.

> The allow-list itself never carries API keys. The one exception is an **explicit operator opt-in**, `FUSION_CLAUDE_ACP_FORWARD_AUTH=1`, which forwards a single Claude auth token (`CLAUDE_CODE_OAUTH_TOKEN` > `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY`) for headless daemons that can't reach the login Keychain (gate R17). It is **OFF by default**, so the no-secrets posture above is the standing default — the opt-in only widens exposure when the operator deliberately enables it.

**2. The Keychain finding (gate R17).** Claude Code stores its OAuth credentials in the macOS **login Keychain** as a generic-password item (service `"Claude Code-credentials"`), *not* a file (`~/.claude/.credentials.json` is an empty directory). A detached/headless process runs in a **different security session** and cannot read the login Keychain, so it fails regardless of env; a login-session process (interactive terminal, or an `fn` daemon launched from a login shell) can. This is codified as gate **R17**: the provider's runtime must have login-Keychain access. The driver also detects a not-logged-in turn and writes a best-effort cross-process signal (`fusion-acp-bridge-auth.json`) that `GET /providers/claude-cli/status` reads, so the dashboard can raise an auth-failure banner with a "Use `claude -p`" fallback.

## Why This Works

Two independent environmental causes were compounding, which is why the failure looked like a flaky upstream bug:

1. **Thin spawn env (the silent one).** `claude` resolves config/auth through more than `{HOME, PATH}` — it reads `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` for config locations and relies on `USER`/`SHELL`/`LANG` for session and locale context. Spawned with only `{HOME, PATH}` it can't locate its auth context and reports "Not logged in." The `{HOME,PATH}`-only harness reproduced this *even in an authenticated terminal*, which is exactly why it misdirected six investigations: it "proved" the bridge couldn't auth using a starved env.

2. **macOS Keychain session isolation.** Even with a perfect env, the login Keychain is bound to the login security session. Interactive terminals (and daemons started from a login shell) share that session and can read the `"Claude Code-credentials"` item; detached launchd daemons and autonomous subprocesses run in a separate session and cannot. Same machine, same credentials, different security session — the precise reason `claude -p` worked interactively while the headless tasks failed.

## Prevention

- **When spawning an agent CLI as a subprocess, forward the full env allow-list, not a thin `{HOME, PATH}`.** Agent CLIs resolve auth/config through `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `USER`, `SHELL`, and locale vars. Keep the allow-list explicit (no inherited `process.env`, no API keys) but make it *complete*.
- **Never trust a verification harness that uses a thinner env than the real spawn path.** A harness that forwards fewer vars than production manufactures failures and masks the real cause. Match the production allow-list exactly, or the harness lies.
- **Treat "works interactively but fails headless" as a session/Keychain problem first.** On macOS, OAuth/login credentials live in the session-bound login Keychain. A detached daemon or autonomous task-runner is in a different security session and cannot read them — no amount of env or file fiddling fixes that. Ask "is this process in the login session?" before assuming the tool is broken.
- **Headless daemons need an explicit credential-delivery story.** Don't assume a daemon inherits interactive credentials. Either launch it from a login shell/session or provide credentials through a session-independent channel, and encode it as a runtime gate (here, R17) so it's checked rather than rediscovered.
- **Don't let autonomous/headless task-runners conclude "impossible" or file upstream issues from a single un-isolated failure.** Six runs reached NOT-GO and an upstream issue from one un-diagnosed environmental cause. Require an environmental-isolation step (interactive vs. headless, full vs. thin env) before declaring an integration unworkable.

## Related Issues

- `docs/solutions/architecture-patterns/acp-persistent-jsonrpc-agent-runtime-integration.md` — the ACP runtime integration pattern. Its §3 rule "build the subprocess env from an allow-list, never inherited `process.env`" is the principle this doc operationalizes; this doc is its concrete failure mode (allow-list too thin → "Not logged in") plus the Keychain-isolation dimension that pattern doc does not cover.
- Upstream `moabualruz/claude-code-cli-acp#2` — filed during the failed investigation; the issue is environmental (this doc), not an upstream bridge gap.
