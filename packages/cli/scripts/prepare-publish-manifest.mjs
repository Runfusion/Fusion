/* global process, URL, console */

import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

export function assertPluginSdkDeclarationExists(packageRoot) {
  const declarationPath = join(packageRoot, "dist", "plugin-sdk", "index.d.ts");
  let declarationSize = 0;
  try {
    declarationSize = statSync(declarationPath).size;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (declarationSize === 0) {
    throw new Error(
      `Refusing to pack @runfusion/fusion: missing or empty dist/plugin-sdk/index.d.ts. Run the full package build first.`,
    );
  }
}

export function applyPrepackTransform(pkg) {
  const devDependencies = { ...(pkg.devDependencies || {}) };
  delete devDependencies["@fusion/core"];
  delete devDependencies["@fusion/dashboard"];
  delete devDependencies["@fusion/engine"];
  delete devDependencies["@fusion/i18n"];
  delete devDependencies["@fusion/pi-claude-cli"];
  delete devDependencies["@fusion/pi-llama-cpp"];
  delete devDependencies["@fusion-plugin-examples/roadmap"];

  return {
    ...pkg,
    devDependencies,
    // Inject exports only for the packed manifest so workspace/dev resolution
    // remains unchanged (postpack restore reverts this file to original state).
    //
    // Declaring any `exports` field flips Node into strict subpath mode, which
    // would otherwise hide every other `./dist/*` file. The runfusion.ai alias
    // imports `@runfusion/fusion/dist/bin.js` and the pi loader reads
    // `./dist/extension.js`, so a `./dist/*` passthrough is required to keep
    // those subpaths resolvable post-pack.
    exports: {
      ...(pkg.exports || {}),
      "./plugin-sdk": {
        types: "./dist/plugin-sdk/index.d.ts",
        import: "./dist/plugin-sdk/index.js",
      },
      "./dist/*": "./dist/*",
      "./package.json": "./package.json",
    },
  };
}

function run() {
  const mode = process.argv[2];
  const packageJsonPath = new URL("../package.json", import.meta.url);
  const backupPath = new URL("../package.json.pack-backup", import.meta.url);

  if (mode === "prepack") {
    if (existsSync(backupPath)) {
      unlinkSync(backupPath);
    }
    assertPluginSdkDeclarationExists(dirname(fileURLToPath(packageJsonPath)));

    const original = readFileSync(packageJsonPath, "utf8");
    writeFileSync(backupPath, original, "utf8");

    const pkg = JSON.parse(original);
    const transformed = applyPrepackTransform(pkg);
    writeFileSync(packageJsonPath, `${JSON.stringify(transformed, null, 2)}\n`, "utf8");
    process.exit(0);
  }

  if (mode === "postpack") {
    if (!existsSync(backupPath)) {
      process.exit(0);
    }

    const backup = readFileSync(backupPath, "utf8");
    writeFileSync(packageJsonPath, backup, "utf8");
    unlinkSync(backupPath);
    process.exit(0);
  }

  console.error("Usage: node ./scripts/prepare-publish-manifest.mjs <prepack|postpack>");
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
