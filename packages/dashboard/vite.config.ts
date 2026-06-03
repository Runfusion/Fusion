import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
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

  // Content hash of the entire app/ source tree + package.json. Hashing only
  // a couple of entry files (the previous behavior) meant that edits to any
  // other component or stylesheet produced an identical build version, so the
  // dashboard's version-check poll never noticed the new bundle and the
  // "reload available" prompt never fired (FN-3333 follow-up).
  const hasher = createHash("sha1");
  const appDir = resolve(__dirname, "app");
  // Collect, sort, then hash so the order is stable across platforms and runs.
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "__tests__" || entry.startsWith(".")) continue;
      const full = resolve(dir, entry);
      let info: ReturnType<typeof statSync>;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        walk(full);
      } else if (info.isFile()) {
        files.push(full);
      }
    }
  };
  walk(appDir);
  files.sort();
  for (const f of files) {
    try {
      hasher.update(f.slice(appDir.length));
      hasher.update(readFileSync(f));
    } catch {
      // file may have been deleted between readdir and read — skip
    }
  }
  try {
    hasher.update(readFileSync(resolve(__dirname, "package.json")));
  } catch {
    // ignore
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
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, `${JSON.stringify({ version: buildVersion })}\n`);
      console.log(`[fusion] build version: ${buildVersion}`);
    },
  };
}

function ensureThemeDataStylesheetOrder(): Plugin {
  return {
    name: "fusion-theme-data-link-order",
    apply: "build",
    enforce: "post",
    transformIndexHtml(html) {
      const headMatch = html.match(/<head>[\s\S]*?<\/head>/i);
      if (!headMatch) return html;

      const head = headMatch[0];
      const themeLinkMatch = head.match(/<link[^>]*id=["']theme-data["'][^>]*>/i);
      if (!themeLinkMatch) return html;

      const themeLink = themeLinkMatch[0];
      const headWithoutThemeLink = head.replace(themeLink, "");
      const reorderedHead = headWithoutThemeLink.replace(/<\/head>$/i, `${themeLink}\n  </head>`);

      return html.replace(head, reorderedHead);
    },
  };
}

export default defineConfig({
  root: "app",
  plugins: [react(), ensureThemeDataStylesheetOrder(), emitVersionJson()],
  define: {
    __BUILD_VERSION__: JSON.stringify(buildVersion),
  },
  resolve: {
    alias: {
      "@fusion/core": resolve(__dirname, "../core/src/types.ts"),
      "@fusion/dashboard/app/components/TaskCard": resolve(__dirname, "app/components/TaskCard.tsx"),
      "@fusion/dashboard/app/plugins/types": resolve(__dirname, "app/plugins/types.ts"),
      "@fusion/dashboard/app/utils/projectStorage": resolve(__dirname, "app/utils/projectStorage.ts"),
      "@fusion/dashboard/app/utils/taskStuck": resolve(__dirname, "app/utils/taskStuck.ts"),
      "@fusion-plugin-examples/dependency-graph/dashboard-view": resolve(
        __dirname,
        "../../plugins/fusion-plugin-dependency-graph/src/dashboard-view.tsx",
      ),
      "@fusion-plugin-examples/dependency-graph": resolve(
        __dirname,
        "../../plugins/fusion-plugin-dependency-graph/src/index.ts",
      ),
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
    manifest: true,
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
