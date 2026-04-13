import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Base ESLint recommended rules
  eslint.configs.recommended,

  // TypeScript-eslint configuration
  ...tseslint.configs.recommended,

  // TypeScript files in packages
  {
    files: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", {
        vars: "all",
        args: "after-used",
        ignoreRestSiblings: true,
        varsIgnorePattern: "^_",
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
    ignores: [
      // Test files
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/__tests__/**",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      // Generated files
      "**/*.gen.ts",
      "**/*.gen.tsx",
      // Build artifacts
      "**/dist/**",
      "**/out/**",
      "**/build/**",
    ],
  },

  // Root-level config files and scripts
  {
    files: [
      "*.mjs",
      "*.cjs",
      "*.js",
      "scripts/**/*.js",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    ignores: [
      "**/dist/**",
      "**/out/**",
      "**/build/**",
      "node_modules/**",
    ],
  },

  // Ignore patterns for all configs
  {
    ignores: [
      "node_modules/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/build/**",
      "coverage/**",
      ".fusion/**",
      ".worktrees/**",
      "*.lock",
      "pnpm-lock.yaml",
      ".git/**",
      "*.log",
    ],
  },
);
