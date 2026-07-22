---
"@runfusion/fusion": patch
---

summary: Allow session Read tool to open host-advertised plugin skill body paths under worktree boundary.
category: fix
dev: Worktree-bound pi sessions treat one normalized AgentOptions.additionalSkillPaths list as a read-only boundary exception for read/glob/grep and as DefaultResourceLoader skill roots (GitHub #2384 / FN-8466); skill-root write/edit remain blocked.
