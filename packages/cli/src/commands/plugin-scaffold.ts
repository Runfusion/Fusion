/**
 * Plugin Scaffold Command
 *
 * Generates plugin projects with boilerplate code.
 * Usage: fn plugin create <name>
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Valid plugin name pattern: kebab-case
const PLUGIN_NAME_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const DEFAULT_RUNFUSION_VERSION = "0.39.0";
const SCAFFOLD_TYPES_NODE_VERSION = "^22.0.0";
const SCAFFOLD_VITEST_VERSION = "^4.1.0";
const SCAFFOLD_TYPESCRIPT_VERSION = "^5.7.0";

/**
 * Convert a kebab-case string to Title Case
 */
function toTitleCase(str: string): string {
  return str
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function failInvalidName(name: string, command: "create" | "new"): never {
  console.error(
    `Invalid plugin name '${name}'. Must be kebab-case (lowercase letters, numbers, hyphens).`,
  );
  console.error(`Example: fn plugin ${command} my-awesome-plugin`);
  process.exit(1);
}

function resolveTargetPath(name: string, output?: string): { targetDir: string; targetPath: string } {
  const targetDir = output ?? name;
  return {
    targetDir,
    targetPath: resolve(process.cwd(), targetDir),
  };
}

function ensureTargetPathAvailable(targetDir: string, targetPath: string): void {
  if (existsSync(targetPath)) {
    console.error(`Error: Directory '${targetDir}' already exists.`);
    console.error("Please choose a different name or remove the existing directory.");
    process.exit(1);
  }
}

function readOwnCliVersion(): string | undefined {
  let currentDir: string;
  try {
    currentDir = dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }

  for (let i = 0; i < 8; i += 1) {
    const pkgPath = resolve(currentDir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === "@runfusion/fusion" && typeof parsed.version === "string") {
          return parsed.version;
        }
      } catch {
        // Ignore malformed package.json and continue walking.
      }
    }
    const parentDir = resolve(currentDir, "..");
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return undefined;
}

function resolveFusionCaretVersion(): string {
  const version = readOwnCliVersion() ?? DEFAULT_RUNFUSION_VERSION;
  return `^${version}`;
}

function normalizeScope(scope?: string): string | undefined {
  if (!scope) return undefined;
  return scope.startsWith("@") ? scope.slice(1) : scope;
}

function computeStandalonePackageName(name: string, scope?: string): string {
  const scoped = normalizeScope(scope);
  if (scoped) {
    return `@${scoped}/fusion-plugin-${name}`;
  }
  return `fusion-plugin-${name}`;
}

/**
 * Generate package.json template for workspace-bound example plugin.
 */
function generatePackageJson(name: string): string {
  return JSON.stringify(
    {
      name: `@fusion-plugin-examples/${name}`,
      version: "0.1.0",
      type: "module",
      description: "A Fusion plugin",
      keywords: ["fusion-plugin"],
      exports: {
        ".": {
          types: "./src/index.ts",
          import: "./dist/index.js",
        },
      },
      private: true,
      scripts: {
        build: "tsc",
        test: "vitest run",
      },
      dependencies: {
        "@fusion/plugin-sdk": "workspace:*",
      },
    },
    null,
    2,
  ) + "\n";
}

/**
 * Generate tsconfig.json template for workspace-bound example plugin.
 */
function generateTsconfig(): string {
  return JSON.stringify(
    {
      extends: "../../tsconfig.base.json",
      compilerOptions: {
        outDir: "dist",
        rootDir: "src",
        types: ["node", "vitest/globals"],
      },
      include: ["src/**/*"],
    },
    null,
    2,
  ) + "\n";
}

function generateStandalonePackageJson(name: string, scope?: string): string {
  return JSON.stringify(
    {
      name: computeStandalonePackageName(name, scope),
      version: "0.1.0",
      type: "module",
      description: "A standalone Fusion plugin",
      keywords: ["fusion-plugin"],
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      },
      files: ["dist", "manifest.json"],
      scripts: {
        build: "tsc",
        test: "vitest run",
      },
      devDependencies: {
        "@runfusion/fusion": resolveFusionCaretVersion(),
        "@types/node": SCAFFOLD_TYPES_NODE_VERSION,
        typescript: SCAFFOLD_TYPESCRIPT_VERSION,
        vitest: SCAFFOLD_VITEST_VERSION,
      },
    },
    null,
    2,
  ) + "\n";
}

function generateStandaloneTsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        declaration: true,
        outDir: "dist",
        rootDir: "src",
        strict: true,
        types: ["node"],
      },
      include: ["src/**/*"],
      exclude: ["src/**/*.test.ts", "dist"],
    },
    null,
    2,
  ) + "\n";
}

function generateManifest(name: string): string {
  const titleCase = toTitleCase(name);
  return JSON.stringify(
    {
      id: name,
      name: titleCase,
      version: "0.1.0",
      description: `A standalone Fusion plugin named ${titleCase}.`,
    },
    null,
    2,
  ) + "\n";
}

/**
 * Generate vitest.config.ts template
 */
function generateVitestConfig(): string {
  return `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    pool: "threads",
  },
});
`;
}

/**
 * Generate src/index.ts template
 */
function generateIndexTs(name: string): string {
  const titleCase = toTitleCase(name);
  return `import { definePlugin } from "@fusion/plugin-sdk";

export default definePlugin({
  manifest: {
    id: "${name}",
    name: "${titleCase}",
    version: "0.1.0",
    description: "A new Fusion plugin",
  },
  state: "installed",
  hooks: {
    onLoad: async (ctx) => {
      ctx.logger.info("${name} plugin loaded");
    },
    onUnload: async () => {
      // Cleanup resources
    },
  },
});
`;
}

/**
 * FNXC:PluginScaffold 2026-06-14-01:40:
 * The published FusionPlugin type requires state: PluginState, so standalone `fn plugin new` output must emit `state: "installed"` and stay in sync with the workspace scaffold plus SDK type surface to build unedited.
 */
function generateStandaloneIndexTs(name: string): string {
  const titleCase = toTitleCase(name);
  return `import { definePlugin } from "@runfusion/fusion/plugin-sdk";

export default definePlugin({
  manifest: {
    id: "${name}",
    name: "${titleCase}",
    version: "0.1.0",
    description: "A standalone Fusion plugin",
  },
  state: "installed",
  hooks: {
    onLoad: async (ctx) => {
      ctx.logger.info("${titleCase} plugin loaded");
    },
  },
});
`;
}

/**
 * Generate src/__tests__/index.test.ts template
 */
function generateTestTs(name: string): string {
  const titleCase = toTitleCase(name);
  return `import { describe, it, expect } from "vitest";
import plugin from "../index.js";

describe("${titleCase} plugin", () => {
  it("should export a valid plugin definition", () => {
    expect(plugin.manifest.id).toBe("${name}");
    expect(plugin.manifest.name).toBe("${titleCase}");
    expect(plugin.manifest.version).toBe("0.1.0");
  });

  it("should have a valid state", () => {
    expect(plugin.state).toBe("installed");
  });
});
`;
}

function generateStandaloneTestTs(name: string): string {
  const titleCase = toTitleCase(name);
  return `import { describe, expect, it } from "vitest";
import { validatePluginManifest } from "@runfusion/fusion/plugin-sdk";
import plugin from "../index.js";

describe("${titleCase} plugin", () => {
  it("exports the expected manifest fields", () => {
    expect(plugin.manifest.id).toBe("${name}");
    expect(plugin.manifest.name).toBe("${titleCase}");
    expect(plugin.manifest.version).toBe("0.1.0");
  });

  it("has a manifest accepted by validatePluginManifest", () => {
    const result = validatePluginManifest(plugin.manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
`;
}

/**
 * Generate README.md template
 */
function generateReadme(name: string): string {
  const titleCase = toTitleCase(name);
  return `# ${titleCase}

A Fusion plugin.

## Installation

\`\`\`bash
fn plugin install /path/to/${name}
\`\`\`

## Development

\`\`\`bash
pnpm install
pnpm lint
pnpm test
pnpm build
\`\`\`

## License

MIT
`;
}

function generateStandaloneReadme(name: string): string {
  const titleCase = toTitleCase(name);
  return `# ${titleCase}

A standalone Fusion plugin scaffold generated by \`fn plugin new\`.

## Development

\`\`\`bash
pnpm install
pnpm build
fn plugin dev .
pnpm test
\`\`\`

Use \`fn plugin dev . --once\` for a single build+install pass (CI-safe, no watcher).

## Publish

\`\`\`bash
npm publish
\`\`\`

`;
}

/**
 * Run the plugin scaffold command
 */
export async function runPluginCreate(
  name: string,
  options?: { output?: string },
): Promise<void> {
  // Validate name
  if (!name || !PLUGIN_NAME_REGEX.test(name)) {
    failInvalidName(name, "create");
  }

  // Determine target directory
  const { targetDir, targetPath } = resolveTargetPath(name, options?.output);

  // Check if directory already exists
  ensureTargetPathAvailable(targetDir, targetPath);

  // Create directory structure
  try {
    mkdirSync(targetPath, { recursive: true });
    mkdirSync(join(targetPath, "src", "__tests__"), { recursive: true });

    // Generate files
    writeFileSync(join(targetPath, "package.json"), generatePackageJson(name));
    writeFileSync(join(targetPath, "tsconfig.json"), generateTsconfig());
    writeFileSync(join(targetPath, "vitest.config.ts"), generateVitestConfig());
    writeFileSync(join(targetPath, "src", "index.ts"), generateIndexTs(name));
    writeFileSync(
      join(targetPath, "src", "__tests__", "index.test.ts"),
      generateTestTs(name),
    );
    writeFileSync(join(targetPath, "README.md"), generateReadme(name));
  } catch (err) {
    console.error(
      `Error creating plugin files: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // Print success message
  console.log();
  console.log(`  Created plugin at ./${targetDir}/`);
  console.log();
  console.log("  Next steps:");
  console.log(`    cd ${targetDir}`);
  console.log("    pnpm install");
  console.log("    pnpm lint");
  console.log("    pnpm test");
  console.log();
}

export async function runPluginNew(
  name: string,
  options?: { output?: string; scope?: string },
): Promise<void> {
  if (!name || !PLUGIN_NAME_REGEX.test(name)) {
    failInvalidName(name, "new");
  }

  const { targetDir, targetPath } = resolveTargetPath(name, options?.output);
  ensureTargetPathAvailable(targetDir, targetPath);

  try {
    mkdirSync(targetPath, { recursive: true });
    mkdirSync(join(targetPath, "src", "__tests__"), { recursive: true });

    writeFileSync(join(targetPath, "package.json"), generateStandalonePackageJson(name, options?.scope));
    writeFileSync(join(targetPath, "tsconfig.json"), generateStandaloneTsconfig());
    writeFileSync(join(targetPath, "vitest.config.ts"), generateVitestConfig());
    writeFileSync(join(targetPath, "manifest.json"), generateManifest(name));
    writeFileSync(join(targetPath, "src", "index.ts"), generateStandaloneIndexTs(name));
    writeFileSync(join(targetPath, "src", "__tests__", "index.test.ts"), generateStandaloneTestTs(name));
    writeFileSync(join(targetPath, "README.md"), generateStandaloneReadme(name));
  } catch (err) {
    console.error(
      `Error creating plugin files: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  console.log();
  console.log(`  Created standalone plugin at ./${targetDir}/`);
  console.log();
  console.log("  Next steps:");
  console.log(`    cd ${targetDir}`);
  console.log("    pnpm install");
  console.log("    pnpm test");
  console.log("    pnpm build");
  console.log();
}
