/**
 * Global test isolation: prevents tests from writing to the real ~/.fusion/ directory.
 *
 * Vitest runs setupFiles in each worker thread. By overriding process.env.HOME
 * to a temp directory, all calls to homedir() (and derived paths like ~/.fusion)
 * resolve to isolated temp locations instead of the user's real home directory.
 *
 * This protects against tests accidentally creating projects, databases, or
 * settings files in the production ~/.fusion/ directory.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempHome = mkdtempSync(join(tmpdir(), "fn-test-home-"));
process.env.HOME = tempHome;
