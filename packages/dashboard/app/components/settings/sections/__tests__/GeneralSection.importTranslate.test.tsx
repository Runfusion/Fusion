// @vitest-environment jsdom
/*
FNXC:GitHubImportTranslate 2026-07-15-16:35:
The import auto-translate controls must render with the SECTION'S native checkbox idiom — a plain
`checkbox-label` with the input BEFORE the text — not the right-aligned toggle-switch primitive that
SettingsToggleRow renders. Two different checkbox idioms in one settings section read as a bug, so
this pins the markup (and its parity with the neighbouring GitHub/import checkbox) rather than
trusting it to survive a refactor back onto the primitive.
*/
import { useState } from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { GeneralSection } from "../GeneralSection";
import type { SettingsFormState } from "../context";
const { fetchWorkflows, fetchProjectDefaultWorkflow } = vi.hoisted(() => ({
  fetchWorkflows: vi.fn(),
  fetchProjectDefaultWorkflow: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

/*
FNXC:GitHubImportTranslate 2026-07-15-20:15:
Mock the NARROW seam, not the whole module (PR #2147 review). `importOriginal()` pulls in the entire
`app/api/legacy.ts` implementation, which is what exhausts the jsdom heap in the sibling translation
test. GeneralSection imports exactly one thing from `../../../api` — `fetchWorkflows` — so there is
nothing else to preserve.
*/
vi.mock("../../../../api", () => ({
  fetchWorkflows,
  // Pulled in by WorkflowSelector, which GeneralSection renders.
  fetchProjectDefaultWorkflow,
}));

beforeEach(() => {
  fetchWorkflows.mockReset();
  fetchWorkflows.mockResolvedValue([]);
  fetchProjectDefaultWorkflow.mockReset();
  fetchProjectDefaultWorkflow.mockResolvedValue(null);
});
afterEach(() => cleanup());

function GeneralHost({ initialForm, onSetForm }: {
  initialForm: Partial<SettingsFormState>;
  onSetForm?: (next: SettingsFormState) => void;
}) {
  const [form, setForm] = useState(initialForm as SettingsFormState);
  return (
    <GeneralSection
      scopeBanner={null}
      form={form}
      setForm={(updater) => {
        setForm((prev) => {
          const next = (typeof updater === "function" ? (updater as (f: SettingsFormState) => SettingsFormState)(prev) : updater);
          onSetForm?.(next);
          return next;
        });
      }}
      addToast={vi.fn()}
      prefixError={null}
      setPrefixError={vi.fn()}
      projectTrackingRepoOptions={[]}
      projectTrackingRepoLoading={false}
      projectTrackingRepoError={null}
    />
  );
}

describe("GeneralSection - import auto-translate controls", () => {
  it("renders the auto-translate control as a checkbox using the section's checkbox-label idiom", () => {
    render(<GeneralHost initialForm={{}} />);
    const input = document.getElementById("githubImportAutoTranslate") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.type).toBe("checkbox");
    expect(input.closest("label")?.className).toContain("checkbox-label");
  });

  it("puts the checkbox BEFORE its text, like every other checkbox in the section", () => {
    render(<GeneralHost initialForm={{}} />);
    const input = document.getElementById("githubImportAutoTranslate")!;
    const label = input.closest("label")!;
    expect(label.firstElementChild).toBe(input);
    expect(label.textContent).toContain("Auto-translate imported issues");
  });

  it("matches the neighbouring imported-issue checkbox's structure exactly", () => {
    render(<GeneralHost initialForm={{}} />);
    const mine = document.getElementById("githubImportAutoTranslate")!.closest("label")!;
    const neighbour = document.getElementById("githubLinkImportedIssuesToTracking")!.closest("label")!;
    expect(mine.className).toBe(neighbour.className);
    expect(mine.firstElementChild?.tagName).toBe(neighbour.firstElementChild?.tagName);
  });

  it("is unchecked by default and stores the opt-in when toggled", () => {
    let latest: SettingsFormState | undefined;
    render(<GeneralHost initialForm={{}} onSetForm={(f) => { latest = f; }} />);
    const input = document.getElementById("githubImportAutoTranslate") as HTMLInputElement;
    expect(input.checked).toBe(false);

    fireEvent.click(input);
    expect(latest?.githubImportAutoTranslate).toBe(true);
  });

  it("clears back to undefined (not false) when switched off, so it stays 'unset'", () => {
    let latest: SettingsFormState | undefined;
    render(<GeneralHost initialForm={{ githubImportAutoTranslate: true } as Partial<SettingsFormState>} onSetForm={(f) => { latest = f; }} />);
    const input = document.getElementById("githubImportAutoTranslate") as HTMLInputElement;
    expect(input.checked).toBe(true);

    fireEvent.click(input);
    expect(latest?.githubImportAutoTranslate).toBeUndefined();
  });

  it("renders the target-language select with the section's select idiom and the inherit option", () => {
    render(<GeneralHost initialForm={{}} />);
    const select = screen.getByTestId("import-translate-target-locale-select") as HTMLSelectElement;
    expect(select.className).toContain("select");
    expect(select.value).toBe("");
    expect([...select.options].map((o) => o.textContent)).toContain("Follow dashboard language");
  });

  it("reflects and stores an explicit target locale", () => {
    let latest: SettingsFormState | undefined;
    render(<GeneralHost initialForm={{}} onSetForm={(f) => { latest = f; }} />);
    const select = screen.getByTestId("import-translate-target-locale-select") as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "ko" } });
    expect(latest?.importTranslateTargetLocale).toBe("ko");
  });

  it("stores undefined (inherit dashboard language) when the blank option is chosen", () => {
    let latest: SettingsFormState | undefined;
    render(<GeneralHost initialForm={{ importTranslateTargetLocale: "ko" } as Partial<SettingsFormState>} onSetForm={(f) => { latest = f; }} />);
    const select = screen.getByTestId("import-translate-target-locale-select") as HTMLSelectElement;
    expect(select.value).toBe("ko");

    fireEvent.change(select, { target: { value: "" } });
    expect(latest?.importTranslateTargetLocale).toBeUndefined();
  });
});
