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

# FNXC:DockerRun 2026-08-18-05:35: ca-certificates is REQUIRED, not optional hardening. The slim
# base ships zero CA certificates, and git verifies TLS against the SYSTEM store — so every HTTPS
# clone failed with "server certificate verification failed. CAfile: none CRLfile: none", which
# breaks project setup outright (operator report). It hid behind Node, which carries its own bundled
# CA store: the dashboard, model APIs, and OAuth token exchanges all worked, so the image looked
# healthy right up until the first clone.
# FNXC:DockerRun 2026-08-18-06:05: ripgrep ships by default because the coding agents Fusion drives
# reach for `rg` as their primary search tool; without it they silently degrade to slower/partial
# fallbacks inside the container while working fine on a developer machine that has it installed.
# FNXC:DockerRun 2026-08-20-04:30: git-lfs ships by default because this repository stores binary
# assets (screenshots) as LFS objects. Without it, git silently checks out 130-byte POINTER FILES
# instead of the real content and reports a clean tree — so an agent reads a text stub where an image
# should be, and `git lfs` subcommands in any workflow fail outright. It is a git dependency, not an
# optional extra: the failure is silent corruption of a working checkout, not a missing feature.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git git-lfs ca-certificates ripgrep curl gnupg \
  && rm -rf /var/lib/apt/lists/*

# FNXC:DockerRun 2026-08-18-06:40: gh, tailscale, and cloudflared ship in the image.
# Rationale per tool: `gh` backs Fusion's GitHub integration (githubAuthMode "gh-cli" is a documented
# option and the auth route tells operators to run `gh auth login`, which is impossible if the binary
# is absent); `cloudflared` backs the dashboard's remote-access feature, whose installer cannot
# bootstrap itself reliably inside a slim container; `tailscale` gives the same box a private-network
# option. All three come from their vendors' own apt repositories with signed keyrings rather than
# curl-to-shell installers, so upgrades and signature checks follow the normal apt path.
#
# NOTE: installing tailscale does NOT make `tailscaled` runnable by itself — the daemon additionally
# needs `--cap-add NET_ADMIN --device /dev/net/tun` on `docker run`. Shipping the binary is the part
# the image can own; granting kernel capabilities stays an explicit operator decision.
#
# FNXC:DockerRun 2026-08-27-20:00: google-chrome-stable joins them, because the image shipped NO
# browser at all and two shipped features silently need one. `plugins/fusion-plugin-agent-browser`
# drives a browser through `playwright-core`, which by design does NOT download one at install time
# (`src/driver.ts`), and probes fixed paths whose first two Linux entries are `/usr/bin/google-chrome`
# and `/usr/bin/google-chrome-stable` (`src/probe.ts`). The Chrome DevTools MCP server
# (`chrome-devtools-mcp`) likewise launches an EXISTING Chrome and downloads nothing; with no browser
# present it fails every call with "Could not find Google Chrome executable for channel 'stable'".
# Google Chrome stable is chosen over Debian's `chromium` because it is the only browser
# chrome-devtools-mcp officially supports (its README supports Chrome and Chrome for Testing only,
# and treats other Chromium builds as unsupported), and Google publishes it for BOTH amd64 and arm64,
# so `arch=$(dpkg --print-architecture)` resolves on either host. Measured 2026-08-27 in the stable
# repo index: google-chrome-stable 152.0.7977.64-1 for amd64 and arm64.
#
# NOTE: shipping the binary does not make Chrome's own sandbox usable. Chrome sandboxes itself with
# unprivileged user namespaces, which the default container seccomp profile blocks — `unshare -U`
# returns EPERM here even though the kernel allows namespaces (max_user_namespaces=126143), and
# Chrome then aborts at startup with "No usable sandbox!". Callers must therefore either pass
# `--no-sandbox` (chrome-devtools-mcp: `--chromeArg=--no-sandbox`) or the operator must relax the
# profile at `docker run` with `--security-opt seccomp=unconfined`. Same division of responsibility
# as tailscale above: the image owns the binary, kernel privileges stay an operator decision.
#
# External integration evidence:
#   gh          — repo https://github.com/cli/cli, docs https://cli.github.com/,
#                 apt https://cli.github.com/packages, binary `gh`, key
#                 githubcli-archive-keyring.gpg (vendor-signed; upstream-pending-verification)
#   tailscale   — repo https://github.com/tailscale/tailscale, docs https://tailscale.com/download/linux,
#                 apt https://pkgs.tailscale.com/stable/debian, binaries `tailscale`/`tailscaled`,
#                 key bookworm.noarmor.gpg (vendor-signed; upstream-pending-verification)
#   cloudflared — repo https://github.com/cloudflare/cloudflared, docs https://pkg.cloudflare.com/,
#                 apt https://pkg.cloudflare.com/cloudflared, binary `cloudflared`,
#                 key cloudflare-main.gpg (vendor-signed; upstream-pending-verification)
#   chrome      — repo https://chromium.googlesource.com/chromium/src/ (upstream Chromium; Chrome
#                 itself is closed-source and has no public repo), docs https://www.google.com/chrome/,
#                 apt https://dl.google.com/linux/chrome/deb/ stable main, binaries
#                 `google-chrome-stable`/`google-chrome`, key
#                 https://dl.google.com/linux/linux_signing_key.pub (ASCII-armored, so it is
#                 gpg --dearmor'ed into the keyring; vendor-signed; upstream-pending-verification)
#                 Consumer docs: https://github.com/ChromeDevTools/chrome-devtools-mcp
RUN install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
  && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list \
  && curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared bookworm main" > /etc/apt/sources.list.d/cloudflared.list \
  && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh tailscale cloudflared google-chrome-stable \
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

# FNXC:DockerRun 2026-08-23-02:03: tailscaled runs as `node`, not root, so its default socket and
# state directories must exist node-owned BEFORE the USER switch — the daemon cannot mkdir them under
# root-owned /var/run and /var/lib itself. /var/lib/tailscale is a SYMLINK into /home/node/.tailscale
# rather than a real directory: the documented `-v <vol>:/home/node` mount then carries the node's
# login state, so an authenticated container survives `docker rm` + recreate instead of demanding a
# fresh `tailscale up` every rebuild. /var/log/tailscaled.log is pre-created for the same
# ownership reason.
RUN mkdir -p /var/run/tailscale /home/node/.tailscale \
  && rm -rf /var/lib/tailscale \
  && ln -sfn /home/node/.tailscale /var/lib/tailscale \
  && touch /var/log/tailscaled.log \
  && chown node:node /var/run/tailscale /home/node/.tailscale /var/log/tailscaled.log

COPY --chmod=0755 scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

USER node

# FNXC:DockerRun 2026-08-18-06:55: A DEFAULT GIT IDENTITY, because a container has none and Fusion
# mostly commits with whatever git finds in ambient config. Only `workspace-fence-ref.ts` passes
# `-c user.name/-c user.email` explicitly; the merge commits, the `--amend` in merger-ai, and the
# experiment git-ops all rely on the environment. With no identity every one of them dies on
# "Author identity unknown ... Please tell me who you are", so an auto-merge reached `status:merging`
# and stopped there with nothing in the UI to explain why (operator report).
#
# The values match the identity Fusion already uses for its own fence commits, so authorship stays
# consistent; an operator who wants real authorship overrides it with `git config --global` in a
# mounted home or a derived image. This is a FALLBACK for the container, not a substitute for
# passing an explicit identity at the commit sites — those should still be fixed upstream so a bare
# machine with no git config behaves the same way.
RUN git config --global user.name "Fusion" \
  && git config --global user.email "fusion@localhost" \
  && git config --global init.defaultBranch main

WORKDIR /workspace

EXPOSE 4040

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:4040/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# FNXC:DockerRun 2026-07-23-00:00: Entrypoint uses the absolute app path so it works
# regardless of the working directory or any volume mounted at /workspace.
# FNXC:DockerRun 2026-08-23-02:03: The wrapper script consumes its own opt-in `--tailscale` flag and
# then `exec`s that same absolute-path node invocation with the REMAINING args verbatim, so PID 1,
# signal handling, and every documented `docker run ... dashboard --host 0.0.0.0` argument list behave
# exactly as before.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["dashboard", "--host", "0.0.0.0"]
