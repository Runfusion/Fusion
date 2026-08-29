# Computer Use CLI

[← Docs index](./README.md) · [CLI reference](./cli-reference.md)

`fn computer` inspects and operates local desktop application windows. It enforces a safe, repeatable **snapshot → act → snapshot** loop: capture the current accessibility state, perform one deliberate action against that capture, then capture again before relying on the UI after navigation, focus changes, scrolling, or re-rendering.

> **Platform support:** macOS is supported using only operating-system-provided `osascript` and `screencapture`. Linux, Windows, and other platforms are honestly unsupported: `capabilities` and `permissions` succeed with `supported: false`; all other commands fail with `UNSUPPORTED_PLATFORM`. Fusion does not download a helper, native module, or automation dependency.

## Setup and permissions

Run the following first:

```bash
fn computer capabilities --json
fn computer permissions --json
```

On macOS, grant the application/process running `fn` both permissions in **System Settings**:

1. **Privacy & Security → Accessibility**: enable the terminal application, IDE, or host process that launches `fn`.
2. **Privacy & Security → Screen Recording**: enable that same host when screenshots are needed.
3. Quit and reopen the host application if macOS asks for it, then rerun `fn computer permissions --json`.

`permissions` reports each check as `granted`, `denied`, or `unknown`, not a guessed yes/no. It uses non-mutating preflights through the JXA Objective-C bridge: `AXIsProcessTrusted` for Accessibility and `CGPreflightScreenCaptureAccess` for Screen Recording. A probe that cannot run is `unknown`, never a claimed grant.

Do **not** use a successful `screencapture` as proof that Screen Recording is granted. macOS can return a normal-looking, desktop-only image when permission is denied. A denied Screen Recording grant therefore does not capture; an unknown grant may capture, but marks `verifiedPermission: false`.

## Quick workflow

Use a bundle ID when available; it is the least ambiguous target:

```bash
fn computer list-apps --json
fn computer get-app-state --app com.apple.Safari --json
# Inspect result.snapshot.elements[].index and save result.snapshot.snapshotId.
fn computer click --app com.apple.Safari --element-index 42 --snapshot-id cs_01HABCDE123 --json
# The successful action consumed that capture; inspect the fresh tree before another action.
fn computer get-app-state --app com.apple.Safari --json
```

The first command persists the snapshot before it prints its `snapshotId`. The later `click` may run in a completely separate `fn` process; `--snapshot-id` is an optimistic-concurrency fence that confirms the snapshot is still the current capture for that app. Every successful action consumes the app's latest capture, so the next element action fails with `SNAPSHOT_STALE` / `consumed-by-action` until `get-app-state` captures again.

Element indexes are snapshot-scoped and sparse. Read indexes from `snapshot.elements[].index`; never derive an index from `elementCount`, position, or bounds. Refresh state after navigation, focus change, scrolling, or re-rendering. Semantic actions (`click`, `set-value`) are preferred over raw keys because they survive focus changes better.

App resolution for a bare `--app` value is: exact bundle ID, then exact unambiguous name, then `pid:<n>`. Ambiguous names fail with `AMBIGUOUS_APP`.

## Commands and flags

All commands support `--json`.

| Command | Required flags | Optional flags |
| --- | --- | --- |
| `capabilities` | — | — |
| `permissions` | — | — |
| `list-apps` | — | — |
| `list-windows` | `--app <target>` | — |
| `get-app-state` | `--app <target>` | `--window-id <id>` or `--window-index <n>`, `--no-screenshot`, `--restore-window` |
| `click` | `--app`, `--element-index <n>` | `--snapshot-id <id>`, `--window-id <id>` or `--window-index <n>` |
| `set-value` | `--app`, `--element-index <n>`, one of `--value <text>` or `--value-stdin` | snapshot/window flags |
| `type-text` | `--app`, one of `--text <text>` or `--text-stdin` | `--element-index`, snapshot/window flags |
| `press-key` | `--app`, `--key <name>` | `--element-index`, snapshot/window flags |
| `hotkey` | `--app`, `--keys <combo>` (repeatable or `+`-joined) | — |
| `scroll` | `--app`, `--direction up\|down\|left\|right` | `--amount <n>` (default 3), `--element-index`, snapshot/window flags |
| `drag` | `--app`, either all `--from-x --from-y --to-x --to-y` or both `--from-element-index --to-element-index` | snapshot/window flags for element form only |

`--window-id` and `--window-index` are mutually exclusive. The value of `--snapshot-id` must match `^cs_[A-Za-z0-9]{10,40}$`; it is validated before filesystem access. Numeric indexes, coordinates, and amounts must be non-negative. Do not mix or partially provide drag forms. `hotkey` and coordinate-only `drag` take neither snapshot nor window flags.

Use `--value-stdin` and `--text-stdin` for secrets. Fusion does not put stdin values in output, process arguments, snapshot records, logs, audit metadata, or error messages.

Targetless `type-text`, `press-key`, and `scroll` act on the target app's currently focused UI element and never activate or raise the app implicitly. If nothing is focused, they fail with `ACTION_FAILED`; focus the app yourself or pass `--element-index`.

## JSON contract (schema version 1)

Every `--json` invocation prints exactly one object to stdout and nothing else. Success has `result` only; failure has `error` only:

```json
{"schemaVersion":1,"ok":true,"command":"computer.get-app-state","result":{}}
```

```json
{"schemaVersion":1,"ok":false,"command":"computer.click","error":{"code":"SNAPSHOT_STALE","message":"Snapshot expired.","remediation":"Re-run `fn computer get-app-state --app <app>`.","details":{"reason":"expired"}}}
```

`schemaVersion` is literal `1` and changes only for breaking reshapes. `command` is `computer.<subcommand>` using a runtime-inventory token. Group-routing failures (unknown or missing subcommand in JSON mode) uniquely use `command: "computer"`. `error.details`, when present, is a flat map of string, number, or boolean values and never contains a secret. Diagnostics go to stderr; in human mode successful summaries go to stdout and failures are `error: <code>: <message>` on stderr.

The runtime exports frozen `COMPUTER_SUBCOMMANDS`, `COMPUTER_ACTIONS`, and `COMPUTER_ERROR_CODES` tuples; their TypeScript unions and dispatcher derive from them. Adding a command requires updating this runtime inventory. Exit code is `0` for success and `1` for every failure. Error codes are append-only:

| Code | Meaning |
| --- | --- |
| `UNSUPPORTED_PLATFORM` | No supported adapter (except capability/permission reporting) |
| `PERMISSION_DENIED` | Definitively denied required permission or missing required built-in |
| `PERMISSION_UNVERIFIED` | Unknown probe followed by a permission-shaped OS failure |
| `INVALID_ARGUMENTS` | Invalid command, flags, number, enum, or snapshot ID |
| `APP_NOT_FOUND` / `AMBIGUOUS_APP` | No app match / more than one name match |
| `WINDOW_NOT_FOUND` | Supplied live window selector did not match |
| `SNAPSHOT_REQUIRED` | An element action has no snapshot for the app |
| `SNAPSHOT_STALE` | Snapshot is no longer usable; see below |
| `ELEMENT_INDEX_NOT_FOUND` | Sparse index is absent from the snapshot |
| `ELEMENT_UNRESOLVABLE` | Recorded locator no longer resolves or identity differs |
| `ACTION_UNSUPPORTED` / `ACTION_FAILED` | Adapter does not support action / OS action failed |
| `SCREENSHOT_FAILED` | Screenshot-only failure, reported in `screenshotError` rather than top-level error |
| `TIMEOUT` / `INTERNAL` | Timed-out seam / unexpected, redacted failure |

Remediation is required for unsupported platform, permission denied/unverified, snapshot required/stale, missing/unresolvable element, ambiguous app, and unsupported action.

### Result values

- `capabilities`: `{ platform, adapterId, supported, actions, unsupportedActions, features: { screenshot, restoreWindow, stdinSecrets, crossInvocationSnapshots } }`. Every action is in exactly one action list.
- `permissions`: `{ platform, adapterId, supported, allGranted, checks }`, where each check is `{ id: "accessibility"|"screen-recording", status: "granted"|"denied"|"unknown", granted, probed, probe, detail, remediation }`. `granted` is exactly `status === "granted"`; `allGranted` is the AND of checks.
- `list-apps`: `{ apps }`, sorted by name. An app is `{ bundleId, name, pid }`.
- `list-windows`: `{ app, windows }`. A window is `{ windowId, windowIndex, title, bounds, minimized }`.
- `get-app-state`: `{ app, window, snapshot, screenshot, screenshotError? }`. `snapshot` has `{ snapshotId, targetKey, windowKey, capturedAt, expiresAt, treeText, elementCount, truncated, elements }`. An element is `{ index, role, title, value, label, enabled, focused, bounds, actions, locator }`; its locator is `{ kind: "ax-path", path, role, subrole, identifier, title }`.
- Actions return `{ action, app, snapshotId, elementIndex, fromElementIndex, toElementIndex, performed: true, snapshotConsumed: true }` only after the OS action succeeds. `snapshotConsumed` confirms the app's latest capture was burned and a fresh capture is required before another element action. Single-endpoint actions use `elementIndex`; element-form drag uses `fromElementIndex` and `toElementIndex` with `elementIndex: null`; hotkey reports all index fields and `snapshotId` as `null`.

Screenshots are always paths, never base64, `data:` URLs, or byte arrays. `--no-screenshot` produces `screenshot: null` with no `screenshotError`; successful capture has `screenshot` and no error; failed/not-captured has `screenshot: null` and `screenshotError`. Screenshot `verifiedPermission` is true only for a preflight-confirmed Screen Recording grant.

## Permissions outcome matrix

| Check/status | Command behavior |
| --- | --- |
| Accessibility granted | Proceed. |
| Accessibility denied | Before automation, fail `PERMISSION_DENIED` with `details.permission: "accessibility"`. |
| Accessibility unknown | Attempt the call. A permission-shaped failure becomes `PERMISSION_UNVERIFIED`; other failures are `ACTION_FAILED` or `TIMEOUT`. This applies to window/locator replay too. |
| `capabilities` or `permissions` | Never fail because of permission status; return status data. |
| Screen Recording granted | Capture; successful image has `verifiedPermission: true`; a failed capture is `SCREENSHOT_FAILED` or `TIMEOUT`. |
| Screen Recording denied | Do not capture; return screenshot `null` and `screenshotError.code: "PERMISSION_DENIED"`. |
| Screen Recording unknown | Attempt capture; success has `verifiedPermission: false`; failure is `PERMISSION_UNVERIFIED` or `TIMEOUT`. |
| Any Screen Recording status with `--no-screenshot` | Do not probe or capture; screenshot is null without an error. |
| Missing `osascript` | Checks are unknown; non-reporting commands fail `PERMISSION_DENIED` with `details.missingBinary: "osascript"`. |
| Missing `screencapture` | Only screenshot degrades with `SCREENSHOT_FAILED`. |

## Durable snapshots and safe element replay

Snapshots are stored under the resolved Fusion project root, not the invoking working directory: `<projectRoot>/.fusion/computer-use/snapshots/<snapshotId>.json`; the app's latest pointer is `<projectRoot>/.fusion/computer-use/latest/<targetKeySlug>.json`. Each `fn computer` invocation resolves that root once by walking upward from its starting directory, and falls back to that resolved directory when no project root is found. Snapshots, pointers, and screenshots use the same root, so they are never shared across projects. Capture atomically persists the record and pointer before returning `snapshotId`.

A resolved app has app-scoped `targetKey` (`bundle:<bundleId>`, or `pid:<pid>`) and window-scoped `windowKey` (`<targetKey>#<windowId>`). There is one latest pointer per app, not per window. An action with no `--snapshot-id` uses that latest snapshot. A successful action consumes that app-scoped pointer rather than deleting its record, so both implicit and matching explicit IDs fail with `SNAPSHOT_STALE` / `consumed-by-action` until a new capture re-arms the pointer. Action window flags are optional assertions: a supplied selector that differs from the recorded window produces `SNAPSHOT_STALE` / `window-mismatch`.

Snapshots expire after five minutes by default; `expiresAt` publishes the exact deadline. An explicit snapshot ID is a concurrency fence, not a way to revive old UI: a superseded ID fails. Before acting, Fusion re-resolves the recorded window and then the locator rooted in it, verifying role, subrole, and recorded identifier. It never acts on a new occupant of the old path and never falls back to saved bounds/coordinates.

| Failure | When | Recovery |
| --- | --- | --- |
| `SNAPSHOT_REQUIRED` | No latest snapshot exists for the target app | Run `get-app-state`. |
| `SNAPSHOT_STALE` | `not-found`, `superseded`, `consumed-by-action`, `expired`, `pid-changed`, `window-mismatch`, or `window-gone` | Run `get-app-state`; use the current window and snapshot. |
| `ELEMENT_INDEX_NOT_FOUND` | Index is absent from sparse map | Read the current `elements[].index` after re-snapshotting. |
| `ELEMENT_UNRESOLVABLE` | Locator path fails or identity no longer matches | Re-snapshot; do not retry with coordinates. |

## Deterministic failure order and timeouts

Exactly one error is emitted: the first failing stage wins. The order is group routing; flag parsing; platform resolution; action support; built-in and permission gate; stdin read; app resolution; supplied-window resolution; snapshot resolution; sparse element lookup; window/locator replay; OS call. Thus malformed flags beat unsupported platform, and a permission-shaped replay error is `PERMISSION_UNVERIFIED`, not an element error. Unexpected failures become a redacted `INTERNAL` envelope, never a stack trace on stdout.

No user timeout flag is provided. Default seam timeouts are: permission probe 5 seconds; app/window listing 10 seconds; state capture 20 seconds; screenshot 15 seconds; locator replay 10 seconds; action 10 seconds.

## Orca prior art and Fusion differences

This surface was informed by [Orca](https://github.com/stablyai/orca) and its [computer-use CLI documentation](https://www.onorca.dev/docs/cli/computer-use). Orca uses two layers: a native-backed `orca computer` CLI and a thin skill that loads a version-matched guide. Fusion follows the CLI-plus-skill separation; the thin discovery skill is shipped separately from this command surface.

Fusion deliberately differs by using macOS OS built-ins instead of native helpers; publishing non-mutating preflight permission checks, an `unknown` status, and the outcome matrix; documenting durable on-disk cross-process snapshots with identity-verified window/locator replay; distinguishing stale, missing, and unresolvable indexes; publishing deterministic failure precedence; and using a versioned envelope with a fixed append-only error enum. `paste-text` and `perform-secondary-action` are not implemented in this release; they remain absent from capabilities rather than being stubs.

## Use it from an agent

<!-- FNXC:ComputerUseDiscovery 2026-08-11-09:23: FN-8984 requires runtime discovery only on macOS, where the CLI capability is supported. Runtime gates must remain authoritative so a requested name or additional bundled path cannot teach unsupported platforms an unreachable capability. -->

### How agents discover this

On macOS, Claude and Grok runtime sessions stage the shipped `computer-use` discovery skill in their session plugin directory, and Hermes installs it into `<hermes home>/skills/computer-use`. The gate is authoritative: no runtime option, requested skill name, or additional path can stage the bundled skill elsewhere, and the Hermes installer returns `skipped` without touching the Hermes home on other platforms. This avoids spending context or disk on an unsupported CLI capability.

Fusion ships the thin `computer-use` skill alongside the Fusion skill. When Claude-compatible skill installation is configured, both are reconciled into project `.claude/skills/` directories; `fn init` also copies both into supported home skill directories.

The discovery stub intentionally contains no command reference. An agent resolves one `fn` executable for its session and runs `fn skills get computer-use` before automation. That command renders its complete guide in-process from the same binary's command-surface descriptor and reports the same package version as `fn --version`.

This is an anti-drift contract: dispatch keys, parser flag literals, required/mutually-exclusive validation, and emitted error codes are independently checked against the descriptor; the rendered guide then includes every command, flag, and error code without truncation. The delivered parser still does not reject unknown flags or invalid enum choices, and a flag literal's source presence does not itself prove a handler honors it.
