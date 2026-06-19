import fs from "node:fs";
import { loadAllAppCss } from "../../test/cssFixture";
import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsModal } from "../SettingsModal";
import type { Settings } from "@fusion/core";


const defaultSettings = {
  maxConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 15_000,
  groupOverlappingFiles: false,
  autoMerge: true,
  mergeStrategy: "direct",
  directMergeCommitStrategy: "auto",
  pushAfterMerge: false,
  pushRemote: "origin",
  recycleWorktrees: false,
  worktreeInitCommand: "",
  testCommand: "",
  buildCommand: "",
  autoResolveConflicts: true,
  smartConflictResolution: true,
  modelPresets: [],
  autoSelectModelPreset: false,
  defaultPresetBySize: {},
  ntfyEnabled: false,
  ntfyTopic: undefined,
  ntfyEvents: ["in-review", "merged", "failed", "awaiting-approval", "awaiting-user-review", "fallback-used", "memory-dreams-processed", "oauth-token-expired"],
  webhookEnabled: false,
  webhookUrl: undefined,
  webhookFormat: undefined,
  webhookEvents: undefined,
  taskStuckTimeoutMs: undefined,
  maxStuckKills: 6,
  runStepsInNewSessions: false,
  maxParallelSteps: 2,
} as Settings;

vi.mock("../../api", () => ({
  fetchProjects: vi.fn(() => Promise.resolve([])),
  fetchGitRemotes: vi.fn(() => Promise.resolve({ remotes: [] })),
  fetchSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
  fetchSettingsByScope: vi.fn(() => Promise.resolve({ global: { ...defaultSettings }, project: {} })),
  updateSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
  updateGlobalSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
  fetchAuthStatus: vi.fn(() => Promise.resolve({ providers: [{ id: "anthropic", name: "Anthropic", authenticated: false }] })),
  loginProvider: vi.fn(() => Promise.resolve({ url: "https://auth.example.com/login" })),
  logoutProvider: vi.fn(() => Promise.resolve({ success: true })),
  saveApiKey: vi.fn(() => Promise.resolve({ success: true })),
  clearApiKey: vi.fn(() => Promise.resolve({ success: true })),
  fetchModels: vi.fn(() => Promise.resolve({ models: [], favoriteProviders: [], favoriteModels: [] })),
  fetchCustomProviders: vi.fn(() => Promise.resolve({ providers: [] })),
  createCustomProvider: vi.fn(() => Promise.resolve({ provider: {} })),
  updateCustomProvider: vi.fn(() => Promise.resolve({ provider: {} })),
  deleteCustomProvider: vi.fn(() => Promise.resolve(undefined)),
  testNtfyNotification: vi.fn(() => Promise.resolve({ success: true })),
  testNotification: vi.fn(() => Promise.resolve({ success: true })),
  fetchBackups: vi.fn(() => Promise.resolve({ count: 0, totalSize: 0, backups: [] })),
  createBackup: vi.fn(() => Promise.resolve({ success: true })),
  exportSettings: vi.fn(() => Promise.resolve({ version: 1, exportedAt: new Date().toISOString(), global: undefined, project: {} })),
  importSettings: vi.fn(() => Promise.resolve({ success: true, globalCount: 0, projectCount: 0 })),
  fetchMemoryFiles: vi.fn(() => Promise.resolve({
    files: [
      {
        path: ".fusion/memory/DREAMS.md",
        label: "Dreams",
        layer: "dreams",
        size: 0,
        updatedAt: "2026-04-17T12:00:00.000Z",
      },
      {
        path: ".fusion/memory/MEMORY.md",
        label: "Long-term memory",
        layer: "long-term",
        size: 0,
        updatedAt: "2026-04-17T12:00:00.000Z",
      },
    ],
  })),
  fetchMemoryFile: vi.fn((path = ".fusion/memory/DREAMS.md") => Promise.resolve({ path, content: "" })),
  saveMemoryFile: vi.fn(() => Promise.resolve({ success: true })),
  installQmd: vi.fn(() => Promise.resolve({ success: true, qmdAvailable: true, qmdInstallCommand: "bun install -g @tobilu/qmd" })),
  testMemoryRetrieval: vi.fn(() => Promise.resolve({
    query: "project memory",
    qmdAvailable: true,
    usedFallback: false,
    qmdInstallCommand: "bun install -g @tobilu/qmd",
    results: [],
  })),
  fetchGlobalConcurrency: vi.fn(() => Promise.resolve({ globalMaxConcurrent: 4, currentlyActive: 0, queuedCount: 0, projectsActive: {} })),
  updateGlobalConcurrency: vi.fn(() => Promise.resolve({ globalMaxConcurrent: 4, currentlyActive: 0, queuedCount: 0, projectsActive: {} })),
  fetchMemoryBackendStatus: vi.fn(() => Promise.resolve({
    currentBackend: "file",
    capabilities: {
      readable: true,
      writable: true,
      supportsAtomicWrite: true,
      hasConflictResolution: false,
      persistent: true,
    },
    availableBackends: ["file", "readonly", "qmd"],
    qmdAvailable: true,
    qmdInstallCommand: "bun install -g @tobilu/qmd",
  })),
  fetchDashboardHealth: vi.fn(() => Promise.resolve({ status: "ok", version: "1.2.3", uptime: 120 })),
  checkForUpdates: vi.fn(() => Promise.resolve({ currentVersion: "1.0.0", latestVersion: "2.0.0", updateAvailable: true })),
  installUpdate: vi.fn(() => Promise.resolve({ currentVersion: "1.0.0", latestVersion: "2.0.0", updated: true })),
  fetchGlobalSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
  // SettingsModal renders ProjectDefaultWorkflowField → WorkflowSelector, which loads these on mount.
  fetchWorkflows: vi.fn(() => Promise.resolve([])),
  fetchProjectDefaultWorkflow: vi.fn(() => Promise.resolve({ workflowId: null })),
  setProjectDefaultWorkflow: vi.fn(() => Promise.resolve({ workflowId: null })),
}));

vi.mock("../../hooks/useMemoryBackendStatus", () => ({
  useMemoryBackendStatus: vi.fn(() => ({
    status: {
      currentBackend: "qmd",
      capabilities: {
        readable: true,
        writable: true,
        supportsAtomicWrite: false,
        hasConflictResolution: false,
        persistent: true,
      },
      availableBackends: ["file", "readonly", "qmd"],
      qmdAvailable: true,
      qmdInstallCommand: "bun install -g @tobilu/qmd",
    },
    currentBackend: "file",
    capabilities: {
      readable: true,
      writable: true,
      supportsAtomicWrite: true,
      hasConflictResolution: false,
      persistent: true,
    },
    availableBackends: ["file", "readonly", "qmd"],
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

import { fetchSettings } from "../../api";

function mockSettingsViewport(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectMobileRule(css: string, selector: string, declaration: string): void {
  const pattern = new RegExp(
    `@media[^{]*\\(max-width:\\s*768px\\)[^{]*\\{[\\s\\S]*?${escapeRegExp(selector)}\\s*\\{[\\s\\S]*?${escapeRegExp(declaration)}`,
  );
  expect(pattern.test(css)).toBe(true);
}

function expectBaseRule(css: string, selector: string, declaration: string): void {
  const pattern = new RegExp(
    `${escapeRegExp(selector)}\\s*\\{[^}]*${escapeRegExp(declaration)}`,
  );
  expect(pattern.test(css)).toBe(true);
}

describe("SettingsModal mobile adaptations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettingsViewport(false);
  });

  it("renders mobile-targeted settings layout classes", async () => {
    const { container } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    expect(container.querySelector(".settings-layout")).toBeTruthy();
    expect(container.querySelector(".settings-sidebar")).toBeTruthy();
    expect(container.querySelector(".settings-content")).toBeTruthy();
  });

  it("renders the app version label in mobile layout", async () => {
    mockSettingsViewport(true);
    const { findByText, container } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const version = await findByText("Version 1.2.3");
    const modalActions = container.querySelector(".modal-actions");
    const modalHeader = container.querySelector(".modal-header");

    expect(version).toBeTruthy();
    expect(modalActions?.contains(version)).toBe(true);
    expect(modalHeader?.contains(version)).toBe(false);
  });

  it("keeps update-check button clickable from the footer", async () => {
    mockSettingsViewport(true);
    const user = userEvent.setup();
    const { container } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const modalActions = container.querySelector(".modal-actions");
    expect(modalActions).toBeTruthy();

    const updateButton = within(modalActions as HTMLElement).getByRole("button", { name: "Check for updates" });
    await user.click(updateButton);

    expect(updateButton).toBeTruthy();
  });

  it("keeps update-now button reachable from the mobile footer", async () => {
    mockSettingsViewport(true);
    const user = userEvent.setup();
    const { container, findByRole, findByText } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const modalActions = container.querySelector(".modal-actions");
    expect(modalActions).toBeTruthy();

    await user.click(within(modalActions as HTMLElement).getByRole("button", { name: "Check for updates" }));
    const updateNow = await findByRole("button", { name: "Update now" });
    expect((modalActions as HTMLElement).contains(updateNow)).toBe(true);

    await user.click(updateNow);
    expect(await findByText("Updated to v2.0.0 — restart Fusion to apply")).toBeTruthy();
  });

  it("excludes research sections from mobile picker when researchView is disabled", async () => {
    mockSettingsViewport(true);
    const user = userEvent.setup();
    const { getByLabelText } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const picker = getByLabelText("Settings Section") as HTMLSelectElement;
    expect(Array.from(picker.options).map((opt) => opt.value)).not.toContain("research-global");
    expect(Array.from(picker.options).map((opt) => opt.value)).not.toContain("research-project");

    await user.selectOptions(picker, "memory");
    expect((picker as HTMLSelectElement).value).toBe("memory");
  });

  it("includes research sections in mobile picker when researchView is enabled", async () => {
    vi.mocked(fetchSettings).mockResolvedValueOnce({
      ...defaultSettings,
      experimentalFeatures: { researchView: true },
    });

    mockSettingsViewport(true);
    const { getByLabelText } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const picker = getByLabelText("Settings Section") as HTMLSelectElement;
    const optionValues = Array.from(picker.options).map((opt) => opt.value);
    expect(optionValues).toContain("research-global");
    expect(optionValues).toContain("research-project");
  });

  it("can open memory settings from the mobile section picker", async () => {
    mockSettingsViewport(true);
    const user = userEvent.setup();
    const { getByLabelText, findByText } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    await user.selectOptions(getByLabelText("Settings Section"), "memory");

    expect(await findByText(/Memory lives in/)).toBeTruthy();
    expect(getByLabelText("Memory File")).toBeTruthy();
  });

  it("keeps research settings controls inside mobile containment wrappers", async () => {
    vi.mocked(fetchSettings).mockResolvedValueOnce({
      ...defaultSettings,
      experimentalFeatures: { researchView: true },
    });

    mockSettingsViewport(true);
    const user = userEvent.setup();
    const { getByLabelText } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const picker = getByLabelText("Settings Section");
    await user.selectOptions(picker, "research-global");

    const details = await within(document.body).findByText(/Advanced — external search providers/i);
    await user.click(details);

    const advancedPanel = document.querySelector(".settings-research-provider-advanced-body");
    expect(advancedPanel).toBeTruthy();
    expect(document.querySelector(".settings-research-provider-advanced-details")).toBeTruthy();
    expect(document.querySelector(".settings-research-limits-grid")).toBeTruthy();
    expect(document.querySelector(".settings-research-source-grid")).toBeTruthy();

    await user.selectOptions(picker, "research-project");

    const maxConcurrent = await within(document.body).findByLabelText("Max Concurrent Runs");
    expect(maxConcurrent).toHaveClass("input");
    expect(document.querySelectorAll(".settings-research-limit-field").length).toBeGreaterThan(0);

    const projectLimitsGrid = maxConcurrent.closest(".settings-research-limits-grid");
    expect(projectLimitsGrid).toBeTruthy();
    expect(within(document.body).getByLabelText("Max Sources Per Run").closest(".settings-research-limits-grid")).toBe(projectLimitsGrid);
    expect(within(document.body).getByLabelText("Max Duration (ms)").closest(".settings-research-limits-grid")).toBe(projectLimitsGrid);
    expect(within(document.body).getByLabelText("Request Timeout (ms)").closest(".settings-research-limits-grid")).toBe(projectLimitsGrid);

    const projectSourceGrid = within(document.body).getByRole("checkbox", { name: "Page Fetch" }).closest(".settings-research-source-grid");
    expect(projectSourceGrid).toBeTruthy();
    expect(within(document.body).getByRole("checkbox", { name: "GitHub" }).closest(".settings-research-source-grid")).toBe(projectSourceGrid);
    expect(within(document.body).getByRole("checkbox", { name: "Local Docs" }).closest(".settings-research-source-grid")).toBe(projectSourceGrid);
    expect(within(document.body).getByRole("checkbox", { name: "LLM Synthesis" }).closest(".settings-research-source-grid")).toBe(projectSourceGrid);
  });

  it("renders settings nav items with active class for touch styling", async () => {
    const { container } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const navItems = container.querySelectorAll(".settings-nav-item");
    expect(navItems.length).toBeGreaterThan(0);
    expect(container.querySelector(".settings-nav-item.active")).toBeTruthy();
  });

  it("renders form controls inside settings-content for 16px mobile targeting", async () => {
    const user = userEvent.setup();
    const { container, findAllByText } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Authentication is first by default, so click General to see form controls
    const generalTabs = await findAllByText("General");
    await user.click(generalTabs[0]);

    const controls = container.querySelectorAll(".settings-content input, .settings-content select, .settings-content textarea");
    expect(controls.length).toBeGreaterThan(0);
  });

  it("shows scope indicators and updates scope banner across sections", async () => {
    const user = userEvent.setup();
    const { container, getByText, getAllByText } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Authentication is first with no scope banner by default - click the Project-scoped General section
    expect(container.querySelectorAll(".settings-scope-icon").length).toBeGreaterThan(0);
    await user.click(getByText("Project General"));

    // Verify project scope banner contains icon elements (SVG from Lucide, not emoji)
    const projectBanner = container.querySelector(".settings-scope-project");
    expect(projectBanner).toBeTruthy();
    const projectBannerIcon = projectBanner!.querySelector(".settings-scope-icon svg");
    expect(projectBannerIcon).toBeTruthy();
    expect(getByText("These settings only affect this project.")).toBeTruthy();

    await user.click(getByText("Appearance"));

    // Verify global scope banner contains icon elements (SVG from Lucide, not emoji)
    const globalBanner = container.querySelector(".settings-scope-global");
    expect(globalBanner).toBeTruthy();
    const globalBannerIcon = globalBanner!.querySelector(".settings-scope-icon svg");
    expect(globalBannerIcon).toBeTruthy();
    expect(getByText("These settings are shared across all your Fusion projects.")).toBeTruthy();
  });

  it("renders notification provider cards responsively on mobile", async () => {
    mockSettingsViewport(true);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    const user = userEvent.setup();
    const { getByLabelText, findByText, container } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    await user.selectOptions(getByLabelText("Settings Section"), "notifications");

    expect(await findByText("ntfy")).toBeTruthy();
    expect(await findByText("Webhook")).toBeTruthy();
    expect(container.querySelectorAll(".notification-provider-card").length).toBeGreaterThan(1);
  });

  it("contains required mobile settings CSS overrides", () => {
    const css = loadAllAppCss();

    expectMobileRule(css, ".settings-layout", "flex-direction: column;");
    expectMobileRule(css, ".settings-mobile-section-picker", "display: flex;");
    expectMobileRule(css, ".settings-sidebar", "display: none;");
    expectMobileRule(css, ".settings-nav-item", "display: flex;");
    expectMobileRule(css, ".settings-nav-item", "align-items: center;");
    expectMobileRule(css, ".settings-nav-item", "justify-content: center;");
    expectMobileRule(css, ".settings-nav-item", "gap: 4px;");
    expectMobileRule(css, ".settings-content textarea", "font-size: 16px;");
    expectMobileRule(css, ".settings-section-heading", "padding: var(--space-lg) 0 var(--space-md);");
    expectMobileRule(css, ".settings-section-heading", "margin: 0;");
    expectMobileRule(css, ".settings-scope-icon", "margin-right: 0;");
    expectMobileRule(css, ".settings-scope-banner", "padding: var(--space-sm) var(--space-lg);");
    expectMobileRule(css, ".settings-empty-state", "padding: 12px 14px;");
    expectMobileRule(css, ".settings-description", "padding: 0 var(--space-lg);");
    expectMobileRule(css, ".theme-selector", "padding: 0 14px 14px;");
    expectMobileRule(css, ".settings-preset-item", "flex-direction: column;");
    expectMobileRule(css, ".settings-preset-item-actions", "justify-content: flex-start;");
    expectMobileRule(css, ".settings-preset-size-grid", "grid-template-columns: 1fr;");
    expectMobileRule(css, ".auth-provider-header > div:not(.auth-provider-info):not(.auth-apikey-section)", "margin-left: auto;");
    expectMobileRule(css, ".auth-apikey-section", "align-items: flex-end;");
    expectMobileRule(css, ".auth-apikey-input-row", "justify-content: flex-end;");
    expectMobileRule(css, ".auth-apikey-input-row .btn", "margin-left: auto;");
    expectMobileRule(css, ".notification-provider-header", "padding: var(--space-sm) var(--space-md);");
    expectMobileRule(css, ".notification-provider-body", "padding: var(--space-md);");

    // Remote Access header elements must use the same mobile gutter as other remote blocks
    expectMobileRule(css, ".remote-status-bar", "margin: 0 var(--space-lg) var(--space-md);");
    expectMobileRule(css, ".remote-share-block", "margin: 0 var(--space-lg) var(--space-md);");
    expectMobileRule(css, ".settings-research-provider-advanced-details", "padding-inline-start: 0;");
    expectMobileRule(css, ".settings-research-source-grid", "grid-template-columns: 1fr;");
    expectMobileRule(css, ".settings-research-limits-grid", "grid-template-columns: 1fr;");

    // Base rules: desktop uses --space-xl horizontal margin for remote header elements
    expectBaseRule(css, ".remote-status-bar", "margin: 0 var(--space-xl) var(--space-md);");
    expectBaseRule(css, ".remote-share-block", "margin: 0 var(--space-xl) var(--space-md);");
    expectBaseRule(css, ".settings-research-provider-advanced-details", "padding-inline-start: var(--space-md);");
    expectBaseRule(css, ".settings-research-provider-advanced-body > .form-group", "padding: 0;");
    expectBaseRule(css, ".settings-research-limits-grid", "min-width: 0;");

    // Settings header actions keep compact controls on a shared height contract on desktop; mobile inherits this height (FN-4354 reverted prior mobile inflation).
    expectBaseRule(css, ".settings-header-actions", "--settings-header-action-height: calc(var(--space-md) * 2 + var(--space-xs) / 2);");
    expectBaseRule(css, ".settings-header-actions > .settings-header-discord-btn", "height: var(--settings-header-action-height);");
  });

  it("FN-4354: settings header actions and modal-close have no mobile touch-target inflation", () => {
    const css = loadAllAppCss();

    // FN-4354 regression guard: mobile settings header no longer inflates compact toolbar controls.
    const mobileBlockMatch = css.match(/@media[^{]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.settings-modal \.modal-close\s*\{[\s\S]*?\}/);
    const mobileBlock = mobileBlockMatch?.[0] ?? "";

    expect(css.includes("--settings-header-action-height: calc(var(--space-md) * 3)")).toBe(false);
    expect(css.includes("min-height: var(--settings-header-action-height)")).toBe(false);
    expect(/\.settings-header-actions\s*>\s*\.btn-icon\s*\{[\s\S]*?min-width:\s*calc\(var\(--space-md\)\s*\*\s*3\)/.test(css)).toBe(false);
    expect(/\.settings-modal \.modal-close\s*\{[^}]*min-height:/.test(mobileBlock)).toBe(false);
    expect(/\.settings-modal \.modal-close\s*\{[^}]*min-width:/.test(mobileBlock)).toBe(false);

    expectBaseRule(css, ".settings-header-actions", "--settings-header-action-height: calc(var(--space-md) * 2 + var(--space-xs) / 2);");
  });

  it("styles settings scrollbar rules for sidebar and content", () => {
    const css = loadAllAppCss();

    expectBaseRule(css, ".settings-sidebar", "scrollbar-color: var(--border) transparent;");
    expectBaseRule(css, ".settings-sidebar", "scrollbar-width: thin;");
    expectBaseRule(css, ".settings-sidebar::-webkit-scrollbar", "width: 6px;");
    expectBaseRule(css, ".settings-sidebar::-webkit-scrollbar-thumb", "background: var(--border);");
    expectBaseRule(css, ".settings-sidebar::-webkit-scrollbar-thumb:hover", "background: var(--text-muted);");

    expectBaseRule(css, ".settings-content", "scrollbar-color: var(--border) transparent;");
    expectBaseRule(css, ".settings-content", "scrollbar-width: thin;");
    expectBaseRule(css, ".settings-content::-webkit-scrollbar", "width: 6px;");
    expectBaseRule(css, ".settings-content::-webkit-scrollbar-thumb", "background: var(--border);");
    expectBaseRule(css, ".settings-content::-webkit-scrollbar-thumb:hover", "background: var(--text-muted);");

    expectBaseRule(css, ".settings-section-heading", "padding: var(--space-lg) 0 var(--space-md);");
    expectBaseRule(css, ".settings-section-heading", "margin: 0;");
    expectBaseRule(css, ".settings-section-heading", "border-bottom: 1px solid var(--border);");
  });
});
