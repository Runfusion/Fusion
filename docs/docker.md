# Running Fusion in Docker

This guide shows how to build and run Fusion in a container.

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
```

Add any other provider keys your setup requires (for example `OPENROUTER_API_KEY`).

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
