import { defineConfig } from "tsup";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";
import { ALL_STAGED_BUNDLED_IDS, RUNTIME_PLUGIN_IDS } from "./src/plugins/staged-bundled-plugin-ids";

export { ALL_STAGED_BUNDLED_IDS };

const RUNTIME_PLUGINS_WITH_MCP_SCHEMA_SERVER = new Set([
  "fusion-plugin-openclaw-runtime",
  "fusion-plugin-droid-runtime",
  // FNXC:GrokAcp 2026-07-11-14:00: Grok ACP ships mcp-schema-server.cjs so
  // session/new can forward executable Fusion fn_* tools to grok agent stdio.
  "fusion-plugin-grok-runtime",
  // FNXC:OmpAcp 2026-07-14-00:05: OMP ACP ships the same bridge asset for fn_* tools.
  "fusion-plugin-omp-runtime",
]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(__dirname, "..", "..");
const dashboardClientSrc = join(__dirname, "..", "dashboard", "dist", "client");
const dashboardClientDest = join(__dirname, "dist", "client");
// FNXC:RuntimeStartupWiring 2026-06-24-11:15:
// The PostgreSQL schema baseline (0000_initial.sql) is read at runtime by the
// schema applier relative to the compiled module location. When @fusion/core
// is bundled into dist/bin.js, the applier's __dirname resolves to dist/, so
// the migration SQL must be staged into dist/migrations to remain resolvable.
const pgMigrationsSrc = join(__dirname, "..", "core", "src", "postgres", "migrations");
const pgMigrationsDest = join(__dirname, "dist", "migrations");
const piClaudeCliSrc = join(__dirname, "..", "pi-claude-cli");
const piClaudeCliDest = join(__dirname, "dist", "pi-claude-cli");
const droidCliSrc = join(__dirname, "..", "droid-cli");
const droidCliDest = join(__dirname, "dist", "droid-cli");
const desktopRuntimeSrc = join(__dirname, "..", "desktop", "dist");
const desktopRuntimeDest = join(__dirname, "dist", "desktop");
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
const linearImportPluginSrc = join(__dirname, "..", "..", "plugins", "fusion-plugin-linear-import");
const linearImportPluginDest = join(__dirname, "dist", "plugins", "fusion-plugin-linear-import");
const pluginSdkCoreRuntimeShim = join(__dirname, "src", "plugin-sdk-core-runtime-shim.ts");
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

type PackageManifest = {
  name?: string;
  version?: string;
  type?: string;
  exports?: unknown;
  main?: string;
  pi?: unknown;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const dependencyMapKeys = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

function isDependencyMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((specifier) => typeof specifier === "string")
  );
}

function sanitizeDependencyMap(dependencyMap: unknown): Record<string, string> | undefined {
  if (!isDependencyMap(dependencyMap)) {
    return undefined;
  }

  const sanitized = Object.fromEntries(
    Object.entries(dependencyMap).filter(
      ([name, specifier]) => !name.startsWith("@fusion/") && !specifier.includes("workspace:"),
    ),
  );
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

/*
 * FNXC:Packaging 2026-06-26-08:40:
 * Copied source manifests in the published CLI must be install-safe outside the workspace. Private @fusion/* dependencies and workspace: specifiers make package managers resolve unpublished packages during npm/npx installs, producing the FN-7060 missing fusion core failure, so raw-src plugin and pi-extension manifests are rewritten while preserving loadable entry metadata and real third-party deps.
 */
function writeSanitizedCopiedManifest(srcPkgPath: string, destPkgPath: string) {
  const srcPkg = JSON.parse(readFileSync(srcPkgPath, "utf-8")) as PackageManifest;
  const destPkg: PackageManifest = {
    name: srcPkg.name,
    version: srcPkg.version,
    type: srcPkg.type,
    private: true,
  };

  if (srcPkg.exports !== undefined) {
    destPkg.exports = srcPkg.exports;
  }
  if (srcPkg.main !== undefined) {
    destPkg.main = srcPkg.main;
  }
  if (srcPkg.pi !== undefined) {
    destPkg.pi = srcPkg.pi;
  }

  for (const dependencyMapKey of dependencyMapKeys) {
    const sanitizedDependencyMap = sanitizeDependencyMap(srcPkg[dependencyMapKey]);
    if (sanitizedDependencyMap) {
      destPkg[dependencyMapKey] = sanitizedDependencyMap;
    }
  }

  writeFileSync(destPkgPath, JSON.stringify(destPkg, null, 2));
}

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
    external: ["@fusion/engine"],
    alias: {
      "@fusion/plugin-sdk": join(__dirname, "..", "plugin-sdk", "src", "index.ts"),
      /*
       * FNXC:BundledPlugins 2026-07-13-00:00:
       * FN-7936 / issue #2059 requires every published bundled.js to be self-contained. The plugin-sdk source re-exports WORKFLOW_EXTENSION_SCHEMA_VERSION, workflowExtensionRegistryId, and createBoardActionServices from private @fusion/core; resolve those runtime values to the shared shim here so npm-installed bundled plugins never crash with Cannot find package '@fusion/core'.
       */
      "@fusion/core": pluginSdkCoreRuntimeShim,
    },
    logLevel: "warning",
  });

  const skillsSourceDir = join(srcDir, "src", "skills");
  if (existsSync(skillsSourceDir)) {
    const skillsDestDir = join(destDir, "skills");
    /*
     * FNXC:BundledPlugins 2026-07-14-12:00:
     * FN-7955 / issue #2094 requires plugin-local runtime-read assets to ship with @runfusion/fusion. esbuild bundle:true only inlines statically imported JS/TS, so files read from disk through resolveBundledSkillsRoot() or PluginSkillContribution.skillFiles, such as nested SKILL.md files under src/skills, must be explicitly staged into dist/plugins/<id>/skills/ or the published npm tarball silently contains zero skill bodies.
     */
    cpSync(skillsSourceDir, skillsDestDir, { recursive: true });
    if (!existsSync(skillsDestDir)) {
      throw new Error(`[tsup] Missing staged skills for ${pluginId}: expected ${skillsDestDir}`);
    }
    console.log(`Staged plugin skills for ${pluginId} to dist/plugins/${pluginId}/skills`);
  }

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

function runWorkspaceCommand(command: string, args: string[], cwd: string, timeoutMs = 600_000): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
      /*
       * FNXC:DesktopPackaging 2026-07-02-15:10:
       * On Windows `pnpm` (and other npm bins) resolve to a `.cmd` shim that Node refuses to
       * spawn without a shell (ENOENT / EINVAL since CVE-2024-27980). Without shell:true the CLI
       * package build failed with `spawn pnpm ENOENT` on Windows at the "building @fusion/desktop"
       * step. The command/args here are fixed repo build invocations (no untrusted input), so shell
       * quoting is safe.
       */
      shell: process.platform === "win32",
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function ensureDesktopRuntimeAssetsBuilt() {
  if (existsSync(desktopRuntimeSrc)) {
    return;
  }

  /*
   * FNXC:DesktopPackaging 2026-07-01-20:53:
   * The published CLI package must contain the desktop runtime it launches. Build the private desktop package during CLI packaging when dist is absent, but keep this strictly in the repository build path — the installed `fusion desktop` command itself must never run pnpm from an operator's cwd.
   */
  console.log("Desktop runtime assets missing; building @fusion/desktop before staging CLI package assets...");
  await runWorkspaceCommand("pnpm", ["--filter", "@fusion/desktop", "build"], workspaceRoot);

  if (!existsSync(desktopRuntimeSrc)) {
    throw new Error(`[tsup] Desktop runtime build did not create expected assets at ${desktopRuntimeSrc}`);
  }
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
  //
  // FNXC:RuntimeStartupWiring 2026-06-24-11:00:
  // embedded-postgres ships platform-specific optional packages
  // (@embedded-postgres/darwin-arm64, linux-x64, windows-x64, ...) that it
  // loads via dynamic import() at runtime based on process.platform/arch.
  // esbuild tries to resolve those dynamic imports at bundle time and fails
  // because only the current platform's binary is installed. Externalize the
  // whole family (plus the umbrella package) so the native binaries are
  // resolved at runtime from node_modules, exactly like node-pty above.
  external: [
    "node-pty",
    "@homebridge/node-pty-prebuilt-multiarch",
    "dockerode",
    "ssh2",
    "cpu-features",
    "embedded-postgres",
    /^@embedded-postgres\//,
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
    // FNXC:RuntimeStartupWiring 2026-06-24-11:15:
    // FNXC:AutomationIsolation 2026-07-13-22:37: Stage the complete versioned PostgreSQL migration directory (including automation project isolation) into dist/migrations so existing installations upgrade before project cron runners start.
    // Stage the PostgreSQL schema migrations into dist/migrations so the schema applier can read them at runtime after
    // @fusion/core is bundled into dist/bin.js. Without this, the PG boot
    // path fails with ENOENT for dist/migrations/0000_initial.sql.
    if (existsSync(pgMigrationsSrc)) {
      if (existsSync(pgMigrationsDest)) {
        rmSync(pgMigrationsDest, { recursive: true, force: true });
      }
      mkdirSync(pgMigrationsDest, { recursive: true });
      cpSync(pgMigrationsSrc, pgMigrationsDest, { recursive: true });
      console.log("Copied PostgreSQL migrations to dist/migrations/");
    } else {
      console.warn(
        `WARNING: PostgreSQL migrations source not found at ${pgMigrationsSrc}; DATABASE_URL boot will fail to apply schema migrations.`,
      );
    }
    if (existsSync(desktopRuntimeDest)) {
      rmSync(desktopRuntimeDest, { recursive: true, force: true });
    }
    await ensureDesktopRuntimeAssetsBuilt();
    /*
     * FNXC:DesktopPackaging 2026-07-01-20:31:
     * Published `@runfusion/fusion` desktop launches must resolve Electron runtime assets from the installed package, not from the operator's current directory. Stage the private @fusion/desktop dist output under CLI dist/desktop so npm installs can launch without pnpm workspace discovery or host JSON parsing.
     */
    mkdirSync(desktopRuntimeDest, { recursive: true });
    cpSync(desktopRuntimeSrc, desktopRuntimeDest, { recursive: true });
    console.log("Copied desktop runtime assets to dist/desktop/");

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
      writeSanitizedCopiedManifest(join(piClaudeCliSrc, "package.json"), join(piClaudeCliDest, "package.json"));
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
      writeSanitizedCopiedManifest(join(droidCliSrc, "package.json"), join(droidCliDest, "package.json"));
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
      writeSanitizedCopiedManifest(join(llamaCppSrc, "package.json"), join(llamaCppDest, "package.json"));
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
      writeSanitizedCopiedManifest(join(whatsappChatPluginSrc, "package.json"), join(whatsappChatPluginDest, "package.json"));
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

    await bundlePluginEntry({
      pluginId: "fusion-plugin-linear-import",
      srcDir: linearImportPluginSrc,
      destDir: linearImportPluginDest,
    });

    if (existsSync(reportsPluginDest)) {
      rmSync(reportsPluginDest, { recursive: true, force: true });
    }
    if (existsSync(reportsPluginSrc)) {
      mkdirSync(reportsPluginDest, { recursive: true });
      cpSync(join(reportsPluginSrc, "manifest.json"), join(reportsPluginDest, "manifest.json"));
      writeSanitizedCopiedManifest(join(reportsPluginSrc, "package.json"), join(reportsPluginDest, "package.json"));
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
      writeSanitizedCopiedManifest(join(cliPrintingPressPluginSrc, "package.json"), join(cliPrintingPressPluginDest, "package.json"));
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
