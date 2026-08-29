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

Subscription logins finish on a **loopback callback server that the container runs itself**, on fixed
ports: `53692` for Anthropic and `1455` for OpenAI Codex. Two things make that unreachable by
default — the port is not published, and the listener binds `127.0.0.1` *inside* the container, so
publishing alone still would not deliver traffic arriving on the container's external interface.
The symptom is a browser that lands on a connection-error page after you approve the login.

Publish both ports and bind the listener to all interfaces:

```bash
docker run -p 4040:4040 -p 53692:53692 -p 1455:1455 \
  -e PI_OAUTH_CALLBACK_HOST=0.0.0.0 \
  -v /path/to/project:/workspace \
  -v fusion-home:/home/node/.fusion \
  fusion
```

The browser callback then completes on its own, with nothing to paste. Both ports are fixed by the
provider's registered redirect URI, so they cannot be remapped to different host ports — `-p
53692:53693` will not work.

Without this, the fallback is manual: copy the full URL from the browser's address bar after
approving and paste it into the login card. Note the callback listener accepts connections from
outside the container while a login is in flight; it is short-lived and validates the OAuth `state`,
but prefer publishing these ports only on a trusted network (`-p 127.0.0.1:53692:53692` restricts
them to the host).

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
