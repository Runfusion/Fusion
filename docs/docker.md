# Running Fusion in Docker

This guide shows how to build and run Fusion in a container.

> This document is about containerizing Fusion itself (`docker build` / `docker run`).
> For managed Docker mesh-node provisioning architecture (services, routes, mesh config flow, and `4041` vs reserved `4040` port convention), see [Architecture → Docker Node Provisioning](./architecture.md#docker-node-provisioning).

## Build the image

```bash
docker build -t fusion .
```

## Run the dashboard

Mount your project into `/workspace` and publish the dashboard port:

```bash
docker run -p 4040:4040 -v /path/to/project:/workspace fusion
```

The application itself is installed under `/app`; `/workspace` is reserved for
your project and is the container's working directory. Do not mount over `/app`.

By default, the container runs:

```bash
fn dashboard
```

on port `4040`.

## Environment variables

Pass provider credentials and integrations with `-e` flags:

```bash
-e ANTHROPIC_API_KEY=...
-e OPENAI_API_KEY=...
-e GITHUB_TOKEN=...
-e FUSION_DASHBOARD_TOKEN=fn_your_stable_token   # optional; persists across restarts
```

Add any other provider keys your setup requires (for example `OPENROUTER_API_KEY`).

### Dashboard authentication

The dashboard is bearer-token protected by default. In a container the
auto-generated token appears in `docker logs` on startup — copy it, or set
`FUSION_DASHBOARD_TOKEN` (or the back-compat `FUSION_DAEMON_TOKEN`) to a
stable value so the token survives restarts. See
[CLI reference → fn dashboard → Authentication](./cli-reference.md#fn-dashboard)
for the full flow.

## Provider OAuth logins (Anthropic, OpenAI Codex)

Anthropic subscription login uses a loopback callback server on port `53692`. OpenAI Codex uses
that browser callback on port `1455` only when the dashboard is reached at a localhost origin. For
a remote dashboard origin, Codex instead displays a device code and a verification-page link; enter
the code on that page, with no localhost callback or paste-back required.

Publish the Anthropic port (and Codex `1455` only when you intentionally use Codex browser login)
and bind the listener to all interfaces:

```bash
docker run -p 4040:4040 -p 53692:53692 -p 1455:1455 \
  -e PI_OAUTH_CALLBACK_HOST=0.0.0.0 \
  -v /path/to/project:/workspace \
  -v fusion-home:/home/node/.fusion \
  fusion
```

These callback ports are fixed by their providers' registered redirect URIs and cannot be remapped
to different host ports. If an environment needs the Codex browser flow despite a remote dashboard,
call `POST /api/auth/login` with `{"provider":"openai-codex","method":"browser"}`; this restores
the paste-back/callback behavior. The temporary callback listener validates OAuth `state`, but
prefer publishing it only on a trusted network.

## Helper script

`scripts/run-container.sh` runs the container with a complete argument list — the OAuth callback
ports, the `/home/node` volume, and the correct placement of `--tailscale` before the CLI arguments:

```bash
scripts/run-container.sh --tailscale
scripts/run-container.sh --build --recreate --tailscale   # rebuild, then replace the container
scripts/run-container.sh --dry-run                        # print the docker command, run nothing
```

Every knob is an environment variable (`--help` lists them). Keep a per-container config in a file
outside the repo — it holds your dashboard token — and pass it with `--env-file`:

```bash
scripts/run-container.sh --env-file ~/.config/fusion/my-box.env --tailscale --recreate
```

An existing container is never replaced without `--recreate`, and volumes are never removed, so a
recreate keeps the database, settings, and tailnet login.

## Tailscale remote access

The image ships the `tailscale` CLI, but the `tailscaled` daemon does **not** run by default — most
containers never use remote access. Fusion's tunnel spawns a bare `tailscale funnel <port>`, which
talks to that daemon over a local socket, so without it the tunnel dies immediately with
`failed to connect to local tailscaled` and exit 1.

Start the daemon by passing `--tailscale` before the normal CLI arguments:

```bash
docker run -p 4040:4040 \
  -v /path/to/project:/workspace \
  -v fusion-home:/home/node \
  fusion --tailscale dashboard --host 0.0.0.0
```

The flag is consumed by the entrypoint and stripped from the argument list, so everything after it
is an ordinary Fusion CLI invocation. `FUSION_TAILSCALE=1` does the same thing for Compose files and
other env-driven setups; `--no-tailscale` overrides it back off.

The daemon runs in **userspace networking** mode, so it needs neither `--cap-add NET_ADMIN` nor
`--device /dev/net/tun` — the documented `docker run` above is complete. That mode is sufficient for
`tailscale serve`/`funnel`, which proxy to a local port rather than route packets.

It starts **logged out**. Authenticate the machine once:

```bash
docker exec -it <container> tailscale up
```

Open the printed URL to approve the node. Login state is written under `/var/lib/tailscale`, which
the image symlinks into `/home/node/.tailscale` — so mounting a volume at `/home/node` (as above)
persists the login across container recreates. Funnel additionally requires HTTPS certificates
enabled and the `funnel` node attribute granted in your tailnet's ACL policy.

If the daemon is missing, logged out, or stopped, the dashboard's remote-access card reports that
directly rather than failing with an unexplained exit code.

## Update Fusion from source, from the dashboard

A contributor whose only access to the box is the Fusion dashboard can pull new source, rebuild it,
and restart into it — no shell, no Docker socket, no image rebuild — using **Command Center → System
Controls → Update from source**. Two pieces make that possible.

**The entrypoint is a restart supervisor.** PID 1 is the wrapper script, not the dashboard, so a
restart request (exit code 86) relaunches the dashboard in place. Any other exit code still ends the
container with its real status, and `SIGTERM`/`SIGINT`/`SIGHUP` are forwarded to the dashboard so
`docker stop` shuts down gracefully. Without this the System panel's Restart button was inert in a
container, because nothing was there to respawn the process.

**Run the CLI from a source checkout instead of the image.** The image-baked `/app` has no `.git` and
no build scripts, so it cannot be updated. Pass `--from-source` before the CLI arguments (or set
`FUSION_FROM_SOURCE=1`) to run the CLI from a git checkout instead:

```bash
docker run -v fusion-node-home:/home/node fusion --from-source dashboard --host 0.0.0.0
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `FUSION_FROM_SOURCE` | `0` | Env equivalent of `--from-source`. |
| `FUSION_SOURCE_ROOT` | `/home/node/fusion` | The git checkout to run from. Needs `node_modules` installed and a built `packages/cli/dist/bin.js`. |
| `FUSION_APP_ROOT` | `/app` | The image-baked build used when not running from source. |

If `--from-source` is requested and the checkout has no built CLI, the container **fails to start
with a message naming the path** rather than quietly serving `/app` — a container silently running
different code than you asked for is worse than one that refuses to start.

With those in place the **Update from source** control runs, against that checkout:

1. `git status --porcelain` — a dirty tree is refused, not stashed or merged over.
2. `git pull --ff-only` — a diverged branch is refused; no merge commit is ever created.
3. `pnpm install` and a full workspace build, streamed live into the System panel's job log.
4. A restart **only if the build succeeded.** A failed build leaves the running instance completely
   untouched, so the dashboard stays up and you can read the failure and try again.

Only one such job runs at a time; a second request while one is in flight is rejected. The control is
disabled with the reason when the process is not running from a git checkout, or when nothing is
supervising it. Authentication is the normal dashboard bearer token.

### Remote access survives a restart

A supervised restart is not a shutdown: the same machine, the same `tailscaled`, and the same operator
are all still there seconds later. Restart (and the source update, which ends in one) therefore **hands
the Tailscale funnel over instead of stopping it** — the funnel process is released from parent-death
supervision and the relaunched dashboard adopts it, so the public URL never goes dark and no second
`tailscale funnel` is spawned (two against one node conflict, and the loser clears the winner's
config). Only a genuine container stop tears the tunnel down, recording the "was running" marker so the
next boot restores it.

If the released process does not survive the swap, the relaunch finds no funnel to adopt and simply
restores one from that marker — a few seconds of downtime rather than a dead URL. The System panel's
remote-access card reports which happened: `restore.reason` is `adopted_running_tunnel` for a clean
handover and `restore_started` for a respawn.

## Pass additional CLI flags

You can append normal CLI arguments after the image name:

```bash
docker run fusion dashboard --port 8080
```

If you change the dashboard port, also update Docker port mapping:

```bash
docker run -p 8080:8080 fusion dashboard --port 8080
```

## Persistence

Fusion keeps state in two places inside the container:

- **Per-project state** — `.fusion/` under the mounted project (`/workspace/.fusion`).
  This is covered automatically by the `/workspace` project mount.
- **Global state** — `/home/node/.fusion` (embedded PostgreSQL data, global
  settings, agents). This is *not* under `/workspace`, so mount it separately if
  you want it to survive container removal:

```bash
docker run -p 4040:4040 \
  -v /path/to/project:/workspace \
  -v fusion-home:/home/node/.fusion \
  fusion
```

The named volume `fusion-home` persists the embedded database across
`docker run` invocations; a host directory bind mount works too.

The image pre-creates `/home/node/.fusion` owned by `node`, so a fresh **named
volume** inherits that ownership and embedded PostgreSQL can initialize on first
run. A **bind mount** does not inherit it — the host directory's ownership wins —
so a host path mounted there must already be writable by uid `1000`:

```bash
mkdir -p /path/to/fusion-home && sudo chown -R 1000:1000 /path/to/fusion-home
```

Symptom when this is wrong: `initdb: error: could not create directory
"/home/node/.fusion/embedded-postgres": Permission denied`, followed by the
dashboard supervisor exhausting its restarts and the container reporting
`unhealthy`.

## Complete example

```bash
docker run --rm \
  -p 4040:4040 \
  -v /path/to/project:/workspace \
  -v fusion-home:/home/node/.fusion \
  -e ANTHROPIC_API_KEY=your_key \
  -e OPENAI_API_KEY=your_key \
  -e GITHUB_TOKEN=your_token \
  fusion dashboard --port 4040
```

## Notes

- The container runs as the non-root `node` user.
- The builder stage runs `pnpm build` with `NODE_OPTIONS=--max-old-space-size=6144`. The dashboard's
  `vite build` exceeds V8's default old-space on a stock Docker Desktop VM and aborts the image build
  with `FATAL ERROR: Ineffective mark-compacts near heap limit` (exit 134). The value is a ceiling,
  not a reservation. If your Docker VM has less than ~8GB, raise its memory allocation rather than
  lowering this number.
- `git` must be available in the container runtime. The mounted project volume must preserve `.git` metadata and repository history for worktree operations; Fusion initializes missing repositories during project registration.
- The root `Dockerfile` installs with `pnpm install --frozen-lockfile` before copying full source, so every current workspace package/plugin manifest selected by `pnpm-workspace.yaml` must be covered by a builder-stage `COPY` before that install. Keep the manifest-only dependency-cache layer; the runner's intentionally filtered production install does not provide builder coverage.
- `scripts/__tests__/dockerfile-workspace-manifests.test.mjs` expands the current workspace entries and rejects missing or duplicate builder pre-install COPY sources. Run it with `pnpm test:scripts -- scripts/__tests__/dockerfile-workspace-manifests.test.mjs` whenever workspace membership or Docker manifest copies change.
