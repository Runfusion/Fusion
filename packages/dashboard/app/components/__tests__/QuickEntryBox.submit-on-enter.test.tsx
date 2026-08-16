import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QuickEntryBox } from "../QuickEntryBox";
import { QuickAddSubmitOnEnterProvider } from "../../hooks/useQuickAddSubmitOnEnter";
import { checkDuplicateTasks } from "../../api";

vi.mock("../../api", () => ({
  checkDuplicateTasks: vi.fn().mockResolvedValue([]),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchAuthStatus: vi.fn().mockResolvedValue({ providers: [] }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchWorkflowOptionalSteps: vi.fn().mockResolvedValue([]),
  refineText: vi.fn(),
  uploadAttachment: vi.fn().mockResolvedValue({}),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
}));
vi.mock("../../hooks/useComposerDictation", () => ({
  useComposerDictation: () => ({ micProps: { enabled: false, supported: false, state: "idle", start: vi.fn(), stop: vi.fn() } }),
}));
vi.mock("../../hooks/useNodes", () => ({ useNodes: () => ({ nodes: [], loading: false, error: null }) }));

const duplicate = { id: "FN-existing", title: "Existing", description: "Existing task", column: "todo", score: 0.9 };

function renderEntry({ enabled, singleLine = false }: { enabled?: boolean; singleLine?: boolean } = {}) {
  const onCreate = vi.fn().mockResolvedValue(undefined);
  const entry = <QuickEntryBox addToast={vi.fn()} onCreate={onCreate} tasks={[]} singleLine={singleLine} defaultExpanded={false} />;
  render(enabled === undefined ? entry : <QuickAddSubmitOnEnterProvider enabled={enabled}>{entry}</QuickAddSubmitOnEnterProvider>);
  const textarea = screen.getByPlaceholderText("Add a task...") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: "Task description" } });
  return { onCreate, textarea };
}

function pressEnter(textarea: HTMLTextAreaElement, options: KeyboardEventInit = {}) {
  const event = createEvent.keyDown(textarea, { key: "Enter", ...options });
  fireEvent(textarea, event);
  return event;
}

afterEach(() => {
  vi.mocked(checkDuplicateTasks).mockReset();
  vi.mocked(checkDuplicateTasks).mockResolvedValue([]);
  vi.restoreAllMocks();
});

describe("QuickEntryBox submit-on-Enter preference", () => {
  it.each([{ singleLine: false, host: "Board" }, { singleLine: true, host: "List" }])("submits on Enter by default in $host Quick Add", async ({ singleLine }) => {
    const { onCreate, textarea } = renderEntry({ singleLine });
    const event = pressEnter(textarea);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
  });

  it("uses the enabled provider in the Board host", async () => {
    const { onCreate, textarea } = renderEntry({ enabled: true });
    expect(pressEnter(textarea).defaultPrevented).toBe(true);
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
  });

  it.each([{ singleLine: false, host: "Board" }, { singleLine: true, host: "List" }])("keeps plain Enter as a browser newline when disabled in $host Quick Add", ({ singleLine }) => {
    const { onCreate, textarea } = renderEntry({ enabled: false, singleLine });
    const event = pressEnter(textarea);
    expect(event.defaultPrevented).toBe(false);
    // jsdom does not perform textarea's native default action, so model the browser newline after proving it was allowed.
    fireEvent.change(textarea, { target: { value: `${textarea.value}\n` } });
    expect(textarea).toHaveValue("Task description\n");
    expect(onCreate).not.toHaveBeenCalled();
  });

  it.each([{ metaKey: true, platform: "Cmd" }, { ctrlKey: true, platform: "Ctrl" }])("uses $platform+Enter as the save accelerator when disabled", async (modifier) => {
    const { onCreate, textarea } = renderEntry({ enabled: false });
    expect(pressEnter(textarea, modifier).defaultPrevented).toBe(true);
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
  });

  it.each([{ enabled: true }, { enabled: false }])("keeps Shift+Enter non-submitting and does not expand the single-line textarea when preference is $enabled", ({ enabled }) => {
    const { onCreate, textarea } = renderEntry({ enabled, singleLine: true });
    expect(textarea.closest(".quick-entry-box")?.className).not.toContain("expanded");
    expect(pressEnter(textarea, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(onCreate).not.toHaveBeenCalled();
    expect(textarea.closest(".quick-entry-box")?.className).not.toContain("expanded");
  });

  it.each(["", "   \n  "])("never creates an empty or whitespace-only task (%j)", async (description) => {
    const { onCreate, textarea } = renderEntry({ enabled: true });
    fireEvent.change(textarea, { target: { value: description } });
    expect(pressEnter(textarea).defaultPrevented).toBe(true);
    await waitFor(() => expect(onCreate).not.toHaveBeenCalled());
  });

  it.each([{ enabled: true }, { enabled: false }])("keeps Enter a no-op while duplicate confirmation is open when preference is $enabled", async ({ enabled }) => {
    vi.mocked(checkDuplicateTasks).mockResolvedValueOnce([duplicate]);
    const { onCreate, textarea } = renderEntry({ enabled });
    pressEnter(textarea, enabled ? {} : { ctrlKey: true });
    await screen.findByText("Possible duplicates");
    const event = pressEnter(textarea);
    expect(event.defaultPrevented).toBe(true);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it.each([{ enabled: true }, { enabled: false }])("keeps Enter a no-op while a submission is in flight when preference is $enabled", async ({ enabled }) => {
    let resolveDuplicateCheck!: (matches: typeof duplicate[]) => void;
    vi.mocked(checkDuplicateTasks).mockImplementationOnce(() => new Promise((resolve) => { resolveDuplicateCheck = resolve; }));
    const { onCreate, textarea } = renderEntry({ enabled });
    pressEnter(textarea, enabled ? {} : { ctrlKey: true });
    const event = pressEnter(textarea);
    expect(event.defaultPrevented).toBe(true);
    resolveDuplicateCheck([]);
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
  });

  it("uses the same disabled Enter behavior at the mobile viewport", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(375);
    const { onCreate, textarea } = renderEntry({ enabled: false });
    expect(pressEnter(textarea).defaultPrevented).toBe(false);
    expect(onCreate).not.toHaveBeenCalled();
  });
});
