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
