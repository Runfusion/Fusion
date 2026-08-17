# syntax=docker/dockerfile:1

FROM node:22-slim AS builder
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# FNXC:DockerBuild 2026-08-10-18:03: This list is derived from pnpm-workspace.yaml.
# Every selected workspace manifest must be copied before frozen install, or pnpm
# omits its dependencies and the later full-workspace image build can fail.
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/cli-alias/package.json ./packages/cli-alias/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/dashboard/package.json ./packages/dashboard/package.json
COPY packages/desktop/package.json ./packages/desktop/package.json
COPY packages/droid-cli/package.json ./packages/droid-cli/package.json
COPY packages/engine/package.json ./packages/engine/package.json
COPY packages/i18n/package.json ./packages/i18n/package.json
COPY packages/mobile/package.json ./packages/mobile/package.json
COPY packages/pi-claude-cli/package.json ./packages/pi-claude-cli/package.json
COPY packages/pi-llama-cpp/package.json ./packages/pi-llama-cpp/package.json
COPY packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
COPY plugins/examples/fusion-plugin-auto-label/package.json ./plugins/examples/fusion-plugin-auto-label/package.json
COPY plugins/examples/fusion-plugin-ci-status/package.json ./plugins/examples/fusion-plugin-ci-status/package.json
COPY plugins/examples/fusion-plugin-notification/package.json ./plugins/examples/fusion-plugin-notification/package.json
COPY plugins/examples/fusion-plugin-settings-demo/package.json ./plugins/examples/fusion-plugin-settings-demo/package.json
COPY plugins/fusion-plugin-acp-runtime/package.json ./plugins/fusion-plugin-acp-runtime/package.json
COPY plugins/fusion-plugin-todos/package.json ./plugins/fusion-plugin-todos/package.json
COPY plugins/fusion-plugin-compound-engineering/package.json ./plugins/fusion-plugin-compound-engineering/package.json
COPY plugins/fusion-plugin-linear-import/package.json ./plugins/fusion-plugin-linear-import/package.json
COPY plugins/fusion-plugin-paperclip-runtime/package.json ./plugins/fusion-plugin-paperclip-runtime/package.json
COPY plugins/fusion-plugin-dependency-graph/package.json ./plugins/fusion-plugin-dependency-graph/package.json
COPY plugins/fusion-plugin-cli-printing-press/package.json ./plugins/fusion-plugin-cli-printing-press/package.json
COPY plugins/fusion-plugin-openclaw-runtime/package.json ./plugins/fusion-plugin-openclaw-runtime/package.json
COPY plugins/fusion-plugin-hermes-runtime/package.json ./plugins/fusion-plugin-hermes-runtime/package.json
COPY plugins/fusion-plugin-droid-runtime/package.json ./plugins/fusion-plugin-droid-runtime/package.json
COPY plugins/fusion-plugin-cursor-runtime/package.json ./plugins/fusion-plugin-cursor-runtime/package.json
COPY plugins/fusion-plugin-grok-runtime/package.json ./plugins/fusion-plugin-grok-runtime/package.json
COPY plugins/fusion-plugin-claude-runtime/package.json ./plugins/fusion-plugin-claude-runtime/package.json
COPY plugins/fusion-plugin-omp-runtime/package.json ./plugins/fusion-plugin-omp-runtime/package.json
COPY plugins/fusion-plugin-quality/package.json ./plugins/fusion-plugin-quality/package.json
COPY plugins/fusion-plugin-agent-browser/package.json ./plugins/fusion-plugin-agent-browser/package.json
COPY plugins/fusion-plugin-whatsapp-chat/package.json ./plugins/fusion-plugin-whatsapp-chat/package.json
COPY plugins/fusion-plugin-roadmap/package.json ./plugins/fusion-plugin-roadmap/package.json
COPY plugins/fusion-plugin-even-realities-glasses/package.json ./plugins/fusion-plugin-even-realities-glasses/package.json
COPY plugins/fusion-plugin-reports/package.json ./plugins/fusion-plugin-reports/package.json

RUN pnpm install --frozen-lockfile

COPY . .
# FNXC:DockerBuild 2026-08-17-23:18: The dashboard's `vite build` transforms ~5.7k modules and
# exceeded V8's default old-space on a stock Docker Desktop VM (8GB), aborting the whole image
# build with "FATAL ERROR: Ineffective mark-compacts near heap limit" (exit 134). The ceiling is
# a cap, not a reservation — V8 only grows to what the build needs — so raising it here costs
# nothing on larger hosts and is the difference between a working and a failing `docker build`
# on a default install. Scoped to this RUN so it never leaks into the runner stage's env.
RUN NODE_OPTIONS=--max-old-space-size=6144 pnpm build

FROM node:22-slim AS runner
LABEL org.opencontainers.image.source="https://github.com/gsxdsm/fusion"
LABEL org.opencontainers.image.description="AI-orchestrated task board"

ENV NODE_ENV=production
ENV PORT=4040

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# FNXC:DockerRun 2026-07-23-00:00: The app install root must be distinct from the
# documented user-project mount point. Installing the app at /project made the
# documented `-v host:/project` bind mount shadow the CLI (MODULE_NOT_FOUND on
# packages/cli/dist/bin.js). The app now lives at /app; users mount their project
# at /workspace, which is also the runtime working directory (issue #2414).
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/dashboard/package.json ./packages/dashboard/package.json
COPY packages/engine/package.json ./packages/engine/package.json

RUN pnpm install --frozen-lockfile --prod \
  --filter @runfusion/fusion

COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/engine/dist ./packages/engine/dist
COPY --from=builder /app/packages/dashboard/dist ./packages/dashboard/dist
COPY --from=builder /app/packages/cli/dist ./packages/cli/dist

# @runfusion/fusion references typebox at runtime via the bundled CLI.
COPY --from=builder /app/node_modules/.pnpm/typebox@*/node_modules/typebox /app/node_modules/typebox

# FNXC:DockerRun 2026-07-23-00:00: /workspace is the documented bind-mount point for
# the user's project and the container working directory, so `fn dashboard` operates
# on the mounted project. It must stay empty in the image so a bind mount never
# shadows application code.
# FNXC:DockerRun 2026-08-17-23:18: /home/node/.fusion must exist node-owned IN THE IMAGE, because
# Docker seeds a fresh NAMED volume from the image's content and ownership at the mount path. The
# documented `-v fusion-home:/home/node/.fusion` invocation previously mounted a root-owned empty
# volume over a path that did not exist, so embedded Postgres `initdb` failed with "could not create
# directory ... Permission denied", the dashboard supervisor burned its 4 restarts, and the container
# went unhealthy on first run. Pre-creating it makes the documented command work with no host-side
# chown. NOTE: this fixes named volumes only — a BIND mount keeps the host directory's ownership, so
# a host path bound here must already be writable by uid 1000 (node).
RUN chown node:node /app \
  && mkdir -p /workspace /home/node/.fusion \
  && chown node:node /workspace /home/node/.fusion

USER node

WORKDIR /workspace

EXPOSE 4040

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:4040/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# FNXC:DockerRun 2026-07-23-00:00: Entrypoint uses the absolute app path so it works
# regardless of the working directory or any volume mounted at /workspace.
ENTRYPOINT ["node", "/app/packages/cli/dist/bin.js"]
CMD ["dashboard", "--host", "0.0.0.0"]
