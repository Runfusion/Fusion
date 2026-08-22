---
"@runfusion/fusion": patch
---

summary: The Docker image now ships gh, tailscale, and cloudflared alongside git and ripgrep.
category: feature
dev: Runner stage adds the GitHub CLI (backs `githubAuthMode: "gh-cli"`, which the auth route tells operators to set up with `gh auth login`), cloudflared (backs dashboard remote access, whose in-app installer cannot bootstrap itself reliably in a slim container), and tailscale, each from its vendor's signed apt repository rather than a curl-to-shell installer. Installing tailscale does not make `tailscaled` runnable on its own — that still needs `--cap-add NET_ADMIN --device /dev/net/tun` at `docker run`. Package names and repo URLs are asserted in scripts/__tests__/dockerfile-workspace-manifests.test.mjs.
