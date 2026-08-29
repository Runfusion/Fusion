import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/*
FNXC:LintConfig 2026-06-20-03:19:
Capacitor sync writes the dashboard web bundle into the Android app as gitignored generated assets. ESLint flat config does not inherit .gitignore, so this guard keeps synced mobile artifacts out of lint while preserving lint coverage for real source files.
*/

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

function fromRoot(relativePath) {
  return path.join(repoRoot, relativePath);
}

test("ESLint ignores Capacitor-synced Android web assets but not real source", async () => {
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({ cwd: repoRoot });

  assert.equal(
    await eslint.isPathIgnored(fromRoot("packages/mobile/android/app/src/main/assets/public/assets/app-B2ZxMfJT.js")),
    true,
    "synced Android JavaScript bundle should be ignored",
  );

  assert.equal(
    await eslint.isPathIgnored(fromRoot("packages/mobile/android/app/src/main/assets/public/sw.js")),
    true,
    "non-bundle synced Android public assets should be ignored",
  );

  assert.equal(
    await eslint.isPathIgnored(fromRoot("packages/core/src/index.ts")),
    false,
    "tracked package source should remain linted",
  );
});
