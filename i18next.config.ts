import {
  defineConfig,
  recommendedAcceptedAttributes,
  recommendedAcceptedTags,
} from "i18next-cli";


const DEFERRED_I18N_LINT_FILES = [
  // FNXC:i18n-LintBaseline 2026-06-19-00:00:
  // These exact files still carry pre-existing user-facing copy debt after FN-6749 restored the guardrail scope and token suppression.
  // Keep the deferral file-scoped and remove entries as those follow-ups localize each cluster.
  // FNXC:i18n-LintBaseline 2026-06-20-00:00:
  // FN-6771 localized the settings/sections cluster, so those files are no longer deferred and must stay covered by i18n lint.
  "packages/dashboard/app/components/WorkflowSelector.tsx",
  "packages/dashboard/app/components/WorkflowResultsTab.tsx",
  "packages/dashboard/app/components/WorkflowNodeEditor.tsx",
  "packages/dashboard/app/components/TaskDetailModal.tsx",
  "packages/dashboard/app/components/TaskComments.tsx",
  "packages/dashboard/app/components/TaskChatTab.tsx",
  "packages/dashboard/app/components/SetupWizardModal.tsx",
  "packages/dashboard/app/components/SettingsModal.tsx",
  "packages/dashboard/app/components/PullRequestView.tsx",
  "packages/dashboard/app/components/PrPanel.tsx",
  "packages/dashboard/app/components/PrCreateModal.tsx",
  "packages/dashboard/app/components/Board.tsx",
] as const;

/**
 * i18next-cli workflow config for the whole monorepo.
 *
 * - `extract` pulls t()/<Trans> keys from the dashboard and CLI source into the
 *   authored `en` catalogs under @fusion/i18n.
 * - `sync` propagates the `en` key structure to the secondary locales.
 * - `types` regenerates key types from the `en` catalogs.
 * - `status` runs the project key-parity gate: structure only, empty values allowed.
 * - `status:report` preserves the upstream translation-completeness report.
 * - `lint` flags hardcoded user-facing strings (primary guardrail).
 *
 * FNXC:i18n-ParityGate 2026-06-20-00:00:
 * `pnpm i18n:status` points at packages/i18n/scripts/check-i18n-parity.mjs because empty secondary-locale values are intentional fallback placeholders, not gate failures.
 * Use `pnpm i18n:status:report` when a human wants the upstream completeness report that still counts empty placeholders as untranslated.
 *
 * Namespaces are routed by the `ns:` prefix in keys / `useTranslation(ns)` in
 * source, not by file path. `common` is the default namespace.
 */
export default defineConfig({
  locales: ["en", "zh-CN", "zh-TW", "fr", "es", "ko"],
  extract: {
    input: [
      "packages/dashboard/app/**/*.{ts,tsx}",
      "packages/cli/src/**/*.{ts,tsx}",
      "!**/__tests__/**",
      "!**/*.test.*",
    ],
    output: "packages/i18n/locales/{{language}}/{{namespace}}.json",
    primaryLanguage: "en",
    defaultNS: "common",
    keySeparator: ".",
    nsSeparator: ":",
    // FNXC:i18n-ParityGate 2026-06-20-00:00:
    // Untranslated secondary-locale keys stay empty for runtime fallback to `en`; `status` now gates structural key parity only, while `status:report` measures real completion.
    defaultValue: "",
  },
  types: {
    input: ["packages/i18n/locales/en/*.json"],
    output: "packages/i18n/src/i18next-resources.d.ts",
  },
  lint: {
    /*
     * FNXC:i18n-LintBaseline 2026-06-19-00:00:
     * i18n lint must scan the same shipping surfaces as extract so it remains a trusted user-facing-copy guardrail.
     * Tests and stories are excluded because they are non-shipping fixtures and extract already excludes test files.
     * Keyboard-key glyphs inside <kbd> are technical tokens, not translated prose.
     */
    ignore: ["**/__tests__/**", "**/*.test.*", "**/*.stories.*", ...DEFERRED_I18N_LINT_FILES],
    ignoredTags: ["kbd"],
    acceptedTags: recommendedAcceptedTags,
    acceptedAttributes: recommendedAcceptedAttributes,
  },
});
