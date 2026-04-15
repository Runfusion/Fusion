---
name: moshi-best-practices
description: Use when preparing or verifying a host for Moshi remote coding. Trigger this for SSH or preferably Mosh readiness, non-interactive shell PATH issues, tmux defaults, creating a tmux project session rooted at a chosen directory, installing Moshi agent hooks for Claude Code or Codex CLI, or offering the optional `moshi DIR` shell helper.
---

# Moshi Best Practices

Use this skill to make any host feel easy to use from Moshi.

Use it for either:

- fresh setup
- verification of an existing setup

## Rules

- Inspect before editing.
- Prefer direct config edits over platform-specific setup scripts.
- Verify every outcome after changing it.
- For `moshi DIR`, use a shell function named `moshi`, not a literal alias. Aliases cannot take arguments safely.

## 1. Host Readiness

Target outcome:

- preferred transport is Mosh plus tmux; fallback is SSH plus tmux
- the host has a working SSH entry point
- `tmux` is installed
- `mosh-server` is installed when the user wants Mosh, otherwise SSH plus tmux is acceptable
- both resolve in the current shell and in the login shell's non-interactive mode
- at least one tmux session exists so the Moshi selector can appear.

Inspect with a small set of real checks. Keep OS-specific mechanics minimal, but do not skip verification.

Useful checks:

```bash
command -v tmux || true
command -v mosh-server || true
tmux list-sessions 2>/dev/null || true
LOGIN_SHELL="${SHELL:-/bin/sh}"
"$LOGIN_SHELL" -c 'command -v tmux'
"$LOGIN_SHELL" -c 'command -v mosh-server'
```

Useful macOS-specific checks when relevant:

```bash
dscl . -read "/Users/$USER" UserShell
systemsetup -getremotelogin || true
```

Verify after changes:

```bash
command -v tmux
tmux list-sessions
"$LOGIN_SHELL" -c 'command -v tmux'
"$LOGIN_SHELL" -c 'command -v mosh-server' || true
```

Then ask the user to reconnect from Moshi. Expected result: the tmux selector appears, and the transport can use Mosh instead of plain SSH when configured.

## 2. tmux Environment

Use these defaults unless the user wants something different:

```tmux
set -g history-limit 100000
set -g mouse on
set -g set-titles on
set -g set-titles-string "#I: #W"
set -g base-index 1
setw -g pane-base-index 1
set -g renumber-windows on
```

Workflow:

- inspect the existing tmux config
- update overlapping settings instead of appending duplicates
- reload tmux after editing

## 3. tmux Project Session

When creating a new session:

- read the current working directory
- ask one concise question: should the session start from here?
- if the answer is no, ask for the directory
- default the session name to the directory basename
- create the session detached
- use the chosen directory for every initial window with `tmux ... -c <dir>`

Recommended windows:

1. `agent`
2. `review`
3. `tests`
4. `servers`
5. `misc`

Create the session detached and root every initial window at the chosen directory.

Then ask the user to reconnect in Moshi. Expected result: the session is visible in the tmux selector.

## 4. Optional `moshi DIR` Helper

Do not install this silently. Ask the user first if they want it.

If yes:

- install a shell function named `moshi` in the correct startup file for the active shell
- make it accept a directory argument, defaulting to `$PWD`
- name the tmux session from the directory basename
- create the standard detached session layout only if the session does not already exist
- attach to the session afterward

Use the exact function from `references/moshi-shell-function.md`.

## 5. Agent Hooks

Use `moshi-hooks`, not hand-written config, unless the user explicitly wants manual edits.

Core commands:

```bash
bunx moshi-hooks setup
bunx moshi-hooks token <YOUR_TOKEN>
```

Optional integrations:

```bash
bunx moshi-hooks setup --local
bunx moshi-hooks setup .
bunx moshi-hooks setup --codex
bunx moshi-hooks setup --opencode
```

Final verification:

- run a short real agent task
- confirm Moshi receives a push notification or Live Activity update
