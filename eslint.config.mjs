import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ESLint Flat Config for Fusion Workspace
 * 
 * Configuration hierarchy (order matters for flat configs):
 * 1. Global ignores — files never linted (must come first)
 * 2. Base recommendations — eslint/recommended + typescript-eslint/recommended
 * 3. Context-specific overrides — production, test-support, node, sw, etc.
 * 
 * Key scoping decisions:
 * - Global ignores come first to prevent base configs from processing excluded files
 * - Test support files use relaxed rules (no-explicit-any off) without blanket-ignoring them
 * - Node scripts get proper Node globals (process, console, require, etc.)
 * - Service worker gets browser SW globals (self, caches, fetch, etc.)
 * - Production source keeps @typescript-eslint/no-explicit-any as warning
 */
export default tseslint.config(
  // ─────────────────────────────────────────────────────────────
  // GLOBAL IGNORES FIRST
  // (per memory guidance: must come before recommended configs)
  // ─────────────────────────────────────────────────────────────
  {
    ignores: [
      // Node modules and build artifacts
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/build/**",
      "coverage/**",
      // Project metadata (fn data, worktrees, etc.)
      ".fusion/**",
      ".worktrees/**",
      // Lock files
      "*.lock",
      "pnpm-lock.yaml",
      // Git internals
      ".git/**",
      // Logs
      "*.log",
      // All test files matching standard patterns — never linted
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/__tests__/**",
      // Dashboard test support directory — test helpers, not production code
      "packages/dashboard/app/test/**",
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // BASE RECOMMENDATIONS
  // ─────────────────────────────────────────────────────────────
  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  // ─────────────────────────────────────────────────────────────
  // TEST SUPPORT FILES — relaxed rules for vitest setup/config
  // (runs BEFORE production config to disable no-explicit-any for test helpers)
  // ─────────────────────────────────────────────────────────────
  {
    // Dashboard vitest.setup.ts — test infrastructure, not production source
    // Includes mock factories, vi.fn() signatures, etc. that legitimately use `any`
    files: [
      "packages/dashboard/vitest.setup.ts",
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
      // Test setup files commonly use `any` for mock types and event handlers
      "@typescript-eslint/no-explicit-any": "off",
      // Allow unused vars in test setup (globals, config, etc.)
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": "off",
      // Allow empty blocks in test setup
      "no-empty": "off",
    },
  },

  // ─────────────────────────────────────────────────────────────
  // PRODUCTION TYPESCRIPT FILES — strict rules with project conventions
  // Enforces @typescript-eslint/no-explicit-any for production source
  // ─────────────────────────────────────────────────────────────
  {
    files: [
      "packages/*/src/**/*.ts",
      "packages/*/src/**/*.tsx",
      "packages/dashboard/app/**/*.ts",
      "packages/dashboard/app/**/*.tsx",
      "packages/dashboard/src/**/*.ts",
      "packages/dashboard/src/**/*.tsx",
      // NOTE: vitest.setup.ts is excluded here (handled by test-support block above)
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
      // Ratcheted from warn → error once the codebase was clean.
      // Use `_`-prefix to intentionally declare an unused binding.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          vars: "all",
          args: "after-used",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Keep no-explicit-any as WARN for production source
      // (use @ts-expect-error or proper types when possible)
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
  // NODE SCRIPTS — proper Node.js globals
  // (scripts/dev-with-memory.mjs, fix.cjs, etc.)
  // ─────────────────────────────────────────────────────────────
  {
    files: [
      "scripts/**/*.js",
      "scripts/**/*.mjs",
      "**/*.cjs",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        // Node.js core globals
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
      // Allow console in scripts (dev tooling)
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
  // PLUGIN EXAMPLES — relaxed rules for plugin development
  // ─────────────────────────────────────────────────────────────
  {
    files: ["plugins/**/*.ts", "plugins/**/*.tsx"],
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
      // Allow explicit any for mocks
      "@typescript-eslint/no-explicit-any": "off",
      // Allow unused vars in tests
      "@typescript-eslint/no-unused-vars": "off",
      // Allow unsafe function types
      "@typescript-eslint/no-unsafe-function-type": "off",
      // Allow prefer-const
      "prefer-const": "off",
      // Allow fallthrough
      "no-fallthrough": "off",
      // Allow useless escape
      "no-useless-escape": "off",
    },
  },

  // ─────────────────────────────────────────────────────────────
  // AGENT SKILL TEMPLATES — template code with underscore prefix support
  // (agent prompt templates use _prefixed placeholders intentionally)
  // ─────────────────────────────────────────────────────────────
  {
    files: [".pi/agent/skills/**/*.ts", ".pi/agent/skills/**/*.tsx"],
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
      // Allow unused vars with underscore prefix (intentional placeholder pattern)
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          vars: "all",
          args: "after-used",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Allow explicit any in templates
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // ─────────────────────────────────────────────────────────────
  // ROOT-LEVEL MJS FILES — common JS/ESM patterns at project root
  // ─────────────────────────────────────────────────────────────
  {
    files: ["*.mjs", "*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        // Common ESM globals
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
  // (packages/dashboard/app/public/sw.js uses self, caches, fetch, etc.)
  // ─────────────────────────────────────────────────────────────
  {
    files: ["**/sw.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        // Service worker globals
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
