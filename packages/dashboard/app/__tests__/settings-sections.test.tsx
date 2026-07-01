// @vitest-environment jsdom
/**
 * Per-section smoke tests for the extracted SettingsModal sections (U9 / KTD-10).
 *
 * These pin the section-component contract: each section reads from `form` and
 * emits edits via `setForm` (the shell keeps persistence/save-split). We cover
 * three representative sections — an Appearance toggle round-trip, a
 * Notifications field, and an Experimental flag — following the dashboard
 * component-test conventions in settings-primitives.test.tsx.
 */
import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";

import { AppearanceSection } from "../components/settings/sections/AppearanceSection";
import { GeneralSection } from "../components/settings/sections/GeneralSection";
import { NotificationsSection } from "../components/settings/sections/NotificationsSection";
import { ExperimentalSection } from "../components/settings/sections/ExperimentalSection";
import { MovedSettingsStub } from "../components/settings/sections/MovedSettingsStub";
import { ProjectModelsSection } from "../components/settings/sections/ProjectModelsSection";
import { PromptsSection } from "../components/settings/sections/PromptsSection";
import { SecretsSection } from "../components/settings/sections/SecretsSection";
import { WorktreesSection } from "../components/settings/sections/WorktreesSection";
import type { SettingsFormState } from "../components/settings/sections/context";

vi.mock("../components/AgentPromptsManager", () => ({
  AgentPromptsManager: () => <div data-testid="agent-prompts-manager" />,
}));
vi.mock("../components/SecretsView", () => ({
  SecretsView: () => <div data-testid="secrets-view" />,
}));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    fetchWorkflows: vi.fn(async () => []),
    fetchWorkflow: vi.fn(async () => ({ id: "builtin:coding", name: "Coding" })),
    fetchProjectDefaultWorkflow: vi.fn(async () => ({ workflowId: null })),
    setProjectDefaultWorkflow: vi.fn(async () => ({ workflowId: null })),
    fetchGlobalSettings: vi.fn(async () => ({})),
  };
});

expect.extend(jestDomMatchers);
afterEach(() => cleanup());

const emptyForm = {} as SettingsFormState;

describe("AppearanceSection", () => {
  function AppearanceHost() {
    const [hidden, setHidden] = useState(false);
    return (
      <AppearanceSection
        scopeBanner={null}
        form={emptyForm}
        setForm={vi.fn()}
        themeMode="dark"
        colorTheme="default"
        dashboardFontScalePct={100}
        sessionBannersHidden={hidden}
        setSessionBannersHidden={setHidden}
      />
    );
  }

  it("round-trips the session-banner toggle through its setter", () => {
    render(<AppearanceHost />);
    const toggle = screen.getByText("Hide AI session notification banners")
      .closest("label")!
      .querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
  });
});

describe("GeneralSection", () => {
  it("emits the absolute file-browser path toggle via setForm", () => {
    function GeneralHost() {
      const [form, setForm] = useState({ allowAbsoluteFileBrowserPaths: false } as SettingsFormState);
      return (
        <GeneralSection
          scopeBanner={null}
          form={form}
          setForm={setForm}
          addToast={vi.fn()}
          prefixError={null}
          setPrefixError={vi.fn()}
          projectTrackingRepoOptions={[]}
          projectTrackingRepoLoading={false}
          projectTrackingRepoError={null}
        />
      );
    }

    render(<GeneralHost />);

    const checkbox = screen.getByLabelText(/Allow absolute file-browser paths/i) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);

    expect(checkbox.checked).toBe(true);
  });
});

describe("NotificationsSection", () => {
  it("emits the chosen failure-notification mode via setForm", () => {
    const setForm = vi.fn();
    render(
      <NotificationsSection
        scopeBanner={null}
        form={emptyForm}
        setForm={setForm}
        testNotificationLoading={{}}
        testNotificationResult={{}}
        onTestProviderNotification={vi.fn()}
      />,
    );
    const select = screen.getByLabelText("Failure notification mode") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "all" } });
    expect(setForm).toHaveBeenCalledTimes(1);
    const updater = setForm.mock.calls[0][0] as (f: SettingsFormState) => SettingsFormState;
    expect(updater(emptyForm)).toMatchObject({ failureNotificationMode: "all" });
  });

  it("shows the ntfy topic field only when ntfy is enabled", () => {
    const { rerender } = render(
      <NotificationsSection
        scopeBanner={null}
        form={{ ntfyEnabled: false } as SettingsFormState}
        setForm={vi.fn()}
        testNotificationLoading={{}}
        testNotificationResult={{}}
        onTestProviderNotification={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("ntfy Topic")).not.toBeInTheDocument();
    rerender(
      <NotificationsSection
        scopeBanner={null}
        form={{ ntfyEnabled: true } as SettingsFormState}
        setForm={vi.fn()}
        testNotificationLoading={{}}
        testNotificationResult={{}}
        onTestProviderNotification={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("ntfy Topic")).toBeInTheDocument();
  });
});

describe("SecretsSection", () => {
  it("renders the scope banner, title, and the SecretsView card", () => {
    render(
      <SecretsSection scopeBanner={<div data-testid="scope-banner" />} addToast={vi.fn()} />,
    );
    expect(screen.getByTestId("scope-banner")).toBeInTheDocument();
    expect(screen.getByText("Secrets")).toBeInTheDocument();
    expect(screen.getByTestId("secrets-view")).toBeInTheDocument();
  });
});

describe("WorktreesSection", () => {
  const worktrunkInstall = {
    status: "installed",
    version: "1.0.0",
    installPath: "/tmp/worktrunk",
    requesting: false,
    requestInstall: vi.fn(),
  } as never;

  it("renders editable copy-file rows with add, browse, and remove controls", () => {
    const onChange = vi.fn();
    const onBrowse = vi.fn();
    const onRemove = vi.fn();
    const onAdd = vi.fn();
    render(
      <WorktreesSection
        scopeBanner={null}
        form={{ recycleWorktrees: false, worktreeCopyFiles: [".env"] } as SettingsFormState}
        setForm={vi.fn()}
        gitRemotes={[]}
        worktrunkInstall={worktrunkInstall}
        worktrunkInstallVerified={true}
        onOpenWorktreesDirPicker={vi.fn()}
        onWorktreeCopyFileChange={onChange}
        onRemoveWorktreeCopyFile={onRemove}
        onAddWorktreeCopyFile={onAdd}
        onOpenWorktreeCopyFilePicker={onBrowse}
      />,
    );

    expect(screen.getByText("Files to copy into new worktrees")).toBeInTheDocument();
    const input = screen.getByLabelText("File to copy into new worktrees") as HTMLInputElement;
    expect(input.value).toBe(".env");
    fireEvent.change(input, { target: { value: "config/local.env" } });
    expect(onChange).toHaveBeenCalledWith(0, "config/local.env");
    fireEvent.click(screen.getByRole("button", { name: "Browse file to copy into new worktrees" }));
    expect(onBrowse).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByRole("button", { name: "Remove copied worktree file" }));
    expect(onRemove).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByRole("button", { name: "Add file" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("renders and toggles the board worktree grouping checkbox", () => {
    const setForm = vi.fn((updater: SettingsFormState | ((prev: SettingsFormState) => SettingsFormState)) => {
      if (typeof updater === "function") {
        return updater({ recycleWorktrees: false, showWorktreeGrouping: false } as SettingsFormState);
      }
      return updater;
    });

    render(
      <WorktreesSection
        scopeBanner={null}
        form={{ recycleWorktrees: false, showWorktreeGrouping: false, worktreeCopyFiles: [] } as SettingsFormState}
        setForm={setForm}
        gitRemotes={[]}
        worktrunkInstall={worktrunkInstall}
        worktrunkInstallVerified={true}
        onOpenWorktreesDirPicker={vi.fn()}
        onWorktreeCopyFileChange={vi.fn()}
        onRemoveWorktreeCopyFile={vi.fn()}
        onAddWorktreeCopyFile={vi.fn()}
        onOpenWorktreeCopyFilePicker={vi.fn()}
      />,
    );

    const checkbox = screen.getByLabelText(/Show worktree grouping on the board/i) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);

    expect(setForm).toHaveBeenCalledTimes(1);
    expect(setForm.mock.results[0]?.value).toMatchObject({ showWorktreeGrouping: true });
  });

  it("keeps an empty copy-file row reachable when the setting is undefined", () => {
    render(
      <WorktreesSection
        scopeBanner={null}
        form={{ recycleWorktrees: false, worktreeCopyFiles: undefined } as SettingsFormState}
        setForm={vi.fn()}
        gitRemotes={[]}
        worktrunkInstall={worktrunkInstall}
        worktrunkInstallVerified={true}
        onOpenWorktreesDirPicker={vi.fn()}
        onWorktreeCopyFileChange={vi.fn()}
        onRemoveWorktreeCopyFile={vi.fn()}
        onAddWorktreeCopyFile={vi.fn()}
        onOpenWorktreeCopyFilePicker={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("File to copy into new worktrees")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Browse file to copy into new worktrees" })).toBeInTheDocument();
  });
});

describe("ProjectModelsSection", () => {
  const models = {
    modelLanes: [],
    getLaneStatus: () => "inherited" as const,
    getLaneValue: () => "",
    updateLaneValue: vi.fn(),
    resetLaneValue: vi.fn(),
    availableModels: [],
    modelsLoading: false,
    favoriteProviders: [],
    favoriteModels: [],
    onToggleFavorite: vi.fn(),
    onToggleModelFavorite: vi.fn(),
    editingPresetId: null,
    setEditingPresetId: vi.fn(),
    presetDraft: null,
    setPresetDraft: vi.fn(),
    onSavePresetDraft: vi.fn(),
    confirmDelete: vi.fn(),
  };

  it("renders PR prompt guidance textareas and emits edits through setForm", () => {
    function ProjectModelsHost() {
      const [form, setFormState] = useState<SettingsFormState>({
        prTitlePromptInstructions: "Keep it short.",
        prDescriptionPromptInstructions: "Mention testing.",
      } as SettingsFormState);
      return (
        <ProjectModelsSection
          scopeBanner={null}
          form={form}
          setForm={setFormState as never}
          models={models}
          addToast={vi.fn()}
        />
      );
    }

    render(<ProjectModelsHost />);

    const titleField = screen.getByLabelText("PR title prompt guidance") as HTMLTextAreaElement;
    const descriptionField = screen.getByLabelText("PR description prompt guidance") as HTMLTextAreaElement;
    expect(titleField.value).toBe("Keep it short.");
    expect(descriptionField.value).toBe("Mention testing.");

    fireEvent.change(titleField, { target: { value: "Use release style." } });
    fireEvent.change(descriptionField, { target: { value: "Group by impact." } });

    expect(titleField.value).toBe("Use release style.");
    expect(descriptionField.value).toBe("Group by impact.");
  });
});

describe("PromptsSection", () => {
  it("renders the title and mounts AgentPromptsManager", () => {
    render(
      <PromptsSection scopeBanner={null} form={emptyForm} setForm={vi.fn()} />,
    );
    expect(screen.getByText("Prompts")).toBeInTheDocument();
    expect(screen.getByTestId("agent-prompts-manager")).toBeInTheDocument();
  });
});

describe("MovedSettingsStub", () => {
  it("renders the message and fires the open-workflow-settings callback", () => {
    const onOpen = vi.fn();
    render(<MovedSettingsStub message="Step execution moved" onOpenWorkflowSettings={onOpen} />);
    expect(screen.getByText("Step execution moved")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open workflow settings" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("disables the action when no handler is wired", () => {
    render(<MovedSettingsStub message="Moved" />);
    expect(screen.getByRole("button", { name: "Open workflow settings" })).toBeDisabled();
  });
});

describe("ExperimentalSection", () => {
  const knownFeatures = { insights: "Insights" };
  const legacyAliases: Record<string, string> = { devServer: "devServerView" };
  const getCanonicalKey = (k: string) => legacyAliases[k] ?? k;
  const isFeatureEnabled = (features: Record<string, boolean>, key: string) => features[key] === true;

  // Stateful host so the controlled checkbox actually toggles between renders
  // (a bare mock setForm never re-renders, so jsdom reports the bound value).
  function ExperimentalHost() {
    const [form, setFormState] = useState<SettingsFormState>(
      { experimentalFeatures: {} } as SettingsFormState,
    );
    return (
      <ExperimentalSection
        scopeBanner={null}
        form={form}
        setForm={setFormState as never}
        knownFeatures={knownFeatures}
        legacyAliases={legacyAliases}
        getCanonicalKey={getCanonicalKey}
        isFeatureEnabled={isFeatureEnabled}
      />
    );
  }

  it("renders a row per known flag and round-trips the canonical key", () => {
    render(<ExperimentalHost />);
    expect(screen.getByText("Insights")).toBeInTheDocument();
    expect(screen.queryByText("Roadmaps")).not.toBeInTheDocument();

    const insightsToggle = document.getElementById("experimental-insights") as HTMLInputElement;
    expect(insightsToggle.checked).toBe(false);
    fireEvent.click(insightsToggle);
    expect(insightsToggle.checked).toBe(true);
    fireEvent.click(insightsToggle);
    expect(insightsToggle.checked).toBe(false);
  });
});
