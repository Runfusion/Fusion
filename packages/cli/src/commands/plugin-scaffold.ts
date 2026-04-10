/**
 * Plugin Scaffold Command
 *
 * Generates a new plugin project with boilerplate code.
 * Usage: fn plugin create <name>
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Valid plugin name pattern: kebab-case
const PLUGIN_NAME_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/**
 * Convert a kebab-case string to Title Case
 */
function toTitleCase(str: string): string {
  return str
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Generate package.json template
 */
function generatePackageJson(name: string): string {
  const titleCase = toTitleCase(name);
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
 * Generate tsconfig.json template
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
pnpm test
pnpm build
\`\`\`

## License

MIT
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
    console.error(
      `Invalid plugin name '${name}'. Must be kebab-case (lowercase letters, numbers, hyphens).`,
    );
    console.error("Example: fn plugin create my-awesome-plugin");
    process.exit(1);
  }

  // Determine target directory
  const targetDir = options?.output ?? name;
  const targetPath = join(process.cwd(), targetDir);

  // Check if directory already exists
  if (existsSync(targetPath)) {
    console.error(`Error: Directory '${targetDir}' already exists.`);
    console.error("Please choose a different name or remove the existing directory.");
    process.exit(1);
  }

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
  console.log("    pnpm test");
  console.log();
}
