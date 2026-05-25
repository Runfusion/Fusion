---
"@runfusion/fusion": patch
---

Fix Windows compatibility in cloudflared install fallback by replacing `execFileAsync("mkdir", ["-p", ...])` with `fs.mkdir({ recursive: true })`. The shell-level `-p` flag is Unix-only and breaks installation on Windows cmd.exe with "A subdirectory or file -p already exists". The worktree-hooks fix from the original report was already landed independently.
