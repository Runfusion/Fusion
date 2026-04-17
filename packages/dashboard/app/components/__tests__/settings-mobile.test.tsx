import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsModal } from "../SettingsModal";
import type { Settings } from "@fusion/core";

const stylesPath = path.resolve(__dirname, "../../styles.css");

const defaultSettings = {
  maxConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 15_000,
  groupOverlappingFiles: false,
  autoMerge: true,
  mergeStrategy: "direct",
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
  ntfyEvents: ["in-review", "merged", "failed", "awaiting-approval", "awaiting-user-review"],
  taskStuckTimeoutMs: undefined,
  maxStuckKills: 6,
  runStepsInNewSessions: false,
  maxParallelSteps: 2,
} as Settings;

vi.mock("../../api", () => ({
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
  testNtfyNotification: vi.fn(() => Promise.resolve({ success: true })),
  fetchBackups: vi.fn(() => Promise.resolve({ count: 0, totalSize: 0, backups: [] })),
  createBackup: vi.fn(() => Promise.resolve({ success: true })),
  exportSettings: vi.fn(() => Promise.resolve({ version: 1, exportedAt: new Date().toISOString(), global: undefined, project: {} })),
  importSettings: vi.fn(() => Promise.resolve({ success: true, globalCount: 0, projectCount: 0 })),
  fetchMemoryFiles: vi.fn(() => Promise.resolve({
    files: [
      {
        path: ".fusion/memory/MEMORY.md",
        label: "Long-term memory",
        layer: "long-term",
        size: 0,
        updatedAt: "2026-04-17T12:00:00.000Z",
      },
    ],
  })),
  fetchMemoryFile: vi.fn(() => Promise.resolve({ path: ".fusion/memory/MEMORY.md", content: "" })),
  saveMemoryFile: vi.fn(() => Promise.resolve({ success: true })),
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
  })),
}));

vi.mock("../../hooks/useMemoryBackendStatus", () => ({
  useMemoryBackendStatus: vi.fn(() => ({
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectMobileRule(css: string, selector: string, declaration: string): void {
  const pattern = new RegExp(
    `@media\\s*\\(max-width:\\s*768px\\)\\s*\\{[\\s\\S]*?${escapeRegExp(selector)}\\s*\\{[\\s\\S]*?${escapeRegExp(declaration)}`,
  );
  expect(pattern.test(css)).toBe(true);
}

describe("SettingsModal mobile adaptations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders mobile-targeted settings layout classes", async () => {
    const { container } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    expect(container.querySelector(".settings-layout")).toBeTruthy();
    expect(container.querySelector(".settings-sidebar")).toBeTruthy();
    expect(container.querySelector(".settings-content")).toBeTruthy();
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
    const { container, getByText } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Authentication is first by default, so click General to see form controls
    await user.click(getByText("General"));

    const controls = container.querySelectorAll(".settings-content input, .settings-content select, .settings-content textarea");
    expect(controls.length).toBeGreaterThan(0);
  });

  it("shows scope indicators and updates scope banner across sections", async () => {
    const user = userEvent.setup();
    const { container, getByText, getAllByText } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Authentication is first with no scope banner by default - click General to see project scope
    expect(container.querySelectorAll(".settings-scope-icon").length).toBeGreaterThan(0);
    await user.click(getAllByText("General")[0]);

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

  it("contains required mobile settings CSS overrides", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");

    expectMobileRule(css, ".settings-layout", "flex-direction: column;");
    expectMobileRule(css, ".settings-sidebar", "flex-direction: row;");
    expectMobileRule(css, ".settings-sidebar", "align-items: center;");
    expectMobileRule(css, ".settings-sidebar", "overflow-x: auto;");
    expectMobileRule(css, ".settings-sidebar", "scrollbar-width: none;");
    expectMobileRule(css, ".settings-sidebar::-webkit-scrollbar", "display: none;");
    expectMobileRule(css, ".settings-nav-item", "display: flex;");
    expectMobileRule(css, ".settings-nav-item", "align-items: center;");
    expectMobileRule(css, ".settings-nav-item", "justify-content: center;");
    expectMobileRule(css, ".settings-nav-item", "gap: 4px;");
    expectMobileRule(css, ".settings-content textarea", "font-size: 16px;");
    expectMobileRule(css, ".settings-scope-icon", "margin-right: 0;");
    expectMobileRule(css, ".settings-scope-banner", "padding: 8px 14px;");
    expectMobileRule(css, ".settings-empty-state", "padding: 12px 14px;");
    expectMobileRule(css, ".settings-description", "padding: 0 14px;");
    expectMobileRule(css, ".theme-selector", "padding: 0 14px 14px;");
  });
});
