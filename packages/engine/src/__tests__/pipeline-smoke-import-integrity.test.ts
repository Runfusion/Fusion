import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ENGINE_SOURCE_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const PIPELINE_SMOKE_ROOT = resolve(ENGINE_SOURCE_ROOT, "__tests__/pipeline-smoke");

type NamedImport = {
  importer: string;
  specifier: string;
  binding: string;
  resolved: string;
};

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

function resolveImportTarget(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".") || specifier.startsWith("node:")) return undefined;
  const target = resolve(dirname(importer), specifier.replace(/\.js$/, ".ts"));
  if (!target.startsWith(`${ENGINE_SOURCE_ROOT}${sep}`) || target.includes(`${sep}__tests__${sep}`)) return undefined;
  return existsSync(target) ? target : undefined;
}

function collectNamedImports(): NamedImport[] {
  const imports: NamedImport[] = [];
  const namedImportPattern = /\bimport\s+(?!type\b)\{([\s\S]*?)\}\s+from\s+["']([^"']+)["']/g;
  for (const importer of listTypeScriptFiles(PIPELINE_SMOKE_ROOT)) {
    const source = readFileSync(importer, "utf8");
    for (const match of source.matchAll(namedImportPattern)) {
      const specifier = match[2]!;
      const resolved = resolveImportTarget(importer, specifier);
      if (!resolved) continue;
      for (const member of match[1]!.split(",")) {
        const declaration = member.trim();
        if (!declaration || declaration.startsWith("type ")) continue;
        const binding = declaration.split(/\s+as\s+/)[0]!.trim();
        imports.push({ importer, specifier, binding, resolved });
      }
    }
  }
  return imports;
}

/*
FNXC:PipelineSmoke 2026-09-12-22:57:
Engine test files are excluded from TypeScript compilation and pipeline smoke is opt-in, so static named imports in that harness need an ordinary-lane export check. This validates runtime module namespaces instead of comments or test-only source prose.
*/
describe("pipeline smoke import integrity", () => {
  it("imports only named engine bindings exported by their relative targets", async () => {
    const namespaces = new Map<string, Record<string, unknown>>();
    for (const imported of collectNamedImports()) {
      let namespace = namespaces.get(imported.resolved);
      if (!namespace) {
        namespace = await import(pathToFileURL(imported.resolved).href) as Record<string, unknown>;
        namespaces.set(imported.resolved, namespace);
      }
      expect(
        imported.binding in namespace,
        `${imported.importer} imports ${imported.binding} from ${imported.specifier}, but that binding is not exported.`,
      ).toBe(true);
    }
  });
});
