import { defineConfig } from "tsup";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardClientSrc = join(__dirname, "..", "dashboard", "dist", "client");
const dashboardClientDest = join(__dirname, "dist", "client");
const piClaudeCliSrc = join(__dirname, "..", "pi-claude-cli");
const piClaudeCliDest = join(__dirname, "dist", "pi-claude-cli");
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
