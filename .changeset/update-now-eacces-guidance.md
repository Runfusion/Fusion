---
"@runfusion/fusion": patch
---

summary: "Update now" now explains permission (EACCES) failures and how to fix them instead of showing raw npm errors.
category: fix
dev: `performUpdateInstall` (packages/dashboard/src/update-check.ts) detects EACCES/EPERM install failures (by error code or stderr text) and returns actionable remediation — run `sudo fn update`, reinstall without sudo, or `brew upgrade fusion` for Homebrew installs — rather than the raw `npm error EACCES … rename '/usr/lib/node_modules/@runfusion/fusion'`. Occurs when Fusion was installed via `sudo npm i -g` (root-owned global dir); `--force` is not retried for this class since it cannot grant write permission.
