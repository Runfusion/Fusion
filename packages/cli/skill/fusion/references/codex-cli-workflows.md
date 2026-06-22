# Codex CLI Workflows

Use this fallback when Fusion's registered `fn_*` tools are not available. Run commands from the intended repository root. The `fn` and `fusion` executables are equivalent; prefer `fn` for brevity.

## Preflight

1. Resolve the intended repository and inspect its Git status before initialization or automated execution.
2. Verify the CLI with `fn --version`.
3. Detect the project with `fn project detect`; use the global `--project <name>` option when selection is ambiguous.
4. Run `fn init` only when the user intends to adopt Fusion in that repository.
5. Use structured JSON output whenever the selected command documents `--json`.
6. Capture returned identifiers and use those exact values in later commands.

## Projects and Tasks

```text
fn project detect
fn project list --json
fn init
fn --project <name> <command>

fn task create "<outcome, scope, constraints, and acceptance criteria>"
fn task plan "<description>"
fn task list
fn task show <task-id>
fn task logs <task-id> --limit <n>
fn task move <task-id> <triage|todo|in-progress|in-review|done|archived>
fn task pause <task-id>
fn task unpause <task-id>
fn task comment <task-id> "<message>"
fn task steer <task-id> "<direction>"
```

Task creation enters triage. Do not move a task into automated execution unless the user requests it.

## Goals, Missions, and Research

```text
fn goals list
fn goals create "<title>" "<description>"
fn mission create "<title>" "<description>" --goal <goal-id> --base-branch <branch>
fn mission list
fn mission show <mission-id>
fn mission activate-slice <slice-id>

fn research create --query "<question>" --wait --json
fn research list --limit <n> --json
fn research show <run-id> --json
fn research export <run-id> --format markdown --output <path> --json
```

Inspect a mission before activating a slice because activation can release work for execution. Use research `--wait` only when the result is needed in the current interaction.

## Dashboard and Service Safety

```text
fn dashboard --paused
fn dashboard --no-engine
fn serve --paused
fn daemon --paused
```

- Prefer `--paused` for first inspection and `--no-engine` for UI-only use.
- Keep the default loopback host unless the user explicitly requests network exposure.
- Never use `--no-auth` on a non-loopback host.
- Never echo or persist dashboard tokens, daemon tokens, API keys, or secret values.

## Mutation Safety

- Treat task movement, agent starts, mission activation, merges, PR actions, imports, restores, plugin installation, settings changes, and service startup as state-changing operations.
- Before enabling execution or merging, inspect the task and relevant settings. Fusion may create branches or worktrees and automate review or merge flows.
- Do not use `--force`, `--yes`, deletion, restore, or merge commands merely to bypass a prompt or error.
- Preserve unrelated changes in dirty worktrees.
- After every mutation, verify the affected entity with `show`, `list`, or logs.
- For third-party plugins, inspect provenance and use `fn plugin install <source> --ai-scan`; an AI scan is not a sandbox or a guarantee of safety.
