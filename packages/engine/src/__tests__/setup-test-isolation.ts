/**
 * Global test isolation: prevents engine tests from writing to the real ~/.fusion/ directory.
 *
 * This runs in every Vitest worker before shared setup. By forcing process.env.HOME
 * to a fresh temp directory, homedir()-derived paths resolve to isolated locations.
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
