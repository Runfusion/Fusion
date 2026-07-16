import fs from "node:fs";
import { loadAllAppCss } from "../../test/cssFixture";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsModal, SettingsView } from "../SettingsModal";
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
  ntfyEvents: ["in-review", "merged", "failed", "awaiting-approval", "awaiting-user-review", "cli-agent-awaiting-input", "fallback-used", "memory-dreams-processed", "oauth-token-expired"],
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
  fetchGitRemotesDetailed: vi.fn(() => Promise.resolve([])),
  fetchGitBranches: vi.fn(() => Promise.resolve([])),
  fetchSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
  fetchSettingsByScope: vi.fn(() => Promise.resolve({ global: { ...defaultSettings }, project: {} })),
  updateSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
  updateGlobalSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
  fetchAuthStatus: vi.fn(() => Promise.resolve({ providers: [
    { id: "anthropic-subscription", name: "Anthropic Subscription", authenticated: false, type: "oauth" },
    { id: "anthropic-api-key", name: "Anthropic API Key", authenticated: false, type: "api_key" },
  ] })),
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
  fetchSystemInfo: vi.fn(() => Promise.resolve({ supervised: true, restartSupported: true })),
  requestSystemRestart: vi.fn(() => Promise.resolve({ scheduled: true })),
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

import { fetchDashboardHealth, fetchSettings, updateSettings } from "../../api";

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: hidden ? "hidden" : "visible" });
}

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

function getMobileMediaBlocks(css: string): string[] {
  const blocks: string[] = [];
  const mediaPattern = /@media[^{]*\(max-width:\s*768px\)[^{]*\{/g;
  let match: RegExpExecArray | null;

  while ((match = mediaPattern.exec(css)) !== null) {
    let depth = 0;
    let end = match.index;
    for (; end < css.length; end += 1) {
      if (css[end] === "{") depth += 1;
      if (css[end] === "}") depth -= 1;
      if (depth === 0 && end > match.index) {
        end += 1;
        break;
      }
    }
    blocks.push(css.slice(match.index, end));
    mediaPattern.lastIndex = end;
  }

  return blocks;
}

function expectNoMobileRule(css: string, selector: string, declaration: string): void {
  const pattern = new RegExp(
    `${escapeRegExp(selector)}\\s*\\{[^}]*${escapeRegExp(declaration)}`,
  );
  const offendingBlock = getMobileMediaBlocks(css).find((block) => pattern.test(block));
  expect(offendingBlock).toBeUndefined();
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
    setDocumentHidden(false);
    localStorage.removeItem("fusion_github_star_count");
    localStorage.removeItem("fusion:github-star-clicked");
    localStorage.setItem("fusion:settings:show-advanced", "true");
    mockSettingsViewport(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders mobile-targeted settings layout classes", async () => {
    const { container } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    expect(container.querySelector(".settings-layout")).toBeTruthy();
    expect(container.querySelector(".settings-sidebar")).toBeTruthy();
    expect(container.querySelector(".settings-content")).toBeTruthy();
  });

  /*
  FNXC:SettingsReset 2026-07-04-01:00:
  FN-7506 mobile surface coverage: the Reset Settings button and its confirmation
  dialog must be reachable and usable at the mobile breakpoint, with no horizontal
  overflow, mirroring the desktop assertions in SettingsModal.general.test.tsx.

  FNXC:SettingsReset 2026-07-12-00:00:
  FN-7880 mobile label coverage: the same footer affordance renders in modal and
  embedded SettingsView presentations, but only the mobile viewport shortens the
  visible label to Reset. Desktop and tablet keep Reset Settings.
  */
  it("renders and operates the compact Reset button/dialog at the mobile breakpoint", async () => {
    mockSettingsViewport(true);
    const { findByTestId, container } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const resetBtn = await findByTestId("settings-reset");
    expect(container.querySelector(".modal-actions")?.contains(resetBtn)).toBe(true);
    expect(resetBtn).toHaveTextContent(/^Reset$/);
    expect(resetBtn).not.toHaveTextContent("Reset Settings");

    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    await user.click(resetBtn);

    const dialog = await findByTestId("settings-reset-dialog");
    expect(dialog).toBeTruthy();
    expect(dialog.querySelector(".settings-reset-dialog")).toBeTruthy();
    expect(within(dialog).getByTestId("settings-reset-menu")).toBeTruthy();
    expect(within(dialog).getByTestId("settings-reset-all-project")).toBeTruthy();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("uses viewport-specific reset labels in modal and embedded footers", async () => {
    mockSettingsViewport(true);
    const mobileModal = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
    expect(await mobileModal.findByTestId("settings-reset")).toHaveTextContent(/^Reset$/);
    mobileModal.unmount();

    vi.clearAllMocks();
    mockSettingsViewport(true);
    const mobileEmbedded = render(<SettingsView onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
    expect(await mobileEmbedded.findByTestId("settings-reset")).toHaveTextContent(/^Reset$/);
    mobileEmbedded.unmount();

    vi.clearAllMocks();
    mockSettingsViewport(false);
    const desktopModal = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
    expect(await desktopModal.findByTestId("settings-reset")).toHaveTextContent(/^Reset Settings$/);
    desktopModal.unmount();

    vi.clearAllMocks();
    mockSettingsViewport(false);
    const desktopEmbedded = render(<SettingsView onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
    expect(await desktopEmbedded.findByTestId("settings-reset")).toHaveTextContent(/^Reset Settings$/);
  });

  it("renders the compact app version label in mobile layout", async () => {
    mockSettingsViewport(true);
    const { findByText, queryByText, container } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const version = await findByText("v1.2.3");
    const modalActions = container.querySelector(".modal-actions");
    const modalHeader = container.querySelector(".modal-header");

    expect(version).toBeTruthy();
    expect(queryByText("Version 1.2.3")).toBeNull();
    expect(modalActions?.contains(version)).toBe(true);
    expect(modalHeader?.contains(version)).toBe(false);
  });

  it("keeps the full app version label outside the mobile viewport", async () => {
    mockSettingsViewport(false);
    const { findByText, queryByText, container } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const version = await findByText("Version 1.2.3");
    expect(version).toBeTruthy();
    expect(queryByText("v1.2.3")).toBeNull();
    expect(container.querySelector(".modal-actions")?.contains(version)).toBe(true);
  });

  it("keeps update-check button clickable from the standalone and embedded mobile footers", async () => {
    mockSettingsViewport(true);
    const user = userEvent.setup();
    const standalone = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const standaloneActions = standalone.container.querySelector(".settings-modal:not(.settings-modal--embedded) .modal-actions");
    expect(standaloneActions).toBeTruthy();

    const standaloneUpdateButton = within(standaloneActions as HTMLElement).getByRole("button", { name: "Check for updates" });
    await user.click(standaloneUpdateButton);
    expect(standaloneUpdateButton.closest(".settings-modal-footer-version")).toBeTruthy();

    standalone.unmount();
    vi.clearAllMocks();

    const embedded = render(<SettingsView onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const embeddedActions = embedded.container.querySelector(".settings-modal--embedded .modal-actions");
    expect(embeddedActions).toBeTruthy();
    const embeddedUpdateButton = within(embeddedActions as HTMLElement).getByRole("button", { name: "Check for updates" });
    await user.click(embeddedUpdateButton);
    expect(embeddedUpdateButton.closest(".settings-modal-footer-version")).toBeTruthy();
  });

  it("omits the version button when appVersion is unavailable without removing the footer rail", async () => {
    vi.mocked(fetchDashboardHealth).mockResolvedValueOnce({ status: "ok", version: "", uptime: 120 });
    mockSettingsViewport(true);
    const { container, queryByRole } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
    await waitFor(() => expect(fetchDashboardHealth).toHaveBeenCalled());

    const modalActions = container.querySelector(".settings-modal:not(.settings-modal--embedded) .modal-actions");
    expect(modalActions).toBeTruthy();
    expect(within(modalActions as HTMLElement).getByRole("link", { name: "Help and discussions" })).toBeTruthy();
    expect(queryByRole("button", { name: "Check for updates" })).toBeNull();
    expect(container.querySelector(".settings-modal-footer-version")).toBeTruthy();
    expect(container.querySelector(".settings-update-check")).toBeTruthy();
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

  it("preserves the mobile section picker accessible name without rendering a visible label", async () => {
    mockSettingsViewport(true);
    const { container, getByLabelText, queryByText } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const picker = getByLabelText("Settings Section") as HTMLSelectElement;
    expect(picker.id).toBe("settings-mobile-section");
    expect(picker.getAttribute("aria-label")).toBe("Settings Section");
    expect(container.querySelector('label[for="settings-mobile-section"]')).toBeNull();
    expect(queryByText("Settings Section", { selector: "label" })).toBeNull();
  });

  /*
  FNXC:SettingsNavigation 2026-07-16-13:40:
  FN-8130 requires the mobile section picker and rendered content to start on Appearance when no explicit initialSection is supplied. Appearance is global and not Advanced-gated, so it remains selectable in the default visibility state.
  */
  it("defaults the mobile section picker to Appearance", async () => {
    mockSettingsViewport(true);
    const { getByLabelText, getByRole } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    expect(getByLabelText("Settings Section")).toHaveValue("appearance");
    expect(getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
  });

  it("keeps CLI Binary reachable from the Basic-mode mobile picker", async () => {
    localStorage.removeItem("fusion:settings:show-advanced");
    mockSettingsViewport(true);
    const user = userEvent.setup();
    const { container, getByLabelText, findByText } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const picker = getByLabelText("Settings Section") as HTMLSelectElement;
    expect(Array.from(picker.options).map((option) => option.value)).toContain("cli-binary");

    await user.selectOptions(picker, "cli-binary");
    expect(await findByText(/Installing the global CLI lets you run fn and fusion/)).toBeTruthy();
    expect(container.querySelector(".cli-binary-panel")).toBeTruthy();
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

  it("filters the mobile section picker from settings search results with distinct duplicate labels", async () => {
    mockSettingsViewport(true);
    const user = userEvent.setup();
    const { getByLabelText, getByTestId, queryByLabelText, getByText } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // FN-7713: search row is collapsed by default on mobile — expand it first.
    await user.click(getByLabelText("Show search"));
    const search = getByTestId("settings-search-input");
    await user.type(search, "mcp");

    const picker = getByLabelText("Settings Section") as HTMLSelectElement;
    const labels = Array.from(picker.options).map((opt) => opt.textContent);
    expect(labels).toEqual(["MCP Servers · Global", "MCP Servers · Project"]);
    expect(Array.from(picker.options).map((opt) => opt.value)).toEqual(["global-mcp", "mcp"]);

    await user.clear(search);
    await user.type(search, "research providers");

    expect(queryByLabelText("Settings Section")).toBeNull();
    expect(getByText("No sections match this search.")).toBeTruthy();
  });

  /*
  FN-7552: the Authentication section is storage-less (scope: undefined) but is global in effect —
  it holds credentials shared across every project — so its mobile picker option must still read as
  Global, without changing scoped sibling labels.
  FNXC:SettingsNavigation 2026-07-15-17:35: the requirement is unchanged; only the notation moved
  from a "Global — " prefix to a " · Global" suffix, matching the nav labels now that the nav is
  grouped by topic. FN-7552 originally derived this from Authentication sitting under a group header
  literally labelled "Global"; no such group exists any more, so SettingsModal names the exception
  explicitly via STORAGE_LESS_GLOBAL_SECTION_IDS.
  */
  it("marks the storage-less Authentication section as Global in the mobile picker", async () => {
    mockSettingsViewport(true);
    const { getByLabelText } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const picker = getByLabelText("Settings Section") as HTMLSelectElement;
    const optionByValue = (value: string) => Array.from(picker.options).find((opt) => opt.value === value);

    expect(optionByValue("authentication")?.textContent).toBe("Authentication · Global");
    expect(optionByValue("global-mcp")?.textContent).toBe("MCP Servers · Global");
    expect(optionByValue("mcp")?.textContent).toBe("MCP Servers · Project");
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

  it("keeps push remote reachable and clears its hidden shell on mobile", async () => {
    mockSettingsViewport(true);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    const user = userEvent.setup();
    const { getByLabelText, queryByLabelText, getByRole, queryByText } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    await user.selectOptions(getByLabelText("Settings Section"), "merge");
    await user.click(getByRole("checkbox", { name: /push to remote after merge/i }));

    const pushRemote = getByLabelText("Push Remote");
    expect(pushRemote).toHaveAttribute("placeholder", "origin");
    await user.type(pushRemote, "upstream main");

    await user.click(getByRole("checkbox", { name: /push to remote after merge/i }));

    expect(queryByLabelText("Push Remote")).toBeNull();
    expect(queryByText("Git remote to push to")).toBeNull();

    await user.click(getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());

    const payload = vi.mocked(updateSettings).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.pushAfterMerge).toBe(false);
    expect(payload).not.toHaveProperty("pushRemote");
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

    const projectSourceGrid = within(document.body).getByRole("checkbox", { name: /^Page Fetch/ }).closest(".settings-research-source-grid");
    expect(projectSourceGrid).toBeTruthy();
    expect(within(document.body).getByRole("checkbox", { name: /^GitHub/ }).closest(".settings-research-source-grid")).toBe(projectSourceGrid);
    expect(within(document.body).getByRole("checkbox", { name: /^Local Docs/ }).closest(".settings-research-source-grid")).toBe(projectSourceGrid);
    expect(within(document.body).getByRole("checkbox", { name: /^LLM Synthesis/ }).closest(".settings-research-source-grid")).toBe(projectSourceGrid);
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

    /*
    FNXC:SettingsNavigation 2026-07-16-01:10:
    Authentication was the previous default and renders provider cards rather than form controls. FN-8130 defaults Settings to Appearance, but this test deliberately navigates to a section with generic form controls.

    FNXC:SettingsNavigation 2026-07-16-13:40:
    The nav label is "General · Project" now that the Global/Project pair is disambiguated — plain "General" no longer matches any element.
    */
    const generalTabs = await findAllByText("General · Project");
    await user.click(generalTabs[0]);

    const controls = container.querySelectorAll(".settings-content input, .settings-content select, .settings-content textarea");
    expect(controls.length).toBeGreaterThan(0);
  });

  /*
  FNXC:SettingsScope 2026-07-15-18:52:
  Scope is communicated per ROW, not by a section banner. The banner claimed one scope for a whole section, which was frequently false — Appearance is a "global" nav entry whose task-presentation toggles are all project-scoped — so it is removed and each row states its own scope.
  This test kept the surviving requirement (an operator can tell what a setting's scope is) and re-pointed it at the mechanism that now carries it: the nav scope icons plus the per-row badges. The old assertions on `.settings-scope-project` / `.settings-scope-global` banner elements went with the banner.
  */
  it("shows scope on nav items and per-row badges rather than a section banner", async () => {
    const user = userEvent.setup();
    const { container, getByRole } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    expect(container.querySelectorAll(".settings-scope-icon").length).toBeGreaterThan(0);

    await user.click(getByRole("button", { name: /Appearance$/ }));

    // The banner is gone for good — it asserted a single scope for a section
    // that genuinely mixes them.
    expect(container.querySelector(".settings-scope-banner")).toBeNull();
    expect(container.querySelector(".settings-scope-project")).toBeNull();
    expect(container.querySelector(".settings-scope-global")).toBeNull();

    // Appearance is exactly the mixed case: global theme controls above,
    // project-scoped task-presentation toggles below, each badged for itself.
    const badges = container.querySelectorAll('[data-testid="settings-field-row-scope"]');
    expect(badges.length).toBeGreaterThan(0);
    expect(Array.from(badges).map((b) => b.textContent)).toContain("project");
  });

  it("renders separate Anthropic Authentication controls on mobile", async () => {
    mockSettingsViewport(true);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    const user = userEvent.setup();
    const { findByTestId, getByLabelText } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
    await user.selectOptions(getByLabelText("Settings Section"), "authentication");

    const subscriptionCard = (await findByTestId("auth-provider-icon-anthropic-subscription")).closest(".auth-provider-card") as HTMLElement;
    const apiKeyCard = (await findByTestId("auth-provider-icon-anthropic-api-key")).closest(".auth-provider-card") as HTMLElement;
    expect(within(subscriptionCard).getByRole("button", { name: "Login" })).toBeTruthy();
    expect(within(subscriptionCard).queryByPlaceholderText("Enter API key")).toBeNull();
    expect(within(apiKeyCard).getByPlaceholderText("Enter API key")).toBeTruthy();
    expect(within(apiKeyCard).getByRole("button", { name: "Save" })).toBeTruthy();
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

  it("keeps the GitHub star count visible in the mobile Settings header", async () => {
    const css = loadAllAppCss();

    expectNoMobileRule(css, ".settings-header-actions .settings-github-star-btn__count", "display: none;");
    expectBaseRule(css, ".settings-github-star-btn__count", "display: inline-flex;");

    localStorage.setItem("fusion_github_star_count", JSON.stringify({ count: 1234, fetchedAt: Date.now() }));
    mockSettingsViewport(true);

    const modalRender = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
    const modalCount = modalRender.container.querySelector(".settings-github-star-btn__count");
    expect(modalCount).toBeTruthy();
    expect(modalCount?.textContent).toBe("1.2k");
    modalRender.unmount();

    vi.mocked(fetchSettings).mockClear();
    const embeddedRender = render(<SettingsView onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
    const embeddedCount = embeddedRender.container.querySelector(".settings-github-star-btn__count");
    expect(embeddedCount).toBeTruthy();
    expect(embeddedCount?.textContent).toBe("1.2k");
    embeddedRender.unmount();
    localStorage.removeItem("fusion_github_star_count");
  });

  it.each([
    ["modal", (props: { onClose: () => void; addToast: () => void }) => <SettingsModal {...props} />],
    ["embedded", (props: { onClose: () => void; addToast: () => void }) => <SettingsView {...props} />],
  ])("refreshes a stale GitHub star count in the %s Settings surface", async (_surface, Surface) => {
    localStorage.setItem("fusion_github_star_count", JSON.stringify({ count: 999, fetchedAt: Date.now() - (16 * 60 * 1000) }));
    let resolveGitHubFetch: ((value: Response) => void) | undefined;
    const githubFetch = vi.fn(() => new Promise<Response>((resolve) => { resolveGitHubFetch = resolve; }));
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => (
      String(input).includes("api.github.com/repos/Runfusion/Fusion")
        ? githubFetch()
        : Promise.resolve({ ok: true, json: async () => ({}) } as Response)
    )));

    const renderResult = render(<Surface onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
    await waitFor(() => expect(githubFetch).toHaveBeenCalledTimes(1));
    expect(renderResult.container.querySelector(".settings-github-star-btn__count")?.textContent).toBe("999");

    resolveGitHubFetch?.({ ok: true, json: async () => ({ stargazers_count: 123 }) } as Response);
    await waitFor(() => expect(renderResult.container.querySelector(".settings-github-star-btn__count")?.textContent).toBe("123"));
    renderResult.unmount();
  });

  it.each([
    ["modal", (props: { onClose: () => void; addToast: () => void }) => <SettingsModal {...props} />],
    ["embedded", (props: { onClose: () => void; addToast: () => void }) => <SettingsView {...props} />],
  ])("refreshes stale GitHub stars when the hidden %s Settings surface returns", async (_surface, Surface) => {
    localStorage.setItem("fusion_github_star_count", JSON.stringify({ count: 999, fetchedAt: Date.now() - (16 * 60 * 1000) }));
    setDocumentHidden(true);
    const githubFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ stargazers_count: 456 }) } as Response);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => (
      String(input).includes("api.github.com/repos/Runfusion/Fusion")
        ? githubFetch()
        : Promise.resolve({ ok: true, json: async () => ({}) } as Response)
    )));

    const renderResult = render(<Surface onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
    expect(githubFetch).not.toHaveBeenCalled();

    setDocumentHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(renderResult.container.querySelector(".settings-github-star-btn__count")?.textContent).toBe("456"));
    expect(githubFetch).toHaveBeenCalledTimes(1);
    renderResult.unmount();
  });

  it("contains required mobile settings CSS overrides", () => {
    const css = loadAllAppCss();

    expectMobileRule(css, ".settings-layout", "flex-direction: column;");
    expectMobileRule(css, ".settings-mobile-section-picker", "display: flex;");
    expectMobileRule(css, ".settings-mobile-section-picker", "padding: var(--space-sm) var(--space-md) var(--space-md);");
    expectMobileRule(css, ".settings-mobile-section-picker-control-row", "display: flex;");
    expectMobileRule(css, ".settings-mobile-section-picker-control-row", "align-items: center;");
    expectMobileRule(css, ".settings-mobile-section-picker select", "flex: 1 1 auto;");
    expectMobileRule(css, ".settings-mobile-section-picker .settings-search-empty-hint", "flex: 1 1 auto;");
    expectMobileRule(css, ".settings-navigation", "width: 100%;");
    expectMobileRule(css, ".settings-search", "padding: var(--space-sm) var(--space-md) var(--space-sm);");
    expectMobileRule(css, ".settings-sidebar", "display: none;");
    expectMobileRule(css, ".settings-nav-item", "display: flex;");
    expectMobileRule(css, ".settings-nav-item", "align-items: center;");
    expectMobileRule(css, ".settings-nav-item", "justify-content: center;");
    expectMobileRule(css, ".settings-nav-item", "gap: var(--space-xs);");
    expectMobileRule(css, ".settings-content", "padding: var(--space-sm) var(--space-sm) var(--space-md);");
    expectMobileRule(css, ".settings-content textarea", "font-size: 16px;");
    expectMobileRule(css, ".settings-section-heading", "padding: var(--space-md) 0 var(--space-sm);");
    expectMobileRule(css, ".settings-section-heading", "margin: 0 0 var(--space-sm);");
    expectMobileRule(css, ".settings-scope-icon", "margin-right: 0;");
    expectMobileRule(css, ".settings-empty-state", "padding: var(--space-sm);");
    expectMobileRule(css, ".settings-description", "padding: 0 var(--space-sm);");
    expectMobileRule(css, ".theme-selector", "padding: 0 var(--space-sm) var(--space-sm);");
    expectMobileRule(css, ".settings-plugins-subsection-toggle", "padding: 0 var(--space-sm);");
    expectMobileRule(css, ".settings-plugins-subsection-panel", "padding-left: var(--space-sm);");
    expectMobileRule(css, ".form-group", "padding: 0 var(--space-sm);");
    expectMobileRule(css, ".settings-preset-item", "flex-direction: column;");
    expectMobileRule(css, ".settings-preset-item-actions", "justify-content: flex-start;");
    expectMobileRule(css, ".settings-preset-item", "padding: var(--space-sm);");
    expectMobileRule(css, ".settings-preset-editor", "padding: var(--space-sm);");
    expectMobileRule(css, ".settings-preset-size-grid", "grid-template-columns: 1fr;");
    expectMobileRule(css, ".settings-modal .modal-actions", "padding-block: var(--space-xs);");
    expectMobileRule(css, ".settings-modal .modal-actions", "flex-wrap: nowrap;");
    expectMobileRule(css, ".settings-modal .modal-actions", "align-items: center;");
    expectMobileRule(css, ".settings-modal .modal-actions", "overflow-x: auto;");
    expectMobileRule(css, ".settings-modal .modal-actions-left", "align-items: center;");
    expectMobileRule(css, ".settings-modal .modal-actions-right", "align-items: center;");
    expectMobileRule(css, ".settings-modal .settings-modal-footer-version", "align-self: center;");
    expectMobileRule(css, ".settings-modal .settings-modal-footer-version", "flex: 0 0 auto;");
    expectMobileRule(css, ".settings-modal .settings-modal-footer-version", "min-width: max-content;");
    expectMobileRule(css, ".settings-modal .settings-update-check", "align-items: center;");
    expectMobileRule(css, ".settings-modal .settings-update-check", "flex-wrap: wrap;");
    expectMobileRule(css, ".settings-modal .settings-version-check-btn", "line-height: 1;");
    expectMobileRule(css, ".settings-modal .settings-version-check-btn", "white-space: nowrap;");
    expectMobileRule(css, ".settings-modal .settings-modal-version", "display: inline-flex;");
    expectMobileRule(css, ".settings-modal .settings-modal-version", "line-height: 1;");
    expectMobileRule(css, ".settings-modal .settings-modal-version", "white-space: nowrap;");
    expect(css).toContain(".settings-modal .modal-header {\n    padding-block: var(--space-sm);");
    expectMobileRule(css, ".auth-provider-row", "padding: var(--space-sm);");
    expectMobileRule(css, ".auth-panel-body", "padding-inline: 0;");
    expectMobileRule(css, ".auth-panel-body .auth-section-hint", "margin: 0 0 var(--space-sm);");
    expectMobileRule(css, ".auth-section-hint", "padding: var(--space-sm);");
    expectMobileRule(css, ".auth-panel-body .auth-group-label", "padding: 0;");
    expectMobileRule(css, ".auth-panel-body .auth-provider-card", "margin: 0 0 var(--space-sm);");
    // Custom Provider cards render outside .auth-panel-body and retain their mobile gutter.
    expectMobileRule(css, ".auth-provider-card", "margin: 0 var(--space-sm) var(--space-sm);");
    expectMobileRule(css, ".auth-provider-header", "padding: var(--space-sm);");
    expectMobileRule(css, ".auth-provider-header > div:not(.auth-provider-info):not(.auth-apikey-section)", "margin-left: auto;");
    expectMobileRule(css, ".auth-apikey-section", "align-items: flex-end;");
    expectMobileRule(css, ".auth-apikey-input-row", "justify-content: flex-end;");
    expectMobileRule(css, ".auth-apikey-input-row .btn", "margin-left: auto;");
    expectMobileRule(css, ".auth-hint", "padding: var(--space-sm) var(--space-sm) 0;");
    expectMobileRule(css, ".notification-provider-card", "margin: 0 var(--space-sm) var(--space-sm);");
    expectMobileRule(css, ".notification-provider-header", "padding: var(--space-sm) var(--space-md);");
    expectMobileRule(css, ".notification-provider-body", "padding: var(--space-md);");
    expectMobileRule(css, ".memory-file-summary", "margin: 0 var(--space-sm) var(--space-sm);");
    expectMobileRule(css, ".memory-file-summary", "padding: var(--space-sm);");
    expectMobileRule(css, ".settings-model-lane-actions", "padding: var(--space-sm) var(--space-sm) var(--space-md);");
    expectMobileRule(css, ".settings-node-routing-note", "padding: var(--space-sm);");

    // Remote Access header elements must use the same tightened mobile gutter as other settings blocks
    expectMobileRule(css, ".remote-status-bar", "margin: 0 var(--space-sm) var(--space-sm);");
    expectMobileRule(css, ".remote-share-block", "margin: 0 var(--space-sm) var(--space-sm);");
    expectMobileRule(css, ".settings-research-provider-advanced-details", "padding-inline-start: 0;");
    expectMobileRule(css, ".settings-research-source-grid", "grid-template-columns: 1fr;");
    expectMobileRule(css, ".settings-research-limits-grid", "grid-template-columns: 1fr;");

    // FN-7506: Reset Settings dialog mobile overrides — full-width tappable choices, no horizontal overflow.
    expectMobileRule(css, ".settings-reset-dialog", "max-width: calc(100vw - var(--space-md));");
    expectMobileRule(css, ".settings-reset-dialog__choice-btn", "width: 100%;");

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

    expectBaseRule(css, ".settings-navigation", "background: var(--surface);");
    expectBaseRule(css, ".settings-search", "border-bottom: var(--btn-border-width) solid var(--border);");
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
    expect(css).not.toMatch(/\.settings-section-heading\s*\{[^}]*border-bottom:\s*1px solid var\(--border\);/);
  });

  // FN-7713: mobile Settings search row collapses by default behind an icon toggle; desktop keeps
  // the row always visible with no toggle.
  describe("mobile settings search collapse toggle (FN-7713)", () => {
    it("hides the search input by default on mobile and reveals it via the toggle", async () => {
      mockSettingsViewport(true);
      const user = userEvent.setup();
      const { getByLabelText, queryByTestId, findByLabelText } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      // Collapsed by default: no search input, toggle present and labeled "Show search".
      expect(queryByTestId("settings-search-input")).toBeNull();
      const toggle = getByLabelText("Show search");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.getAttribute("aria-controls")).toBe("settings-search-row-region");
      const picker = toggle.closest(".settings-mobile-section-picker") as HTMLElement;
      expect(picker).toBeTruthy();
      expect(within(picker).getByLabelText("Settings Section")).toBeTruthy();
      expect(queryByTestId("settings-search")).toBeNull();

      await user.click(toggle);
      const hideToggle = await findByLabelText("Hide search");
      expect(hideToggle).toBeTruthy();
      expect(hideToggle.getAttribute("aria-expanded")).toBe("true");
      expect(hideToggle.closest(".settings-mobile-section-picker")).toBe(picker);
      expect(document.getElementById("settings-search-row-region")).toBeTruthy();

      await user.click(getByLabelText("Hide search"));
      await waitFor(() => expect(queryByTestId("settings-search-input")).toBeNull());
      expect(getByLabelText("Show search").getAttribute("aria-expanded")).toBe("false");
      // No leftover shell for the search row or results region while collapsed.
      expect(queryByTestId("settings-search")).toBeNull();
      expect(document.getElementById("settings-search-row-region")).toBeNull();
      expect(document.getElementById("settings-search-results")).toBeNull();
    });

    it("preserves an active search query across collapse/expand cycles", async () => {
      mockSettingsViewport(true);
      const user = userEvent.setup();
      const { getByLabelText, getByTestId, queryByTestId } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      await user.click(getByLabelText("Show search"));
      const search = getByTestId("settings-search-input");
      await user.type(search, "mcp");
      expect((getByTestId("settings-search-input") as HTMLInputElement).value).toBe("mcp");

      // Collapse while a query is active: state is preserved, no forced auto-expand.
      await user.click(getByLabelText("Hide search"));
      expect(queryByTestId("settings-search-input")).toBeNull();

      // Re-expanding restores the exact query and its results region.
      await user.click(getByLabelText("Show search"));
      expect((getByTestId("settings-search-input") as HTMLInputElement).value).toBe("mcp");
      expect(document.getElementById("settings-search-results")?.textContent).toContain("matching sections");
    });

    it("keeps the desktop search row always visible with no toggle rendered", async () => {
      mockSettingsViewport(false);
      const { container, queryByLabelText, getByTestId } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      expect(getByTestId("settings-search-input")).toBeTruthy();
      expect(queryByLabelText("Show search")).toBeNull();
      expect(queryByLabelText("Hide search")).toBeNull();
      expect(container.querySelector(".settings-mobile-section-picker .settings-search-toggle")).toBeNull();
    });

    it("keeps the inline toggle reachable when mobile search has no section results", async () => {
      mockSettingsViewport(true);
      const user = userEvent.setup();
      const { getByLabelText, getByTestId, findByText } = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      await user.click(getByLabelText("Show search"));
      await user.type(getByTestId("settings-search-input"), "zzzzzz-no-match");

      const emptyHint = await findByText("No sections match this search.");
      const picker = emptyHint.closest(".settings-mobile-section-picker") as HTMLElement;
      expect(picker).toBeTruthy();
      expect(within(picker).getByLabelText("Hide search")).toBeTruthy();
      expect(picker.querySelector("#settings-mobile-section")).toBeNull();
    });

    it("contains the mobile-only toggle CSS override and hides it on desktop", () => {
      const css = loadAllAppCss();

      expectMobileRule(css, ".settings-search-toggle", "display: inline-flex;");
      expectMobileRule(css, ".settings-search-toggle", "flex-shrink: 0;");
      expectBaseRule(css, ".settings-search-toggle", "display: none;");
    });
  });
});
