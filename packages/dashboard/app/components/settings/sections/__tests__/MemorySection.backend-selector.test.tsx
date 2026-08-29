// @vitest-environment jsdom
/**
 * MemorySection backend-selector + Stash URL surface tests (RUFU-068).
 *
 * These pin the per-project memory-backend surface operated onto origin/main's
 * form-driven Settings pattern: a SettingsSelectRow writing `memoryBackendType`
 * via setForm, and a stash-only SettingsTextRow for `stashUrl` that renders only
 * when the backend is "stash". TencentDB is intentionally absent (operator
 * decision 2026-08-12) — no tencentdb option, no memoryBackendUrl row.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemorySection, type MemorySectionMemoryProps } from "../MemorySection";
import type { SectionBaseProps, SettingsFormState } from "../context";

function makeForm(overrides: Partial<SettingsFormState> = {}): SettingsFormState {
  return {
    memoryEnabled: true,
    memoryBackendType: "qmd",
    stashUrl: "",
    ...overrides,
  } as SettingsFormState;
}

function makeMemoryProps(overrides: Partial<MemorySectionMemoryProps> = {}): MemorySectionMemoryProps {
  return {
    memoryCapabilities: { writable: true },
    memoryBackendStatus: { backend: "qmd", writable: true },
    memoryBackendLoading: false,
    memoryBackendError: null,
    memoryFiles: [],
    selectedMemoryPath: "",
    setSelectedMemoryPath: vi.fn(),
    memoryContent: "",
    setMemoryContent: vi.fn(),
    memoryLoading: false,
    memoryDirty: false,
    setMemoryDirty: vi.fn(),
    memoryTestQuery: "",
    setMemoryTestQuery: vi.fn(),
    memoryTestLoading: false,
    memoryTestResult: null,
    qmdInstallLoading: false,
    dreamRunning: false,
    memoryCompactLoading: false,
    onInstallQmd: vi.fn(),
    onTestMemoryRetrieval: vi.fn(),
    onDreamNow: vi.fn(),
    onCompactMemory: vi.fn(),
    onSaveMemory: vi.fn(),
    ...overrides,
  } as MemorySectionMemoryProps;
}

function renderMemorySection(form: SettingsFormState = makeForm()) {
  const setForm = vi.fn();
  const props: SectionBaseProps & { memory: MemorySectionMemoryProps } = {
    form,
    setForm,
    memory: makeMemoryProps(),
  };
  const view = render(<MemorySection {...props} />);
  return { setForm, view };
}

describe("FN-RUFU-068 MemorySection memory-backend selector", () => {
  it("exposes qmd, local files, read-only, and Stash backend options", () => {
    renderMemorySection(makeForm({ memoryBackendType: "qmd" }));
    const select = screen.getByLabelText(/memory backend/i);
    const options = within(select).getAllByRole("option");
    const optionLabels = options.map((o) => o.textContent ?? "");
    expect(optionLabels.join(" ")).toMatch(/stash/i);
    expect(optionLabels.join(" ")).toMatch(/read-only/i);
    expect(optionLabels.join(" ")).toMatch(/local files/i);
    expect(optionLabels.join(" ")).toMatch(/qmd/i);
  });

  it("does NOT offer a TencentDB backend option", () => {
    renderMemorySection(makeForm({ memoryBackendType: "qmd" }));
    const select = screen.getByLabelText(/memory backend/i);
    const optionLabels = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    expect(optionLabels.join(" ").toLowerCase()).not.toMatch(/tencentdb|tencent|tcimg|tdsql/i);
  });

  it("selecting Stash writes memoryBackendType via setForm", () => {
    const { setForm } = renderMemorySection(makeForm({ memoryBackendType: "qmd" }));
    const select = screen.getByLabelText(/memory backend/i);
    fireEvent.change(select, { target: { value: "stash" } });
    expect(setForm).toHaveBeenCalledWith(expect.any(Function));
    // Re-apply the functional updater to confirm it flips memoryBackendType to "stash".
    const updater = setForm.mock.calls[setForm.mock.calls.length - 1][0] as (prev: SettingsFormState) => SettingsFormState;
    const next = updater(makeForm({ memoryBackendType: "qmd" }));
    expect(next.memoryBackendType).toBe("stash");
  });

  it("renders the Stash URL row only when the backend is Stash", () => {
    const stashForm = makeForm({ memoryBackendType: "stash", stashUrl: "" });
    const { view } = renderMemorySection(stashForm);
    expect(screen.getByLabelText(/stash server url/i)).toBeInTheDocument();

    // Rerender with a non-stash backend: the row must disappear.
    view.rerender(
      <MemorySection
        form={makeForm({ memoryBackendType: "qmd", stashUrl: "" })}
        setForm={vi.fn()}
        memory={makeMemoryProps()}
      />,
    );
    expect(screen.queryByLabelText(/stash server url/i)).not.toBeInTheDocument();
  });

  it("filling the Stash URL row writes stashUrl via setForm", () => {
    const { setForm } = renderMemorySection(makeForm({ memoryBackendType: "stash" }));
    const urlRow = screen.getByLabelText(/stash server url/i);
    fireEvent.change(urlRow, { target: { value: "http://127.0.0.1:3457" } });
    expect(setForm).toHaveBeenCalledWith(expect.any(Function));
  });

  it("renders NO TencentDB memoryBackendUrl affordance even when the backend is Stash", () => {
    renderMemorySection(makeForm({ memoryBackendType: "stash" }));
    expect(screen.queryByLabelText(/tencentdb|memory backend url|gateway url/i)).not.toBeInTheDocument();
  });
});