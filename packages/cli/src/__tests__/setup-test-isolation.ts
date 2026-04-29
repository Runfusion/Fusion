/**
 * Global test isolation for CLI package.
 * @see packages/core/src/__tests__/setup-test-isolation.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempHome = mkdtempSync(join(tmpdir(), "fn-test-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
if (process.platform === "win32") {
  const match = tempHome.match(/^([A-Za-z]:)(.*)$/);
  if (match) {
    process.env.HOMEDRIVE = match[1];
    process.env.HOMEPATH = match[2] || "\\";
  }
}
