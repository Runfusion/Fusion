import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const declarationPath = join(import.meta.dirname, "..", "dist", "plugin-sdk", "index.d.ts");
const legacyTransaction = "PostgresJsTransaction<Record<string, never>, Record<string, never>>";
const currentTransaction = "PostgresJsTransaction<Record<string, never>>";

function wantsFullCliPackage(env = process.env) {
  const explicit = env.FUSION_CLI_FULL_PACKAGE;
  if (explicit === "0" || explicit === "false") return false;
  if (explicit === "1" || explicit === "true") return true;
  if (env.CI === "true" || env.CI === "1") return true;
  return env.npm_lifecycle_event === "prepack";
}

/*
 * FNXC:PluginSdkDeclarations 2026-09-24-07:34:
 * The ordinary CLI build also runs this script, but only full packaging emits
 * plugin SDK declarations. A fast build may retain an earlier declaration, so
 * normalize it when present while requiring full/release builds to emit it.
 */
const fullCliPackage = wantsFullCliPackage();
if (!existsSync(declarationPath)) {
  if (fullCliPackage) {
    throw new Error(`Plugin SDK declaration was not emitted: ${declarationPath}`);
  }
  process.exit(0);
}

const declaration = readFileSync(declarationPath, "utf8");
if (declaration.includes(legacyTransaction)) {
  writeFileSync(declarationPath, declaration.replace(legacyTransaction, currentTransaction), "utf8");
} else if (!declaration.includes(currentTransaction)) {
  throw new Error("Plugin SDK declaration no longer matches the Drizzle transaction finalizer");
}
