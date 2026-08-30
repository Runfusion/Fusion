---
"@runfusion/fusion": patch
---

summary: The Docker image now ships Google Chrome, so browser automation works in a container.
category: fix
dev: Runner stage installs `google-chrome-stable` from Google's signed apt repository (https://dl.google.com/linux/chrome/deb/), alongside gh, tailscale and cloudflared. The image previously shipped no browser at all, which silently broke two features that launch an existing browser and download none: `plugins/fusion-plugin-agent-browser` (uses `playwright-core`, which by design does not fetch a browser at install time, and probes `/usr/bin/google-chrome` first) and the Chrome DevTools MCP server, which failed every call with "Could not find Google Chrome executable for channel 'stable'". Chrome rather than Debian's `chromium` because it is the only browser chrome-devtools-mcp officially supports, and Google publishes it for both amd64 and arm64 so the existing `arch=$(dpkg --print-architecture)` pattern resolves on either host. Chrome's own sandbox still needs unprivileged user namespaces, which the default container seccomp profile blocks, so callers pass `--no-sandbox` (chrome-devtools-mcp: `--chromeArg=--no-sandbox`) or the operator runs with `--security-opt seccomp=unconfined`. Package name and repo URL are asserted in scripts/__tests__/dockerfile-workspace-manifests.test.mjs.
