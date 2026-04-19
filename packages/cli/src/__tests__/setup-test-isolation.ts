/**
 * Global test isolation for CLI package.
 * @see packages/core/src/__tests__/setup-test-isolation.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempHome = mkdtempSync(join(tmpdir(), "fn-test-home-"));
process.env.HOME = tempHome;
