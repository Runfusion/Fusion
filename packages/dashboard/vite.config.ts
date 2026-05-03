import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * Generate a deterministic build version string.
 *
 * Uses the short git commit hash + a content hash of key files so the version
 * only changes when the actual source (or uncommitted changes to those files)
 * changes. Falls back to package.json version when git is unavailable.
 */
function computeBuildVersion(): string {
  // Get git short hash or fall back to package.json version
  let prefix: string;
  try {
    prefix = execSync("git rev-parse --short HEAD", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    try {
      const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));
      prefix = typeof pkg.version === "string" ? pkg.version : "0.0.0";
    } catch {
      prefix = "0.0.0";
    }
  }

  // Content hash of key source files — changes when source changes
  const filesToHash = [resolve(__dirname, "app/main.tsx"), resolve(__dirname, "package.json")];
  const hasher = createHash("sha1");
  for (const f of filesToHash) {
    try {
      hasher.update(readFileSync(f));
    } catch {
      // file may not exist during certain builds — skip
    }
  }
  const contentHash = hasher.digest("hex").slice(0, 8);

  return `${prefix}-${contentHash}`;
}

const buildVersion = computeBuildVersion();

function emitVersionJson(): Plugin {
  return {
    name: "fusion-emit-version-json",
    apply: "build",
    closeBundle() {
      const outFile = resolve(__dirname, "dist/client/version.json");
      writeFileSync(outFile, `${JSON.stringify({ version: buildVersion })}\n`);
      console.log(`[fusion] build version: ${buildVersion}`);
    },
  };
}

export default defineConfig({
  root: "app",
  plugins: [react(), emitVersionJson()],
  define: {
    __BUILD_VERSION__: JSON.stringify(buildVersion),
  },
  resolve: {
    alias: {
      "@fusion/core": resolve(__dirname, "../core/src/types.ts"),
    },
  },
  optimizeDeps: {
    include: [
      "@xterm/xterm",
      "@xterm/addon-fit",
      "@xterm/addon-web-links",
      "@xterm/addon-webgl",
    ],
  },
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
    target: "es2022",
    cssCodeSplit: true,
    sourcemap: false,
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
        manualChunks: (id) => {
          if (id.includes("/node_modules/react/") || id.includes("/node_modules/react-dom/")) {
            return "vendor-react";
          }

          if (id.includes("/node_modules/@xterm/xterm/")) {
            return "vendor-xterm";
          }

          if (id.includes("/node_modules/@codemirror/")) {
            return "vendor-codemirror";
          }

          return undefined;
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.FUSION_API_PORT ?? "4040"}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
