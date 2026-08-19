// @vitest-environment jsdom
/**
 * FNXC:StashSessionCapture 2026-08-19-05:09:
 * RUFU-122 Step 5 tests: the Memory section's task-transcript upload rows.
 *
 * Pinned surface:
 * - `executorSessionCaptureEnabled` (toggle) + `executorSessionCaptureMaxEvents`
 *   (number) render ONLY when the memory backend is Stash — the feature is
 *   inert for every other backend, same condition as the other stash rows.
 * - When memory is disabled the rows render DISABLED (not hidden) so the
 *   operator still sees the controls and their defaults.
 * - Toggle defaults ON (form value undefined ⇒ true); off means anchor-only
 *   capture, never "no capture".
 * - `executorSessionCaptureIncludeStatus` is schema-only by design: no row.
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

/** Applies the last functional setForm updater to a base form state. */
function applyLastUpdater(setForm: ReturnType<typeof vi.fn>, base: SettingsFormState): SettingsFormState {
  const updater = setForm.mock.calls[setForm.mock.calls.length - 1][0] as (
    prev: SettingsFormState,
  ) => SettingsFormState;
  return updater(base);
}

describe("RUFU-122 MemorySection task-transcript upload rows", () => {
  it("renders the toggle + max-events rows when the backend is Stash", () => {
    renderMemorySection(makeForm({ memoryBackendType: "stash" }));
    expect(screen.getByLabelText("Executor session capture")).toBeInTheDocument();
    expect(screen.getByLabelText("Max transcript events per task")).toBeInTheDocument();
  });

  it("renders NEITHER row for a non-Stash backend (feature inert elsewhere)", () => {
    renderMemorySection(makeForm({ memoryBackendType: "qmd" }));
    expect(screen.queryByLabelText("Executor session capture")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Max transcript events per task")).not.toBeInTheDocument();
  });

  it("defaults the toggle ON when the form carries no explicit value", () => {
    renderMemorySection(makeForm({ memoryBackendType: "stash" }));
    const toggle = screen.getByLabelText("Executor session capture") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it("toggling writes executorSessionCaptureEnabled via setForm", () => {
    const { setForm } = renderMemorySection(makeForm({ memoryBackendType: "stash" }));
    const toggle = screen.getByLabelText("Executor session capture") as HTMLInputElement;
    fireEvent.click(toggle);
    expect(setForm).toHaveBeenCalledWith(expect.any(Function));
    const next = applyLastUpdater(setForm, makeForm({ memoryBackendType: "stash" }));
    expect(next.executorSessionCaptureEnabled).toBe(false);
  });

  it("editing the number row writes executorSessionCaptureMaxEvents via setForm", () => {
    const { setForm } = renderMemorySection(makeForm({ memoryBackendType: "stash" }));
    const number = screen.getByLabelText("Max transcript events per task") as HTMLInputElement;
    fireEvent.change(number, { target: { value: "25000" } });
    expect(setForm).toHaveBeenCalledWith(expect.any(Function));
    const next = applyLastUpdater(setForm, makeForm({ memoryBackendType: "stash" }));
    expect(next.executorSessionCaptureMaxEvents).toBe(25000);
  });

  it("renders the rows DISABLED (not hidden) when memory is disabled", () => {
    renderMemorySection(
      makeForm({ memoryBackendType: "stash", memoryEnabled: false }),
    );
    const toggle = screen.getByLabelText("Executor session capture") as HTMLInputElement;
    const number = screen.getByLabelText("Max transcript events per task") as HTMLInputElement;
    expect(toggle).toBeInTheDocument();
    expect(number).toBeInTheDocument();
    expect(toggle.disabled).toBe(true);
    expect(number.disabled).toBe(true);
  });

  it("renders the rows ENABLED when memory is enabled", () => {
    renderMemorySection(makeForm({ memoryBackendType: "stash" }));
    const toggle = screen.getByLabelText("Executor session capture") as HTMLInputElement;
    const number = screen.getByLabelText("Max transcript events per task") as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
    expect(number.disabled).toBe(false);
  });

  it("number row carries the 100..100000/step-1000 contract and the 20000 default", () => {
    renderMemorySection(makeForm({ memoryBackendType: "stash" }));
    const number = screen.getByLabelText("Max transcript events per task") as HTMLInputElement;
    expect(number.min).toBe("100");
    expect(number.max).toBe("100000");
    expect(number.step).toBe("1000");
    expect(number.value).toBe("20000");
  });

  it("renders NO row for the schema-only executorSessionCaptureIncludeStatus flag", () => {
    renderMemorySection(makeForm({ memoryBackendType: "stash" }));
    // The flag has no label on screen; ensure no checkbox/number is wired to
    // its key (a stray row would expose a control the spec says not to build).
    expect(document.getElementById("executorSessionCaptureIncludeStatus")).toBeNull();
    // The two rendered rows are the ONLY controls anchored to executorSessionCapture* keys.
    expect(document.getElementById("executorSessionCaptureEnabled")).not.toBeNull();
    expect(document.getElementById("executorSessionCaptureMaxEvents")).not.toBeNull();
  });

  it("help copy carries the default-value indicator operators rely on", () => {
    renderMemorySection(makeForm({ memoryBackendType: "stash" }));
    const help = within(document.body)
      .getAllByText(/agent-log/i)
      .map((n) => n.textContent ?? "")
      .join(" ");
    expect(help).toMatch(/default: enabled/i);
    expect(help).toMatch(/anchor event is captured/i);
  });
});
