import { defineConfig } from "tsup";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";
import { ALL_STAGED_BUNDLED_IDS, RUNTIME_PLUGIN_IDS } from "./src/plugins/staged-bundled-plugin-ids";

export { ALL_STAGED_BUNDLED_IDS };

const RUNTIME_PLUGINS_WITH_MCP_SCHEMA_SERVER = new Set([
  "fusion-plugin-openclaw-runtime",
  "fusion-plugin-droid-runtime",
]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardClientSrc = join(__dirname, "..", "dashboard", "dist", "client");
const dashboardClientDest = join(__dirname, "dist", "client");
const piClaudeCliSrc = join(__dirname, "..", "pi-claude-cli");
const piClaudeCliDest = join(__dirname, "dist", "pi-claude-cli");
const droidCliSrc = join(__dirname, "..", "droid-cli");
const droidCliDest = join(__dirname, "dist", "droid-cli");
const llamaCppSrc = join(__dirname, "..", "pi-llama-cpp");
const llamaCppDest = join(__dirname, "dist", "pi-llama-cpp");
const dependencyGraphPluginSrc = join(__dirname, "..", "..", "plugins", "fusion-plugin-dependency-graph");
const dependencyGraphPluginDest = join(__dirname, "dist", "plugins", "fusion-plugin-dependency-graph");
const whatsappChatPluginSrc = join(__dirname, "..", "..", "plugins", "fusion-plugin-whatsapp-chat");
const whatsappChatPluginDest = join(__dirname, "dist", "plugins", "fusion-plugin-whatsapp-chat");
const roadmapPluginSrc = join(__dirname, "..", "..", "plugins", "fusion-plugin-roadmap");
const roadmapPluginDest = join(__dirname, "dist", "plugins", "fusion-plugin-roadmap");
const reportsPluginSrc = join(__dirname, "..", "..", "plugins", "fusion-plugin-reports");
const reportsPluginDest = join(__dirname, "dist", "plugins", "fusion-plugin-reports");
const cliPrintingPressPluginSrc = join(__dirname, "..", "..", "plugins", "fusion-plugin-cli-printing-press");
const cliPrintingPressPluginDest = join(__dirname, "dist", "plugins", "fusion-plugin-cli-printing-press");
const compoundEngineeringPluginSrc = join(__dirname, "..", "..", "plugins", "fusion-plugin-compound-engineering");
const compoundEngineeringPluginDest = join(__dirname, "dist", "plugins", "fusion-plugin-compound-engineering");
const dashboardClientStub = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Fusion Dashboard</title>
  </head>
  <body>
    <main>
      <h1>Fusion Dashboard</h1>
      <p>Dashboard assets not built — run \`pnpm build\` to generate full client assets.</p>
    </main>
  </body>
</html>
`;

type BundlePluginEntryOptions = {
  pluginId: string;
  srcDir: string;
  destDir: string;
  withMcpAsset?: boolean;
};

async function bundlePluginEntry({ pluginId, srcDir, destDir, withMcpAsset = false }: BundlePluginEntryOptions) {
  if (existsSync(destDir)) {
    rmSync(destDir, { recursive: true, force: true });
  }
  if (!existsSync(srcDir)) {
    console.warn(
      `WARNING: Plugin source not found at ${srcDir}; ${pluginId} will be unavailable in the published package.`,
    );
    return;
  }

  mkdirSync(destDir, { recursive: true });
  cpSync(join(srcDir, "manifest.json"), join(destDir, "manifest.json"));

  const srcPkg = JSON.parse(readFileSync(join(srcDir, "package.json"), "utf-8"));
  const destPkg = {
    name: srcPkg.name,
    version: srcPkg.version,
    type: "module",
    exports: { ".": { import: "./bundled.js" } },
    private: true,
  };
  writeFileSync(join(destDir, "package.json"), JSON.stringify(destPkg, null, 2));

  const srcEntry = join(srcDir, "src", "index.ts");
  const builtEntry = join(srcDir, "dist", "index.js");
  const entry = existsSync(srcEntry) ? srcEntry : builtEntry;
  if (!existsSync(entry)) {
    throw new Error(`No entry found for ${pluginId} (looked for src/index.ts and dist/index.js)`);
  }

  await esbuildBuild({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile: join(destDir, "bundled.js"),
    external: ["@fusion/core", "@fusion/engine"],
    alias: {
      "@fusion/plugin-sdk": join(__dirname, "..", "plugin-sdk", "src", "index.ts"),
    },
    logLevel: "warning",
  });

  if (withMcpAsset) {
    const mcpServerAsset = join(srcDir, "src", "mcp-schema-server.cjs");
    if (!existsSync(mcpServerAsset)) {
      throw new Error(
        `[tsup] Missing required bridge asset for ${pluginId} at ${mcpServerAsset}; expected committed source file mcp-schema-server.cjs.`,
      );
    }
    cpSync(mcpServerAsset, join(destDir, "mcp-schema-server.cjs"));
  }

  const bundledOutput = join(destDir, "bundled.js");
  if (!existsSync(bundledOutput)) {
    throw new Error(`[tsup] Missing bundled output for ${pluginId}: expected ${bundledOutput}`);
  }

  console.log(`Bundled plugin ${pluginId} to dist/plugins/${pluginId}/bundled.js`);
}

function assertAllStagedBundledPluginsLoadable() {
  const missingEntries: string[] = [];

  for (const pluginId of ALL_STAGED_BUNDLED_IDS) {
    const destDir = join(__dirname, "dist", "plugins", pluginId);
    const manifestPath = join(destDir, "manifest.json");
    const bundledEntryPath = join(destDir, "bundled.js");
    const sourceEntryPath = join(destDir, "src", "index.ts");

    if (!existsSync(manifestPath) || (!existsSync(bundledEntryPath) && !existsSync(sourceEntryPath))) {
      missingEntries.push(
        `${pluginId} (expected manifest.json plus bundled.js or src/index.ts under ${destDir})`,
      );
    }
  }

  if (missingEntries.length > 0) {
    throw new Error(`[tsup] Missing loadable staged bundled plugin entries:\n${missingEntries.join("\n")}`);
  }
}

const pluginSdkEntry = join(__dirname, "..", "plugin-sdk", "src", "index.ts");
const pluginSdkCoreRuntimeShim = join(__dirname, "src", "plugin-sdk-core-runtime-shim.ts");

const cliBuildConfig = {
  entry: ["src/bin.ts", "src/extension.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  esbuildOptions(options: { conditions?: string[] }) {
    options.conditions = [...(options.conditions || []), "source"];
  },
  noExternal: [/^@fusion\//, /^@fusion-plugin-examples\//],
  // Native module: leave node-pty (aliased to @homebridge fork) out of the
  // bundle. esbuild can't statically resolve its conditional native require()s
  // (build/Release/pty.node, build/Debug/conpty.node, ...).
  external: [
    "node-pty",
    "@homebridge/node-pty-prebuilt-multiarch",
    "dockerode",
    "ssh2",
    "cpu-features",
  ],
  splitting: false,
  // Keep clean disabled so the dedicated plugin-sdk tsup config can emit into
  // dist/plugin-sdk without being wiped between config executions.
  clean: false,
  removeNodeProtocol: false,
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  onSuccess: async () => {
    // Stage the vendored pi-claude-cli pi extension into dist/. It can't
    // be bundled by esbuild because pi loads extensions as separate files
    // at runtime via jiti, so we ship the raw .ts source. This also lets
    // us drop @fusion/pi-claude-cli from the published package's
    // dependencies — the workspace package is private and would 404 on
    // `pnpm install` of @runfusion/fusion otherwise.
    if (existsSync(piClaudeCliDest)) {
      rmSync(piClaudeCliDest, { recursive: true, force: true });
    }
    if (existsSync(piClaudeCliSrc)) {
      mkdirSync(piClaudeCliDest, { recursive: true });
      cpSync(join(piClaudeCliSrc, "index.ts"), join(piClaudeCliDest, "index.ts"));
      cpSync(join(piClaudeCliSrc, "src"), join(piClaudeCliDest, "src"), { recursive: true });
      cpSync(join(piClaudeCliSrc, "package.json"), join(piClaudeCliDest, "package.json"));
      console.log("Copied pi-claude-cli extension to dist/pi-claude-cli/");
    } else {
      console.warn(
        `WARNING: pi-claude-cli source not found at ${piClaudeCliSrc}; useClaudeCli will not work in the published package.`,
      );
    }

    // Stage the vendored @fusion/droid-cli pi extension into dist/, following
    // the same pattern as pi-claude-cli above. The extension ships raw .ts
    // source that pi loads via jiti at runtime, so it cannot be bundled by
    // esbuild. This lets us drop @fusion/droid-cli from the published
    // package's dependencies — the workspace package is private and would 404
    // on `pnpm install` of @runfusion/fusion otherwise.
    if (existsSync(droidCliDest)) {
      rmSync(droidCliDest, { recursive: true, force: true });
    }
    if (existsSync(droidCliSrc)) {
      mkdirSync(droidCliDest, { recursive: true });
      cpSync(join(droidCliSrc, "index.ts"), join(droidCliDest, "index.ts"));
      cpSync(join(droidCliSrc, "src"), join(droidCliDest, "src"), { recursive: true });
      cpSync(join(droidCliSrc, "package.json"), join(droidCliDest, "package.json"));
      console.log("Copied droid-cli extension to dist/droid-cli/");
    } else {
      console.warn(
        `WARNING: droid-cli source not found at ${droidCliSrc}; useDroidCli will not work in the published package.`,
      );
    }

    if (existsSync(llamaCppDest)) {
      rmSync(llamaCppDest, { recursive: true, force: true });
    }
    if (existsSync(llamaCppSrc)) {
      mkdirSync(llamaCppDest, { recursive: true });
      cpSync(join(llamaCppSrc, "index.ts"), join(llamaCppDest, "index.ts"));
      cpSync(join(llamaCppSrc, "src"), join(llamaCppDest, "src"), { recursive: true });
      cpSync(join(llamaCppSrc, "package.json"), join(llamaCppDest, "package.json"));
      console.log("Copied pi-llama-cpp extension to dist/pi-llama-cpp/");
    } else {
      console.warn(
        `WARNING: pi-llama-cpp source not found at ${llamaCppSrc}; useLlamaCpp will not work in the published package.`,
      );
    }

    await bundlePluginEntry({
      pluginId: "fusion-plugin-dependency-graph",
      srcDir: dependencyGraphPluginSrc,
      destDir: dependencyGraphPluginDest,
    });

    if (existsSync(whatsappChatPluginDest)) {
      rmSync(whatsappChatPluginDest, { recursive: true, force: true });
    }
    if (existsSync(whatsappChatPluginSrc)) {
      mkdirSync(whatsappChatPluginDest, { recursive: true });
      cpSync(join(whatsappChatPluginSrc, "manifest.json"), join(whatsappChatPluginDest, "manifest.json"));
      cpSync(join(whatsappChatPluginSrc, "package.json"), join(whatsappChatPluginDest, "package.json"));
      cpSync(join(whatsappChatPluginSrc, "src"), join(whatsappChatPluginDest, "src"), { recursive: true });
      console.log("Copied WhatsApp chat plugin to dist/plugins/fusion-plugin-whatsapp-chat/");
    } else {
      console.warn(
        `WARNING: WhatsApp chat plugin source not found at ${whatsappChatPluginSrc}; bundled auto-install will be unavailable.`,
      );
    }

    await bundlePluginEntry({
      pluginId: "fusion-plugin-roadmap",
      srcDir: roadmapPluginSrc,
      destDir: roadmapPluginDest,
    });

    await bundlePluginEntry({
      pluginId: "fusion-plugin-compound-engineering",
      srcDir: compoundEngineeringPluginSrc,
      destDir: compoundEngineeringPluginDest,
    });

    if (existsSync(reportsPluginDest)) {
      rmSync(reportsPluginDest, { recursive: true, force: true });
    }
    if (existsSync(reportsPluginSrc)) {
      mkdirSync(reportsPluginDest, { recursive: true });
      cpSync(join(reportsPluginSrc, "manifest.json"), join(reportsPluginDest, "manifest.json"));
      cpSync(join(reportsPluginSrc, "package.json"), join(reportsPluginDest, "package.json"));
      cpSync(join(reportsPluginSrc, "src"), join(reportsPluginDest, "src"), { recursive: true });
      console.log("Copied reports plugin to dist/plugins/fusion-plugin-reports/");
    } else {
      console.warn(
        `WARNING: Reports plugin source not found at ${reportsPluginSrc}; bundled auto-install will be unavailable.`,
      );
    }

    if (existsSync(cliPrintingPressPluginDest)) {
      rmSync(cliPrintingPressPluginDest, { recursive: true, force: true });
    }
    if (existsSync(cliPrintingPressPluginSrc)) {
      mkdirSync(cliPrintingPressPluginDest, { recursive: true });
      cpSync(join(cliPrintingPressPluginSrc, "manifest.json"), join(cliPrintingPressPluginDest, "manifest.json"));
      cpSync(join(cliPrintingPressPluginSrc, "package.json"), join(cliPrintingPressPluginDest, "package.json"));
      cpSync(join(cliPrintingPressPluginSrc, "src"), join(cliPrintingPressPluginDest, "src"), { recursive: true });
      console.log("Copied cli-printing-press plugin to dist/plugins/fusion-plugin-cli-printing-press/");
    } else {
      console.warn(
        `WARNING: cli-printing-press plugin source not found at ${cliPrintingPressPluginSrc}; bundled auto-install will be unavailable.`,
      );
    }

    // Bundle each runtime plugin into a self-contained ESM file so npm/npx
    // installs can load them without the workspace `@fusion/plugin-sdk`.
    for (const pluginId of RUNTIME_PLUGIN_IDS) {
      await bundlePluginEntry({
        pluginId,
        srcDir: join(__dirname, "..", "..", "plugins", pluginId),
        destDir: join(__dirname, "dist", "plugins", pluginId),
        withMcpAsset: RUNTIME_PLUGINS_WITH_MCP_SCHEMA_SERVER.has(pluginId),
      });
    }

    /*
     * FNXC:BundledPlugins 2026-06-17-22:15:
     * Build output must cover the complete staged plugin surface, including raw-src copied plugins that do not pass through bundlePluginEntry's per-plugin bundled.js assertion. Droid and ACP runtimes are intentionally staged but not auto-installed pending FN-6623, so this checks loadable staged entries rather than BUNDLED_PLUGIN_IDS equality.
     */
    assertAllStagedBundledPluginsLoadable();

    if (existsSync(dashboardClientDest)) {
      rmSync(dashboardClientDest, { recursive: true, force: true });
    }

    if (existsSync(dashboardClientSrc)) {
      cpSync(dashboardClientSrc, dashboardClientDest, { recursive: true });
      console.log("Copied dashboard client assets to dist/client/");
      return;
    }

    mkdirSync(dashboardClientDest, { recursive: true });
    writeFileSync(join(dashboardClientDest, "index.html"), dashboardClientStub, "utf-8");
    console.warn(
      `WARNING: Dashboard client assets not found at ${dashboardClientSrc}. Generated minimal stub at ${join(dashboardClientDest, "index.html")}.`,
    );
  },
};

const pluginSdkBuildConfig = {
  entry: { "plugin-sdk/index": pluginSdkEntry },
  format: ["esm"],
  platform: "node",
  target: "node22",
  tsconfig: join(__dirname, "..", "plugin-sdk", "tsconfig.json"),
  dts: {
    /*
     * FNXC:PluginSDK 2026-06-13-12:00:
     * FN-6409 requires the published @runfusion/fusion/plugin-sdk declaration entry to be self-contained. External plugin authors cannot resolve private @fusion/core types from scaffolded projects, so leaving @fusion/* imports in dist/plugin-sdk/index.d.ts makes tsc fail with TS2307 before ctx parameters can typecheck.
     */
    resolve: [/^@fusion\//],
    compilerOptions: {
      rootDir: join(__dirname, ".."),
      baseUrl: ".",
      paths: {
        "@fusion/core": ["../core/src/index.ts"],
      },
      removeComments: true,
    },
  },
  noExternal: [/^@fusion\//],
  esbuildOptions(options: { alias?: Record<string, string> }) {
    options.alias = {
      ...(options.alias || {}),
      "@fusion/core": pluginSdkCoreRuntimeShim,
    };
  },
  clean: false,
  outDir: "dist",
};

export default defineConfig([cliBuildConfig, pluginSdkBuildConfig]);
