---
"@runfusion/fusion": patch
---

summary: Elevated Windows no longer creates a local 'fusion-pg' account to boot embedded PostgreSQL; leftover accounts are removed.
category: fix
dev: "Replaces the Start-Process -Credential non-admin-user launcher with pg_ctl's built-in restricted-token re-exec (embedded-windows-elevated.ts). Removes user creation, icacls grants, and the cmd/PowerShell wrapper — also eliminating the 'directory name is invalid' launch failure and the EBUSY on wrapper-held postgres.log. The elevated path now best-effort deletes a legacy fusion-pg account on start."
