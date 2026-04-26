import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const buildVersion = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;

function emitVersionJson(): Plugin {
  return {
    name: "fusion-emit-version-json",
    apply: "build",
    closeBundle() {
      const outFile = resolve(__dirname, "dist/client/version.json");
      writeFileSync(outFile, `${JSON.stringify({ version: buildVersion })}\n`);
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
