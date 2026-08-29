---
title: "Login-shell --login first-prompt latency: measurement and decision"
date: 2026-07-08
category: developer-experience
module: packages/dashboard/src/terminal-service.ts
problem_type: performance_investigation
component: embedded_terminal
applies_when: "Investigating why the embedded terminal's first prompt/output is slow to appear, specifically whether the `--login` shell flag in detectShell()/createSession() is the cause."
symptoms:
  - "Terminal view renders immediately but shows no output for multiple seconds"
  - "Suspicion that bash/zsh --login profile sourcing is the bottleneck"
root_cause: user_profile_content_not_the_login_flag
resolution_type: documented_finding_plus_additive_diagnostic
severity: low
related_components:
  - packages/dashboard/src/terminal-service.ts
  - packages/dashboard/src/__tests__/terminal-service.test.ts
tags: [terminal, login-shell, shell-profile, latency, pty, fn-7686, fn-7688]
---

# Login-shell `--login` first-prompt latency: measurement and decision

## Problem

FN-7686 (slow initial terminal load) flagged `detectShell()`'s use of `--login` for bash/zsh as a
*possible but unconfirmed, environment-dependent* contributor to first-prompt latency, and deferred
root-causing it. FN-7688 investigated this in isolation.

## Investigation

An ad hoc timed PTY harness (same `@homebridge/node-pty-prebuilt-multiarch` binding the dashboard
bundles) measured wall-clock time from `pty.spawn()` to first readable output byte, for
`bash`/`zsh` with and without `--login`, on (a) a typical/lean real developer profile and (b) a
synthetic heavy profile (`ZDOTDIR` pointed at a temp dir whose `.zprofile`/`.zshrc` each `sleep 0.8`).

Raw numbers and method are recorded in the FN-7688 task's `repro` document; summary:

- **Typical/lean profile:** `--login` vs. non-login delta is single-digit milliseconds for both
  bash and zsh — noise-level, not perceptible.
- **Heavy profile (simulated slow version-manager init):** `--login` costs an additional
  ~815-820ms over non-login, because a login *interactive* zsh sources `.zshenv` → `.zprofile` →
  `.zshrc` → `.zlogin`, while a non-login interactive zsh sources only `.zshenv` → `.zshrc`. Any
  slow command placed in `.zprofile`/`.zlogin` (not `.zshrc`) is entirely additive cost that only
  exists because of `--login`.

## Root cause

`--login` itself is not a meaningful latency contributor on a typical/lean shell profile. It **is**
a meaningful, user-environment-dependent contributor when the user's own `.zprofile`/`.bash_profile`
eagerly sources something slow (most commonly a version manager init script: nvm/rbenv/pyenv/direnv).
The mechanism is structural — a login shell sources strictly more profile files than a non-login
shell — not a defect in `detectShell()`/`createSession()`.

## Decision

`--login` is preserved unconditionally (per FN-7686's hard constraint): dropping it would silently
break `.zprofile`-managed PATH/env/secrets for any user relying on login-shell semantics. That
tradeoff is correct — the fix belongs in shell-profile hygiene, not in Fusion's spawn logic.

**Delivered mitigation (additive only, no spawn-path change):**

1. Operator-facing troubleshooting guidance in `docs/dashboard-guide.md` → "Slow first prompt /
   shell profile hygiene", explaining the login-vs-non-login profile-sourcing difference and
   concrete steps to trim/lazy-load slow `.zprofile`/`.bash_profile` content.
2. A one-time, non-blocking, server-log-only diagnostic in `terminal-service.ts`: if a login-shell
   session's first PTY output takes ≥ `SLOW_LOGIN_PROFILE_HINT_MS` (2000ms) to appear, a
   `console.info` hint is logged once per session, pointing at the docs section above. This never
   alters spawn args, timeouts, the readiness contract (`READY_QUIET_WINDOW_MS`/`READY_TIMEOUT_MS`),
   or the `retry-without-login` fallback — it is purely informational and additive.

## Verification

- `detectShell()` still returns `["--login"]` for bash/zsh, `[]` for sh/powershell/pwsh/cmd
  (asserted in `packages/dashboard/src/__tests__/terminal-service.test.ts`,
  describe block "FN-7688: --login preservation and slow-login-profile hint").
- `createSession()` still spawns `--login` as the primary attempt with the `retry-without-login`
  fallback registered.
- The slow-profile hint fires exactly once, only for login-shell sessions, only when first output
  is at/above the threshold, and never for non-login shells (sh) or fast sessions.
