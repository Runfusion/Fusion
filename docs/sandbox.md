# Sandbox Backends

## Linux `bubblewrap` backend

Fusion supports an opt-in Linux sandbox backend using `bubblewrap` (`bwrap`).

- Enable with `sandbox.backend = "bubblewrap"`
- Default remains `native`
- If unavailable, behavior follows `failureMode` (`fail-hard` or `fallback-native`)

### Install

- Debian/Ubuntu: `sudo apt install bubblewrap`
- Fedora: `sudo dnf install bubblewrap`

### Policy mapping

`policyToBwrapArgs()` translates sandbox policy into bwrap args:

- Writable binds (`--bind`): worktree path, pnpm store path, plus configured `allowedWritePaths`
- Read-only binds (`--ro-bind`): repo root (when distinct), system runtime paths (`/usr`, `/bin`, `/lib`, `/lib64`), TLS/DNS paths, and node binary directory
- Temporary filesystem: `--tmpfs /tmp`
- Working directory: `--chdir <worktreePath>`
- Network isolation: `allowNetwork=false` adds `--unshare-net`
- Environment isolation: `--clearenv` plus allowlisted passthrough (`PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `NODE_*`, `npm_*`, `PNPM_*`, `CI`, `FUSION_*`)

### Port 4040 guard

Port 4040 is reserved for the production dashboard. Sandbox policy rejects `allowedPorts` containing `4040` unless `allowPort4040Override=true` is explicitly set.

### Fusion workflow defaults

Use `fusionWorktreePreset(ctx)` to get the standard Fusion-friendly defaults:

- Worktree writable
- pnpm store writable
- `.fusion/` compatibility metadata and task artifacts are not added to writable mounts

### Troubleshooting

If you see `bwrap: setting up uid map: Permission denied`, unprivileged user namespaces may be disabled by host policy/kernel settings. Enable user namespaces or use `sandbox.backend = "native"` as a fallback.

### Related settings

See `docs/settings-reference.md` for full sandbox settings schema and precedence.

## macOS `sandbox-exec` backend

Fusion supports an opt-in macOS sandbox backend using Apple's `sandbox-exec` (Seatbelt).

- Enable with `sandbox.backend = "sandbox-exec"`
- Default remains `native`
- If unavailable, behavior follows `failureMode` (`fail-hard` or `fallback-native`)

### Install / availability

`/usr/bin/sandbox-exec` ships with macOS. If detection fails, install Xcode Command Line Tools and retry.

### Policy mapping

`policyToSbplProfile()` translates policy into an SBPL profile:

- Base deny policy with additive allows
- Writable paths: worktree, pnpm store, `/private/tmp`, and user temp (`/private/var/folders/.../T/`)
- Read paths: repo root (when needed), Node binary directory, and curated system/runtime paths (`/usr`, `/bin`, `/sbin`, `/System`, `/Library`, resolver/cert/hosts/services/timezone paths)
- Network: `allowNetwork=true` enables outbound and local bind, `allowNetwork=false` denies network

### Port 4040 guard

Port 4040 is always blocked in the emitted SBPL profile (`(deny network-bind (local ip "*:4040"))`), and policy rejects explicit 4040 allowance unless `allowPort4040Override=true` is set.

### `.fusion/` write guard

Writable paths under `.fusion/` (including `.fusion/project.json`, retained migration inputs, and `.fusion/tasks/**`) are rejected by policy validation.

### Troubleshooting

If commands fail with `sandbox-exec: ...: Operation not permitted`, expand `allowedReadPaths`/`allowedWritePaths` for required inputs/outputs.

### Deprecation note

Apple marks `sandbox-exec` as deprecated. It remains functional for many workflows, but `failureMode = "fallback-native"` is the recommended hedge when host support varies.
