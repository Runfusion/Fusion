/*
 * FNXC:TestInfrastructure 2026-07-13-10:00:
 * Static gate check that prevents the recurring full-suite failure pattern where
 * a new export added to a barrel module (@fusion/dashboard, @fusion/engine) is
 * imported by source code but missing from the hardcoded vi.mock factory in the
 * corresponding test file.
 *
 * This runs as part of the merge gate (pnpm test:gate) so drift is caught
 * before merge, not after full-suite fails on main.
 *
 * The check is purely static (regex-based, no module evaluation) and fast (<0.2s).
 *
 * Covers both CLI and engine test files. For each hardcoded vi.mock of a barrel
 * module, it:
 *   1. Extracts the mock factory's exported keys
 *   2. Finds what the test's source files import from that barrel
 *   3. Reports any barrel exports that are imported by source but absent from the mock
 *
 * Mocks that use importOriginal/importActual (auto-spread) are skipped — they
 * inherit all real exports automatically.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// ── Config: barrel modules to check ──────────────────────────────────────────

const BARRELS = [
  {
    moduleName: "@fusion/dashboard",
    barrelPath: join(root, "packages/dashboard/src/index.ts"),
    testDirs: [
      join(root, "packages/cli/src/__tests__"),
      join(root, "packages/cli/src/commands/__tests__"),
      join(root, "packages/cli/src/plugins/__tests__"),
    ],
    cliSrc: join(root, "packages/cli/src"),
  },
  {
    moduleName: "@fusion/engine",
    barrelPath: join(root, "packages/engine/src/index.ts"),
    testDirs: [
      join(root, "packages/cli/src/__tests__"),
      join(root, "packages/cli/src/commands/__tests__"),
      join(root, "packages/cli/src/plugins/__tests__"),
      // FNXC:TestInfrastructure 2026-07-13-11:00: Dashboard API tests also mock @fusion/engine; include them to prevent the same barrel-export drift.
      join(root, "packages/dashboard/src/__tests__"),
    ],
    cliSrc: join(root, "packages/cli/src"),
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  // Also catch `export function foo`, `export const bar`, `export class Baz`
  const declRe = /export\s+(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = declRe.exec(src)) !== null) {
    exports.add(m[1]);
  }
  return exports;
}

function extractModuleUsage(filePath, moduleName) {
  let src;
  try { src = readFileSync(filePath, "utf8"); } catch { return new Set(); }
  const used = new Set();

  // Named imports: import { A, type B, C as D } from "@fusion/engine"
  const namedRe = new RegExp(
    `import\\s*\\{([^}]+)\\}\\s*from\\s*"${moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
    "g",
  );
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

  // NOTE: namespace imports (import * as X) do NOT throw when a member is
  // missing from the mock — the member is simply `undefined`. Only named
  // imports trigger the "[vitest] No X export defined" error, so we skip
  // namespace import member extraction here.

  return used;
}

function resolveSourceFiles(testPath, cliSrc) {
  const sources = new Set();
  const testDir = dirname(testPath);
  let testSrc;
  try { testSrc = readFileSync(testPath, "utf8"); } catch { return sources; }

  // Static imports: import { ... } from "../foo.js"
  const staticRe = /import\s+(?:type\s+)?[\w{},\s*]*\s*from\s*"(\.\.?\/[^"]+\.js)"/g;
  let m;
  while ((m = staticRe.exec(testSrc)) !== null) {
    const resolved = resolve(testDir, m[1].replace(/\.js$/, ".ts"));
    if (existsSync(resolved)) sources.add(resolved);
  }

  // Dynamic imports: await import("../foo.js")
  const dynRe = /import\(\s*"(\.\.?\/[^"]+\.js)"\s*\)/g;
  while ((m = dynRe.exec(testSrc)) !== null) {
    const resolved = resolve(testDir, m[1].replace(/\.js$/, ".ts"));
    if (existsSync(resolved)) sources.add(resolved);
  }

  // Convention: __tests__/foo.test.ts → ../foo.ts, __tests__/foo.test.tsx → ../foo.tsx
  const noTests = testPath.replace(/__tests\//, "");
  const convPath = noTests.replace(/\.test\.ts$/, ".ts").replace(/\.test\.tsx$/, ".tsx");
  if (existsSync(convPath)) sources.add(convPath);

  // bin.test.ts special case
  if (testPath.endsWith("__tests__/bin.test.ts")) {
    const binPath = join(cliSrc, "bin.ts");
    if (existsSync(binPath)) sources.add(binPath);
  }

  return sources;
}

function extractMockKeys(testSrc, moduleName, testPath) {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    new RegExp(`vi\\.mock\\(\\s*"${escaped}"[^)]*importOriginal`).test(testSrc) ||
    new RegExp(`vi\\.mock\\(\\s*"${escaped}"[^)]*importActual`).test(testSrc)
  ) {
    return null; // auto-spread, safe
  }

  const startRe = new RegExp(
    `vi\\.mock\\(\\s*"${escaped}"\\s*,\\s*\\([^)]*\\)\\s*=>\\s*\\(\\s*\\{`,
  );
  const startMatch = startRe.exec(testSrc);
  if (!startMatch) return null;

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

  const keys = new Set();
  // Match both regular properties (key: value) and shorthand (key, or key}).
  const keyRe = /(?:^|\n)\s*([A-Za-z_$][\w$]*)\s*(?::|[,}])/g;
  let km;
  while ((km = keyRe.exec(body)) !== null) {
    keys.add(km[1]);
  }

  // FNXC:TestInfrastructure 2026-07-13-10:15:
  // Resolve spread helpers: when the mock body contains `...someHelper`,
  // find the import for that helper, read its exported object, and add its keys.
  // This handles centralized mock helpers like `workflowAuthoringEngineMock`.
  const testDir = dirname(testPath);
  const spreadRe = /\.\.\.\s*([A-Za-z_$][\w$]*)/g;
  let sm;
  while ((sm = spreadRe.exec(body)) !== null) {
    const helperName = sm[1];
    const importRe = new RegExp(
      `import\\s*\\{[^}]*\\b${helperName}\\b[^}]*\\}\\s*from\\s*"([^"]+)"`,
    );
    const importMatch = importRe.exec(testSrc);
    if (!importMatch) continue;
    const helperPath = resolve(testDir, importMatch[1].replace(/\.js$/, ".ts"));
    if (!existsSync(helperPath)) continue;
    const helperSrc = readFileSync(helperPath, "utf8");
    const objStartRe = new RegExp(`export\\s+const\\s+${helperName}\\s*=\\s*\\{`);
    const objStart = objStartRe.exec(helperSrc);
    if (!objStart) continue;
    let depth2 = 1;
    let j = objStart.index + objStart[0].length;
    while (j < helperSrc.length && depth2 > 0) {
      if (helperSrc[j] === "{") depth2++;
      else if (helperSrc[j] === "}") depth2--;
      j++;
    }
    const helperBody = helperSrc.slice(objStart.index + objStart[0].length, j - 1);
    const helperKeyRe = /(?:^|\n)\s*([A-Za-z_$][\w$]*)\s*(?::)/g;
    let hkm;
    while ((hkm = helperKeyRe.exec(helperBody)) !== null) {
      keys.add(hkm[1]);
    }
  }

  return keys;
}

function collectTs(dir) {
  let out = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) out = out.concat(collectTs(full));
      else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
    }
  } catch { /* dir may not exist */ }
  return out;
}

// ── Run ──────────────────────────────────────────────────────────────────────

let totalErrors = 0;

for (const cfg of BARRELS) {
  if (!existsSync(cfg.barrelPath)) continue;

  const barrelSrc = readFileSync(cfg.barrelPath, "utf8");
  const barrelExports = extractBarrelExports(barrelSrc);

  const testFiles = new Set();
  for (const dir of cfg.testDirs) {
    for (const f of collectTs(dir)) {
      if (f.endsWith(".test.ts") || f.endsWith(".test.tsx")) testFiles.add(f);
    }
  }

  const errors = [];

  for (const testFile of testFiles) {
    const testSrc = readFileSync(testFile, "utf8");
    if (!testSrc.includes(`vi.mock("${cfg.moduleName}"`)) continue;

    const mockKeys = extractMockKeys(testSrc, cfg.moduleName, testFile);
    if (mockKeys === null) continue;

    const sourcePaths = resolveSourceFiles(testFile, cfg.cliSrc);
    const requiredExports = new Set();

    for (const srcPath of sourcePaths) {
      const used = extractModuleUsage(srcPath, cfg.moduleName);
      for (const e of used) {
        if (barrelExports.has(e)) requiredExports.add(e);
      }
    }

    const missing = [...requiredExports].filter((e) => !mockKeys.has(e));
    if (missing.length > 0) {
      const rel = testFile.replace(root + "/", "");
      errors.push(
        `  ${rel}\n    missing: ${missing.map((m) => `"${m}"`).join(", ")}` +
          `\n    (imported from ${cfg.moduleName} in source, absent from vi.mock factory)`,
      );
    }
  }

  if (errors.length > 0) {
    console.error(
      `\n❌ ${cfg.moduleName} mock completeness check failed (${errors.length} issue${errors.length > 1 ? "s" : ""}):\n`,
    );
    for (const e of errors) console.error(e + "\n");
    console.error(
      `Fix: add the missing export(s) to each vi.mock("${cfg.moduleName}") factory,\n` +
        `or convert the mock to use importOriginal spread: { ...await importOriginal(), onlyOverride: vi.fn() }`,
    );
    totalErrors += errors.length;
  } else {
    console.log(`✅ ${cfg.moduleName} mock completeness: all hardcoded mocks cover source imports.`);
  }
}

if (totalErrors > 0) {
  process.exit(1);
}
