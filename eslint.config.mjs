import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // ─────────────────────────────────────────────────────────────
  // GLOBAL IGNORES FIRST (per memory guidance)
  // ─────────────────────────────────────────────────────────────
  {
    ignores: [
      // Node modules and build artifacts
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/build/**",
      "coverage/**",
      // Project metadata
      ".fusion/**",
      ".worktrees/**",
      // Lock files
      "*.lock",
      "pnpm-lock.yaml",
      // Git internals
      ".git/**",
      // Logs
      "*.log",
      // All test files - ignore them from all linting
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/__tests__/**",
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // BASE RECOMMENDATIONS
  // ─────────────────────────────────────────────────────────────
  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  // ─────────────────────────────────────────────────────────────
  // PRODUCTION TYPESCRIPT FILES — strict rules with project conventions
  // ─────────────────────────────────────────────────────────────
  {
    files: [
      "packages/*/src/**/*.ts",
      "packages/*/src/**/*.tsx",
      "packages/dashboard/app/**/*.ts",
      "packages/dashboard/app/**/*.tsx",
      "packages/dashboard/src/**/*.ts",
      "packages/dashboard/src/**/*.tsx",
      "packages/dashboard/vitest.setup.ts",
      // Plugin example source files (e.g. fusion-plugin-auto-label, fusion-plugin-ci-status)
      // follow the same production TypeScript rules as packages/* to ensure consistency
      // with project conventions (argsIgnorePattern for underscore params, etc.)
      "plugins/examples/*/src/**/*.ts",
      "plugins/examples/*/src/**/*.tsx",
      // Agent skill plugin templates — follow project conventions for underscore params
      ".pi/agent/skills/create-fusion-plugin/templates/**/*.ts",
    ],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",  // Warning for unused vars
        {
          vars: "all",
          args: "after-used",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Allow any in catch blocks and event emitter signatures
      "@typescript-eslint/no-explicit-any": ["warn", {
        "ignoreRestArgs": true,
      }],
      // Allow fallthrough with comment
      "no-fallthrough": ["warn", { "commentPattern": ".*fallthrough.*" }],
      // Allow useless escape
      "no-useless-escape": "warn",
      // Allow empty blocks
      "no-empty": "warn",
      // Allow case declarations
      "no-case-declarations": "warn",
      // Allow unused expressions (for intentional side effects)
      "@typescript-eslint/no-unused-expressions": "warn",
      // Allow empty object types
      "@typescript-eslint/no-empty-object-type": "warn",
      // Allow empty interface
      "@typescript-eslint/no-empty-interface": "warn",
      // Allow @ts-ignore comments
      "@typescript-eslint/ban-ts-comment": "warn",
      // Allow control regex
      "no-control-regex": "warn",
      // Allow prefer-const (warn instead of error)
      "prefer-const": "warn",
      // Allow useless catch
      "no-useless-catch": "warn",
    },
    ignores: ["**/*.gen.ts", "**/*.gen.tsx"],
  },

  // ─────────────────────────────────────────────────────────────
  // NODE SCRIPTS — proper node globals
  // ─────────────────────────────────────────────────────────────
  {
    files: [
      "scripts/**/*.js",
      "scripts/**/*.mjs",
      "*.cjs",
      "fix.cjs",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        globalThis: "readonly",
        require: "readonly",
        module: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        Buffer: "readonly",
      },
    },
    rules: {
      // Node scripts commonly use require()
      "@typescript-eslint/no-require-imports": "off",
      // Allow console in scripts
      "no-console": "off",
      // Allow unused vars in scripts (tooling often has them)
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },

  // ─────────────────────────────────────────────────────────────
  // DEMO FILES — tooling/linting noise, not production code
  // ─────────────────────────────────────────────────────────────
  {
    files: ["demo/**/*.ts"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      // Allow explicit any in demo files
      "@typescript-eslint/no-explicit-any": "off",
      // Allow unused vars in demo files
      "@typescript-eslint/no-unused-vars": "off",
      // Allow console in demo files
      "no-console": "off",
    },
  },

  // ─────────────────────────────────────────────────────────────
  // ROOT-LEVEL MJS FILES — common JS/ESM patterns
  // ─────────────────────────────────────────────────────────────
  {
    files: ["*.mjs", "*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        globalThis: "readonly",
      },
    },
    rules: {
      "no-console": "off",
      "no-unused-vars": "off",
    },
  },

  // ─────────────────────────────────────────────────────────────
  // SERVICE WORKER FILES — browser service worker globals
  // ─────────────────────────────────────────────────────────────
  {
    files: ["**/sw.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        self: "readonly",
        caches: "readonly",
        fetch: "readonly",
        console: "readonly",
        URL: "readonly",
        Promise: "readonly",
        Request: "readonly",
        Response: "readonly",
        Headers: "readonly",
        Cache: "readonly",
        CacheStorage: "readonly",
        ExtendableEvent: "readonly",
        FetchEvent: "readonly",
        Clients: "readonly",
        Client: "readonly",
        WindowClient: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "off",
      "no-console": "off",
    },
  },
);
