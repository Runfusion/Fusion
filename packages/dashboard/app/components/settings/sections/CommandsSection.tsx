/**
 * Commands section (U9 / KTD-10).
 *
 * Project-scoped test/build command inputs injected into generated task specs.
 * Behavior and keys preserved verbatim from the original inline JSX.
 */
import type { ReactNode } from "react";
import type { SectionBaseProps } from "./context";

export interface CommandsSectionProps extends SectionBaseProps {
  scopeBanner: ReactNode;
}

export function CommandsSection({ scopeBanner, form, setForm }: CommandsSectionProps) {
  return (
    <>
      {scopeBanner}
      <h4 className="settings-section-heading">Commands</h4>
      <div className="form-group">
        <label htmlFor="testCommand">Test Command</label>
        <input
          id="testCommand"
          type="text"
          placeholder="e.g. pnpm test"
          value={form.testCommand || ""}
          onChange={(e) =>
            setForm((f) => ({ ...f, testCommand: e.target.value || undefined }))
          }
        />
        <small>Command used to run tests — injected into generated task specs</small>
      </div>
      <div className="form-group">
        <label htmlFor="buildCommand">Build Command</label>
        <input
          id="buildCommand"
          type="text"
          placeholder="e.g. pnpm build"
          value={form.buildCommand || ""}
          onChange={(e) =>
            setForm((f) => ({ ...f, buildCommand: e.target.value || undefined }))
          }
        />
        <small>Command used to build the project — injected into generated task specs</small>
      </div>
    </>
  );
}

export default CommandsSection;
