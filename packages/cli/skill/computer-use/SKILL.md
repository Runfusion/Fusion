---
name: computer-use
description: Control a desktop app, click a button in an app window, read what is on screen in an app, automate a GUI, drive a native app, or fill a form in a desktop app.
---

<!--
FNXC:ComputerUseSkill 2026-08-11-07:19:
This discovery stub must never gain a computer command or flag list. The binary owns its matching
reference through `fn skills get computer-use`; computer-use-skill.test.ts enforces this boundary.
-->

## When to engage
Use this skill for desktop GUI automation, reading native app state, clicking controls, or filling desktop forms.

## Resolve the CLI for this session
Resolve exactly one executable in this order: an explicitly exported `FUSION_CLI_BIN`, then `fn` on PATH, then the dev-checkout entry point. Reuse that executable for every command in this session. If resolution fails, report the error and stop; do not fall through to a different binary that could target another build.

## Load the full guide before running commands
Using the resolved executable, run `fn skills get computer-use` before any computer command. It prints the complete guide for the exact binary that will execute work.

## Keep this stub thin
This stub deliberately lists no subcommands or flags, so it can never drift from the binary that will actually run your commands.

## Older-binary fallback
If that binary does not know `skills get`, only inspect these read-only capabilities, then ask the user to update Fusion rather than guessing a command surface:

- `fn computer capabilities --json`
- `fn computer permissions --json`
- `fn computer list-apps --json`

macOS is first-class. On other platforms capabilities report `supported: false` and actions fail with `UNSUPPORTED_PLATFORM`; stop instead of retrying.
