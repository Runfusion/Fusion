/*
 * FNXC:TestInfrastructure 2026-07-13-09:30:
 * Static gate check that prevents the recurring full-suite failure pattern where
 * a new export added to the @fusion/dashboard barrel is imported by CLI source
 * code but missing from the hardcoded vi.mock("@fusion/dashboard") factory in
 * the corresponding CLI test file.
 *
 * This runs as part of the merge gate (pnpm test:gate) so drift is caught
 * before merge, not after full-suite fails on main.
 *
 * The check is purely static (regex-based, no module evaluation) and fast (<1s).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const cliSrc = join(root, "packages/cli/src");

// ── 1. Extract value exports from the dashboard barrel ──────────────────────

const barrelPath = join(root, "packages/dashboard/src/index.ts");
const barrelSrc = readFileSync(barrelPath, "utf8");

/**
 * Extract named exports from the barrel, excluding type-only exports.
 * Handles: export { foo, type Bar, baz as qux } from "./mod.js";
 */
function extractBarrelExports(src) {
  const exports = new Set();
  const namedRe = /export\s*\{([^}]+)\}\s*from\s*"[^"]+"/g;
  let m;
  while ((m = namedRe.exec(src)) !== null) {
    for (let raw of m[1].split(",")) {
      raw = raw.trim();
      if (!raw || raw.startsWith("type ")) continue;
      const aliased = raw.split(/\s+as\s+/);
      const name = (aliased[aliased.length - 1] || raw).trim();
      if (name && /^[A-Za-z_]/.test(name)) exports.add(name);
    }
  }
  return exports;
}

const barrelExports = extractBarrelExports(barrelSrc);

// ── 2. Extract @fusion/dashboard usage from a source file ───────────────────

/**
 * Extract dashboard member usage from a source file.
 * Handles both named imports and namespace imports.
 * Returns a Set of member names.
 */
function extractDashboardUsage(filePath) {
  let src;
  try { src = readFileSync(filePath, "utf8"); } catch { return new Set(); }
  const used = new Set();

  // Named imports: import { A, type B, C as D } from "@fusion/dashboard"
  const namedRe = /import\s*\{([^}]+)\}\s*from\s*"@fusion\/dashboard"/g;
  let m;
  while ((m = namedRe.exec(src)) !== null) {
    for (let raw of m[1].split(",")) {
      raw = raw.trim();
      if (!raw || raw.startsWith("type ")) continue;
      const aliased = raw.split(/\s+as\s+/);
      const name = (aliased[0] || raw).trim();
      if (name && /^[A-Za-z_]/.test(name)) used.add(name);
    }
  }

  // Namespace imports: import * as X from "@fusion/dashboard"
  // Then find all X.member usages.
  const nsRe = /import\s*\*\s*as\s+(\w+)\s*from\s*"@fusion\/dashboard"/g;
  while ((m = nsRe.exec(src)) !== null) {
    const ns = m[1];
    const memberRe = new RegExp(`\\b${ns}\\.(\\w+)`, "g");
    let mm;
    while ((mm = memberRe.exec(src)) !== null) {
      used.add(mm[1]);
    }
  }

  return used;
}

// ── 3. Resolve source files from a test file ────────────────────────────────

/**
 * Find source files a test covers by:
 * 1. Parsing static/dynamic imports in the test file
 * 2. Convention: __tests__/foo.test.ts → ../foo.ts
 */
function resolveSourceFiles(testPath) {
  const sources = new Set();
  const testDir = dirname(testPath);
  let testSrc;
  try { testSrc = readFileSync(testPath, "utf8"); } catch { return sources; }

  // Static imports: import { ... } from "../foo.js" or "../commands/bar.js"
  const staticRe = /import\s+(?:type\s+)?[\w{},\s*]*\s*from\s*"(\.\.?\/[^"]+\.js)"/g;
  let m;
  while ((m = staticRe.exec(testSrc)) !== null) {
    const resolved = resolve(testDir, m[1].replace(/\.js$/, ".ts"));
    if (existsSync(resolved)) sources.add(resolved);
  }

  // Dynamic imports: await import("../foo.js") or import("../commands/bar.js")
  const dynRe = /import\(\s*"(\.\.?\/[^"]+\.js)"\s*\)/g;
  while ((m = dynRe.exec(testSrc)) !== null) {
    const resolved = resolve(testDir, m[1].replace(/\.js$/, ".ts"));
    if (existsSync(resolved)) sources.add(resolved);
  }

  // Convention fallback: __tests__/foo.test.ts → ../foo.ts
  const noTests = testPath.replace(/__tests\//, "");
  const convPath = noTests.replace(/\.test\.ts$/, ".ts");
  if (existsSync(convPath)) sources.add(convPath);

  // bin.test.ts special case
  if (testPath.endsWith("__tests__/bin.test.ts")) {
    const binPath = join(cliSrc, "bin.ts");
    if (existsSync(binPath)) sources.add(binPath);
  }

  return sources;
}

// ── 4. Extract mock keys from a hardcoded vi.mock factory ───────────────────

/**
 * Extract mock keys from vi.mock("@fusion/dashboard", () => ({ ... })).
 * Returns null if mock uses importOriginal/importActual (auto-spread, safe).
 */
function extractMockKeys(testSrc) {
  if (/vi\.mock\(\s*"@fusion\/dashboard"[^)]*importOriginal/.test(testSrc) ||
      /vi\.mock\(\s*"@fusion\/dashboard"[^)]*importActual/.test(testSrc)) {
    return null;
  }

  // Find the start of the mock factory object: () => ({
  const startRe = /vi\.mock\(\s*"@fusion\/dashboard"\s*,\s*\([^)]*\)\s*=>\s*\(\s*\{/;
  const startMatch = startRe.exec(testSrc);
  if (!startMatch) return null;

  // Depth-aware extraction: track { } depth to find the matching close
  const bodyStart = startMatch.index + startMatch[0].length;
  let depth = 1;
  let i = bodyStart;
  while (i < testSrc.length && depth > 0) {
    const ch = testSrc[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  const body = testSrc.slice(bodyStart, i - 1);

  // Extract property keys from the mock body
  const keys = new Set();
  const keyRe = /(?:^|\n)\s*([A-Za-z_$][\w$]*)\s*(?::)/g;
  let km;
  while ((km = keyRe.exec(body)) !== null) {
    keys.add(km[1]);
  }
  return keys;
}

// ── 5. Run the check ─────────────────────────────────────────────────────────

/**
 * Recursively collect .ts files under a directory.
 */
function collectTs(dir) {
  let out = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) out = out.concat(collectTs(full));
      else if (entry.endsWith(".ts")) out.push(full);
    }
  } catch { /* dir may not exist */ }
  return out;
}

const testFiles = collectTs(join(cliSrc, "__tests__"))
  .concat(collectTs(join(cliSrc, "commands", "__tests__")))
  .concat(collectTs(join(cliSrc, "plugins", "__tests__")))
  .filter(f => f.endsWith(".test.ts"));

const errors = [];

for (const testFile of testFiles) {
  const testSrc = readFileSync(testFile, "utf8");
  if (!testSrc.includes('vi.mock("@fusion/dashboard"')) continue;

  const mockKeys = extractMockKeys(testSrc);
  if (mockKeys === null) continue;

  // Collect required dashboard exports from all source files this test covers
  const sourcePaths = resolveSourceFiles(testFile);
  const requiredExports = new Set();

  for (const srcPath of sourcePaths) {
    const used = extractDashboardUsage(srcPath);
    for (const e of used) {
      // Only flag exports that actually exist in the dashboard barrel
      // (filters out namespace typos and non-export members)
      if (barrelExports.has(e)) requiredExports.add(e);
    }
  }

  // Check: every required export must be in mock keys
  const missing = [...requiredExports].filter(e => !mockKeys.has(e));
  if (missing.length > 0) {
    const rel = testFile.replace(root + "/", "");
    errors.push(
      `  ${rel}\n    missing: ${missing.map(m => `"${m}"`).join(", ")}\n` +
      `    (imported from @fusion/dashboard in source, absent from vi.mock factory)\n` +
      `    resolved sources: ${[...sourcePaths].map(s => s.replace(root + "/", "")).join(", ") || "(none found)"}`
    );
  }
}

if (errors.length > 0) {
  console.error(
    `\n❌ CLI dashboard mock completeness check failed (${errors.length} issue${errors.length > 1 ? "s" : ""}):\n`
  );
  for (const e of errors) console.error(e + "\n");
  console.error(
    `Fix: add the missing export(s) to each vi.mock("@fusion/dashboard") factory.`
  );
  process.exit(1);
} else {
  console.log("✅ CLI dashboard mock completeness: all hardcoded mocks cover source imports.");
}
