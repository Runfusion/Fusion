import { defineConfig } from "tsup";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

export default defineConfig({
  entry: ["src/bin.ts", "src/extension.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  esbuildOptions(options) {
    options.conditions = [...(options.conditions || []), "source"];
  },
  noExternal: [/^@fusion\//],
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
  clean: true,
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

    if (existsSync(dependencyGraphPluginDest)) {
      rmSync(dependencyGraphPluginDest, { recursive: true, force: true });
    }
    if (existsSync(dependencyGraphPluginSrc)) {
      mkdirSync(dependencyGraphPluginDest, { recursive: true });
      cpSync(join(dependencyGraphPluginSrc, "manifest.json"), join(dependencyGraphPluginDest, "manifest.json"));
      cpSync(join(dependencyGraphPluginSrc, "package.json"), join(dependencyGraphPluginDest, "package.json"));
      cpSync(join(dependencyGraphPluginSrc, "src"), join(dependencyGraphPluginDest, "src"), { recursive: true });
      console.log("Copied dependency graph plugin to dist/plugins/fusion-plugin-dependency-graph/");
    } else {
      console.warn(
        `WARNING: Dependency graph plugin source not found at ${dependencyGraphPluginSrc}; bundled auto-install will be unavailable.`,
      );
    }

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
});
