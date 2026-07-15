// FNXC:WindowsDesktopPackaging 2026-07-15-02:30:
// Embedded PostgreSQL refuses to start under a Windows process token whose
// Administrators group is enabled (an elevated token): it exits with
// "Execution of PostgreSQL by a user with administrative permissions is not
// permitted." GitHub's windows-latest runner executes jobs elevated, so the
// embedded-PG smoke runs the whole test process AS a non-admin helper user
// (see .github/workflows/desktop-windows.yml); postgres then inherits that
// non-admin token and boots via the normal path.
//
// This module only detects the elevated case so the launcher can fail fast
// with a clear, actionable error if an end user launches Fusion elevated
// ("Run as administrator") — instead of hanging ~120s on the refused start.
// The earlier in-launcher non-admin boot (Start-Process -Credential, staging,
// per-instance ACLs) was removed: it worked for single starts but was not
// reliably deterministic across Windows process-kill / file-lock teardown for
// the multi-start/reuse tests.

import { spawnSync } from "node:child_process";

let elevatedCache: boolean | null = null;

/**
 * True only on Windows when the current process holds an elevated admin token.
 * `net session` succeeds (exit 0) exclusively under an elevated admin token, so
 * it is a reliable elevation probe that does not depend on UAC EnableLUA.
 */
export function isWindowsElevatedAdmin(): boolean {
  if (process.platform !== "win32") return false;
  if (elevatedCache !== null) return elevatedCache;
  const r = spawnSync("net", ["session"], { encoding: "utf8", shell: true });
  elevatedCache = r.status === 0;
  return elevatedCache;
}
