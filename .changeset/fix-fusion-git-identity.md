---
"@runfusion/fusion": patch
---

summary: Fusion now sets its own git identity for commits, attributing them to the agent that did the work.
category: fix
dev: Merge commits, the merger's `--amend`, and experiment git-ops all relied on ambient `user.name`/`user.email`; only workspace-fence-ref.ts passed an explicit identity. On a host with no git identity — container, CI, fresh machine — git refuses with "Author identity unknown" and an auto-merge stalls at `status:merging` with nothing surfaced. New `resolveCommitIdentity` in packages/engine/src/git-identity.ts resolves operator `commitAuthor*` settings > acting agent (`Name (Fusion) <slug@agents.fusion.local>`) > `Fusion <noreply@runfusion.ai>`, applied via `mergerCommitEnv` (author AND committer) and via `-c` args for the two paths that build their own argv. `commitAuthorEnabled: false` opts out and restores ambient config.
