# syntax=docker/dockerfile:1

FROM node:22-slim AS builder
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
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
COPY plugins/fusion-plugin-compound-engineering/package.json ./plugins/fusion-plugin-compound-engineering/package.json
COPY plugins/fusion-plugin-paperclip-runtime/package.json ./plugins/fusion-plugin-paperclip-runtime/package.json
COPY plugins/fusion-plugin-dependency-graph/package.json ./plugins/fusion-plugin-dependency-graph/package.json
COPY plugins/fusion-plugin-cli-printing-press/package.json ./plugins/fusion-plugin-cli-printing-press/package.json
COPY plugins/fusion-plugin-openclaw-runtime/package.json ./plugins/fusion-plugin-openclaw-runtime/package.json
COPY plugins/fusion-plugin-hermes-runtime/package.json ./plugins/fusion-plugin-hermes-runtime/package.json
COPY plugins/fusion-plugin-droid-runtime/package.json ./plugins/fusion-plugin-droid-runtime/package.json
COPY plugins/fusion-plugin-cursor-runtime/package.json ./plugins/fusion-plugin-cursor-runtime/package.json
COPY plugins/fusion-plugin-agent-browser/package.json ./plugins/fusion-plugin-agent-browser/package.json
COPY plugins/fusion-plugin-whatsapp-chat/package.json ./plugins/fusion-plugin-whatsapp-chat/package.json
COPY plugins/fusion-plugin-roadmap/package.json ./plugins/fusion-plugin-roadmap/package.json
COPY plugins/fusion-plugin-even-realities-glasses/package.json ./plugins/fusion-plugin-even-realities-glasses/package.json
COPY plugins/fusion-plugin-reports/package.json ./plugins/fusion-plugin-reports/package.json
COPY plugins/fusion-plugin-linear-import/package.json ./plugins/fusion-plugin-linear-import/package.json

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:22-slim AS runner
LABEL org.opencontainers.image.source="https://github.com/gsxdsm/fusion"
LABEL org.opencontainers.image.description="AI-orchestrated task board"

ENV NODE_ENV=production
ENV PORT=4040

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /project

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
COPY --from=builder /app/node_modules/.pnpm/typebox@*/node_modules/typebox /project/node_modules/typebox

RUN chown node:node /project

USER node

EXPOSE 4040

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:4040/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "packages/cli/dist/bin.js"]
CMD ["dashboard", "--host", "0.0.0.0"]
