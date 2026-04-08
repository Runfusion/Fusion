# syntax=docker/dockerfile:1

FROM node:22-slim AS builder
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/dashboard/package.json ./packages/dashboard/package.json
COPY packages/desktop/package.json ./packages/desktop/package.json
COPY packages/engine/package.json ./packages/engine/package.json
COPY packages/mobile/package.json ./packages/mobile/package.json
COPY packages/tui/package.json ./packages/tui/package.json

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
  --filter @gsxdsm/fusion

# tsup rewrites node:sqlite imports to "sqlite" in the CLI bundle.
# Provide a tiny ESM shim so runtime resolves to Node's built-in sqlite module.
RUN mkdir -p /project/node_modules/sqlite \
  && printf '{"name":"sqlite","version":"0.0.0","type":"module","exports":"./index.js"}\n' > /project/node_modules/sqlite/package.json \
  && printf 'export * from "node:sqlite";\n' > /project/node_modules/sqlite/index.js

COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/engine/dist ./packages/engine/dist
COPY --from=builder /app/packages/dashboard/dist ./packages/dashboard/dist
COPY --from=builder /app/packages/cli/dist ./packages/cli/dist

# @gsxdsm/fusion references @sinclair/typebox at runtime via the bundled CLI.
COPY --from=builder /app/node_modules/.pnpm/@sinclair+typebox@*/node_modules/@sinclair/typebox /project/node_modules/@sinclair/typebox

# tsup emits dynamic require() helpers; provide require in ESM context.
RUN sed -i '2i import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);' /project/packages/cli/dist/bin.js

RUN chown node:node /project

USER node

EXPOSE 4040

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:4040/api/tasks').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "packages/cli/dist/bin.js"]
CMD ["dashboard"]
