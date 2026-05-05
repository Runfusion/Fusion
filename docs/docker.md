# Running Fusion in Docker

This guide shows how to build and run Fusion in a container.

> This document is about containerizing Fusion itself (`docker build` / `docker run`).
> For managed Docker mesh-node provisioning architecture (services, routes, mesh config flow, and `4041` vs reserved `4040` port convention), see [Architecture → Docker Node Provisioning](./architecture.md#docker-node-provisioning).

## Build the image

```bash
docker build -t fusion .
```

## Run the dashboard

Mount your project into `/project` and publish the dashboard port:

```bash
docker run -p 4040:4040 -v /path/to/project:/project fusion
```

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

Fusion state lives in `.fusion` under the mounted project. You can mount it explicitly:

```bash
docker run -p 4040:4040 \
  -v /path/to/project:/project \
  -v /path/to/project/.fusion:/project/.fusion \
  fusion
```

## Complete example

```bash
docker run --rm \
  -p 4040:4040 \
  -v /path/to/project:/project \
  -v /path/to/project/.fusion:/project/.fusion \
  -e ANTHROPIC_API_KEY=your_key \
  -e OPENAI_API_KEY=your_key \
  -e GITHUB_TOKEN=your_token \
  fusion dashboard --port 4040
```

## Notes

- The container runs as the non-root `node` user.
- `git` must be available in the project volume for worktree operations (`.git` metadata and repository history are required).
