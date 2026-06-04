---
"@runfusion/fusion": minor
---

Add an ACP (Agent Client Protocol) client runtime plugin (`runtimeId: "acp"`)
that drives any external ACP-compatible agent over JSON-RPC/stdio, built on the
official `@agentclientprotocol/sdk`. Installed on demand (experimental).

The agent runs as an untrusted subprocess that calls back into Fusion, so the
integration ships a defense-in-depth security floor: per-category permission
gating against the live policy (never a preset shortcut; `allow_once` only;
unmappable kinds and missing policy default-deny), an unrestricted-risk
acknowledgement that escalates blanket allows to approval under the allow-all
default, an opt-in filesystem capability behind a real symlink-resolving cwd jail
(realpath + `O_NOFOLLOW`, secret/`.git` deny-list, writes gated through the
permission policy), untrusted-output sanitization and bounds, and an env
allow-list for the subprocess.
