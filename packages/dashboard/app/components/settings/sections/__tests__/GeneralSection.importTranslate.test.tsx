// @vitest-environment jsdom
/*
FNXC:GitHubImportTranslate 2026-07-15-16:35:
The import auto-translate controls must render with the SECTION'S native checkbox idiom — a native
checkbox with the input BEFORE its text, matching the neighbouring GitHub/import checkbox. Two
different checkbox idioms in one settings section read as a bug.

FNXC:SettingsStyling 2026-07-15-19:10:
The requirement above is unchanged; what satisfies it moved. This originally pinned the literal
`checkbox-label` class and was written to survive "a refactor back onto the primitive", because
SettingsToggleRow then rendered a right-aligned toggle switch that clashed with the section's
checkboxes.

Both halves of that objection are now gone: SettingsToggleRow renders a native checkbox BEFORE its
label (SettingsFieldRow `inlineControl`), and every checkbox in this section — including the
neighbour this asserts parity against — renders through the same primitive. The idiom split that
motivated the pin is resolved by migrating all of them rather than by de-migrating these two, so the
assertions below track the primitive's markup instead of `checkbox-label`.

The behavioural contracts are untouched and still pinned: input-before-text, exact parity with the
neighbouring checkbox, `undefined`-not-`false` on switch-off, and inherit-on-blank.
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
  // FNXC:DashboardTests 2026-07-20-23:40: GeneralSection now loads Discussion categories for report target settings.
  listDiscussionCategories: vi.fn().mockResolvedValue({ categories: [] }),
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
    />
  );
}

describe("GeneralSection - import auto-translate controls", () => {
  it("renders the auto-translate control as a native checkbox using the section's row idiom", () => {
    render(<GeneralHost initialForm={{}} />);
    const input = document.getElementById("githubImportAutoTranslate") as HTMLInputElement;
    expect(input).not.toBeNull();
    // Still a native checkbox — not a bespoke switch widget.
    expect(input.type).toBe("checkbox");
    expect(input.closest(".settings-field-row")).not.toBeNull();
  });

  it("puts the checkbox BEFORE its text, like every other checkbox in the section", () => {
    render(<GeneralHost initialForm={{}} />);
    const input = document.getElementById("githubImportAutoTranslate")!;
    const row = input.closest(".settings-field-row")!;
    // Reading order is the requirement: "[x] Auto-translate imported issues".
    // The primitive binds label->control via htmlFor/id, so the label is a
    // sibling of the control rather than its wrapper; assert DOM order directly.
    const head = row.querySelector(".settings-field-row-head")!;
    const controlSlot = head.querySelector(".settings-field-row-control")!;
    expect(controlSlot.contains(input)).toBe(true);
    expect(head.firstElementChild).toBe(controlSlot);
    expect(row.textContent).toContain("Auto-translate imported issues");
  });

  /*
  FNXC:SourceControl 2026-07-15-20:30:
  The parity neighbour used to be `githubLinkImportedIssuesToTracking`, which moved to "Source Control · Project" with the rest of the GitHub tracking block. The REQUIREMENT is unchanged — auto-translate must not become a second checkbox idiom inside General — so this now compares against a checkbox General still renders. Any of the section's toggles serves: they all render through SettingsToggleRow, which is the invariant being pinned.
  */
  it("matches a neighbouring section checkbox's structure exactly", () => {
    render(<GeneralHost initialForm={{}} />);
    const mine = document.getElementById("githubImportAutoTranslate")!.closest(".settings-field-row")!;
    const neighbour = document.getElementById("showTaskChatsInCommonFeed")!.closest(".settings-field-row")!;
    // Parity is the point: both render through the same row primitive, so an
    // idiom split cannot reappear in this section.
    expect(mine.className).toBe(neighbour.className);
    expect(mine.firstElementChild?.className).toBe(neighbour.firstElementChild?.className);
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
    const select = document.getElementById("importTranslateTargetLocale") as HTMLSelectElement;
    expect(select.className).toContain("select");
    expect(select.value).toBe("");
    expect([...select.options].map((o) => o.textContent)).toContain("Follow dashboard language");
  });

  it("reflects and stores an explicit target locale", () => {
    let latest: SettingsFormState | undefined;
    render(<GeneralHost initialForm={{}} onSetForm={(f) => { latest = f; }} />);
    const select = document.getElementById("importTranslateTargetLocale") as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "ko" } });
    expect(latest?.importTranslateTargetLocale).toBe("ko");
  });

  it("stores undefined (inherit dashboard language) when the blank option is chosen", () => {
    let latest: SettingsFormState | undefined;
    render(<GeneralHost initialForm={{ importTranslateTargetLocale: "ko" } as Partial<SettingsFormState>} onSetForm={(f) => { latest = f; }} />);
    const select = document.getElementById("importTranslateTargetLocale") as HTMLSelectElement;
    expect(select.value).toBe("ko");

    fireEvent.change(select, { target: { value: "" } });
    expect(latest?.importTranslateTargetLocale).toBeUndefined();
  });
});
